// tests/fixes-round18.test.mjs — named regressions for the round-18 fix pass,
// server side.
//
//   R18-S1 (server/config.mjs validateDir)
//       validateDir bounds its work with two private caps: WALK_FILE_CAP
//       (250,000 files) and WALK_MS_CAP (8s). walk() — which handles every
//       NESTED file — checked both on entry, drained its stat queue as it went,
//       and re-checked the cap after each increment. The `for (const e of top)`
//       loop that handles the candidate directory's OWN top level did none of
//       that: it ran `files += 1; pending.push(...)` for every loose file with
//       no cap test, no deadline test, and no incremental drain.
//
//       So the caps bounded recursion only. A projects directory with six
//       figures of loose files in it counted every one of them: measured at
//       600,000 loose files, validateDir returned files:600000 — 2.4x past the
//       cap — and spent ~4 seconds in pure promise/microtask overhead before
//       any real disk latency, against a documented 8s budget. The missing
//       incremental drain made it worse: the final drain(true) spliced 32
//       entries at a time off a 600,000-entry array, ~19,000 memmoves of an
//       O(n^2/32) shape.
//
//       Nothing above it bounds the request either — server/http.mjs sets no
//       requestTimeout, and both POST /api/validate-dir and PUT /api/config's
//       inline preview await validateDir raw — so one wrong folder aimed at the
//       settings screen's validate button is an unbounded stat storm.
//
//       NOT part of this finding: the `truncated` flag was never dishonest.
//       The shipped code counted everything it queued and reported
//       truncated:false correctly, because the unguarded branch did too MUCH
//       work, not too little. Nothing was under-counted and nothing was
//       claimed. The fix is what introduces truncation here — and reports it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { validateDir } = await import('../server/config.mjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors the private constant in server/config.mjs. Not exported, and this
// test deliberately does not export it either — a seam is not worth widening
// for one assertion. If the constant moves, this number moves with it.
const WALK_FILE_CAP = 250000;

/* ============================================================= R18-S1 */

// A fake root that reports more loose top-level files than the cap allows.
// `import { promises as fsp }` in server/config.mjs binds the SAME object as
// fs.promises here, so patching it reaches the real module. Only paths under
// the fake root are intercepted; everything else falls through untouched.
function withFakeRoot(fileCount, run) {
  const root = path.join(os.tmpdir(), 'r18s1-fake-root');
  const DIRENT_FILE = { isDirectory() { return false; }, isFile() { return true; } };
  const entries = new Array(fileCount);
  for (let i = 0; i < fileCount; i++) entries[i] = { __proto__: DIRENT_FILE, name: 'f' + i };

  const realReaddir = fs.promises.readdir;
  const realStat = fs.promises.stat;
  let statCalls = 0;

  fs.promises.stat = async (p, ...rest) => {
    const s = String(p);
    if (s === root) return { isDirectory: () => true, isFile: () => false, size: 0 };
    if (s.startsWith(root)) {
      statCalls += 1;
      // size 1 per file, so `bytes` doubles as a count of what actually drained
      return { isDirectory: () => false, isFile: () => true, size: 1 };
    }
    return realStat(p, ...rest);
  };
  fs.promises.readdir = async (p, ...rest) => {
    if (String(p) === root) return entries;
    return realReaddir(p, ...rest);
  };

  return run(root).finally(() => {
    fs.promises.readdir = realReaddir;
    fs.promises.stat = realStat;
  }).then((r) => ({ ...r, statCalls }));
}

test('R18-S1 — loose TOP-LEVEL files obey WALK_FILE_CAP, not just nested ones', async () => {
  const OVER = WALK_FILE_CAP + 10000;
  const res = await withFakeRoot(OVER, (root) => validateDir(root));

  assert.equal(res.ok, true, 'a readable directory still validates');
  assert.ok(res.files <= WALK_FILE_CAP,
    'the top-level file branch used to count every loose file with no cap at all — ' +
    'got ' + res.files + ', cap is ' + WALK_FILE_CAP);
  assert.equal(res.files, WALK_FILE_CAP, 'it stops exactly at the cap');
  assert.ok(res.files < OVER, 'and therefore short of the ' + OVER + ' files on offer');
  assert.equal(res.truncated, true,
    'stopping short is a truncation and validateDir must say so');

  // The stat queue drained as the scan went, rather than accumulating one
  // entry per top-level file and splicing 32 at a time off the tail at the end.
  assert.equal(res.bytes, WALK_FILE_CAP,
    'every counted file was stat-ed exactly once and its size added');
  assert.ok(res.statCalls <= WALK_FILE_CAP + 1,
    'no file is stat-ed twice; got ' + res.statCalls);
});

test('R18-S1 — an ordinary directory is unaffected: no truncation, same counts', async () => {
  // The guard must not fire on real input. Anything under the cap behaves
  // exactly as before the fix.
  const res = await withFakeRoot(1000, (root) => validateDir(root));
  assert.equal(res.ok, true);
  assert.equal(res.files, 1000, 'every file is still counted');
  assert.equal(res.bytes, 1000, 'and every one of them still stat-ed');
  assert.equal(res.truncated, false, 'nothing was skipped, so nothing is claimed to be');
  assert.equal(res.projects, 0, 'loose files are not projects');
  assert.equal(res.sessions, 0);
});

test('R18-S1 — the cap does not disturb validateDir on a real tree', async () => {
  // Equivalence check against actual disk: the repo's own server/ directory.
  const res = await validateDir(path.join(REPO, 'server'));
  assert.equal(res.ok, true);
  assert.equal(res.truncated, false, 'a normal directory is never truncated');
  assert.ok(res.files > 0, 'and its files are counted');
  assert.ok(res.bytes > 0, 'and their bytes summed');
});
