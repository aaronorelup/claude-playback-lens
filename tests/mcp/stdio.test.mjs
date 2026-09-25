// tests/mcp/stdio.test.mjs — KAN-106 §9 acceptance criterion 1, automated.
//
//   "node lens-mcp.mjs speaks MCP over stdio and survives tools/list + one
//    tools/call with ZERO non-JSON-RPC bytes on stdout."
//
// Every other test on this server calls a tool's handler in-process. This one
// is the only test that proves the PROCESS works: that it boots against a real
// corpus root, negotiates the protocol, and — the part no in-process test can
// see — that nothing it or the lens or a dependency writes ever lands on the
// wire.
//
// WHY THE JSON-RPC IS HAND-ROLLED HERE rather than driven with
// @modelcontextprotocol/client's StdioClientTransport. The transport consumes
// the child's stdout stream to parse messages. Once it owns the pipe, the raw
// bytes are gone: a client that successfully reads four messages proves the
// four messages were there, NOT that they were the only thing there — a stray
// `console.log` between two framed messages would be silently skipped as an
// unparseable line by a tolerant reader and the assertion would still pass. So
// this test owns the pipe itself, keeps every byte, and frames the protocol by
// hand. It is ~40 lines of newline-delimited JSON and it is the only way the
// purity claim is actually tested.
//
// The corpus is the lens's own fixture store, via CLAUDE_PROJECTS — the same
// store tests/mcp/helpers.mjs builds. The real ~/.claude/projects would make this
// test's runtime a function of the developer's disk.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { REPO_ROOT, lensFixtures } from './helpers.mjs';

// The five tools of the phase-1 cut (KAN-106 §8). tools/list must name these
// and nothing else: a tool that appears without being registered here is a
// surface an agent can call that nobody wrote a description for.
const EXPECTED_TOOLS = [
  'lens_pricing',
  'lens_read',
  'lens_search',
  'lens_session',
  'lens_sessions',
  'lens_status',
  'lens_usage',
];
// The one tool that writes — and what it writes is the user's rate file.
const WRITERS = new Set(['lens_pricing']);

// The protocol revision this server's SDK negotiates. Read from the SDK rather
// than written down, so an SDK bump that changes it fails loudly here instead
// of leaving a stale literal that happens to still be accepted.
const { LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/server');

// Generous: a cold child pays for node startup, the SDK import and a fixture
// index build. A slow machine is not a protocol failure.
const BOOT_MS = 60000;

let child = null;
let cacheDir = null;

// Every byte the child ever wrote to fd 1, in order and unparsed. This is the
// evidence for the purity assertion; nothing else in the process may consume
// the stream.
const stdoutChunks = [];
const stderrChunks = [];

// Pending JSON-RPC requests by id, plus the line buffer the reader drains into.
const pending = new Map();
let lineBuf = '';
let nextId = 1;

before(async () => {
  const fixtures = await lensFixtures();
  cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-mcp-stdio-'));

  // shell:false and the absolute node path: on win32 a shell hop would put
  // cmd.exe between this test and the child's stdio, and the raw bytes this
  // test exists to inspect would be the shell's, not the server's.
  child = spawn(process.execPath, [path.join('mcp', 'lens-mcp.mjs')], {
    cwd: REPO_ROOT,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_PROJECTS: fixtures.STORE,
      // An index cache belongs to one process (SPEC §9). This child gets its
      // own so it never contends with the suite's other contexts.
      LENS_CACHE_DIR: cacheDir,
      // The forwarder spawns a shared daemon; this run's daemon keeps its lock
      // and info files in the scratch dir and exits soon after the suite.
      LENS_STATE_DIR: path.join(cacheDir, 'run'),
      LENS_DAEMON_IDLE_MS: '4000',
      LENS_PRICING_FILE: path.join(cacheDir, 'pricing.json'),
    },
  });

  child.stdout.on('data', (buf) => {
    stdoutChunks.push(Buffer.from(buf));
    lineBuf += buf.toString('utf8');
    for (;;) {
      const nl = lineBuf.indexOf('\n');
      if (nl < 0) break;
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // the purity test judges it
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.on('data', (buf) => stderrChunks.push(Buffer.from(buf)));

  // A child that dies during the handshake must fail the waiting request
  // rather than hang the suite until the runner's own timeout.
  child.on('exit', (code, signal) => {
    for (const [, { reject }] of pending) {
      reject(new Error(`server exited (code ${code}, signal ${signal}) before answering.\nstderr:\n${stderrText()}`));
    }
    pending.clear();
  });

  // ---- the handshake, by hand.
  const init = await rpc('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'lens-mcp-stdio-test', version: '0' },
  });
  assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}\nstderr:\n${stderrText()}`);
  notify('notifications/initialized', {});
});

after(async () => {
  // The child holds an indexer worker thread; an un-killed one keeps this
  // process alive and the suite never exits. Killing it is not cleanup
  // politeness, it is what makes `npm test` terminate.
  for (const [, { reject }] of pending) reject(new Error('torn down'));
  pending.clear();
  if (child && child.exitCode === null) {
    const done = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (cacheDir) await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

function stderrText() {
  return Buffer.concat(stderrChunks).toString('utf8');
}

function send(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function rpc(method, params) {
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} did not answer in ${BOOT_MS}ms.\nstderr:\n${stderrText()}`));
      }
    }, BOOT_MS).unref?.();
  });
  send({ jsonrpc: '2.0', id, method, params });
  return p;
}

// ---------------------------------------------------------------- the tests
//
// They run in order and share the one child: the handshake is expensive and
// the purity assertion is strongest when it covers a whole real session.

test('tools/list names exactly the five lens_* tools', { timeout: BOOT_MS + 30000 }, async () => {
  const r = await rpc('tools/list', {});
  assert.ok(r.result, `tools/list failed: ${JSON.stringify(r.error)}`);
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);

  for (const t of r.result.tools) {
    assert.ok(t.description && t.description.length > 40,
      `${t.name} has no agent-facing description`);
    // §7.2: no tool declares an outputSchema, because declaring one obliges the
    // server to ship structuredContent on every call — the exact token
    // doubling this server exists to prevent.
    assert.equal(t.outputSchema, undefined, `${t.name} must not declare an outputSchema`);
    assert.equal(t.annotations?.readOnlyHint, !WRITERS.has(t.name), `${t.name} read-only hint`);
  }
});

test('a tools/call of lens_status returns a real, non-error result', { timeout: BOOT_MS + 30000 }, async () => {
  const r = await rpc('tools/call', { name: 'lens_status', arguments: {} });
  assert.ok(r.result, `tools/call failed: ${JSON.stringify(r.error)}\nstderr:\n${stderrText()}`);
  assert.notEqual(r.result.isError, true, 'lens_status over a ready fixture store is not an error');
  const text = r.result.content.map((c) => c.text ?? '').join('\n');
  // The version header proves the answer came from the linked lens, not from a
  // stub: 3.0.0 is the lens's own APP_VERSION.
  assert.match(text, /LENS 3\.0\.0/);
  assert.match(text, /^corpus: /m);
  // Text-only by default (§7.2).
  assert.equal(r.result.structuredContent, undefined);
});

// The memory fix: the stdio process is a forwarder, and the call above was
// answered by ONE shared daemon whose info file names a live pid other than
// the forwarder's own.
test('tool calls are answered by the shared daemon, not by the stdio process', { timeout: 30000 }, async () => {
  const runDir = path.join(cacheDir, 'run');
  const files = await fsp.readdir(runDir);
  const infoFile = files.find((f) => /^daemon-[0-9a-f]{12}\.json$/.test(f));
  assert.ok(infoFile, `no daemon info file in ${runDir}: ${files.join(', ')}`);
  const info = JSON.parse(await fsp.readFile(path.join(runDir, infoFile), 'utf8'));
  assert.notEqual(info.pid, child.pid, 'the daemon is a separate process');
  assert.ok(info.port > 0 && typeof info.token === 'string' && info.token.length >= 32);
  process.kill(info.pid, 0); // throws if the daemon is not alive
});

// THE ACCEPTANCE CRITERION. It runs last so it judges every byte the child
// wrote across the whole session above.
test('every byte on stdout is a JSON-RPC message and nothing else', { timeout: 30000 }, () => {
  const raw = Buffer.concat(stdoutChunks).toString('utf8');
  assert.ok(raw.length > 0, 'the server wrote nothing at all');

  // Newline-delimited framing: the stream is lines, and the last one is
  // terminated. A non-empty tail would be a partial write — or a print with no
  // newline, which is exactly the corruption this asserts against.
  const parts = raw.split('\n');
  assert.equal(parts.pop(), '', 'stdout ends mid-line — something wrote unterminated bytes');

  assert.ok(parts.length >= 3, `expected at least initialize + list + call responses, got ${parts.length}`);
  for (const [i, line] of parts.entries()) {
    assert.notEqual(line, '', `line ${i + 1} is blank — blank lines are not JSON-RPC messages`);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      // The failure this whole file exists to catch. Show the offending bytes.
      assert.fail(`line ${i + 1} on stdout is not JSON — a stray write corrupted the stream:\n${line.slice(0, 400)}`);
    }
    assert.equal(msg.jsonrpc, '2.0', `line ${i + 1} is JSON but not a JSON-RPC message: ${line.slice(0, 200)}`);
    // A JSON-RPC message is a response (id + result|error), a request (id +
    // method) or a notification (method). Nothing else is legal on this wire.
    const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
    const isCall = typeof msg.method === 'string';
    assert.ok(isResponse || isCall, `line ${i + 1} is neither a response nor a call: ${line.slice(0, 200)}`);
  }

  // And the diagnostics the server DOES emit went to the other channel, which
  // is where the stdio transport requires them (KAN-106 §3.3).
  assert.match(stderrText(), /\[lens-mcp\]/, 'startup logging must land on stderr');
});
