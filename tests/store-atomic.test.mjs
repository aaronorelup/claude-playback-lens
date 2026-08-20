// tests/store-atomic.test.mjs — the write discipline the whole cache rests on.
//
// The EPERM path is simulated with an fs shim rather than by holding a real
// Windows handle: Node opens files with FILE_SHARE_DELETE, so a real open
// handle does NOT reliably block a rename, which would make the test pass for
// the wrong reason. The shim reproduces exactly the failure mode SPEC §9
// describes (a scanner holding the destination) and does it deterministically.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  atomicWriteFile,
  loadIndex,
  loadIndexVerbose,
  createIndexWriter,
  indexPath,
  INDEX_VERSION,
  cacheDirCandidates,
  resolveCacheDir,
  ensureCacheDir,
} from '../server/index-store.mjs';

let TMP;

before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-atomic-'));
});
after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const freshDir = async () => {
  const d = path.join(TMP, `d${n++}`);
  await fsp.mkdir(d, { recursive: true });
  return d;
};

function errWith(code) {
  return Object.assign(new Error(code), { code });
}

/** fs shim: rename fails with `code` for the first `failures` calls. */
function flakyRename(code, failures) {
  let seen = 0;
  return {
    ...fsp,
    async rename(a, b) {
      if (seen < failures) {
        seen += 1;
        throw errWith(code);
      }
      return fsp.rename(a, b);
    },
    get renameAttempts() {
      return seen;
    },
  };
}

/** fs shim: rename fails with EPERM until unlink(dest) is called — the win32 lock. */
function lockedUntilUnlink(destPath) {
  const st = { locked: true, renames: 0, unlinkedDest: false };
  return {
    shim: {
      ...fsp,
      async rename(a, b) {
        st.renames += 1;
        if (st.locked && path.resolve(b) === path.resolve(destPath)) throw errWith('EPERM');
        return fsp.rename(a, b);
      },
      async unlink(p) {
        if (path.resolve(p) === path.resolve(destPath)) {
          st.locked = false;
          st.unlinkedDest = true;
          return fsp.unlink(p).catch(() => {});
        }
        return fsp.unlink(p);
      },
    },
    st,
  };
}

describe('atomicWriteFile', () => {
  test('happy path: content lands, no .tmp left behind', async () => {
    const dir = await freshDir();
    const dest = path.join(dir, 'index.json');
    const res = await atomicWriteFile(dest, '{"hello":1}');
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 1);
    assert.equal(res.unlinkedDest, false);
    assert.equal(await fsp.readFile(dest, 'utf8'), '{"hello":1}');
    await assert.rejects(fsp.stat(dest + '.tmp'), (e) => e.code === 'ENOENT');
  });

  test('creates the destination directory if absent', async () => {
    const dest = path.join(await freshDir(), 'nested', 'deeper', 'index.json');
    const res = await atomicWriteFile(dest, 'x');
    assert.equal(res.ok, true);
    assert.equal(await fsp.readFile(dest, 'utf8'), 'x');
  });

  test('overwrites an existing destination', async () => {
    const dest = path.join(await freshDir(), 'index.json');
    await atomicWriteFile(dest, 'old');
    await atomicWriteFile(dest, 'new');
    assert.equal(await fsp.readFile(dest, 'utf8'), 'new');
  });

  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    test(`retries a ${code} rename and succeeds`, async () => {
      const dest = path.join(await freshDir(), 'index.json');
      const shim = flakyRename(code, 2);
      const t0 = Date.now();
      const res = await atomicWriteFile(dest, 'retried', { fs: shim, backoffMs: 20 });
      assert.equal(res.ok, true, `${code} should have been retried`);
      assert.equal(res.attempts, 3, 'two failures then success');
      assert.ok(Date.now() - t0 >= 30, 'backoff was actually awaited');
      assert.equal(await fsp.readFile(dest, 'utf8'), 'retried');
    });
  }

  test('after 3 retries, falls back to unlink(dest) + rename', async () => {
    const dir = await freshDir();
    const dest = path.join(dir, 'index.json');
    await fsp.writeFile(dest, 'stale');
    const { shim, st } = lockedUntilUnlink(dest);
    const res = await atomicWriteFile(dest, 'fresh', { fs: shim, backoffMs: 5 });
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 4, 'initial attempt + 3 retries');
    assert.equal(res.unlinkedDest, true);
    assert.equal(st.unlinkedDest, true);
    assert.equal(await fsp.readFile(dest, 'utf8'), 'fresh');
  });

  test('final failure returns a cache-write-failed Problem and never throws', async () => {
    const dir = await freshDir();
    const dest = path.join(dir, 'index.json');
    await fsp.writeFile(dest, 'stale');
    const shim = {
      ...fsp,
      async rename() {
        throw errWith('EPERM');
      },
      async unlink(p) {
        if (path.resolve(p) === path.resolve(dest)) throw errWith('EPERM');
        return fsp.unlink(p);
      },
    };
    const res = await atomicWriteFile(dest, 'never', { fs: shim, backoffMs: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'EPERM');
    assert.equal(res.problem.code, 'cache-write-failed');
    assert.equal(res.problem.severity, 'warning');
    assert.equal(res.problem.affects, 'nothing', 'a failed cache write does not change any number we serve');
    assert.equal(await fsp.readFile(dest, 'utf8'), 'stale', 'the old good file survives');
  });

  test('a non-lock error is not retried and does not delete the destination', async () => {
    const dir = await freshDir();
    const dest = path.join(dir, 'index.json');
    await fsp.writeFile(dest, 'stale');
    const shim = {
      ...fsp,
      async rename() {
        throw errWith('ENOSPC');
      },
    };
    const res = await atomicWriteFile(dest, 'never', { fs: shim, backoffMs: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.attempts, 1, 'ENOSPC is not fixed by waiting');
    assert.equal(res.unlinkedDest, false, 'and it is not fixed by deleting the good file either');
    assert.equal(await fsp.readFile(dest, 'utf8'), 'stale');
  });
});

describe('loadIndex', () => {
  test('absent file → null, nothing created', async () => {
    const dir = await freshDir();
    assert.equal(await loadIndex(dir), null);
    await assert.rejects(fsp.stat(indexPath(dir)), (e) => e.code === 'ENOENT');
  });

  test('corrupt file → deleted and null (rebuild from scratch)', async () => {
    const dir = await freshDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(indexPath(dir), '{"indexVersion":1,"cards":[{"id":"a"');
    assert.equal(await loadIndex(dir), null);
    await assert.rejects(fsp.stat(indexPath(dir)), (e) => e.code === 'ENOENT', 'corrupt index must be removed');
  });

  test('valid JSON of the wrong shape is also treated as corrupt', async () => {
    const dir = await freshDir();
    await fsp.writeFile(indexPath(dir), '[1,2,3]');
    assert.equal(await loadIndex(dir), null);
    await assert.rejects(fsp.stat(indexPath(dir)), (e) => e.code === 'ENOENT');
  });

  test('loadIndexVerbose reports the cache-corrupt Problem it recovered from', async () => {
    const dir = await freshDir();
    await fsp.writeFile(indexPath(dir), 'not json at all');
    const { index, problem } = await loadIndexVerbose(dir);
    assert.equal(index, null);
    assert.equal(problem.code, 'cache-corrupt');
    assert.equal(problem.affects, 'nothing');
  });

  test('an older indexVersion is ignored (bump invalidates everything) but not deleted', async () => {
    const dir = await freshDir();
    const body = JSON.stringify({ indexVersion: INDEX_VERSION + 99, cards: [{ id: 'x' }] });
    await fsp.writeFile(indexPath(dir), body);
    assert.equal(await loadIndex(dir), null);
    assert.equal(await fsp.readFile(indexPath(dir), 'utf8'), body);
  });

  test('a BOM does not defeat the parser', async () => {
    const dir = await freshDir();
    await fsp.writeFile(indexPath(dir), '\uFEFF' + JSON.stringify({ indexVersion: INDEX_VERSION, cards: [{ id: 'a', fingerprint: 'f' }] }));
    const idx = await loadIndex(dir);
    assert.equal(idx.cards.size, 1);
  });
});

describe('createIndexWriter', () => {
  test('round-trips cards through index.json', async () => {
    const dir = await freshDir();
    const w = createIndexWriter(dir, { minIntervalMs: 5, projectsDir: 'C:\\corpus' });
    w.update({ id: 's1', slug: 'p', fingerprint: 'f1' });
    w.update({ id: 's2', slug: 'p', fingerprint: 'f2' });
    const res = await w.flush();
    assert.equal(res.ok, true);
    await w.close();

    const idx = await loadIndex(dir);
    assert.equal(idx.indexVersion, INDEX_VERSION);
    assert.equal(idx.cards.size, 2);
    assert.equal(idx.cards.get('s2').fingerprint, 'f2');
    assert.equal(idx.projectsDir, 'C:\\corpus');
  });

  test('cards without an id are refused (never a half-identified entry)', async () => {
    const dir = await freshDir();
    const w = createIndexWriter(dir, { minIntervalMs: 5 });
    assert.equal(w.update({ slug: 'p' }), false);
    assert.equal(w.update(null), false);
    assert.equal(w.size, 0);
    await w.close();
  });

  test('debounce: a burst of updates costs one write, the next waits the interval', async () => {
    const dir = await freshDir();
    const w = createIndexWriter(dir, { minIntervalMs: 200 });

    for (let i = 0; i < 6; i += 1) w.update({ id: `s${i}`, fingerprint: 'f' });
    await sleep(60);
    assert.equal(w.stats.writes, 1, 'six synchronous updates coalesced into one write');

    w.update({ id: 'later', fingerprint: 'f' });
    await sleep(60);
    assert.equal(w.stats.writes, 1, 'the second write is held back by the 200ms floor');

    await sleep(250);
    assert.equal(w.stats.writes, 2, 'and lands once the floor has passed');

    await w.close();
    const idx = await loadIndex(dir);
    assert.equal(idx.cards.size, 7);
  });

  test('prune drops vanished sessions', async () => {
    const dir = await freshDir();
    const w = createIndexWriter(dir, { minIntervalMs: 5 });
    w.update({ id: 'a', fingerprint: '1' });
    w.update({ id: 'b', fingerprint: '2' });
    w.update({ id: 'c', fingerprint: '3' });
    const removed = w.prune(new Set(['a', 'c']));
    assert.deepEqual(removed, ['b']);
    await w.flush();
    await w.close();
    const idx = await loadIndex(dir);
    assert.deepEqual(Array.from(idx.cards.keys()).sort(), ['a', 'c']);
  });

  test('a write failure surfaces a Problem and the writer keeps serving from memory', async () => {
    const dir = await freshDir();
    const problems = [];
    const shim = {
      ...fsp,
      async rename() {
        throw errWith('EBUSY');
      },
      async unlink(p) {
        if (p.endsWith('index.json')) throw errWith('EBUSY');
        return fsp.unlink(p);
      },
    };
    const w = createIndexWriter(dir, { minIntervalMs: 5, fs: shim, onProblem: (p) => problems.push(p) });
    w.update({ id: 'survivor', fingerprint: 'f' });
    const res = await w.flush();

    assert.equal(res.ok, false);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'cache-write-failed');
    assert.equal(w.get('survivor').fingerprint, 'f', 'still serving from memory');
    assert.equal(w.stats.failures, 1);
    await w.close();
  });
});

describe('cache directory resolution', () => {
  test('LENS_CACHE_DIR wins, then <app>/.cache, then LOCALAPPDATA, then tmp', () => {
    const cands = cacheDirCandidates({ LENS_CACHE_DIR: TMP, LOCALAPPDATA: 'C:\\lad' }, 'C:\\app');
    assert.equal(cands[0].source, 'LENS_CACHE_DIR');
    assert.equal(cands[1].dir, path.join('C:\\app', '.cache'));
    assert.equal(cands[2].dir, path.join('C:\\lad', 'claude-playback-lens'));
    assert.equal(cands[3].source, 'tmp');
    assert.equal(resolveCacheDir({ LENS_CACHE_DIR: TMP }, 'C:\\app'), path.resolve(TMP));
  });

  test('ensureCacheDir falls through to a writable candidate', async () => {
    const good = await freshDir();
    // An unwritable first candidate: point it at a path whose parent is a FILE.
    const blocker = path.join(await freshDir(), 'blocker');
    await fsp.writeFile(blocker, 'x');
    const res = await ensureCacheDir({ LENS_CACHE_DIR: path.join(blocker, 'cache') }, good);
    assert.equal(res.problem, null);
    assert.equal(res.dir, path.join(good, '.cache'), 'fell back to <app>/.cache');
  });
});
