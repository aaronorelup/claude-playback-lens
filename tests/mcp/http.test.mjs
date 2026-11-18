// tests/mcp/http.test.mjs — the --http service, end to end.
//
// Spawns the real `node mcp/lens-mcp.mjs --http` on a free port over the
// fixture corpus and talks to it with the SDK's own Streamable HTTP client —
// the same wire Claude Code uses for "type": "http". Asserts:
//
//   * two clients (two sessions) are served by ONE process;
//   * tool calls work and the caller's session id header reaches the tools;
//   * a browser-style cross-origin request is refused;
//   * a stdio forwarder of the same identity uses the service instead of
//     spawning a daemon of its own (one index for every client);
//   * a second --http start exits at once instead of fighting for the port.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { REPO_ROOT, lensFixtures } from './helpers.mjs';

const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');

const BOOT_MS = 60000;
let child = null;
let tmp = null;
let port = 0;
let env = null;
const stderr = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitHealthy(p, ms = BOOT_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`);
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`service did not come up on ${p}:\n${Buffer.concat(stderr).toString('utf8')}`);
}

async function connect() {
  const client = new Client({ name: 'lens-http-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  return client;
}

before(async () => {
  const fixtures = await lensFixtures();
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-mcp-http-'));
  port = await freePort();
  env = {
    ...process.env,
    CLAUDE_PROJECTS: fixtures.STORE,
    LENS_CACHE_DIR: tmp,
    LENS_STATE_DIR: path.join(tmp, 'run'),
    LENS_PRICING_FILE: path.join(tmp, 'pricing.json'),
    LENS_MCP_PORT: String(port),
  };
  child = spawn(process.execPath, [path.join('mcp', 'lens-mcp.mjs'), '--http'], {
    cwd: REPO_ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  child.stdout.on('data', (b) => stderr.push(Buffer.from(b)));
  child.stderr.on('data', (b) => stderr.push(Buffer.from(b)));
  await waitHealthy(port);
});

after(async () => {
  if (child && child.exitCode === null) {
    const done = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  }
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

test('two sessions are served by the one service process', { timeout: BOOT_MS }, async () => {
  const a = await connect();
  const b = await connect();
  try {
    const [la, lb] = await Promise.all([a.listTools(), b.listTools()]);
    const names = la.tools.map((t) => t.name).sort();
    assert.ok(names.includes('lens_search') && names.includes('lens_status'), names.join(','));
    assert.deepEqual(lb.tools.map((t) => t.name).sort(), names);

    const st = await a.callTool({ name: 'lens_status', arguments: {} });
    assert.ok(!st.isError, JSON.stringify(st));
    assert.match(st.content[0].text, /sessions?/i);

    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.pid, child.pid, 'both sessions answered by the spawned service');
    assert.equal(h.app, 'claude-playback-lens');
  } finally {
    await a.close(); await b.close();
  }
});

test('over HTTP the calling session is unknown, and search says so instead of guessing', { timeout: BOOT_MS }, async () => {
  const c = await connect();
  try {
    const out = (await c.callTool({ name: 'lens_search', arguments: { q: 'e', limit: 1 } })).content[0].text;
    assert.match(out.split(/\r?\n/)[0], /calling session unknown \(shared HTTP service\)/);
    assert.doesNotMatch(out, /skipping this session/);
  } finally {
    await c.close();
  }
});

test('a cross-origin browser request is refused', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(r.status, 403);
});

// Drive a real stdio server by hand: newline-delimited JSON-RPC.
function stdioSession(extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join('mcp', 'lens-mcp.mjs')], {
    cwd: REPO_ROOT, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv },
  });
  const pending = new Map();
  let buf = '';
  let id = 1;
  const errs = [];
  proc.stderr.on('data', (b) => errs.push(String(b)));
  proc.stdout.on('data', (b) => {
    buf += b;
    for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* ignore */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const n = id++; pending.set(n, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  return { proc, rpc, errs, notify: (method, params) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`) };
}

test('a stdio forwarder routes its calls to the running service (one index for every client)', { timeout: BOOT_MS }, async () => {
  const { daemonPaths } = await import('../../mcp/daemon-files.mjs');
  // daemonPaths() reads the identity from THIS process's env; mirror the child's.
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let P;
  try { P = daemonPaths(); } finally { for (const k of Object.keys(env)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } }
  const info = JSON.parse(fs.readFileSync(P.info, 'utf8'));
  assert.equal(info.pid, child.pid, 'the service registered itself as the daemon for its identity');
  assert.equal(info.http, true);

  const { LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/server');
  const s = stdioSession();
  try {
    const init = await s.rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.ok(init.result, JSON.stringify(init));
    s.notify('notifications/initialized', {});
    const r = await s.rpc('tools/call', { name: 'lens_status', arguments: {} });
    assert.ok(r.result && !r.result.isError, JSON.stringify(r));
    // Still the service's pid in the info file: no second daemon was spawned.
    assert.equal(JSON.parse(fs.readFileSync(P.info, 'utf8')).pid, child.pid);
    assert.ok(!s.errs.join('').includes('spawned lens daemon'), s.errs.join(''));
  } finally {
    s.proc.kill();
  }
});

// In-process mode on purpose: it holds an indexer worker thread, the thing
// that kept a stdio server alive after its session was gone. (A forwarder
// happens to drain out on its own; this one does not without the handler.)
test('a stdio server exits by itself when its session closes stdin', { timeout: BOOT_MS }, async () => {
  const s = stdioSession({ LENS_MCP_INPROCESS: '1', LENS_CACHE_DIR: path.join(tmp, 'inproc') });
  const { LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/server');
  await s.rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const exited = new Promise((r) => s.proc.once('exit', (code) => r(code)));
  s.proc.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 10000))]);
  if (code === 'still running') s.proc.kill();
  assert.equal(code, 0, s.errs.join(''));
});

test('a second --http start exits at once and leaves the first serving', { timeout: BOOT_MS }, async () => {
  const second = spawn(process.execPath, [path.join('mcp', 'lens-mcp.mjs'), '--http'], {
    cwd: REPO_ROOT, shell: false, stdio: ['ignore', 'ignore', 'ignore'], env,
  });
  const code = await new Promise((r) => second.once('exit', r));
  assert.equal(code, 0);
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.pid, child.pid);
});
