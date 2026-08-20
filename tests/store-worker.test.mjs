// tests/store-worker.test.mjs — the parent↔worker protocol.
//
// scan/parse/ledger/summary are injected as stubs (tests/stubs/store/*) via
// workerData.modules, so this exercises the protocol and the cache logic
// without needing group A/B to exist or a 1.15 GB corpus to walk.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadIndex } from '../server/index-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, '..', 'server', 'indexer.worker.mjs');
const STUBS = path.join(HERE, 'stubs', 'store');

const stubModules = () => ({
  scan: pathToFileURL(path.join(STUBS, 'scan.mjs')).href,
  parse: pathToFileURL(path.join(STUBS, 'parse.mjs')).href,
  ledger: pathToFileURL(path.join(STUBS, 'ledger.mjs')).href,
  summary: pathToFileURL(path.join(STUBS, 'summary.mjs')).href,
  jsonl: pathToFileURL(path.join(STUBS, 'jsonl.mjs')).href,
});

let TMP;
before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-worker-'));
});
after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

let n = 0;
async function scenario(files, { rescanMs = 60000, debounceMs = 10, env = {} } = {}) {
  const root = path.join(TMP, `w${n++}`);
  await fsp.mkdir(root, { recursive: true });
  const worldPath = path.join(root, 'world.json');
  const callsPath = path.join(root, 'calls.log');
  const cacheDir = path.join(root, 'cache');
  const projectsDir = path.join(root, 'projects');
  await fsp.writeFile(worldPath, JSON.stringify({ files }));
  await fsp.writeFile(callsPath, '');

  const inbox = [];
  const waiters = [];
  const worker = new Worker(WORKER, {
    workerData: { modules: stubModules(), rescanMs, debounceMs },
    env: { ...process.env, LENS_TEST_WORLD: worldPath, LENS_TEST_CALLS: callsPath, ...env },
  });
  worker.on('message', (m) => {
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(m)) {
        waiters.splice(i, 1)[0].resolve(m);
      }
    }
  });
  worker.on('error', (e) => {
    for (const w of waiters.splice(0)) w.reject(e);
  });

  const waitFor = (match, ms = 8000) =>
    new Promise((resolve, reject) => {
      const hit = inbox.find(match);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timed out waiting; saw ${JSON.stringify(inbox.map((m) => m.type))}`)), ms);
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });

  return {
    worker,
    inbox,
    waitFor,
    projectsDir,
    cacheDir,
    of: (type) => inbox.filter((m) => m.type === type),
    async setWorld(next) {
      await fsp.writeFile(worldPath, JSON.stringify({ files: next }));
    },
    async calls() {
      return (await fsp.readFile(callsPath, 'utf8')).split('\n').filter(Boolean);
    },
    clear() {
      inbox.length = 0;
    },
    async close() {
      await worker.terminate();
    },
  };
}

const S = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
};

const baseWorld = () => [
  { rel: `proj-a/${S.a}.jsonl`, size: 100, mtimeMs: 1000 },
  { rel: `proj-a/${S.b}.jsonl`, size: 200, mtimeMs: 3000 },
  { rel: `proj-a/${S.b}/subagents/agent-a1111111111111111.jsonl`, size: 50, mtimeMs: 2500 },
  { rel: `proj-b/${S.c}.jsonl`, size: 400, mtimeMs: 2000 },
];

describe('indexer worker protocol', () => {
  test('start → cards + progress → ready, MRU first, index.json written', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());

    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');

    const cards = s.of('card');
    assert.equal(cards.length, 3, 'one card per session');
    assert.deepEqual(
      cards.map((m) => m.card.id),
      [S.b, S.c, S.a],
      'most-recently-modified session first (b=3000, c=2000, a=1000)',
    );
    for (const m of cards) {
      assert.equal(typeof m.card.fingerprint, 'string');
      assert.ok(m.card.fingerprint.length > 0, 'a card is only emitted fully summarised, fingerprint included');
      assert.equal(m.card.state, 'ok');
    }

    const progress = s.of('progress');
    assert.ok(progress.length >= 2, 'progress is reported during the build');
    const last = progress[progress.length - 1];
    assert.equal(last.of, 3);
    assert.equal(last.done, 3);
    assert.equal(last.bytesTotal, 100 + 250 + 400);
    assert.equal(last.bytesDone, last.bytesTotal);

    const ready = s.of('ready')[0];
    assert.equal(ready.of, 3);
    assert.equal(ready.done, 3);
    assert.deepEqual(s.of('problem'), [], 'a clean corpus reports no problems');

    // The debounced writer flushed before ready.
    const idx = await loadIndex(s.cacheDir);
    assert.ok(idx, 'index.json exists after ready');
    assert.equal(idx.cards.size, 3);
    assert.equal(idx.projectsDir, s.projectsDir);
    assert.equal(idx.cards.get(S.b).fingerprint, cards[0].card.fingerprint);
  });

  test('rescan marks a changed session stale and nothing else', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());

    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');
    s.clear();

    // Session a grew on disk (the live-corpus case).
    const next = baseWorld();
    next[0] = { ...next[0], size: 180, mtimeMs: 9000 };
    await s.setWorld(next);

    s.worker.postMessage({ type: 'rescan' });
    const stale = await s.waitFor((m) => m.type === 'stale');
    assert.deepEqual(stale.sessionIds, [S.a]);
    assert.deepEqual(s.of('card'), [], 'a rescan re-renders nothing — it only reports');

    // Reported once, not every tick.
    s.clear();
    s.worker.postMessage({ type: 'rescan' });
    s.worker.postMessage({ type: 'rescan' });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(s.of('stale'), [], 'already-reported staleness is not repeated');
  });

  test('rescan reports a new session and a deleted one', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());
    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');
    s.clear();

    const D = '44444444-4444-4444-8444-444444444444';
    const next = baseWorld().filter((f) => !f.rel.includes(S.c));
    next.push({ rel: `proj-a/${D}.jsonl`, size: 10, mtimeMs: 8000 });
    await s.setWorld(next);

    s.worker.postMessage({ type: 'rescan' });
    const stale = await s.waitFor((m) => m.type === 'stale');
    assert.deepEqual(stale.sessionIds.sort(), [D, S.c].sort(), 'new and vanished sessions are both stale');
  });

  test('the 5s rescan loop runs on its own while the worker is alive', async (t) => {
    const s = await scenario(baseWorld(), { rescanMs: 80 });
    t.after(() => s.close());
    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');
    s.clear();

    const next = baseWorld();
    next[3] = { ...next[3], size: 999, mtimeMs: 9999 };
    await s.setWorld(next);

    const stale = await s.waitFor((m) => m.type === 'stale', 4000);
    assert.deepEqual(stale.sessionIds, [S.c]);
    assert.deepEqual(s.of('card'), [], 'the loop never re-summarises under the reader');
  });

  test('a second start reuses cached cards and re-parses only what changed', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());

    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');
    assert.equal((await s.calls()).filter((l) => l.startsWith('parse')).length, 3);
    s.clear();

    const next = baseWorld();
    next[3] = { ...next[3], size: 777, mtimeMs: 9000 };
    await s.setWorld(next);

    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');

    const parses = (await s.calls()).filter((l) => l.startsWith('parse'));
    assert.equal(parses.length, 4, 'only the changed session was parsed again');
    assert.equal(parses[3], `parse ${S.c}`);
    assert.equal(s.of('card').length, 3, 'but every session still ships a current card');
  });

  test('a FRESH worker reuses the on-disk index — the warm-start path', async (t) => {
    const first = await scenario(baseWorld());
    first.worker.postMessage({ type: 'start', projectsDir: first.projectsDir, cacheDir: first.cacheDir });
    await first.waitFor((m) => m.type === 'ready');
    await first.close();
    const parsedCold = (await first.calls()).filter((l) => l.startsWith('parse')).length;
    assert.equal(parsedCold, 3);

    // Second process, same cache dir and the same world file.
    const second = new Worker(WORKER, {
      workerData: { modules: stubModules(), rescanMs: 60000, debounceMs: 10 },
      env: { ...process.env, LENS_TEST_WORLD: path.join(path.dirname(first.cacheDir), 'world.json'), LENS_TEST_CALLS: path.join(path.dirname(first.cacheDir), 'calls.log') },
    });
    t.after(() => second.terminate());
    const msgs = [];
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ready')), 8000);
      second.on('message', (m) => {
        msgs.push(m);
        if (m.type === 'ready') {
          clearTimeout(timer);
          resolve(m);
        }
      });
      second.on('error', reject);
    });
    second.postMessage({ type: 'start', projectsDir: first.projectsDir, cacheDir: first.cacheDir });
    await ready;

    assert.equal(msgs.filter((m) => m.type === 'card').length, 3, 'all three cards still ship');
    const parsedWarm = (await first.calls()).filter((l) => l.startsWith('parse')).length;
    assert.equal(parsedWarm, 3, 'and not one of them was re-parsed');
  });

  test('reindex ignores fingerprints and rebuilds everything', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());

    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');
    s.clear();

    s.worker.postMessage({ type: 'reindex' });
    await s.waitFor((m) => m.type === 'ready');

    const parses = (await s.calls()).filter((l) => l.startsWith('parse'));
    assert.equal(parses.length, 6, 'all three parsed a second time');
    assert.equal(s.of('card').length, 3);
  });

  test('a session that cannot be summarised yields a Problem and no card', async (t) => {
    const s = await scenario(baseWorld(), { env: { LENS_TEST_THROW_ID: S.c } });
    t.after(() => s.close());

    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    const ready = await s.waitFor((m) => m.type === 'ready');

    const ids = s.of('card').map((m) => m.card.id);
    assert.deepEqual(ids.sort(), [S.a, S.b].sort(), 'the failing session is absent, never partial');
    // R8-PROB-1: a session's problems ride ONE `session-problems` batch per
    // summarise attempt — including the failure case, where no card is ever
    // posted — instead of N individual `problem` appends the parent could
    // never retract. `problem` is now the store/worker-scope channel only.
    const batches = s.of('session-problems');
    const failed = batches.filter((m) => m.id === S.c);
    assert.equal(failed.length, 1, 'exactly one batch for the session that failed');
    assert.equal(failed[0].problems.length, 1);
    assert.equal(failed[0].problems[0].code, 'indexer-crashed');
    assert.equal(failed[0].problems[0].scope, 'session');
    assert.equal(failed[0].problems[0].id, S.c);
    assert.equal(failed[0].problems[0].affects, 'aggregates');
    assert.deepEqual(s.of('problem'), [], 'no session-scope record on the append channel');
    for (const ok of [S.a, S.b]) {
      const b = batches.filter((m) => m.id === ok);
      assert.equal(b.length, 1, `a batch is posted for ${ok} too — the empty case is the retraction`);
      assert.deepEqual(b[0].problems, [], 'and it is empty, because that session has none');
    }
    assert.equal(ready.of, 3, 'the denominator still counts the session that failed');
    assert.equal(ready.done, 3);

    const idx = await loadIndex(s.cacheDir);
    assert.equal(idx.cards.size, 2);
  });

  test('vanished sessions are pruned from the persisted index', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());
    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');
    s.clear();

    await s.setWorld(baseWorld().filter((f) => !f.rel.includes(S.a)));
    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');

    const idx = await loadIndex(s.cacheDir);
    assert.deepEqual(Array.from(idx.cards.keys()).sort(), [S.b, S.c].sort());
  });

  test('the worker hands parseSession absolute, native-separator paths', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());
    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');

    const abs = (await s.calls()).filter((l) => l.startsWith('abs '));
    assert.equal(abs.length, 3);
    for (const line of abs) {
      const p = line.split(' ').slice(2).join(' ');
      assert.ok(path.isAbsolute(p), `${p} must be absolute — everything handed to fs is`);
      assert.ok(p.startsWith(s.projectsDir), `${p} must resolve inside projectsDir`);
    }
    const bLine = abs.find((l) => l.includes(S.b));
    assert.ok(bLine.endsWith(path.join(s.projectsDir, 'proj-a', `${S.b}.jsonl`)));
    assert.deepEqual(s.of('problem'), []);
  });

  test('start without a projectsDir reports a Problem and still answers ready', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());
    s.worker.postMessage({ type: 'start', projectsDir: null, cacheDir: s.cacheDir });
    const ready = await s.waitFor((m) => m.type === 'ready');
    assert.equal(ready.ok, false);
    assert.equal(s.of('problem')[0].problem.code, 'dir-unreadable');
  });

  test('unknown message types are ignored, not fatal', async (t) => {
    const s = await scenario(baseWorld());
    t.after(() => s.close());
    s.worker.postMessage({ type: 'start', projectsDir: s.projectsDir, cacheDir: s.cacheDir });
    await s.waitFor((m) => m.type === 'ready');
    s.clear();
    s.worker.postMessage({ type: 'not-a-real-message' });
    s.worker.postMessage({ type: 'rescan' });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(s.of('problem'), []);
  });
});
