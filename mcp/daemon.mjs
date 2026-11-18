// mcp/daemon.mjs — the ONE process per corpus that holds the index.
//
// Why: Claude Code starts one MCP server per session. When each of those built
// its own index, eighteen open sessions held eighteen copies (measured 11 GB).
// Now each session runs a thin forwarder (mcp/forwarder.mjs) and they all talk
// to this daemon over loopback HTTP. The daemon:
//
//   * is a singleton per identity (package dir + corpus/caching env): an
//     exclusive lock file decides, so N forwarders racing to spawn it produce
//     one daemon and N-1 processes that exit at once;
//   * accepts forwarder calls only with the random token it wrote into its
//     info file (user-only directory), on 127.0.0.1 only;
//   * exits after LENS_DAEMON_IDLE_MS (default 15 min) with no calls, which
//     returns the whole index's memory to the machine. The next call respawns
//     it; the on-disk index cache makes that restart cheap.
//
// THE SERVICE SHAPE (--http). Even thin, a forwarder is one process per
// session — four plus a conhost on Windows under `npx`. Started with --http,
// the daemon also serves MCP itself at http://127.0.0.1:<port>/mcp (default
// port 8792, LENS_MCP_PORT), never idles out, and Claude Code sessions connect
// to it directly ("type": "http") — no per-session process at all. It is the
// same singleton: it takes over the lock from an idle-mode daemon of the same
// identity (asking it to shut down), and stdio forwarders find and use it
// through the same info file, so every client shares one index.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEngine, collectTools, schemaDeps, lens } from './engine.mjs';
import { daemonPaths, servicePaths, httpPort, portOwner, DEFAULT_IDLE_MS } from './daemon-files.mjs';
import { PACKAGE_VERSION } from './versions.mjs';

const MAX_BODY = 1 << 20;
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lens-mcp.mjs');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/** Take the singleton lock, or return false when a live daemon holds it. */
function takeLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let holder = NaN;
      try { holder = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10); } catch { /* unreadable: treat as stale */ }
      if (pidAlive(holder)) return false;
      try { fs.unlinkSync(lockPath); } catch { /* raced with another cleaner */ }
    }
  }
  return false;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function post(port, urlPath, token) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, headers: { 'x-lens-token': token } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.setTimeout(3000, () => req.destroy());
    req.end();
  });
}

/**
 * --http only: an idle-mode daemon of this identity holds the lock. Ask it to
 * shut down (its forwarders reconnect to us through the info file), then take
 * the lock. Returns false when the holder is itself a service.
 */
async function takeOverLock(P, log) {
  const info = readJson(P.info);
  if (info && info.http) return false;
  if (info && info.port && info.token) {
    log(`asking the idle-mode daemon pid ${info.pid} to hand over`);
    await post(info.port, '/shutdown', info.token);
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (takeLock(P.lock)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * runDaemon({ http }) — http:false is the idle-exiting daemon forwarders
 * spawn; http:true is the long-lived service that also serves /mcp.
 */
export async function runDaemon({ http: httpMode = false } = {}) {
  const log = (msg) => process.stderr.write(`[lens-daemon ${new Date().toISOString()}] ${msg}\n`);
  const P = daemonPaths();
  fs.mkdirSync(P.dir, { recursive: true });

  if (!takeLock(P.lock)) {
    if (!httpMode || !(await takeOverLock(P, log))) {
      log('another daemon holds the lock — exiting');
      process.exit(0);
    }
  }

  const envIdle = process.env.LENS_DAEMON_IDLE_MS;
  const idleMs = httpMode ? 0 : (Number(envIdle) > 0 ? Number(envIdle) : DEFAULT_IDLE_MS);
  const token = crypto.randomBytes(24).toString('hex');
  let inflight = 0;
  let idleTimer = null;
  let closing = false;

  const S = servicePaths();
  const cleanupFiles = () => {
    for (const f of [P.info, P.lock, ...(httpMode ? [S.info] : [])]) {
      try {
        const txt = fs.readFileSync(f, 'utf8');
        const pid = f === P.lock ? Number.parseInt(txt, 10) : JSON.parse(txt).pid;
        if (pid === process.pid) fs.unlinkSync(f);
      } catch { /* already gone */ }
    }
  };

  let engine = null;
  let server = null;
  async function shutdown(why) {
    if (closing) return;
    closing = true;
    log(`shutting down: ${why}`);
    cleanupFiles();
    try { server && server.close(); } catch { /* ignore */ }
    try { engine && await engine.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  const armIdle = () => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (inflight === 0) shutdown(`idle ${Math.round(idleMs / 1000)}s`); else armIdle(); }, idleMs);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('exit', cleanupFiles);
  process.on('uncaughtException', (e) => { log(`uncaught: ${(e && e.stack) || e}`); shutdown('uncaught exception'); });

  // The engine builds while the socket is already answering: tools/list needs
  // only the schemas, and a call simply waits for the index. A service that is
  // listening within a second of logon is what a connecting session needs.
  const engineReady = createEngine({ log, mode: httpMode ? 'service' : 'daemon' }).then((e) => (engine = e));
  engineReady.catch((e) => {
    log(`engine failed to start: ${(e && e.stack) || e}`);
    cleanupFiles();
    process.exit(1);
  });
  const invoke = async (name, args, caller) => (await engineReady).invoke(name, args, caller);

  let mcp = null;
  if (httpMode) {
    const { createHttpMcp } = await import('./http-mcp.mjs');
    const tools = collectTools(schemaDeps());
    mcp = createHttpMcp({
      tools,
      version: lens.core.APP_VERSION,
      log,
      invoke: async (name, args, caller) => {
        inflight += 1;
        try { return await invoke(name, args, caller); } finally { inflight -= 1; }
      },
    });
  }

  server = http.createServer((req, res) => {
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const url = (req.url || '').split('?')[0];
    // Unauthenticated, loopback: the MCP endpoint (Host/Origin-checked inside)
    // and a liveness probe that says whose port this is.
    if (mcp && (url === '/mcp' || url === '/mcp/')) return mcp.handle(req, res);
    if (req.method === 'GET' && url === '/health') {
      return send(200, { ok: true, app: 'claude-playback-lens', pid: process.pid, version: PACKAGE_VERSION, ready: !!engine });
    }
    if (req.headers['x-lens-token'] !== token) return send(403, { error: 'bad token' });
    if (req.method === 'GET' && url === '/ping') return send(200, { ok: true, pid: process.pid });
    if (req.method === 'POST' && url === '/shutdown') {
      send(200, { ok: true });
      setImmediate(() => shutdown('asked to hand over'));
      return undefined;
    }
    if (req.method !== 'POST' || url !== '/call') return send(404, { error: 'not found' });
    if (closing) return send(503, { error: 'closing' });
    inflight += 1;
    armIdle();
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', async () => {
      try {
        if (size > MAX_BODY) return send(413, { error: 'request too large' });
        const { name, args, caller } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await invoke(name, args, caller);
        send(200, { result });
      } catch (e) {
        log(`call failed: ${(e && e.stack) || e}`);
        send(200, { result: { content: [{ type: 'text', text: `lens daemon: the call failed: ${(e && e.message) || e}` }], isError: true } });
      } finally {
        inflight -= 1;
        armIdle();
      }
    });
    return undefined;
  });
  // The forwarders' own sockets keep-alive across calls; do not let one idle
  // connection hold the daemon open past its idle deadline.
  server.keepAliveTimeout = 5000;

  const wantPort = httpMode ? httpPort() : 0;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(wantPort, '127.0.0.1', resolve);
    });
  } catch (e) {
    cleanupFiles();
    if (e && e.code === 'EADDRINUSE') {
      log(`port ${wantPort} is already in use — ${await portOwner(wantPort)}. Set LENS_MCP_PORT to use another.`);
      process.exit(0);
    }
    throw e;
  }
  const { port } = server.address();
  const info = { pid: process.pid, port, token, started: new Date().toISOString(), idleMs, http: httpMode };
  writeAtomic(P.info, info);
  if (httpMode) {
    // Where the service runs from, so the plugin's session-start check (and a
    // person) can restart the same install: plugin/hooks/ensure-service.mjs.
    writeAtomic(S.info, { pid: process.pid, port, url: `http://127.0.0.1:${port}/mcp`, node: process.execPath, entry: ENTRY, version: PACKAGE_VERSION, started: info.started });
  }
  log(httpMode
    ? `serving MCP at http://127.0.0.1:${port}/mcp — long-lived (no idle exit)`
    : `listening on 127.0.0.1:${port} — idle exit after ${Math.round(idleMs / 1000)}s`);
  armIdle();
}

function writeAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
