// server/indexer.worker.mjs — the index builder, on a worker thread.
//
// Protocol (BUILD-CONTRACTS group C):
//   parent → worker: {type:'start', projectsDir, cacheDir}
//                    {type:'rescan'}        stat walk only; reports staleness
//                    {type:'reindex'}       full rebuild, fingerprints ignored
//   worker → parent: {type:'card', card}
//                    {type:'progress', done, of, bytesDone, bytesTotal}
//                    {type:'stale', sessionIds}
//                    {type:'problem', problem}   store/worker scope ONLY
//                    {type:'session-problems', id, slug, problems}
//                                              one batch per summarise attempt,
//                                              posted even when empty
//                    {type:'ready'}
//
// Two rules govern everything here:
//   * A card is emitted only when its session is FULLY summarised. Nothing
//     half-built ever reaches the index — "totals over 61 of 85 sessions" is an
//     honest sentence only if those 61 are complete.
//   * Most-recently-modified first. The user is almost always looking for what
//     they did in the last hour, and that arrives in the first ~200 ms.
//
// The 5 s rescan loop is a *stat walk only*. It marks sessions stale and says
// so; it never re-summarises under a reader. A refresh is the parent's call
// (send `start` again — unchanged sessions reuse their cached cards, so a
// refresh of an 85-session corpus costs one stat walk plus the changed ones).

import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESCAN_INTERVAL_MS, WORKER_PROGRESS_MS, INDEX_WRITE_DEBOUNCE_MS } from './limits.mjs';
import { sameDir as samePath } from './api/fileref.mjs';

const WIN = process.platform === 'win32';
const RESCAN_MS = numOr(workerData && workerData.rescanMs, RESCAN_INTERVAL_MS);
const PROGRESS_MS = numOr(workerData && workerData.progressMs, WORKER_PROGRESS_MS);

function numOr(v, d) {
  return Number.isFinite(v) && v > 0 ? v : d;
}

// ---------------------------------------------------------------------------
// Module wiring
//
// Group A's ledger and group B's scan/parse/summary are built in parallel with
// this file, so they are imported LAZILY (on `start`) and by URL. workerData
// .modules may point any of them at a substitute — that is how the protocol is
// unit-tested without a 1.15 GB corpus.
// ---------------------------------------------------------------------------

const MODULE_DEFAULTS = {
  scan: new URL('./scan.mjs', import.meta.url).href,
  parse: new URL('./parse.mjs', import.meta.url).href,
  ledger: new URL('./ledger.mjs', import.meta.url).href,
  summary: new URL('./summary.mjs', import.meta.url).href,
  jsonl: new URL('./jsonl.mjs', import.meta.url).href,
  indexStore: new URL('./index-store.mjs', import.meta.url).href,
};

function moduleUrl(name) {
  const override = workerData && workerData.modules && workerData.modules[name];
  if (!override) return MODULE_DEFAULTS[name];
  if (typeof override !== 'string') return MODULE_DEFAULTS[name];
  if (/^[a-z][a-z0-9+.-]*:/i.test(override) && !/^[a-z]:[\\/]/i.test(override)) return override; // already a URL
  return pathToFileURL(path.resolve(override)).href;
}

let mods = null;
async function loadModules() {
  if (mods) return mods;
  const [scan, parse, ledger, summary, jsonl, indexStore] = await Promise.all([
    import(moduleUrl('scan')),
    import(moduleUrl('parse')),
    import(moduleUrl('ledger')),
    import(moduleUrl('summary')),
    import(moduleUrl('jsonl')),
    import(moduleUrl('indexStore')),
  ]);
  mods = { scan, parse, ledger, summary, jsonl, indexStore };
  return mods;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  projectsDir: null,
  cacheDir: null,
  writer: null,
  /** sessionId -> fingerprint of the card we have emitted */
  fingerprints: new Map(),
  /** sessionId -> the last card emitted */
  cards: new Map(),
  /** sessions already reported stale since the last build */
  reportedStale: new Set(),
  generation: 0,
  building: false,
  scanning: false,
  rescanTimer: null,
  lastScan: null,
  warnedRelMiss: false,
};

function post(msg) {
  if (parentPort) parentPort.postMessage(msg);
}

// postProblem is the APPEND channel and carries STORE/WORKER-scope events only
// (a scan that could not read a directory, a cache we had to delete, the
// indexer's own crash). A session's problems ride postSessionProblems instead.
function postProblem(problem) {
  post({ type: 'problem', problem });
}

// One batch per summarise attempt, posted UNCONDITIONALLY, including the
// empty case. Posting problems one at a time, and nothing at all when a
// session has none, would leave the parent with no event to retract on: a
// condition that stopped holding would stay in the store-level census forever
// while the session's own payload correctly said it was gone. The empty batch
// IS the retraction.
function postSessionProblems(session, problems) {
  post({ type: 'session-problems', id: session.id, slug: session.slug, problems: problems ?? [] });
}

function problem(code, severity, scope, message, extra = {}) {
  return { code, severity, scope, message, affects: 'nothing', count: 1, ...extra };
}

// ---------------------------------------------------------------------------
// FileTable helpers
// ---------------------------------------------------------------------------

/**
 * `rel` keys are POSIX-separated and compared case-insensitively on win32
 * (SPEC §9). Group B normalises at scan time; this lookup is the belt to that
 * braces, because one missed stat here silently zeroes a session's fingerprint.
 */
function makeFileLookup(fileTable) {
  let ci = null;
  return function get(rel) {
    if (!rel) return null;
    const direct = fileTable.get(rel);
    if (direct) return direct;
    if (!WIN) return null;
    if (!ci) {
      ci = new Map();
      for (const [k, v] of fileTable) ci.set(k.toLowerCase(), v);
    }
    return ci.get(String(rel).toLowerCase()) ?? null;
  };
}

/**
 * `[{rel, size, mtimeMs}]` sorted by rel — the shape group B's fingerprint()
 * wants. `misses` counts rels that were not in the FileTable: that number must
 * be 0, and if it is not, the two modules disagree about what `rel` means
 * (projectsDir-relative here, per scanStore's key space — NOT the
 * session-relative `rel` of the HTTP API). A silent disagreement would produce
 * fingerprints that never notice a file changing, so it is reported loudly.
 */
function sessionFileStats(session, lookup) {
  const out = [];
  let misses = 0;
  for (const rel of session.files || []) {
    const st = lookup(rel);
    if (!st) misses += 1;
    out.push({
      rel,
      size: st && Number.isFinite(st.size) ? st.size : 0,
      mtimeMs: st && Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0,
    });
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  out.misses = misses;
  return out;
}

function newestMtime(fileStats) {
  let max = 0;
  for (const f of fileStats) if (f.mtimeMs > max) max = f.mtimeMs;
  return max;
}

function totalBytes(fileStats) {
  let n = 0;
  for (const f of fileStats) n += f.size;
  return n;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * One stat walk + grouping + per-session fingerprints.
 * @returns {Promise<{fileTable:Map, grouped:object, sessions:Array}|null>}
 */
async function scanNow() {
  const { scan } = await loadModules();
  let fileTable;
  try {
    fileTable = await scan.scanStore(state.projectsDir);
  } catch (err) {
    postProblem(
      problem('dir-unreadable', 'error', 'store', `Could not scan ${state.projectsDir}: ${err && err.message}`, {
        file: state.projectsDir,
        affects: 'aggregates',
      }),
    );
    return null;
  }

  let grouped;
  try {
    grouped = scan.groupSessions(fileTable);
  } catch (err) {
    postProblem(
      problem('indexer-crashed', 'error', 'store', `Grouping failed: ${err && err.message}`, {
        affects: 'aggregates',
      }),
    );
    return null;
  }

  const lookup = makeFileLookup(fileTable);
  const sessions = [];
  let relMisses = 0;
  for (const s of grouped.sessions || []) {
    const fileStats = sessionFileStats(s, lookup);
    relMisses += fileStats.misses;
    let fp = null;
    try {
      fp = scan.fingerprint(fileStats);
    } catch (err) {
      postProblem(
        problem('indexer-crashed', 'error', 'session', `Fingerprint failed: ${err && err.message}`, {
          slug: s.slug,
          id: s.id,
          affects: 'aggregates',
        }),
      );
    }
    sessions.push({
      session: s,
      fileStats,
      fingerprint: fp,
      bytes: Number.isFinite(s.bytes) ? s.bytes : totalBytes(fileStats),
      mtimeMs: newestMtime(fileStats),
    });
  }

  if (relMisses > 0 && !state.warnedRelMiss) {
    state.warnedRelMiss = true;
    postProblem(
      problem(
        'unclassified-file',
        'error',
        'store',
        `${relMisses} session file path(s) were not found in the FileTable. groupSessions() and scanStore() ` +
          'disagree about the rel key space (expected projectsDir-relative POSIX keys); fingerprints and ' +
          'liveness are unreliable until that is fixed.',
        { affects: 'aggregates' },
      ),
    );
  }

  // MRU first: what the user touched last is what they are looking for.
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const scanned = { fileTable, grouped, sessions };
  state.lastScan = scanned;
  return scanned;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function build({ force = false } = {}) {
  const gen = ++state.generation;
  state.building = true;
  state.reportedStale.clear();

  try {
    const scanned = await scanNow();
    if (!scanned || gen !== state.generation) return;

    const { fileTable, sessions } = scanned;
    const of = sessions.length;
    const bytesTotal = sessions.reduce((n, s) => n + s.bytes, 0);
    let done = 0;
    let bytesDone = 0;
    let lastProgressAt = 0;

    const emitProgress = (partialBytes = 0, forceEmit = false) => {
      const now = Date.now();
      if (!forceEmit && now - lastProgressAt < PROGRESS_MS) return;
      lastProgressAt = now;
      post({
        type: 'progress',
        done,
        of,
        bytesDone: Math.min(bytesTotal, bytesDone + partialBytes),
        bytesTotal,
      });
    };

    emitProgress(0, true);

    const { parse, ledger, summary, jsonl } = await loadModules();

    for (const entry of sessions) {
      if (gen !== state.generation) return; // superseded by a reindex
      const s = entry.session;
      const cached = force ? null : state.cards.get(s.id) || null;

      let card = null;
      if (cached && entry.fingerprint && cached.fingerprint === entry.fingerprint) {
        card = cached; // unchanged since last build — reuse, no parse
      } else {
        card = await summariseSession(entry, { parse, ledger, summary, jsonl, fileTable, emitProgress });
      }

      if (card) {
        card.fingerprint = entry.fingerprint; // cache correctness is ours to guarantee
        if (card.id == null) card.id = s.id;
        if (card.slug == null) card.slug = s.slug;
        state.cards.set(s.id, card);
        state.fingerprints.set(s.id, entry.fingerprint);
        if (state.writer) state.writer.update(card);
        post({ type: 'card', card });
      }

      done += 1;
      bytesDone += entry.bytes;
      emitProgress(0, done === of);

      // Yield so the parent drains the message queue between sessions.
      await new Promise((r) => setImmediate(r));
    }

    // Sessions that vanished from disk leave the index with them.
    const live = new Set(sessions.map((e) => e.session.id));
    for (const id of Array.from(state.cards.keys())) {
      if (!live.has(id)) {
        state.cards.delete(id);
        state.fingerprints.delete(id);
      }
    }
    if (state.writer) state.writer.prune(live);

    if (state.writer) {
      const res = await state.writer.flush();
      if (res && !res.ok && res.problem) postProblem(res.problem);
    }

    post({ type: 'ready', done, of, bytesDone, bytesTotal });
  } catch (err) {
    postProblem(
      problem('indexer-crashed', 'error', 'store', `Indexer failed: ${(err && err.stack) || err}`, {
        affects: 'aggregates',
      }),
    );
    post({ type: 'ready', ok: false });
  } finally {
    if (gen === state.generation) state.building = false;
    startRescanLoop();
  }
}

async function summariseSession(entry, { parse, ledger, summary, jsonl, fileTable, emitProgress }) {
  const s = entry.session;
  const projectsDir = state.projectsDir;

  // parseSession takes the grouping entry. It is handed absolute paths as well,
  // because everything given to fs in this app is absolute (BUILD-CONTRACTS).
  const absOf = (rel) => path.resolve(projectsDir, rel.split('/').join(path.sep));
  const sessionEntry = {
    ...s,
    projectsDir,
    fileTable,
    fileStats: entry.fileStats,
    fingerprint: entry.fingerprint,
    absMain: s.mainRel ? absOf(s.mainRel) : null,
    absFiles: (s.files || []).map((rel) => ({ rel, abs: absOf(rel) })),
    absOf,
  };

  try {
    const model = await parse.parseSession(sessionEntry, {
      readLines: jsonl.readLines,
      stripHeavy: jsonl.stripHeavy,
      onProgress: (p) => {
        const b = p && (Number.isFinite(p.bytesDone) ? p.bytesDone : Number.isFinite(p.bytes) ? p.bytes : 0);
        emitProgress(b || 0);
      },
    });

    const rows = ledger.buildSessionLedger(model && model.assistantLines ? model.assistantLines : []);
    const out = summary.summarise(model, rows, entry.fingerprint);
    const card = out && out.card ? out.card : null;
    if (!card) {
      postSessionProblems(s, [
        problem('indexer-crashed', 'error', 'session', 'Summariser returned no card.', {
          slug: s.slug,
          id: s.id,
          affects: 'aggregates',
        }),
      ]);
      return null;
    }
    // The session's own problem list, as ONE current-state contribution.
    // summarise() has already put the identical array on card.problems (and on
    // detail.problems), which is what makes /api/index and /api/session agree
    // by construction rather than by two computations happening to match.
    postSessionProblems(s, Array.isArray(card.problems) ? card.problems : []);
    return card;
  } catch (err) {
    postSessionProblems(s, [
      problem('indexer-crashed', 'error', 'session', `Could not index session ${s.id}: ${(err && err.message) || err}`, {
        slug: s.slug,
        id: s.id,
        affects: 'aggregates',
        severity: 'error',
      }),
    ]);
    return null; // a session that cannot be summarised is absent, never partial
  }
}

// ---------------------------------------------------------------------------
// Rescan (liveness)
// ---------------------------------------------------------------------------

function startRescanLoop() {
  if (state.rescanTimer || !state.projectsDir || RESCAN_MS <= 0) return;
  state.rescanTimer = setInterval(() => {
    void rescan();
  }, RESCAN_MS);
  if (state.rescanTimer && typeof state.rescanTimer.unref === 'function') state.rescanTimer.unref();
}

/**
 * A stat walk, nothing more. Emits the ids whose fingerprint moved (or that are
 * new, or that disappeared) exactly once each until the next build.
 */
async function rescan() {
  if (!state.projectsDir || state.scanning || state.building) return [];
  state.scanning = true;
  try {
    const scanned = await scanNow();
    if (!scanned) return [];
    const stale = [];
    const seen = new Set();
    for (const entry of scanned.sessions) {
      const id = entry.session.id;
      seen.add(id);
      const known = state.fingerprints.get(id);
      if (known !== entry.fingerprint && !state.reportedStale.has(id)) {
        state.reportedStale.add(id);
        stale.push(id);
      }
    }
    for (const id of state.fingerprints.keys()) {
      if (!seen.has(id) && !state.reportedStale.has(id)) {
        state.reportedStale.add(id);
        stale.push(id);
      }
    }
    if (stale.length) post({ type: 'stale', sessionIds: stale });
    return stale;
  } finally {
    state.scanning = false;
  }
}

// ---------------------------------------------------------------------------
// Message pump
// ---------------------------------------------------------------------------

async function onStart(msg) {
  const changedDir = state.projectsDir && state.projectsDir !== msg.projectsDir;
  state.projectsDir = msg.projectsDir ? path.resolve(msg.projectsDir) : null;
  state.cacheDir = msg.cacheDir ? path.resolve(msg.cacheDir) : null;

  if (!state.projectsDir) {
    postProblem(problem('dir-unreadable', 'error', 'store', 'No projectsDir supplied to the indexer.', { affects: 'aggregates' }));
    post({ type: 'ready', ok: false });
    return;
  }

  let indexStore;
  try {
    ({ indexStore } = await loadModules());
  } catch (err) {
    postProblem(
      problem('indexer-crashed', 'error', 'store', `Indexer modules failed to load: ${(err && err.message) || err}`, {
        affects: 'aggregates',
      }),
    );
    post({ type: 'ready', ok: false });
    return;
  }

  if (!state.writer && state.cacheDir) {
    // The writer's owner sweeps the intermediate files earlier runs crashed
    // out of (unique tmp names make that litter permanent otherwise). Silent
    // and janitorial — these are our own scratch files, hours old, holding no
    // recorded fact.
    if (typeof indexStore.sweepStaleTmpFiles === 'function') {
      await indexStore.sweepStaleTmpFiles(state.cacheDir);
    }
    // Verbose load — a corrupt cache is deleted AND disclosed. postProblem
    // is the same channel every other recoverable anomaly in here rides.
    const { index: loaded, problem: loadProblem } = await indexStore.loadIndexVerbose(state.cacheDir);
    if (loadProblem) postProblem(loadProblem);
    state.writer = indexStore.createIndexWriter(state.cacheDir, {
      projectsDir: state.projectsDir,
      onProblem: postProblem,
      minIntervalMs: numOr(workerData && workerData.debounceMs, INDEX_WRITE_DEBOUNCE_MS),
    });
    // A cache built against a different corpus is not ours to reuse.
    if (loaded && loaded.cards && (!loaded.projectsDir || samePath(loaded.projectsDir, state.projectsDir))) {
      state.writer.seed(loaded.cards);
      for (const [id, card] of loaded.cards) {
        state.cards.set(id, card);
        if (card && typeof card.fingerprint === 'string') state.fingerprints.set(id, card.fingerprint);
      }
    }
    state.writer.setProjectsDir(state.projectsDir);
  } else if (state.writer && changedDir) {
    state.cards.clear();
    state.fingerprints.clear();
    state.writer.prune(new Set());
    state.writer.setProjectsDir(state.projectsDir);
  }

  await build({ force: false });
}

async function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'start':
      await onStart(msg);
      break;
    case 'rescan':
      await rescan();
      break;
    case 'reindex':
      state.reportedStale.clear();
      await build({ force: true });
      break;
    case 'close':
      if (state.rescanTimer) clearInterval(state.rescanTimer);
      state.rescanTimer = null;
      if (state.writer) await state.writer.close();
      break;
    default:
      // Unknown message types are ignored, never fatal.
      break;
  }
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg) => {
    onMessage(msg).catch((err) => {
      postProblem(
        problem('indexer-crashed', 'error', 'store', `Indexer message handler failed: ${(err && err.stack) || err}`, {
          affects: 'aggregates',
        }),
      );
    });
  });

  // A crashed worker must DIE, not linger: swallowing the crash can leave
  // `building: true` forever (no future rescan) while workerAlive() stays
  // true — a zombie that silently disables liveness. Post the problem, then
  // exit nonzero so the parent flips S.alive and 503s honestly.
  process.on('uncaughtException', (err) => {
    postProblem(
      problem('indexer-crashed', 'error', 'store', `Uncaught in indexer: ${(err && err.stack) || err}`, {
        affects: 'aggregates',
      }),
    );
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    postProblem(
      problem('indexer-crashed', 'error', 'store', `Unhandled rejection in indexer: ${(err && err.stack) || err}`, {
        affects: 'aggregates',
      }),
    );
    process.exit(1);
  });
}
