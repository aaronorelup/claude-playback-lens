// server/index-store.mjs — the index.json cache (SPEC §9 "Cache & liveness").
//
// Owns three things:
//   1. atomicWriteFile()  — the write discipline every persisted file in this
//      app uses (config.json included): a PER-WRITE unique tmp in the same dir
//      → fsync → rename, with the win32 EPERM/EBUSY/EACCES retry ladder. Never
//      throws. sweepStaleTmpFiles() clears the orphans a crash leaves behind.
//   2. loadIndexVerbose() — reads index.json; a corrupt file is deleted, null
//      is returned so the caller rebuilds, and the `cache-corrupt` Problem
//      rides back so the recovery is DISCLOSED (both real load sites forward
//      it). A file that CHANGED under the read is `cache-busy` instead: kept,
//      not deleted. An indexVersion mismatch is ignored (null, no problem) — a
//      version bump invalidates everything by design. loadIndex() is the same
//      read with the note dropped.
//   3. createIndexWriter()— an in-memory card table with a debounced (≥2 s)
//      atomic flush, so a cold build that emits 85 cards writes a handful of
//      times, not 85.
//
// The cache stores TOKENS ONLY (SessionCards). No dollars are ever persisted —
// that is what makes "pricing edits never invalidate the cache" true.
//
// SINGLE-WRITER CONTRACT: one cache directory belongs to one running
// instance. Two instances of the same install DO share `<app>/.cache` by
// default — `lens.mjs --port N` only guards against a duplicate on the same
// port — and every write here is collision-safe, but the cost of sharing is
// still real (two full scans, each instance's cache overwritten by the other,
// `cache-busy` notes). Point the second instance at its own LENS_CACHE_DIR.
//
// CONTRACT-DEVIATION (additive only): BUILD-CONTRACTS lists loadIndex /
// createIndexWriter / INDEX_VERSION. This module additionally exports
// loadIndexVerbose, atomicWriteFile, sweepStaleTmpFiles, APP_DIR, indexPath,
// resolveCacheDir, ensureCacheDir and cacheWriteProblem because config.mjs and
// indexer.worker.mjs need them and the contract does not name a home for them.
// No listed signature changed: loadIndex(cacheDir) still returns the same
// object-or-null.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TMP_SWEEP_MAX_AGE_MS, INDEX_WRITE_DEBOUNCE_MS } from './limits.mjs';

// Re-exported: the sweep threshold is part of this module's documented surface.
export { TMP_SWEEP_MAX_AGE_MS };

/**
 * Bump to invalidate every cached SessionCard on disk.
 * THE RULE: bump for a change to what the *persisted* card holds, never for
 * one that is recomputed on every read. Each entry below carries a one-line
 * reason; add yours when you bump.
 */
// 5: round-8 fix pass (R8-PROB-1). The SessionCard gained `problems` — the
//    session's own Problem list, which until now existed only on the in-memory
//    SessionDetail. It is persisted because the store-level problems census is
//    fed by whatever this process parsed, so a WARM boot (every card restored
//    from this file, nothing reparsed) reported an empty census while the
//    sessions' own payloads reported real problems. A card written by v4 has no
//    such key, and a missing key is indistinguishable from "this session has
//    none" — which is exactly the silent-absence lie this app exists to avoid.
//    Hence a real bump, per THE RULE above.
// 4: round-5 fix pass (R5-1). NOTHING PERSISTED CHANGED. The image byte census
//    (b64Length/bytes) lives on the in-memory SessionDetail, which is rebuilt
//    by a fresh parse on every read; the card carries only the integer `images`
//    count (summary.mjs `card.images = inv.counts.images`), and that integer is
//    bit-identical before and after R5-1. This bump was made in error and is
//    left at 4 only because reverting to 3 would discard every card a second
//    time. Do NOT cite this entry as precedent — THE RULE above is the rule.
// 3: round-1 fix pass (the SINGLE scheduled bump): ledgerLite bucket ttlAssumed
//    now counts rows with cacheFlat > 0 regardless of the ttl tag (R5), cached
//    turn/agent usage excludes synthetic rows, dupRows carry
//    speedAbsent/serviceTierAbsent (SPEC §10 pair census from Path A).
// 2: SessionCard gained ledgerLite / r2FirstTsMs / foreignMsgIds / turnBars /
//    lastPromptCount / lostAgents / mainRel (SPEC §9, integration 2026-08-17).
export const INDEX_VERSION = 5;

export const INDEX_FILENAME = 'index.json';

/** The app directory (parent of server/). Config and .cache/ live here. */
export const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Rename failures that are routine on win32 when a scanner holds the file. */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The intermediate file is per-WRITE, never a fixed `<name>.tmp`. Two
// processes sharing one cache dir (two instances of the same install with
// different --port share `<app>/.cache` by default) opening one shared tmp
// with 'w' would interleave their bytes; the winning rename would publish a
// SPLICED file — invalid JSON at rest, which the next reader diagnoses as
// corrupt and deletes — while the losing renames fail ENOENT (not a
// RETRYABLE_CODE, so the ladder never engages) and raise `cache-write-failed`
// on a run where nothing is wrong. A unique name closes both at the source:
// dest is only ever replaced by one complete atomic rename.
const TMP_PREFIX = '.tmp-';
function uniqueTmpSuffix() {
  return `${TMP_PREFIX}${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

/**
 * A `cache-write-failed` Problem per SPEC §9. `affects: 'nothing'` is the
 * load-bearing field: the served numbers are still correct, we just could not
 * persist them.
 */
export function cacheWriteProblem(file, err, detail = {}) {
  return {
    code: 'cache-write-failed',
    severity: 'warning',
    scope: 'store',
    file,
    message:
      `Could not write the cache file ${path.basename(file)}` +
      (err && err.code ? ` (${err.code})` : '') +
      '. Serving from memory; the next run will rebuild.',
    affects: 'nothing',
    count: 1,
    ...detail,
  };
}

function corruptProblem(file, err) {
  return {
    code: 'cache-corrupt',
    severity: 'note',
    scope: 'store',
    file,
    message: `Cache file ${path.basename(file)} was unreadable (${err && err.code ? err.code : 'parse error'}); it was deleted and will be rebuilt.`,
    affects: 'nothing',
    count: 1,
  };
}

/**
 * The cache file changed on disk WHILE we were reading it, so the bytes we
 * failed to parse are not the bytes that are there now. `cache-corrupt` must
 * not be claimed here and the file must not be deleted — the note says exactly
 * what was observed and what was (not) done about it.
 */
function busyProblem(file) {
  return {
    code: 'cache-busy',
    severity: 'note',
    scope: 'store',
    file,
    message:
      `Cache file ${path.basename(file)} changed while it was being read (another process is writing this cache directory), ` +
      'so it could not be parsed. It was LEFT IN PLACE — not deleted — and the index is being rebuilt this run.',
    affects: 'nothing',
    count: 1,
  };
}

/** Same file, or a different one wearing its name? size+mtime+inode, best effort. */
function statChanged(before, after) {
  if (!before || !after) return true; // it vanished (or never resolved) under us
  if (before.size !== after.size) return true;
  if (before.mtimeMs !== after.mtimeMs) return true;
  if (before.ino && after.ino && before.ino !== after.ino) return true;
  return false;
}

async function statOrNull(fsImpl, file) {
  try { return await fsImpl.stat(file); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Atomically replace `destPath` with `data`.
 *
 * write `<name>.tmp-<pid>-<rand>` (same dir) → fsync → rename over dest. On
 * EPERM/EBUSY/EACCES retry 3× with 50 ms backoff, then unlink(dest)+rename.
 * On final failure returns `{ok:false, problem}` — it never throws, because a
 * cache that cannot be written must not take down a server that is correct.
 *
 * The tmp name is unique PER WRITE (see TMP_PREFIX above), so no two writers
 * — threads or processes — can ever share an intermediate file. The cost of
 * that is litter: a crash between open and rename leaves a distinct orphan.
 * sweepStaleTmpFiles() is the other half of the discipline and boots with the
 * writer.
 *
 * @param {string} destPath absolute path
 * @param {string|Buffer} data
 * @param {{retries?:number, backoffMs?:number, fs?:object, sleep?:Function, tmpSuffix?:string}} [opts]
 * @returns {Promise<{ok:boolean, path:string, tmpPath:string, attempts:number,
 *                    unlinkedDest:boolean, error:Error|null, problem:object|null}>}
 */
export async function atomicWriteFile(destPath, data, opts = {}) {
  const {
    retries = 3,
    backoffMs = 50,
    fs: fsImpl = fsp,
    sleep: sleepImpl = sleep,
    tmpSuffix = uniqueTmpSuffix(),
  } = opts;

  const dest = path.resolve(destPath);
  const tmp = dest + tmpSuffix;
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const out = {
    ok: false,
    path: dest,
    tmpPath: tmp,
    attempts: 0,
    unlinkedDest: false,
    error: null,
    problem: null,
  };

  // 1. Directory.
  try {
    await fsImpl.mkdir(path.dirname(dest), { recursive: true });
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      out.error = err;
      out.problem = cacheWriteProblem(dest, err);
      return out;
    }
  }

  // 2. Temp file + fsync (durability before the rename makes it visible).
  let fh = null;
  try {
    fh = await fsImpl.open(tmp, 'w');
    await fh.writeFile(buf);
    await fh.sync();
  } catch (err) {
    out.error = err;
    out.problem = cacheWriteProblem(dest, err);
    try {
      if (fh) await fh.close();
    } catch { /* already failing */ }
    await quietUnlink(fsImpl, tmp);
    return out;
  }
  try {
    await fh.close();
  } catch (err) {
    out.error = err;
    out.problem = cacheWriteProblem(dest, err);
    await quietUnlink(fsImpl, tmp);
    return out;
  }

  // 3. Rename, with the win32 retry ladder.
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    out.attempts = attempt + 1;
    try {
      await fsImpl.rename(tmp, dest);
      return { ...out, ok: true, error: null, problem: null };
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_CODES.has(err && err.code)) break;
      if (attempt < retries) await sleepImpl(backoffMs);
    }
  }

  // 4. Last resort: drop the destination, then rename. Only for the lock-shaped
  //    errors — an ENOSPC or EROFS is not fixed by deleting the old good file.
  if (RETRYABLE_CODES.has(lastErr && lastErr.code)) {
    try {
      await fsImpl.unlink(dest);
      out.unlinkedDest = true;
      await fsImpl.rename(tmp, dest);
      return { ...out, ok: true, error: null, problem: null };
    } catch (err) {
      lastErr = err;
    }
  }

  await quietUnlink(fsImpl, tmp);
  out.error = lastErr;
  out.problem = cacheWriteProblem(dest, lastErr, { detail: out.unlinkedDest ? 'unlink+rename also failed' : undefined });
  return out;
}

async function quietUnlink(fsImpl, p) {
  try {
    await fsImpl.unlink(p);
  } catch { /* best effort */ }
}

/**
 * The other half of the unique tmp name: delete `<baseName>.tmp-*` files in
 * `dir` that are older than `maxAgeMs` (TMP_SWEEP_MAX_AGE_MS, limits.mjs —
 * past that age an orphaned tmp file is certainly nobody's in-flight write).
 *
 * A crash between open and rename leaves its intermediate file behind, and
 * unique names make every crashed run leave a distinct orphan, so the
 * writer's owner sweeps them at boot.
 *
 * Deliberately janitorial and silent: these are this app's OWN scratch files,
 * they hold no recorded fact, and the age threshold is far past any live write
 * (a 5.8 MB flush is milliseconds). It never throws and never touches
 * `<baseName>` itself, nor the legacy fixed `<baseName>.tmp` — which may still
 * be a live write by an older build running beside this one.
 *
 * @param {string} dir
 * @param {{baseName?:string, maxAgeMs?:number, fs?:object, now?:number}} [opts]
 * @returns {Promise<{removed:string[], kept:number, error:Error|null}>}
 */
export async function sweepStaleTmpFiles(dir, opts = {}) {
  const {
    baseName = INDEX_FILENAME,
    maxAgeMs = TMP_SWEEP_MAX_AGE_MS,
    fs: fsImpl = fsp,
    now = Date.now(),
  } = opts;
  const out = { removed: [], kept: 0, error: null };
  if (!dir) return out;
  const root = path.resolve(dir);
  const prefix = baseName + TMP_PREFIX;
  let names;
  try {
    names = await fsImpl.readdir(root);
  } catch (err) {
    out.error = err; // an unreadable cache dir is the caller's problem, not ours
    return out;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || name.length === prefix.length) continue;
    const full = path.join(root, name);
    try {
      const st = await fsImpl.stat(full);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) { out.kept += 1; continue; }
      await fsImpl.unlink(full);
      out.removed.push(name);
    } catch { out.kept += 1; /* raced or unreadable — leave it for the next boot */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

/**
 * Ordered cache-dir candidates: LENS_CACHE_DIR override, `<app>/.cache`,
 * the per-user local app data dir, then tmp.
 */
export function cacheDirCandidates(env = process.env, appDir = APP_DIR) {
  const out = [];
  const override = env && typeof env.LENS_CACHE_DIR === 'string' ? env.LENS_CACHE_DIR.trim() : '';
  if (override) out.push({ dir: path.resolve(override), source: 'LENS_CACHE_DIR' });
  out.push({ dir: path.join(appDir, '.cache'), source: 'app' });
  const localBase =
    (env && env.LOCALAPPDATA) ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : path.join(os.homedir(), '.cache'));
  if (localBase) out.push({ dir: path.join(localBase, 'claude-playback-lens'), source: 'localappdata' });
  out.push({ dir: path.join(os.tmpdir(), 'claude-playback-lens'), source: 'tmp' });
  return out;
}

/** The preferred cache dir without touching the disk. */
export function resolveCacheDir(env = process.env, appDir = APP_DIR) {
  return cacheDirCandidates(env, appDir)[0].dir;
}

/**
 * First candidate cache dir we can actually create and write into.
 * @returns {Promise<{dir:string|null, source:string|null, problem:object|null}>}
 */
export async function ensureCacheDir(env = process.env, appDir = APP_DIR) {
  let lastErr = null;
  for (const cand of cacheDirCandidates(env, appDir)) {
    try {
      await fsp.mkdir(cand.dir, { recursive: true });
      const probe = path.join(cand.dir, `.probe-${process.pid.toString(36)}`);
      await fsp.writeFile(probe, 'ok');
      await quietUnlink(fsp, probe);
      return { dir: cand.dir, source: cand.source, problem: null };
    } catch (err) {
      lastErr = err;
    }
  }
  return {
    dir: null,
    source: null,
    problem: cacheWriteProblem(path.join(appDir, '.cache', INDEX_FILENAME), lastErr, {
      message: 'No writable cache directory found; the index will be rebuilt every run.',
    }),
  };
}

/** Absolute path of index.json inside a cache dir. */
export function indexPath(cacheDir) {
  return path.join(path.resolve(cacheDir), INDEX_FILENAME);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read index.json, reporting the `cache-corrupt` Problem it recovered from.
 *
 * This is the SINGLE implementation — loadIndex() is a thin `.index` on it
 * (one read, one parse; two readers of the same file WILL drift apart).
 * Both real load sites forward `problem` into the normal problems[] channel,
 * because a cache we silently deleted is a recovery the user is owed a note
 * about — SPEC §9 lists `cache-corrupt` and it must be reachable.
 *
 * Deleting the file is the one destructive act in this module, so it is
 * gated on evidence that the bytes we failed to parse are still the bytes on
 * disk (a stat before the read and another immediately before the unlink). A
 * writer replacing the file across our read is `cache-busy`, not
 * `cache-corrupt`: nothing is deleted and the note says so. Deliberately NOT
 * a re-read-and-retry — a second parse would blunt a genuine corruption
 * signal and could still hit the same window.
 *
 * @param {string} cacheDir
 * @param {{fs?:object}} [opts] fs seam — the rename window is not reachable on
 *   demand with a real filesystem, so the regression test drives it here.
 * @returns {Promise<{index:{indexVersion:number, cards:Map<string,object>,
 *                    projectsDir:string|null, writtenAt:number|null,
 *                    problems:object[]}|null, problem:object|null}>}
 *   index is null when: absent, unreadable, corrupt (file is deleted), raced by
 *   another writer (file is KEPT), or written by a different INDEX_VERSION.
 */
export async function loadIndexVerbose(cacheDir, opts = {}) {
  const fsImpl = opts.fs ?? fsp;
  const file = indexPath(cacheDir);
  let text;
  const before = await statOrNull(fsImpl, file);
  try {
    text = await fsImpl.readFile(file, 'utf8');
  } catch (err) {
    // ENOENT is the normal cold-start path, not a problem. Any other read
    // failure IS an anomaly (a cache we cannot reach, so we rebuild blind).
    return { index: null, problem: err && err.code === 'ENOENT' ? null : corruptProblem(file, err) };
  }

  let obj = null;
  let parseErr = null;
  try {
    obj = JSON.parse(stripBom(text));
  } catch (err) {
    parseErr = err;
  }
  if (!parseErr && !(obj && typeof obj === 'object' && Array.isArray(obj.cards) && Number.isInteger(obj.indexVersion))) {
    parseErr = Object.assign(new Error('index.json has an unexpected shape'), { code: 'ESHAPE' });
  }
  if (parseErr) {
    // Did the file change under the read? If it did, what we hold is a torn
    // snapshot of a file that may be perfectly healthy right now — deleting it
    // would destroy a good cache and disclose a corruption that never existed.
    // (`before === null` means the pre-read stat itself failed, which is not
    // evidence of a race: the old delete-and-disclose path stands.)
    if (before && statChanged(before, await statOrNull(fsImpl, file))) {
      return { index: null, problem: busyProblem(file) };
    }
    // Corrupt / unparseable: delete and rebuild (SPEC §9), and SAY SO.
    await quietUnlink(fsImpl, file);
    return { index: null, problem: corruptProblem(file, parseErr) };
  }
  if (obj.indexVersion !== INDEX_VERSION) {
    // A known-good file from another build. Leave it; our next write replaces
    // it. Not an anomaly — a version bump invalidating the cache is the
    // designed path, so no problem is raised.
    return { index: null, problem: null };
  }

  const cards = new Map();
  for (const card of obj.cards) {
    if (card && typeof card === 'object' && typeof card.id === 'string' && card.id) {
      cards.set(card.id, card);
    }
  }
  return {
    index: {
      indexVersion: obj.indexVersion,
      cards,
      projectsDir: typeof obj.projectsDir === 'string' ? obj.projectsDir : null,
      writtenAt: Number.isFinite(obj.writtenAt) ? obj.writtenAt : null,
      problems: [],
    },
    problem: null,
  };
}

/**
 * Read index.json, discarding the recovery note.
 *
 * @returns {Promise<{indexVersion:number, cards:Map<string,object>,
 *                    projectsDir:string|null, writtenAt:number|null,
 *                    problems:object[]}|null>}
 *   null when: absent, unreadable, corrupt (file is deleted), or written by a
 *   different INDEX_VERSION.
 */
export async function loadIndex(cacheDir) {
  return (await loadIndexVerbose(cacheDir)).index;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// Debounced writer
// ---------------------------------------------------------------------------

// The debounce interval is measured on a MONOTONIC clock, never on
// Date.now(). schedule() hands its delay to setTimeout, whose countdown then
// runs against libuv's own monotonic loop clock and is FIXED at creation. If
// the delay were computed from wall-clock arithmetic and the wall clock
// stepped backward between writes (an NTP/manual step correction, or an RTC
// fix on resume from sleep — note DST and timezone changes do NOT move
// Date.now(), which is UTC epoch ms), the computed delay would balloon to the
// size of the jump, and restoring the clock afterwards would NOT rescue the
// already-armed timer: schedule() early-returns on `timer`, so nothing
// re-arms and the write stalls for the full size of the skew. Blast radius is
// the cache only (SPEC §9: a cache write failure `affects: 'nothing'`), but
// the interval-since-last-write has no legitimate dependence on wall time.
const monoNow = () => Number(process.hrtime.bigint() / 1000000n);

/**
 * An in-memory SessionCard table that persists itself atomically, at most once
 * every `minIntervalMs` (default INDEX_WRITE_DEBOUNCE_MS, limits.mjs).
 *
 * @param {string} cacheDir
 * @param {{minIntervalMs?:number, onProblem?:Function, projectsDir?:string|null, fs?:object}} [opts]
 */
export function createIndexWriter(cacheDir, opts = {}) {
  const { minIntervalMs = INDEX_WRITE_DEBOUNCE_MS, onProblem = null, fs: fsImpl = fsp } = opts;

  const file = indexPath(cacheDir);
  const cards = new Map();
  const meta = { projectsDir: opts.projectsDir ?? null };

  let dirty = false;
  let timer = null;
  let inFlight = null;
  let lastWriteAt = 0; // wall clock — stats display only, never arithmetic
  let lastWriteMono = -Infinity; // monotonic — the debounce arithmetic runs on this
  let closed = false;
  const stats = { writes: 0, failures: 0, updates: 0 };
  let lastResult = null;

  function emitProblem(problem) {
    if (!problem) return;
    if (typeof onProblem === 'function') {
      try {
        onProblem(problem);
      } catch { /* a problem reporter must never be the failure */ }
    }
  }

  function serialize() {
    return JSON.stringify({
      indexVersion: INDEX_VERSION,
      writtenAt: Date.now(),
      projectsDir: meta.projectsDir,
      cardCount: cards.size,
      cards: Array.from(cards.values()),
    });
  }

  function schedule() {
    if (closed || timer) return;
    // The Math.min clamp is belt-and-braces: no debounce can ever exceed the
    // configured floor, whatever any clock does. The -Infinity seed keeps the
    // first write immediate.
    const delay = Math.max(0, Math.min(minIntervalMs, lastWriteMono + minIntervalMs - monoNow()));
    timer = setTimeout(() => {
      timer = null;
      void pump(false);
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function pump(force) {
    // This must be a LOOP, not a single await. Every pump queued behind one
    // in-flight write resumes in the same microtask drain; with a bare `if`,
    // the first one re-acquires but the rest sail past a check they already
    // passed and write CONCURRENTLY — flush(); flush(); flush() must
    // serialise, not race. Re-checking after the await is what actually
    // serialises the writer this claims to be.
    while (inFlight) await inFlight.catch(() => {});
    if (!dirty && !force) return lastResult;
    dirty = false;
    const payload = serialize();
    lastWriteAt = Date.now();
    lastWriteMono = monoNow();
    const run = atomicWriteFile(file, payload, { fs: fsImpl }).then((res) => {
      stats.writes += 1;
      lastResult = res;
      if (!res.ok) {
        stats.failures += 1;
        emitProblem(res.problem);
      }
      return res;
    });
    inFlight = run.finally(() => {
      inFlight = null;
    });
    const res = await inFlight;
    if (dirty && !closed) schedule();
    return res;
  }

  return {
    /** Absolute path of the file this writer owns. */
    path: file,
    get size() {
      return cards.size;
    },
    get stats() {
      return { ...stats, pending: dirty, lastWriteAt: lastWriteAt || null };
    },

    /** Record the projectsDir the cards were built from (written into the file). */
    setProjectsDir(dir) {
      meta.projectsDir = dir ?? null;
      dirty = true;
      schedule();
    },

    /** Insert/replace one SessionCard and schedule a debounced flush. */
    update(card) {
      if (!card || typeof card !== 'object' || typeof card.id !== 'string' || !card.id) return false;
      cards.set(card.id, card);
      stats.updates += 1;
      dirty = true;
      schedule();
      return true;
    },

    /** Seed from a loaded index without marking dirty. */
    seed(map) {
      if (!map) return;
      for (const [k, v] of map) cards.set(k, v);
    },

    get(id) {
      return cards.get(id) ?? null;
    },
    has(id) {
      return cards.has(id);
    },
    delete(id) {
      const had = cards.delete(id);
      if (had) {
        dirty = true;
        schedule();
      }
      return had;
    },
    /** Drop every card whose id is not in `keepIds`. Returns the removed ids. */
    prune(keepIds) {
      const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
      const removed = [];
      for (const id of Array.from(cards.keys())) {
        if (!keep.has(id)) {
          cards.delete(id);
          removed.push(id);
        }
      }
      if (removed.length) {
        dirty = true;
        schedule();
      }
      return removed;
    },
    /** Live view of the card table (the same Map identity every call). */
    cards() {
      return cards;
    },

    /** Write now, ignoring the debounce. Resolves to the atomicWriteFile result. */
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return pump(true);
    },

    /** Flush if dirty, then stop scheduling. Safe to call twice. */
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const needed = dirty;
      let r = lastResult;
      if (needed) r = await pump(true);
      else if (inFlight) await inFlight.catch(() => {});
      closed = true;
      // pump() may have re-armed the timer if an update landed mid-write.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return r;
    },
  };
}
