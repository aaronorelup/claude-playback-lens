// Round-1 fix regressions — jsonl bounds (SEC-3, SEC-4/COR-8, COR-24/SEC-5)
// and http guards (SEC-2, SEC-9, COR-16).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLineRange, readLineAt, buildOffsetTable, offsetTableCount, dropOffsetTable } from '../server/jsonl.mjs';
import { originAllowed } from '../server/http.mjs';
import { buildCtx, startServer, getJson, rawGet } from './fixtures/api/helpers.mjs';

const TMP = path.join(os.tmpdir(), `lens-fix-jsonl-${process.pid.toString(36)}`);
before(async () => { await fsp.mkdir(TMP, { recursive: true }); });
after(async () => { await fsp.rm(TMP, { recursive: true, force: true }); });

test('SEC-3 — readLineRange caps one window at the byte budget (no ~1GB allocation), min one line', async () => {
  const abs = path.join(TMP, 'big.jsonl');
  const line = '{"x":"' + 'y'.repeat(2 * 1024 * 1024) + '"}\n'; // ~2MB, routine per SPEC §1
  await fsp.writeFile(abs, line.repeat(20)); // 40MB on disk
  const win = await readLineRange(abs, 1, 500);
  assert.ok(win.count >= 1, 'at least one line');
  assert.ok(win.count < 20, `capped below the full window (got ${win.count})`);
  assert.ok(win.count * line.length <= (16 << 20) + line.length, 'window stays near the 16MB budget');
  assert.equal(win.total, 20, 'total still reports the real file');
  await fsp.rm(abs, { force: true });
});

test('SEC-4/COR-8 — the offset-table map is bounded; dropOffsetTable still works', async () => {
  const files = [];
  for (let i = 0; i < 40; i++) {
    const abs = path.join(TMP, `t${i}.jsonl`);
    await fsp.writeFile(abs, '{"a":1}\n');
    files.push(abs);
    await buildOffsetTable(abs);
  }
  assert.ok(offsetTableCount() <= 32, `table cache bounded (got ${offsetTableCount()})`);
  // an evicted file still reads correctly (rebuild on demand)
  assert.equal(await readLineAt(files[0], 1), '{"a":1}');
  dropOffsetTable(files[0]);
  assert.equal(await readLineAt(files[0], 1), '{"a":1}', 'drop + rebuild round-trips');
  for (const f of files) await fsp.rm(f, { force: true });
});

test('COR-24 — a same-size in-place rewrite invalidates the cached offsets (mtime check)', async () => {
  const abs = path.join(TMP, 'rw.jsonl');
  await fsp.writeFile(abs, '{"a":1}\n{"b":2}\n');
  assert.equal(await readLineAt(abs, 2), '{"b":2}');
  await new Promise((r) => setTimeout(r, 20)); // ensure mtime moves
  await fsp.writeFile(abs, '{"c":3}\n{"d":4}\n'); // same byte length
  assert.equal(await readLineAt(abs, 2), '{"d":4}', 'rebuilt, not served from the stale table');
  await fsp.rm(abs, { force: true });
});

test('SEC-5 — early EOF (file shrank under the table) yields null, never a torn decode', async () => {
  const abs = path.join(TMP, 'shrink.jsonl');
  await fsp.writeFile(abs, '{"a":1}\n{"b":2}\n{"c":3}\n');
  await buildOffsetTable(abs);
  const fh = await fsp.open(abs, 'r+');
  await fh.truncate(10);
  await fh.close();
  // the stale table thinks line 3 exists; the read must come back null/absent
  const t = await readLineAt(abs, 3);
  assert.equal(t, null);
  await fsp.rm(abs, { force: true });
});

test('SEC-2 — originAllowed: cross-site browser requests rejected, app/self/non-browser allowed', () => {
  assert.equal(originAllowed({}), true, 'non-browser clients carry neither header');
  assert.equal(originAllowed({ 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(originAllowed({ 'sec-fetch-site': 'none' }), true, 'direct navigation');
  assert.equal(originAllowed({ 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(originAllowed({ 'sec-fetch-site': 'same-site' }), false);
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:8791' }), true);
  assert.equal(originAllowed({ origin: 'http://localhost:8791' }), true);
  assert.equal(originAllowed({ origin: 'https://evil.example' }), false);
  assert.equal(originAllowed({ origin: 'null' }), false, 'opaque origin is not the app');
});

test('SEC-2/SEC-9/COR-16 — over the wire: 403 cross-site, nosniff everywhere, %zz never a 500', async () => {
  const ctx = await buildCtx();
  const srv = await startServer(ctx);
  try {
    const blocked = await rawGet(srv.port, '/api/index', { host: `127.0.0.1:${srv.port}`, 'sec-fetch-site': 'cross-site' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'cross-site-forbidden');
    const ok = await getJson(`${srv.url}/api/hello`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    const bad = await getJson(`${srv.url}/api/session/%zz/x`);
    assert.ok(bad.status === 404 || bad.status === 400, `client typo is ${bad.status}, never a 500`);
    assert.notEqual(bad.status, 500);
  } finally { await srv.close(); }
});
