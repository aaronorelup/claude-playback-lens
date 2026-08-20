// tests/fixes-round9.test.mjs — named regressions for the round-9 fix pass.
// One group per validated finding id:
//
//   R9-D1 (lens.mjs — worker respawn)
//       spawnWorker() overwrote S.worker with no stop, and the ONLY production
//       terminate() was in close(), which terminates the currently tracked
//       worker alone. reindex() routes to reviveWorker() -> spawnWorker()
//       directly whenever the worker is down, and S.alive flips true only on
//       the replacement's FIRST posted message (~175 ms on the real store:
//       thread boot + ESM load + a full stat walk all precede it). Any second
//       POST /api/reindex inside that window — a double-click, two open tabs,
//       or one click during a backoff respawn — spawned another worker and
//       orphaned the previous one. The orphan is not idle: it completes a whole
//       independent build and writes its own index.json through its own writer,
//       and the losing renames surfaced as `cache-write-failed` ON THE TRACKED
//       WORKER — the app reporting a cache anomaly whose only cause was its own
//       leaked threads, in the one channel this app exists to keep honest.
//
//   R9-F1 (server/index-store.mjs — atomicWriteFile / loadIndexVerbose)
//       The intermediate file was a fixed `index.json.tmp`. Two processes
//       sharing one cache dir — the DEFAULT for two instances of one install,
//       since the already-running guard is keyed on port alone — both opened
//       that path with 'w' and interleaved, so the winning rename published a
//       SPLICED file (invalid JSON at rest in the destination, which the next
//       reader deletes and discloses as corrupt) while the losing renames
//       failed ENOENT — not a RETRYABLE_CODE, so the ladder never engaged, and
//       every one of them raised a `cache-write-failed` Problem on a run where
//       nothing was wrong. Measured here at 400 writes per arm, two real OS
//       processes: fixed tmp -> 55 and 119 failures (14–30%), nearly all
//       ENOENT; unique tmp -> 0–2, all EPERM (the win32 dest-side lock race,
//       which the retry ladder is for and which is honestly disclosed).
//       ensureCacheDir already pid-suffixed its own writability probe: the
//       module always knew two processes can share the dir.
//
//   R9-F2 (server/find.mjs — REGEX_LINE_CAP)
//       runFind's per-line loop did `if (!match1(stripped)) continue;` BEFORE
//       the per-block pass, and match1 truncates regex input at 256 KiB. A line
//       whose EARLY block is itself oversized therefore ends the searched
//       prefix inside that block, so a real match sitting in a LATER,
//       individually small block was never looked at — substring search (which
//       is uncapped) found it, regex reported matches:0, and the skip note read
//       as "searched a truncated prefix" rather than "may have missed matches".
//       The count in that note was wrong too: it incremented per match1() call,
//       so one physical oversized line was disclosed as two.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createIndexState } from '../lens.mjs';
import {
  atomicWriteFile, loadIndexVerbose, indexPath, sweepStaleTmpFiles,
  TMP_SWEEP_MAX_AGE_MS, INDEX_VERSION,
} from '../server/index-store.mjs';
import { runFind, REGEX_LINE_CAP } from '../server/find.mjs';
import { saveConfig } from '../server/config.mjs';
import { PROBLEM_CODES } from '../server/errors.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import * as store from '../server/index-store.mjs';
import * as lru from '../server/lru.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 20000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

/* ================================================================== R9-D1 */

describe('R9-D1 — a worker we stop tracking is a worker we stop', () => {
  const STORE = path.join(HERE, 'fixtures', 'reader', 'store');
  let cacheDir;

  before(async () => { cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r9-d1-')); });
  after(async () => { await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {}); });

  test('R9-D1 — four back-to-back reindex() calls leave NO un-terminated worker, and no false cache-write-failed', async () => {
    // Real Worker threads against the real fixture store. The backoff is parked
    // at 10 minutes so the scheduled respawn cannot fire inside the window:
    // every worker observed here is one a reindex() asked for.
    const idx = createIndexState({
      projectsDir: STORE,
      cacheDir,
      mods: { pricing, ledger, jsonl, parse, scan, summary, store, lru },
      workerBackoffMs: [600000],
      crashWindowMs: 60000,
      crashCap: 5,
    });
    const S = idx._test.state;
    // Keyed by the Worker OBJECT: Node resets threadId to -1 once a thread is
    // gone, which is exactly the population this test is about.
    const seen = new Map(); // Worker -> {threadId, msgs, exited}
    const spawned = [];
    const watch = (w) => {
      if (!w || spawned.includes(w)) return;
      spawned.push(w);
      const rec = { threadId: w.threadId, msgs: [], exited: false };
      seen.set(w, rec);
      // Listeners attached DIRECTLY to the thread, independent of lens.mjs's own
      // `S.worker !== w` guard — an orphan's activity has to stay observable.
      w.on('message', (m) => rec.msgs.push(m && m.type));
      w.on('exit', () => { rec.exited = true; });
    };
    const idsOf = (list) => list.map((w) => seen.get(w).threadId).join(', ');

    try {
      await idx.start();
      assert.equal(S.hasWorker, true, 'worker mode (the fallback indexer is a different code path)');
      assert.ok(await waitFor(() => S.alive && S.state === 'ready', 30000), 'the booted worker finished a build');
      const booted = S.worker;
      watch(booted);

      // Force it down the way a real crash does.
      await booted.terminate();
      assert.ok(await waitFor(() => !S.alive), 'the parent noticed the death');
      assert.equal(S.workerExits, 1);

      // Four rapid reindex() calls === four rapid POST /api/reindex. Each lands
      // while the previous replacement has not spoken yet (S.alive === false),
      // so each spawns another worker.
      for (let i = 0; i < 4; i += 1) {
        await idx.reindex();
        watch(S.worker);
      }
      assert.equal(spawned.length, 5, 'the booted worker plus one replacement per reindex()');

      const tracked = S.worker;
      const orphans = spawned.filter((w) => w !== tracked && w !== booted);
      assert.equal(orphans.length, 3, 'N reindex() calls supersede N-1 workers');

      // THE FIX: superseded means stopped. Before it, these three ran to
      // completion — a full independent build each — and were still running
      // after close().
      const allGone = await waitFor(() => orphans.every((w) => seen.get(w).exited), 20000);
      assert.ok(allGone, `superseded workers must be terminated, not merely forgotten (still running: ${
        idsOf(orphans.filter((w) => !seen.get(w).exited))})`);
      for (const w of orphans) {
        assert.deepEqual(seen.get(w).msgs, [],
          `orphan ${seen.get(w).threadId} was stopped before it could post anything (it used to post progress/card/ready and write its own index.json)`);
      }

      // The tracked worker finishes normally, and the census is unchanged: the
      // deaths WE caused fail the `S.worker !== w` guard, so they can neither
      // inflate workerExits nor trigger another respawn.
      assert.ok(await waitFor(() => S.alive && S.state === 'ready', 30000), 'the surviving worker completed its build');
      assert.equal(S.workerExits, 1, 'only the crash we staged is counted');
      const problems = idx.problems();
      const exit = problems.find((p) => p.code === 'worker-exit');
      assert.ok(exit, 'the staged crash is still disclosed');
      assert.equal(exit.count, 1, 'one exit, counted once');
      assert.deepEqual(problems.filter((p) => p.code === 'cache-write-failed'), [],
        'no cache-write-failed: the only thing that ever raced index.json here was the app\'s own leaked threads');

      await idx.close();
      assert.ok(await waitFor(() => spawned.every((w) => seen.get(w).exited), 15000),
        `close() leaves nothing running (still up: ${idsOf(spawned.filter((w) => !seen.get(w).exited))})`);
    } finally {
      for (const w of spawned) { try { await w.terminate(); } catch { /* already gone */ } }
      try { await idx.close(); } catch { /* already closed */ }
    }
  });

  test('R9-D1 — spawnWorker assigns BEFORE it terminates, so a superseded death is never news', async () => {
    // Order matters for more than tidiness: if the terminate ran first, the
    // superseded worker's `exit` could reach onWorkerGone while S.worker still
    // pointed at it, inflating S.workerExits and scheduling a respawn for a
    // death we caused. Node's async `exit` makes the other order happen to work
    // today; nothing should depend on that.
    const src = await fsp.readFile(path.join(HERE, '..', 'lens.mjs'), 'utf8');
    const body = src.slice(src.indexOf('function spawnWorker()'), src.indexOf('function onWorkerGone'));
    const assignAt = body.indexOf('S.worker = w;');
    const terminateAt = body.indexOf('prev.terminate()');
    assert.ok(assignAt > 0, 'spawnWorker still assigns S.worker');
    assert.ok(terminateAt > 0, 'spawnWorker terminates the worker it supersedes');
    assert.ok(assignAt < terminateAt, 'assign first, then terminate');
  });
});

/* ================================================================== R9-F1 */

describe('R9-F1 — one cache dir, two processes: the intermediate file is per-write', () => {
  const CHILD = path.join(HERE, 'fixtures', 'round9', 'cache-writer.mjs');
  const COUNT = 200;
  const PAD = 20000; // ~20 KB payload per write
  let root;

  before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r9-f1-')); });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }).catch(() => {}); });

  /** Two real OS processes hammering one index.json, with a reader in the middle. */
  async function storm(name, mode) {
    const cacheDir = path.join(root, name);
    await fsp.mkdir(cacheDir, { recursive: true });
    const runOne = (tag) => new Promise((resolve, reject) => {
      const outFile = path.join(cacheDir, `${tag}.result.json`);
      const argv = [CHILD, cacheDir, tag, String(COUNT), String(PAD), outFile];
      if (mode) argv.push(mode);
      const child = spawn(process.execPath, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (b) => { err += b; });
      child.on('error', reject);
      child.on('exit', async (code) => {
        if (code !== 0) return reject(new Error(`writer ${tag} exited ${code}: ${err}`));
        try { resolve(JSON.parse(await fsp.readFile(outFile, 'utf8'))); } catch (e) { reject(e); }
      });
    });

    const both = Promise.all([runOne('A'), runOne('B')]);
    let running = true;
    both.then(() => { running = false; }, () => { running = false; });

    // The app's own real reader, on the same file, throughout.
    const reads = { total: 0, ok: 0, byCode: {}, deletions: 0 };
    while (running) {
      const before = fs.existsSync(indexPath(cacheDir));
      const res = await loadIndexVerbose(cacheDir);
      reads.total += 1;
      if (res.index) reads.ok += 1;
      if (res.problem) {
        reads.byCode[res.problem.code] = (reads.byCode[res.problem.code] || 0) + 1;
        if (before && !fs.existsSync(indexPath(cacheDir))) reads.deletions += 1;
      }
      await sleep(3);
    }
    const [a, b] = await both;
    return { cacheDir, a, b, reads };
  }

  test('R9-F1 — two real processes writing one index.json: no shared intermediate, no ENOENT storm, no torn read', async () => {
    const { cacheDir, a, b, reads } = await storm('unique', '');

    // The fix itself, stated deterministically: no two writes ever shared an
    // intermediate path — not within a process, not across the two.
    assert.equal(a.distinctTmp, COUNT, 'writer A used a distinct tmp file for every write');
    assert.equal(b.distinctTmp, COUNT, 'writer B used a distinct tmp file for every write');
    assert.notEqual(a.pid, b.pid, 'these really are two OS processes');
    assert.notEqual(a.firstTmp, b.firstTmp, 'and they never met on one tmp path');
    for (const p of [a.firstTmp, b.firstTmp]) {
      assert.match(path.basename(p), /^index\.json\.tmp-[0-9a-z]+-[0-9a-f]{8}$/, 'tmp name carries pid + randomness');
    }

    // Consequence 1: the write-failure storm is gone. Fixed-tmp control arm
    // below measures 14–30% here; the residual is the win32 dest-side lock
    // race (EPERM), which the retry ladder exists for.
    const writes = a.ok + a.fail + b.ok + b.fail;
    assert.equal(writes, COUNT * 2);
    const failRate = (a.fail + b.fail) / writes;
    assert.ok(failRate <= 0.05,
      `write failures must be a rounding error, not a storm — got ${a.fail + b.fail}/${writes} ${J({ A: a.codes, B: b.codes })}`);

    // Consequence 2: the reader never saw a torn file, so it never deleted a
    // healthy one and never disclosed a corruption that did not exist.
    assert.ok(reads.total > 10, `the reader really ran alongside the writers (${reads.total} reads)`);
    assert.equal(reads.byCode['cache-corrupt'] ?? 0, 0, 'no cache-corrupt across the whole storm');
    assert.equal(reads.byCode['cache-busy'] ?? 0, 0, 'and nothing even changed under a read');
    assert.equal(reads.deletions, 0, 'the shared cache file was never deleted');

    const final = await loadIndexVerbose(cacheDir);
    assert.ok(final.index, 'and what is left on disk is a valid index');
    assert.equal(final.index.indexVersion, INDEX_VERSION);
    const left = (await fsp.readdir(cacheDir)).filter((n) => n.includes('.tmp'));
    assert.deepEqual(left, [], 'no intermediate file survives a completed storm');
  });

  test('R9-F1 — control: the OLD fixed index.json.tmp puts both processes on one path (the collision itself)', async () => {
    // Same storm, same code, only tmpSuffix reverted to the pre-fix '.tmp'.
    // Asserted on the deterministic half — that the two processes share one
    // intermediate — because the failure count it produces is a race. Measured
    // on this machine: 55/400 and 119/400 failures, ~all ENOENT, versus 0–2/400
    // for the unique-name arm above.
    const { a, b } = await storm('fixed', 'fixed-tmp');
    assert.equal(a.distinctTmp, 1, 'every write of A reused one path');
    assert.equal(b.distinctTmp, 1, 'every write of B reused one path');
    assert.equal(a.firstTmp, b.firstTmp, 'and it is the SAME path in both processes — two writers, one open("w")');
    assert.equal(path.basename(a.firstTmp), 'index.json.tmp');
  });

  test('R9-F1 — concurrent writers in one process also get their own intermediate', async () => {
    const dir = path.join(root, 'inproc');
    const dest = path.join(dir, 'index.json');
    const [r1, r2, r3] = await Promise.all([
      atomicWriteFile(dest, J({ indexVersion: INDEX_VERSION, cards: [{ id: 'a' }] })),
      atomicWriteFile(dest, J({ indexVersion: INDEX_VERSION, cards: [{ id: 'b' }] })),
      atomicWriteFile(dest, J({ indexVersion: INDEX_VERSION, cards: [{ id: 'c' }] })),
    ]);
    assert.deepEqual([r1.ok, r2.ok, r3.ok], [true, true, true]);
    assert.equal(new Set([r1.tmpPath, r2.tmpPath, r3.tmpPath]).size, 3, 'three writes, three intermediates');
    const idx = await loadIndexVerbose(dir);
    assert.ok(idx.index, 'and the file that landed is one whole payload, never a splice');
    assert.equal(idx.index.cards.size, 1);
  });
});

describe('R9-F1 — the litter unique names create is swept, and only the litter', () => {
  let dir;
  before(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r9-sweep-')); });
  after(async () => { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); });

  test('R9-F1 — sweepStaleTmpFiles drops aged orphans, keeps live writes, the index and the legacy path', async () => {
    const old = Date.now() - (TMP_SWEEP_MAX_AGE_MS + 60000);
    const write = async (name, mtime) => {
      const p = path.join(dir, name);
      await fsp.writeFile(p, 'x', 'utf8');
      if (mtime) await fsp.utimes(p, new Date(mtime), new Date(mtime));
      return p;
    };
    await write('index.json', old);                     // the cache itself
    await write('index.json.tmp-abc-11111111', old);    // a crashed run's orphan
    await write('index.json.tmp-def-22222222', old);    // another
    await write('index.json.tmp-ghi-33333333');         // somebody's live write
    await write('index.json.tmp', old);                 // an older build's fixed path
    await write('other.json.tmp-xyz-44444444', old);    // not ours

    const res = await sweepStaleTmpFiles(dir);
    assert.deepEqual(res.removed.sort(), ['index.json.tmp-abc-11111111', 'index.json.tmp-def-22222222']);
    const left = (await fsp.readdir(dir)).sort();
    assert.deepEqual(left, [
      'index.json',
      'index.json.tmp',                  // may be a live write by an older build
      'index.json.tmp-ghi-33333333',     // fresh: someone is writing it right now
      'other.json.tmp-xyz-44444444',     // a different file's business
    ]);
    assert.equal(res.error, null);

    // A missing directory is not an exception — this runs at boot.
    const gone = await sweepStaleTmpFiles(path.join(dir, 'nope'));
    assert.deepEqual(gone.removed, []);
    assert.ok(gone.error, 'the failure is reported, never thrown');
  });

  test('R9-F1 — saving config sweeps config.json orphans too (every atomicWriteFile caller litters now)', async () => {
    const appDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r9-cfg-'));
    try {
      const orphan = path.join(appDir, 'config.json.tmp-old-12345678');
      await fsp.writeFile(orphan, 'half a write', 'utf8');
      const old = new Date(Date.now() - (TMP_SWEEP_MAX_AGE_MS + 60000));
      await fsp.utimes(orphan, old, old);
      const fresh = path.join(appDir, 'config.json.tmp-new-87654321');
      await fsp.writeFile(fresh, 'in flight', 'utf8');

      const res = await saveConfig({ projectsDir: 'C:\\r9\\projects' }, {}, appDir);
      assert.equal(res.ok, true);
      assert.equal(fs.existsSync(orphan), false, 'the aged orphan is gone');
      assert.equal(fs.existsSync(fresh), true, 'a live write is not');
      assert.ok(fs.existsSync(path.join(appDir, 'config.json')), 'and the config itself landed');
    } finally {
      await fsp.rm(appDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('R9-F1 — the worker sweeps its cache dir at boot', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r9-wsweep-'));
    const cacheDir = path.join(root, 'cache');
    const projectsDir = path.join(root, 'projects');
    const worldPath = path.join(root, 'world.json');
    const callsPath = path.join(root, 'calls.log');
    const STUBS = path.join(HERE, 'stubs', 'store');
    const SID = '99000000-0000-4000-8000-0000000000d1';
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(worldPath, J({ files: [{ rel: `proj-a/${SID}.jsonl`, size: 100, mtimeMs: 1000 }] }));
    await fsp.writeFile(callsPath, '');
    const orphan = path.join(cacheDir, 'index.json.tmp-zzz-99999999');
    await fsp.writeFile(orphan, 'half a write', 'utf8');
    const old = new Date(Date.now() - (TMP_SWEEP_MAX_AGE_MS + 60000));
    await fsp.utimes(orphan, old, old);

    const worker = new Worker(path.join(HERE, '..', 'server', 'indexer.worker.mjs'), {
      workerData: {
        modules: {
          scan: pathToFileURL(path.join(STUBS, 'scan.mjs')).href,
          parse: pathToFileURL(path.join(STUBS, 'parse.mjs')).href,
          ledger: pathToFileURL(path.join(STUBS, 'ledger.mjs')).href,
          summary: pathToFileURL(path.join(STUBS, 'summary.mjs')).href,
          jsonl: pathToFileURL(path.join(STUBS, 'jsonl.mjs')).href,
        },
        rescanMs: 60000, debounceMs: 10,
      },
      env: { ...process.env, LENS_TEST_WORLD: worldPath, LENS_TEST_CALLS: callsPath },
    });
    try {
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no ready')), 15000);
        worker.on('message', (m) => { if (m.type === 'ready') { clearTimeout(timer); resolve(m); } });
        worker.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      worker.postMessage({ type: 'start', projectsDir, cacheDir });
      await ready;
      assert.equal(fs.existsSync(orphan), false, 'a crashed run\'s intermediate does not live forever');
      assert.ok(fs.existsSync(indexPath(cacheDir)), 'and the build still wrote its own index');
    } finally {
      await worker.terminate();
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('R9-F1 — deleting the cache is gated on evidence', () => {
  let dir;
  before(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r9-busy-')); });
  after(async () => { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); });

  // The rename window is not reachable on demand against a real filesystem —
  // with unique tmp names the destination is only ever replaced by one atomic
  // rename, which is the point of the fix — so this drives loadIndexVerbose's
  // fs seam to simulate it: the read returns torn bytes and the file's identity
  // changes underneath, exactly as a writer's rename would leave it.
  const changingFs = (real, file) => {
    let stats = 0;
    return {
      ...real,
      async stat(p) {
        if (path.resolve(p) !== path.resolve(file)) return real.stat(p);
        stats += 1;
        return { size: stats === 1 ? 10 : 4096, mtimeMs: stats === 1 ? 1000 : 2000, ino: stats, isFile: () => true };
      },
      async readFile() { return '{"indexVersion":5,"cards":[{"id":"a"}]}{"indexVersion"'; },
      async unlink(p) { throw new Error(`must not delete ${p}`); },
    };
  };

  test('R9-F1 — a cache file that CHANGED under the read is kept and disclosed as cache-busy, never deleted as corrupt', async () => {
    const file = indexPath(dir);
    await fsp.writeFile(file, J({ indexVersion: INDEX_VERSION, cards: [{ id: 'healthy' }] }), 'utf8');

    const { index, problem } = await loadIndexVerbose(dir, { fs: changingFs(fsp, file) });
    assert.equal(index, null, 'the torn bytes are not served');
    assert.equal(problem.code, 'cache-busy');
    assert.equal(problem.severity, 'note');
    assert.equal(problem.scope, 'store');
    assert.equal(problem.affects, 'nothing', 'no figure we serve came from it');
    assert.match(problem.message, /LEFT IN PLACE/, 'the note says what was NOT done, because that is the part that used to be a lie');
    assert.match(problem.message, /another process is writing this cache directory/);
    assert.ok(PROBLEM_CODES.has('cache-busy'), 'the code is registered, not ad-hoc');

    // The file itself: still there, still healthy.
    const after = await loadIndexVerbose(dir);
    assert.ok(after.index, 'a file that was fine all along survived the diagnosis');
    assert.equal(after.problem, null);
    assert.deepEqual([...after.index.cards.keys()], ['healthy']);
  });

  test('R9-F1 — a file that did NOT change is still deleted and disclosed as cache-corrupt (the guard is not a licence to keep garbage)', async () => {
    const d2 = path.join(dir, 'stable');
    await fsp.mkdir(d2, { recursive: true });
    await fsp.writeFile(indexPath(d2), 'not json at all', 'utf8');
    const { index, problem } = await loadIndexVerbose(d2);
    assert.equal(index, null);
    assert.equal(problem.code, 'cache-corrupt');
    assert.match(problem.message, /deleted and will be rebuilt/);
    await assert.rejects(fsp.stat(indexPath(d2)), (e) => e.code === 'ENOENT', 'genuinely corrupt still means deleted');
  });
});

/* ================================================================== R9-F2 */

describe('R9-F2 — the regex line cap truncates a LINE, and must not blind the blocks inside it', () => {
  const SLUG = 'C--r9-find';
  const SID = '99000000-0000-4000-8000-0000000000f2';
  const NEEDLE = 'FINDME_REGEX_TARGET';
  const FILLER = 'X'.repeat(300000); // block 0: past the 256 KiB cap on its own
  let root, fileTable, sessions;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r9-find-'));
    const dir = path.join(root, SLUG);
    await fsp.mkdir(dir, { recursive: true });

    // Line 1 — ordinary size. Carries the metadata a match can only ever
    // resolve at LINE level: cwd, gitBranch, the session uuid, and a tool's
    // `name` (blockTexts yields tool_use.input, never the name).
    const normal = J({
      parentUuid: null, isSidechain: false, type: 'assistant', uuid: 'MARKERUUID-0001',
      timestamp: '2026-08-01T10:00:00.000Z', sessionId: SID,
      cwd: 'C:\\r9\\MARKERCWD', gitBranch: 'MARKERBRANCH',
      message: {
        id: 'msg_R9F2a', model: 'claude-fable-5', type: 'message', role: 'assistant',
        content: [
          { type: 'text', text: 'a perfectly ordinary line' },
          { type: 'tool_use', id: 'toolu_r9', name: 'MARKERTOOLNAME', input: { path: 'MARKERINPUT' } },
        ],
      },
    });

    // Line 2 — one oversized block followed by a tiny one holding the needle.
    const oversized = J({
      parentUuid: null, isSidechain: false, type: 'assistant', uuid: 'MARKERUUID-0002',
      timestamp: '2026-08-01T10:00:10.000Z', sessionId: SID,
      cwd: 'C:\\r9\\MARKERCWD', gitBranch: 'MARKERBRANCH',
      message: {
        id: 'msg_R9F2b', model: 'claude-fable-5', type: 'message', role: 'assistant',
        content: [
          { type: 'text', text: FILLER },
          { type: 'text', text: `the tail block holds ${NEEDLE} and is 70-odd bytes long` },
        ],
      },
    });

    await fsp.writeFile(path.join(dir, `${SID}.jsonl`), `${normal}\n${oversized}\n`, 'utf8');
    fileTable = await scan.scanStore(root);
    sessions = scan.groupSessions(fileTable).sessions;
    assert.equal(sessions.length, 1);
  });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }).catch(() => {}); });

  const find = async (q, re, caseSensitive = false) => {
    const events = [];
    await runFind({
      projectsDir: root, fileTable, sessions, q, re, caseSensitive,
      emit: (type, payload) => events.push({ type, payload }),
    });
    return {
      events,
      matches: events.filter((e) => e.type === 'match').map((e) => e.payload),
      done: events.filter((e) => e.type === 'done').map((e) => e.payload)[0],
      truncSkip: events.filter((e) => e.type === 'skip' && /regex-matched on their first/.test(e.payload.reason)).map((e) => e.payload),
    };
  };

  test('R9-F2 — a match in a small in-bounds block is FOUND even though a sibling block busts the cap', async () => {
    const sub = await find(NEEDLE, false);
    assert.equal(sub.matches.length, 1, 'substring search is uncapped and always found this');
    assert.equal(sub.matches[0].bi, '1');
    assert.equal(sub.truncSkip.length, 0, 'and it truncates nothing, so it discloses nothing');

    const rx = await find(NEEDLE, true);
    assert.equal(rx.matches.length, 1, 'regex used to report matches:0 for the identical needle');
    assert.equal(rx.matches[0].bi, '1', 'and it resolves to the real block, not the line');
    assert.equal(rx.matches[0].line, 2);
    assert.match(rx.matches[0].ctx, /FINDME_REGEX_TARGET/);
    assert.equal(rx.done.matches, 1, 'done reports a number that is now true');
  });

  test('R9-F2 — line-level metadata still matches: the rescue pass is additive, not a replacement', async () => {
    // blockTexts() yields block bodies only. Leading with it — the finder's
    // original proposal — would have silently stopped matching every one of
    // these, which is a worse regression than the bug.
    for (const [q, line] of [['MARKERCWD', 1], ['MARKERBRANCH', 1], ['MARKERUUID-0001', 1], ['MARKERTOOLNAME', 1]]) {
      const r = await find(q, true);
      assert.ok(r.matches.length >= 1, `${q} must still match somewhere`);
      const first = r.matches.find((m) => m.line === line);
      assert.ok(first, `${q} matches on line ${line}`);
      assert.equal(first.bi, null, `${q} lives in the envelope, so its address is the LINE — never a fabricated block index`);
    }
    // A tool_use input IS a block body, and still resolves to one.
    const input = await find('MARKERINPUT', true);
    assert.equal(input.matches[0].bi, '1');
  });

  test('R9-F2 — one physical oversized line is disclosed as one, not two', async () => {
    // The needle inside the early filler block is in bounds, so the line-level
    // match succeeds and the per-block pass re-searches the same line. The
    // tally used to increment inside makeMatcher, once per call: 2 for 1 line.
    const inBounds = await find('XXXXXXXXXX', true);
    assert.equal(inBounds.matches.length, 1);
    assert.equal(inBounds.matches[0].bi, '0');
    assert.equal(inBounds.truncSkip.length, 1);
    assert.match(inBounds.truncSkip[0].reason, /^1 line\(s\) longer than/, 'one physical line, counted once');

    // Same count when nothing matches at all: the corpus fact does not depend
    // on how many times the matcher was called.
    const miss = await find('NOTHING_MATCHES_THIS_ANYWHERE', true);
    assert.equal(miss.done.matches, 0);
    assert.equal(miss.truncSkip.length, 1);
    assert.match(miss.truncSkip[0].reason, /^1 line\(s\) longer than/);
  });

  test('R9-F2 — the disclosure says matches MAY HAVE BEEN MISSED, not merely that fidelity was lower', async () => {
    const r = await find(NEEDLE, true);
    assert.equal(r.truncSkip.length, 1);
    const reason = r.truncSkip[0].reason;
    assert.match(reason, /MAY HOLD MATCHES THIS SCAN DID NOT FIND/,
      'two gaps survive the rescue pass — the truncated remainder of the envelope, and a block that is itself oversized');
    assert.match(reason, new RegExp(String(REGEX_LINE_CAP)), 'and it still names the bound');
    assert.equal(r.truncSkip[0].bytes, 0, 'no bytes were skipped — they were read, just not searched');
  });

  test('R9-F2 — a substring scan never claims a truncation it did not perform', async () => {
    const r = await find('XXXXXXXXXX', false);
    assert.equal(r.matches.length, 1);
    assert.equal(r.truncSkip.length, 0, 'the cap is a regex bound only');
    assert.equal(r.done.matches, 1);
  });
});
