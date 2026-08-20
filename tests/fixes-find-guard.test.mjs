// Round-1 fix regressions — find (SEC-1 regex guard, COR-5 stale cursor,
// COR-21 progress bytes) + the /api/find 400 path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFind } from '../server/find.mjs';
import { catastrophicShape } from '../server/api.mjs';
import { buildCtx, startServer, getJson, sseCollect, SLUG, S1 } from './fixtures/api/helpers.mjs';

let ctx, srv;
before(async () => { ctx = await buildCtx(); srv = await startServer(ctx); });
after(async () => { await srv.close(); });

test('SEC-1 — catastrophicShape flags nested unbounded quantifiers, passes ordinary patterns', () => {
  assert.ok(catastrophicShape('(a+)+$'), 'the classic exponential shape');
  assert.ok(catastrophicShape('(a*)*'));
  assert.ok(catastrophicShape('(\\d+){1,}'));
  assert.ok(catastrophicShape('((ab)+c?)+'));
  assert.equal(catastrophicShape('Ultra\\w+'), null);
  assert.equal(catastrophicShape('NEEDLE_(ALPHA|BETA)'), null);
  assert.equal(catastrophicShape('foo.*bar'), null);
  assert.equal(catastrophicShape('[a+]+'), null, 'quantifiers inside a class are atoms');
  assert.equal(catastrophicShape('(abc)+'), null, 'quantified group without inner quantifier is fine');
});

test('SEC-1 — /api/find rejects an exponential regex with 400 bad-regex, bounded (no hang)', async () => {
  const t0 = Date.now();
  const r = await getJson(`${srv.url}/api/find?re=1&q=${encodeURIComponent('(a+)+$')}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'bad-regex');
  assert.ok(Date.now() - t0 < 2000, 'rejected before any scan work');
  // a sane regex still streams
  const ok = await sseCollect(`${srv.url}/api/find?re=1&q=NEEDLE_ALPHA`);
  assert.equal(ok.status, 200);
});

test('COR-5 — a stale cursor emits a problem + error, never a clean done {matches:0}', async () => {
  const root = path.join(os.tmpdir(), `lens-fix-find-${process.pid.toString(36)}`);
  const slug = 'C--find';
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const rel = `${slug}/${id}.jsonl`;
  await fsp.writeFile(path.join(root, slug, `${id}.jsonl`), '{"type":"user","message":{"content":"hay"}}\n');
  const sessions = [{ slug, id, mainRel: rel, files: [rel] }];
  const fileTable = new Map([[rel, { size: 40, mtimeMs: 5 }]]);
  const staleCursor = Buffer.from(JSON.stringify({ k: `${slug}/gone-session`, f: 'gone.jsonl', l: 3, m: 99 }), 'utf8').toString('base64url');
  const events = [];
  await runFind({
    projectsDir: root, sessions, fileTable, q: 'hay', re: false, caseSensitive: false,
    after: staleCursor, scope: { kind: 'store' },
    emit: (ev, d) => events.push({ ev, d }),
  });
  assert.ok(!events.some((e) => e.ev === 'done'), 'no clean done for a scan that skipped everything');
  const err = events.find((e) => e.ev === 'error');
  assert.ok(err, 'error event emitted');
  assert.equal(err.d.code, 'find-cursor-stale');
  assert.ok(events.some((e) => e.ev === 'problem' && e.d.code === 'find-cursor-stale'));
  await fsp.rm(root, { recursive: true, force: true });
});

test('COR-5 — a VALID cursor resumes and completes with a clean done', async () => {
  const root = path.join(os.tmpdir(), `lens-fix-find2-${process.pid.toString(36)}`);
  const slug = 'C--find2';
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const id = 'ffffffff-ffff-4fff-8fff-fffffffffff2';
  const rel = `${slug}/${id}.jsonl`;
  const line = '{"type":"user","message":{"content":"hay"}}\n';
  await fsp.writeFile(path.join(root, slug, `${id}.jsonl`), line + line + line);
  const sessions = [{ slug, id, mainRel: rel, files: [rel] }];
  const fileTable = new Map([[rel, { size: line.length * 3, mtimeMs: 5 }]]);
  const cursor = Buffer.from(JSON.stringify({ k: `${slug}/${id}`, f: rel, l: 1, m: 5 }), 'utf8').toString('base64url');
  const events = [];
  await runFind({
    projectsDir: root, sessions, fileTable, q: 'hay', re: false, caseSensitive: false,
    after: cursor, scope: { kind: 'store' },
    emit: (ev, d) => events.push({ ev, d }),
  });
  const done = events.find((e) => e.ev === 'done');
  assert.ok(done, 'clean done after a resolved resume');
  assert.equal(done.d.matches, 2, 'lines after the cursor only');
  await fsp.rm(root, { recursive: true, force: true });
});

test('COR-21 — a raced-deleted file still advances bytesDone to 100%', async () => {
  const root = path.join(os.tmpdir(), `lens-fix-find3-${process.pid.toString(36)}`);
  const slug = 'C--find3';
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const idA = 'ffffffff-ffff-4fff-8fff-fffffffffff3';
  const idB = 'ffffffff-ffff-4fff-8fff-fffffffffff4';
  const relA = `${slug}/${idA}.jsonl`;
  const relB = `${slug}/${idB}.jsonl`;
  const line = '{"type":"user","message":{"content":"hay"}}\n';
  await fsp.writeFile(path.join(root, slug, `${idA}.jsonl`), line);
  // relB is in the table but NOT on disk (raced deletion)
  const sessions = [
    { slug, id: idA, mainRel: relA, files: [relA] },
    { slug, id: idB, mainRel: relB, files: [relB] },
  ];
  const fileTable = new Map([
    [relA, { size: line.length, mtimeMs: 2 }],
    [relB, { size: 1000, mtimeMs: 1 }],
  ]);
  const events = [];
  await runFind({
    projectsDir: root, sessions, fileTable, q: 'hay', re: false, caseSensitive: false,
    scope: { kind: 'store' },
    emit: (ev, d) => events.push({ ev, d }),
  });
  const progress = events.filter((e) => e.ev === 'progress').at(-1);
  assert.equal(progress.d.bytesDone, progress.d.ofBytes, 'skipped bytes count as done — the bar reaches 100%');
  assert.ok(events.some((e) => e.ev === 'skip' && /unreadable/.test(e.d.reason)));
  await fsp.rm(root, { recursive: true, force: true });
});
