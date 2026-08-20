// Error envelope + every status in the SPEC §9 table, over a real server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { buildCtx, startServer, getJson, rawGet, SLUG, S1, S2, A1, RUN } from './fixtures/api/helpers.mjs';

let ctx, srv;
before(async () => { ctx = await buildCtx(); srv = await startServer(ctx); });
after(async () => { await srv.close(); });

function assertEnvelope(body, code) {
  assert.ok(body && body.error, 'has error envelope');
  assert.equal(typeof body.error.code, 'string');
  assert.equal(typeof body.error.message, 'string');
  if (code) assert.equal(body.error.code, code);
}

test('hello answers with the app name (port probe contract)', async () => {
  const r = await getJson(`${srv.url}/api/hello`);
  assert.equal(r.status, 200);
  assert.equal(r.body.app, 'Claude Playback Lens');
  assert.equal(typeof r.body.pid, 'number');
  assert.ok(!('error' in r.body), 'no 2xx response carries an error key');
});

test('400 — malformed scope, malformed param, missing param', async () => {
  let r = await getJson(`${srv.url}/api/records?scope=bogus`);
  assert.equal(r.status, 400); assertEnvelope(r.body, 'bad-scope');
  r = await getJson(`${srv.url}/api/records?scope=zebra:x`);
  assert.equal(r.status, 400); assertEnvelope(r.body, 'bad-scope');
  r = await getJson(`${srv.url}/api/lines?slug=${SLUG}&id=${S1}&file=${S1}.jsonl&from=abc`);
  assert.equal(r.status, 400); assertEnvelope(r.body, 'bad-param');
  r = await getJson(`${srv.url}/api/find`);
  assert.equal(r.status, 400); assertEnvelope(r.body, 'missing-param');
  r = await getJson(`${srv.url}/api/find?q=x&re=1`.replace('x', '%5B')); // "[" — invalid regex
  assert.equal(r.status, 400); assertEnvelope(r.body, 'bad-regex');
  r = await getJson(`${srv.url}/api/turn/${SLUG}/${S1}/notanint`);
  assert.equal(r.status, 400); assertEnvelope(r.body, 'bad-param');
});

test('403 — foreign Host header is rejected', async () => {
  const r = await rawGet(srv.port, '/api/hello', { Host: 'evil.example.com' });
  assert.equal(r.status, 403);
  assertEnvelope(r.body, 'host-not-allowed');
  const ok = await rawGet(srv.port, '/api/hello', { Host: `localhost:${srv.port}` });
  assert.equal(ok.status, 200);
  const ok2 = await rawGet(srv.port, '/api/hello', { Host: '127.0.0.1' });
  assert.equal(ok2.status, 200);
});

test('403 — traversal and out-of-FileTable paths on file routes', async () => {
  for (const rel of ['..%2Fsecret', 'a%5Cb', 'C%3A%2Fx', 'not-in-table.jsonl']) {
    const r = await getJson(`${srv.url}/api/file?slug=${SLUG}&id=${S1}&rel=${rel}`);
    assert.equal(r.status, 403, `rel=${rel}`);
    assertEnvelope(r.body, 'path-forbidden');
  }
});

test('404 — unknown slug / session / turn / agent / line / runId', async () => {
  let r = await getJson(`${srv.url}/api/project/no-such-slug`);
  assert.equal(r.status, 404); assertEnvelope(r.body, 'unknown-project');
  r = await getJson(`${srv.url}/api/session/${SLUG}/99999999-9999-4999-8999-999999999999`);
  assert.equal(r.status, 404); assertEnvelope(r.body, 'unknown-session');
  r = await getJson(`${srv.url}/api/turn/${SLUG}/${S1}/99`);
  assert.equal(r.status, 404); assertEnvelope(r.body, 'unknown-turn');
  r = await getJson(`${srv.url}/api/agent/${SLUG}/${S1}/a0000000000000000`);
  assert.equal(r.status, 404); assertEnvelope(r.body, 'unknown-agent');
  r = await getJson(`${srv.url}/api/line?slug=${SLUG}&id=${S1}&file=${S1}.jsonl&line=999`);
  assert.equal(r.status, 404); assertEnvelope(r.body, 'unknown-line');
  r = await getJson(`${srv.url}/api/workflow/${SLUG}/${S1}/wf_00000000-000`);
  assert.equal(r.status, 404); assertEnvelope(r.body, 'unknown-workflow');
  r = await getJson(`${srv.url}/api/nosuchroute`);
  assert.equal(r.status, 404); assertEnvelope(r.body, 'unknown-route');
});

test('409 — not-indexed-yet carries retryAfterMs and byte denominators', async () => {
  const pctx = await buildCtx({
    extraPendingSession: true,
    status: { state: 'building', sessionsDone: 2, sessionsTotal: 3, bytesIndexed: 500, bytesTotal: 1000 },
  });
  const psrv = await startServer(pctx);
  try {
    const r = await getJson(`${psrv.url}/api/session/${SLUG}/33333333-3333-4333-8333-333333333333`);
    assert.equal(r.status, 409);
    assertEnvelope(r.body, 'not-indexed-yet');
    assert.equal(typeof r.body.error.detail.retryAfterMs, 'number');
    assert.equal(r.body.error.detail.bytesIndexed, 500);
    assert.equal(r.body.error.detail.bytesTotal, 1000);
  } finally { await psrv.close(); }
});

test('416 — unsatisfiable /api/lines window; satisfiable one is exact', async () => {
  let r = await getJson(`${srv.url}/api/lines?slug=${SLUG}&id=${S1}&file=${S1}.jsonl&from=999`);
  assert.equal(r.status, 416); assertEnvelope(r.body, 'window-unsatisfiable');
  r = await getJson(`${srv.url}/api/lines?slug=${SLUG}&id=${S1}&file=${S1}.jsonl&from=7&count=5`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 8);
  assert.equal(r.body.count, 2); // lines 7..8 only
  assert.ok(!('error' in r.body));
});

test('416 — unsatisfiable Range on /api/file', async () => {
  const r = await fetch(`${srv.url}/api/file?slug=${SLUG}&id=${S1}&rel=${S1}.jsonl`, {
    headers: { Range: 'bytes=999999-1000000' },
  });
  assert.equal(r.status, 416);
  const body = await r.json();
  assertEnvelope(body, 'bad-range');
});

test('503 — indexer worker down', async () => {
  const dctx = await buildCtx({ workerAlive: () => false });
  const dsrv = await startServer(dctx);
  try {
    const r = await getJson(`${dsrv.url}/api/session/${SLUG}/${S1}`);
    assert.equal(r.status, 503);
    assertEnvelope(r.body, 'indexer-down');
    // R8-WORKER: /api/index and /api/reindex are the two exceptions — the
    // problems census is only reachable through /api/index, so 503ing it made a
    // dead indexer undiagnosable, and /api/reindex is the recovery action.
    const idx = await getJson(`${dsrv.url}/api/index`);
    assert.equal(idx.status, 200, '/api/index answers degraded rather than hiding the failure');
    assert.ok(!('error' in idx.body));
    assert.ok(Array.isArray(idx.body.problems));
  } finally { await dsrv.close(); }
});

test('204 — /api/index?since=<current>&boot=<ours>; stale/foreign since gets a full payload', async () => {
  const cur = await getJson(`${srv.url}/api/index`);
  assert.equal(cur.status, 200);
  const version = cur.body.version;
  const boot = cur.body.boot;
  assert.equal(typeof boot, 'string', 'payload carries the per-process boot id');
  const same = await fetch(`${srv.url}/api/index?since=${version}&boot=${encodeURIComponent(boot)}`);
  assert.equal(same.status, 204);
  assert.equal((await same.text()).length, 0);
  const older = await getJson(`${srv.url}/api/index?since=${version - 1}&boot=${encodeURIComponent(boot)}`);
  assert.equal(older.status, 200);
  assert.equal(older.body.version, version);
  const stale = await getJson(`${srv.url}/api/index?since=${version + 500}&boot=${encodeURIComponent(boot)}`); // previous-run cursor
  assert.equal(stale.status, 200, 'stale since must get the full payload, never a spurious 204');
  // COR-18: a since from ANOTHER process life (no/foreign boot id) never 204s,
  // even when the bare counters happen to collide
  const foreign = await getJson(`${srv.url}/api/index?since=${version}`);
  assert.equal(foreign.status, 200, 'a since without our boot id gets the full payload');
  const otherBoot = await getJson(`${srv.url}/api/index?since=${version}&boot=not-this-process`);
  assert.equal(otherBoot.status, 200);
});

test('2xx payloads: /api/index shape (dayBands, turnBars, status denominator)', async () => {
  const r = await getJson(`${srv.url}/api/index`);
  assert.equal(r.status, 200);
  assert.ok(!('error' in r.body));
  assert.ok(Array.isArray(r.body.sessions) && r.body.sessions.length === 2);
  assert.ok(Array.isArray(r.body.turnBars) && r.body.turnBars.length === 2);
  assert.ok(Array.isArray(r.body.dayBands) && r.body.dayBands.length >= 1);
  const band = r.body.dayBands[0];
  assert.match(band.localDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(band.turnCount >= 1);
  assert.equal(typeof band.usd, 'number');
  assert.equal(typeof band.tokens.input, 'number');
  assert.equal(typeof r.body.status.sessionsTotal, 'number');
});

test('file routes: mem/ and frag/ forms serve bytes; Range works', async () => {
  let r = await fetch(`${srv.url}/api/file?slug=${SLUG}&rel=mem/notes.md`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('NEEDLE_MEM'));
  r = await fetch(`${srv.url}/api/file?slug=${SLUG}&id=${S1}&rel=frag/${SLUG}/memory/notes.md`);
  assert.equal(r.status, 200);
  r = await fetch(`${srv.url}/api/file?slug=${SLUG}&id=${S1}&rel=${S1}.jsonl`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal((await r.text()).length, 10);
  assert.match(r.headers.get('content-range'), /^bytes 0-9\/\d+$/);
});

test('COR-7: a client that disconnects mid-download stops the server-side read', async () => {
  // a file big enough that one socket buffer cannot swallow it
  const rel = `${SLUG}/${S1}/big-download.bin`;
  // R7-1: write into THIS ctx's private store root, never the committed
  // fixture store — a 16 MB transient file there raced audit-pathb's and
  // fixes-audit's two-walk file-census self-checks under node --test's
  // file-level parallelism. resolveFileRef 403s anything outside
  // ctx.projectsDir, so the ctx root is the only place this can live.
  const abs = path.join(ctx.projectsDir, ...rel.split('/'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, Buffer.alloc(16 << 20, 0x61));
  const st = await fsp.stat(abs);
  ctx._internals.fileTable.set(rel, { size: st.size, mtimeMs: st.mtimeMs });

  const realCreate = fs.createReadStream;
  let opened = null;
  fs.createReadStream = (...args) => { opened = realCreate.apply(fs, args); return opened; };
  try {
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: srv.port, method: 'GET',
        path: `/api/file?slug=${SLUG}&id=${S1}&rel=big-download.bin`,
      }, (res) => {
        assert.equal(res.statusCode, 200);
        res.once('data', () => { req.destroy(); resolve(); }); // hang up mid-body
        res.on('error', () => { /* the abort surfaces here */ });
      });
      req.on('error', () => { /* expected: we destroyed it */ });
      req.end();
    });
    const deadline = Date.now() + 3000;
    while (!(opened && opened.destroyed) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(opened, 'the route streams (createReadStream), it does not buffer the whole file');
    assert.equal(opened.destroyed, true, 'res.on(close) destroyed the read stream');
    assert.ok(opened.bytesRead < st.size,
      `the read stopped early: ${opened.bytesRead} of ${st.size} bytes — a 240 MB transcript never accumulates behind a gone socket`);
  } finally {
    fs.createReadStream = realCreate;
    ctx._internals.fileTable.delete(rel);
    await fsp.rm(abs, { force: true });
  }
});

test('workflow route: partial envelope for an in-flight run (never 404 an existing run dir)', async () => {
  const r = await getJson(`${srv.url}/api/workflow/${SLUG}/${S1}/${RUN}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, false);
  assert.equal(r.body.journal.length, 1);
  assert.equal(r.body.journal[0].agentId, 'a2222222222222222');
  assert.match(r.body.script, /fixture workflow script/);
  // WF-2 (round 3): agents are OBJECTS on both envelopes — the bare filename
  // strings this route used to ship rendered every column of the run's agents
  // table as unknown, agentId included. The list is still the run DIRECTORY
  // LISTING (SPEC §7), one row per transcript.
  assert.equal(r.body.agents.length, 1);
  assert.equal(typeof r.body.agents[0], 'object');
  assert.equal(r.body.agents[0].agentId, 'a2222222222222222');
  assert.equal(r.body.agents[0].file, 'agent-a2222222222222222.jsonl');
  assert.equal(r.body.agents[0].rel, `${SLUG}/${S1}/subagents/workflows/${RUN}/agent-a2222222222222222.jsonl`);
});

test('agent route: main + agent rows page with from/count', async () => {
  let r = await getJson(`${srv.url}/api/agent/${SLUG}/${S1}/main`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  r = await getJson(`${srv.url}/api/agent/${SLUG}/${S1}/${A1}?from=1&count=1`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].line, 2);
});

test('line route: 1-based line with stripped payload + torn-line problem row', async () => {
  let r = await getJson(`${srv.url}/api/line?slug=${SLUG}&id=${S1}&file=${S1}.jsonl&line=4`);
  assert.equal(r.status, 200);
  assert.equal(r.body.event.message.id, 'msg_AAA');
  assert.deepEqual(r.body.problems, []);
  r = await getJson(`${srv.url}/api/line?slug=${SLUG}&id=${S1}&file=${S1}.jsonl&line=7`); // the torn line
  assert.equal(r.status, 200);
  assert.equal(r.body.event, null);
  assert.equal(r.body.problems[0].code, 'torn-line');
});
