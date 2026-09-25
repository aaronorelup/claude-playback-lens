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
//   * accepts calls only with the random token it wrote into its info file
//     (user-only directory), on 127.0.0.1 only;
//   * exits after LENS_DAEMON_IDLE_MS (default 15 min) with no calls, which
//     returns the whole index's memory to the machine. The next call respawns
//     it; the on-disk index cache makes that restart cheap.

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createEngine } from './engine.mjs';
import { daemonPaths, DEFAULT_IDLE_MS } from './daemon-files.mjs';

const MAX_BODY = 1 << 20;

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

export async function runDaemon() {
  const log = (msg) => process.stderr.write(`[lens-daemon ${new Date().toISOString()}] ${msg}\n`);
  const P = daemonPaths();
  fs.mkdirSync(P.dir, { recursive: true });

  if (!takeLock(P.lock)) {
    log('another daemon holds the lock — exiting');
    process.exit(0);
  }

  const idleMs = Number(process.env.LENS_DAEMON_IDLE_MS) > 0 ? Number(process.env.LENS_DAEMON_IDLE_MS) : DEFAULT_IDLE_MS;
  const token = crypto.randomBytes(24).toString('hex');
  let inflight = 0;
  let idleTimer = null;
  let closing = false;

  const cleanupFiles = () => {
    for (const f of [P.info, P.lock]) {
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
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (inflight === 0) shutdown(`idle ${Math.round(idleMs / 1000)}s`); else armIdle(); }, idleMs);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('exit', cleanupFiles);
  process.on('uncaughtException', (e) => { log(`uncaught: ${(e && e.stack) || e}`); shutdown('uncaught exception'); });

  try {
    engine = await createEngine({ log, mode: 'daemon' });
  } catch (e) {
    log(`engine failed to start: ${(e && e.stack) || e}`);
    cleanupFiles();
    process.exit(1);
  }

  server = http.createServer((req, res) => {
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.headers['x-lens-token'] !== token) return send(403, { error: 'bad token' });
    if (req.method === 'GET' && req.url === '/ping') return send(200, { ok: true, pid: process.pid });
    if (req.method !== 'POST' || req.url !== '/call') return send(404, { error: 'not found' });
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
        const result = await engine.invoke(name, args, caller);
        send(200, { result });
      } catch (e) {
        log(`call failed: ${(e && e.stack) || e}`);
        send(200, { result: { content: [{ type: 'text', text: `lens daemon: the call failed: ${(e && e.message) || e}` }], isError: true } });
      } finally {
        inflight -= 1;
        armIdle();
      }
    });
  });
  // The forwarders' own sockets keep-alive across calls; do not let one idle
  // connection hold the daemon open past its idle deadline.
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const info = { pid: process.pid, port, token, started: new Date().toISOString(), idleMs };
  const tmp = `${P.info}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, P.info);
  log(`listening on 127.0.0.1:${port} — idle exit after ${Math.round(idleMs / 1000)}s`);
  armIdle();
}
