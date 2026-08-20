#!/usr/bin/env node
// lens.mjs — Claude Playback Lens entrypoint (group D).
//
//   node lens.mjs --serve [--open] [--port N] [--projects DIR]
//
// Flow (SPEC §9, DESIGN §8): args → config (group C) → port probe
// (GET /api/hello; an answering instance is focused, not duplicated) →
// start server → spawn indexer worker → open browser.
//
// Every group A/B/C module is imported dynamically and individually: a
// missing module degrades that capability (503 envelopes on index-backed
// routes) instead of preventing boot.
//
// createIndexState lives here (not in server/) deliberately: its worker
// lifecycle is pinned to this file by tests, and it is the seam tests import
// (`import { createIndexState } from '../lens.mjs'`).

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRouter, createHttpServer, listen } from './server/http.mjs';
import { createApi } from './server/api.mjs';
import { createStaticHandler } from './server/static.mjs';
import { PendingError, HttpError } from './server/errors.mjs';
import { sameDir } from './server/api/fileref.mjs';
import {
  DEFAULT_PORT, PORT_SCAN_ATTEMPTS, HELLO_PROBE_TIMEOUT_MS, RETRY_AFTER_MS,
  WORKER_RESTART_DEBOUNCE_MS, WORKER_BACKOFF_MS, WORKER_CRASH_WINDOW_MS,
  WORKER_CRASH_CAP, RESCAN_INTERVAL_MS, PROBLEMS_CAP, PROBLEM_SOURCE_CAP,
} from './server/limits.mjs';

const APP_NAME = 'Claude Playback Lens';
const APP_VERSION = '3.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------ args
const argv = process.argv.slice(2);
function argVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const FLAGS = {
  serve: argv.includes('--serve'),
  open: argv.includes('--open'),
  port: argVal('--port'),
  projects: argVal('--projects'),
  help: argv.includes('--help') || argv.includes('-h'),
};

if (FLAGS.help) {
  console.log(`${APP_NAME} ${APP_VERSION}
  node lens.mjs --serve [--open] [--port N] [--projects DIR]
  Config precedence: --projects > CLAUDE_PROJECTS > config.json > ~/.claude/projects`);
  process.exit(0);
}

// ------------------------------------------------------------ module loading
async function tryImport(rel) {
  try { return await import(pathToFileURL(path.join(HERE, rel)).href); }
  catch (e) {
    if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND')) return null;
    console.error(`[lens] ${rel} failed to load: ${e && e.message}`);
    return null;
  }
}

// ------------------------------------------------------------ config
async function resolveProjects(mods) {
  if (mods.config && mods.config.resolveProjectsDir) {
    const r = mods.config.resolveProjectsDir(process.argv.slice(2), process.env);
    return { dir: r.dir, source: r.source };
  }
  // fallback when group C is absent — same precedence (SPEC §9)
  if (FLAGS.projects) return { dir: path.resolve(FLAGS.projects), source: '--projects' };
  if (process.env.CLAUDE_PROJECTS) return { dir: path.resolve(process.env.CLAUDE_PROJECTS), source: 'CLAUDE_PROJECTS' };
  try {
    // canonical location per config.mjs: <app>/config.json (NOT .cache/)
    const cfg = JSON.parse(await fsp.readFile(path.join(HERE, 'config.json'), 'utf8'));
    if (cfg && cfg.projectsDir) return { dir: cfg.projectsDir, source: 'config.json' };
  } catch { /* no config file */ }
  return { dir: path.join(os.homedir(), '.claude', 'projects'), source: 'default ~/.claude/projects' };
}

// ------------------------------------------------------------ index state
// Wires groups A/B/C into the ctx.index contract documented in
// server/api/index.mjs. Prefers the group C worker (server/indexer.worker.mjs);
// falls back to an in-process indexing loop when the worker file is absent, so
// a partial checkout still boots. (// CONTRACT-DEVIATION: workerAlive() reports
// true in in-process fallback mode — the indexer exists, it is simply not a
// worker thread; 503 stays reserved for a genuinely dead indexer.)
export function createIndexState({
  projectsDir, cacheDir, mods, restartDebounceMs = WORKER_RESTART_DEBOUNCE_MS,
  // Respawn policy. The shipped defaults live in server/limits.mjs; the tests
  // drive the same code paths on a compressed clock.
  workerBackoffMs = WORKER_BACKOFF_MS,
  crashWindowMs = WORKER_CRASH_WINDOW_MS,
  crashCap = WORKER_CRASH_CAP,
} = {}) {
  // Sessions are keyed by BARE sessionId everywhere (SPEC §2: a session is
  // keyed by sessionId alone; ids are store-unique).
  const S = {
    version: 1,
    state: 'building', // 'building' | 'ready' | 'failed'
    fileTable: new Map(),
    projects: [],
    sessions: [],
    cards: new Map(),     // id -> SessionCard
    details: new Map(),   // id -> SessionDetail
    rowsStore: new Map(), // id -> BilledRow[]
    bytesIndexed: 0,
    bytesTotal: 0,
    alive: true,
    worker: null,
    hasWorker: false,     // worker mode (vs the in-process fallback indexer)
    indexing: false,
    problems: [],         // STORE/WORKER-scope events only (append + cap)
    // A session's problems are a CURRENT-STATE contribution, not a log entry.
    // The whole per-session list is replaced on every (re)parse, so a
    // condition that stops holding drops out on the next parse and a
    // re-parsed unchanged condition does not inflate count.
    sessionProblems: new Map(), // id -> Problem[]
    failed: new Map(),    // id -> Problem: sessions that could not be indexed
    // Live worker-lifecycle facts, reported derived (never logged)
    workerExits: 0,
    workerGaveUp: false,
    lastWorkerExit: null,
  };
  // Evicted parsed models take their jsonl offset tables with them (the tables
  // are keyed per absolute file path and otherwise outlive every consumer).
  const dropModelTables = (model) => {
    if (!mods.jsonl || typeof mods.jsonl.dropOffsetTable !== 'function' || !model) return;
    const rels = [];
    if (model.main?.rel) rels.push(model.main.rel);
    for (const a of model.agents ?? []) if (a.rel) rels.push(a.rel);
    for (const rel of rels) {
      try { mods.jsonl.dropOffsetTable(path.resolve(projectsDir, ...String(rel).split('/'))); } catch { /* best effort */ }
    }
  };
  S.models = mods.lru
    ? mods.lru.createLru({ onEvict: (_key, model) => dropModelTables(model) })
    : null; // parsed SessionModels (limits.mjs LRU budgets, SPEC §9)
  const bump = () => { S.version += 1; };
  // Append-only channel — for STORE/WORKER-scope events whose truth is "this
  // happened once, in this process" (a cache file we had to delete, a scan that
  // could not read a directory). Session-scope problems do NOT come through
  // here: they are a replaceable per-session contribution (setSessionProblems).
  const noteProblem = (p) => {
    if (!p) return;
    if (p.scope === 'session' && p.id) {
      // A session-scope record arriving on the append channel would never be
      // retracted. Route it through the replaceable contribution instead.
      setSessionProblems(p.id, [p]);
      return;
    }
    S.problems.push(p);
    if (S.problems.length > PROBLEMS_CAP) S.problems.splice(0, S.problems.length - PROBLEMS_CAP); // bounded
  };
  // Replace a session's whole contribution, including the EMPTY case — the
  // empty batch is what makes a retraction possible at all.
  function setSessionProblems(id, problems) {
    if (!id) return;
    const list = Array.isArray(problems) ? problems : [];
    S.sessionProblems.set(id, list);
    // S.failed keys off the same facts, so it is derived from the same list
    // rather than accumulated beside it.
    const fail = list.find((p) => p && p.code === 'indexer-crashed' && p.scope === 'session');
    if (fail) S.failed.set(id, fail); else S.failed.delete(id);
  }
  const dropSession = (id) => { S.sessionProblems.delete(id); S.failed.delete(id); };

  async function rescan() {
    if (!mods.scan) return;
    const table = await mods.scan.scanStore(projectsDir);
    const groups = mods.scan.groupSessions(table);
    S.fileTable = table;
    S.projects = groups.projects;
    S.sessions = groups.sessions;
    S.bytesTotal = groups.sessions.reduce((a, s) => a + (s.bytes ?? 0), 0);
    bump();
  }

  // ------------------------------------------------- parse invalidation
  // Bookkeeping for the in-flight parse maps further down.
  //
  // Exactly two events declare the index's copy of a session superseded: the
  // worker's `stale` message and POST /api/reindex. Both clear S.rowsStore —
  // but clearing the stores cannot reach a parse that is ALREADY IN FLIGHT: a
  // request arriving after the invalidation would join it, be served
  // pre-invalidation bytes, and re-warm S.rowsStore with them; ensureParsed's
  // warm guard would then short-circuit on that resurrected data until the
  // file happened to change AGAIN (the worker reports a given session's
  // staleness once per change, so there is no second signal to rescue it).
  //
  // Two halves, both required:
  //  (1) invalidate() EVICTS the id from both in-flight maps, so the next
  //      caller starts a parse of the CURRENT bytes instead of joining a parse
  //      of bytes that are known superseded.
  //  (2) a per-id generation counter, captured by parseOne at entry and
  //      re-read after its writes. A parse whose generation moved underneath
  //      it is known-superseded, and the id is marked `dirty`.
  //
  // (2) marks rather than SUPPRESSES the write on purpose. Dropping the write
  // would leave S.rowsStore empty for any session being appended to while it
  // parses, so need() would throw PendingError forever — a 409 loop. The data
  // a superseded parse produced is real and is fingerprinted with the bytes it
  // actually read; it is served, and `dirty` records that it is not the last
  // word. ensureParsed's warm guard consults `dirty`, so the very next request
  // reparses.
  const staleGen = new Map(); // id -> count of invalidations seen
  const dirty = new Set();    // ids whose stored rows are known superseded
  const genOf = (id) => staleGen.get(id) ?? 0;
  function invalidate(id) {
    if (!id) return;
    staleGen.set(id, genOf(id) + 1);
    inflightParse.delete(id);
    inflightModel.delete(id);
  }
  // reindex() clears the same stores `stale` does, so it invalidates the same
  // way. Only an id with a parse actually IN FLIGHT can re-warm rowsStore with
  // pre-reindex bytes — everything else is already cold and reparses anyway.
  function invalidateInflight() {
    for (const id of new Set([...inflightParse.keys(), ...inflightModel.keys()])) invalidate(id);
  }

  async function parseOne(entry, { force = false } = {}) {
    if (!mods.parse || !mods.jsonl || !mods.ledger || !mods.summary) return;
    const id = entry.id;
    const gen0 = genOf(id);
    const files = entry.files.map((rel) => ({ rel, ...(S.fileTable.get(rel) ?? { size: 0, mtimeMs: 0 }) }));
    const fp = mods.scan.fingerprint(files.slice().sort((a, b) => (a.rel < b.rel ? -1 : 1)));
    // A dirty id must reach a REAL parse. The fingerprint early-return reads
    // the CARD's fingerprint, which a worker `card` push can advance
    // independently of the rows — so letting it fire here would clear `dirty`
    // on the strength of a card that says nothing about the rows beside it.
    if (!force && !dirty.has(id) && S.cards.get(id)?.fingerprint === fp && S.rowsStore.has(id)) return;
    const model = await mods.parse.parseSession(entry, {
      projectsDir, // group B's parseSession resolves rels against the store root
      readLines: mods.jsonl.readLines, stripHeavy: mods.jsonl.stripHeavy, onProgress: null,
    });
    // parse.mjs emits assistantLines in group A's {file, line, event} wrapper,
    // and summary.mjs carries the R2 evidence (r2FirstTsMs / foreignMsgIds)
    // plus ledgerLite natively on the card.
    const rows = mods.ledger.buildSessionLedger(model.assistantLines ?? []);
    const { card, detail } = mods.summary.summarise(model, rows, fp);
    // The in-process indexer replaces this session's whole problem
    // contribution with the one array summarise() built for both payloads —
    // /api/index's census and /api/session's report come from the same list.
    setSessionProblems(id, detail.problems ?? []);
    const hadRows = S.rowsStore.has(id);
    S.cards.set(id, card);
    S.details.set(id, detail);
    S.rowsStore.set(id, rows);
    if (S.models) S.models.set(S.models.key(entry.slug, id, fp), model); // parsed model for /api/agent rows
    // One writer per mode. In WORKER mode the worker's `progress` messages are
    // the sole authority for bytesIndexed (handleWorkerMessage OVERWRITES the
    // field), and the worker never ships rows — so every first ensureParsed
    // here would otherwise add a whole session's bytes on top of a counter
    // already at 100%, permanently. The in-process fallback path has no worker
    // and keeps counting, because there it IS the only writer. An LRU-refill
    // reparse (hadRows) is not new indexing in either mode.
    if (!hadRows && !S.worker) S.bytesIndexed += entry.bytes ?? 0;
    // Did an invalidation land while this parse was in flight? If so the
    // bytes just written are already known superseded — say so, so the next
    // request reparses instead of short-circuiting on them. If not, this
    // parse IS the last word and clears any earlier mark.
    if (genOf(id) !== gen0) dirty.add(id); else dirty.delete(id);
    bump();
    if (S.writer) { try { S.writer.update(card); } catch { /* cache-write-failed keeps serving */ } }
    return model;
  }

  // The no-worker fallback's supersession guard, mirroring what the worker's
  // generation counter does for worker mode. A rebuild asked for while one is
  // already running is QUEUED, never dropped and never allowed to clear the
  // card map out from under the running loop.
  let pendingRebuild = false, pendingForce = false, pendingClear = false;

  async function indexAll({ force = false, clear = false } = {}) {
    if (S.indexing) {
      // A silently-dropped second call would leave cards cleared from outside
      // unrebuilt for the life of the process (the running loop never
      // revisits sessions it has passed) while status() still flips to
      // 'ready'. Queue the request instead.
      pendingRebuild = true;
      pendingForce ||= force;
      pendingClear ||= clear;
      return;
    }
    S.indexing = true;
    // The clear lives INSIDE the guard, and only when asked for. start() calls
    // indexAll() right after seeding S.cards from the index.json cache, so an
    // unconditional clear here would silently turn every warm boot cold.
    if (clear) S.cards.clear();
    S.state = 'building';
    S.bytesIndexed = 0;
    try {
      // MRU-first: most-recently-modified sessions first (SPEC §9)
      const mt = (s) => Math.max(0, ...s.files.map((r) => S.fileTable.get(r)?.mtimeMs ?? 0));
      const order = [...S.sessions].sort((a, b) => mt(b) - mt(a));
      for (const entry of order) {
        try { await parseOne(entry, { force }); }
        catch (e) { console.error(`[lens] parse failed for ${entry.slug}/${entry.id}: ${e && e.message}`); }
        await new Promise((r) => setImmediate(r));
      }
      // Never report 'ready' for a pass this process already knows has been
      // superseded.
      if (!pendingRebuild) S.state = 'ready';
      bump();
    } finally {
      S.indexing = false;
      if (pendingRebuild) {
        const f = pendingForce, c = pendingClear;
        pendingRebuild = pendingForce = pendingClear = false;
        indexAll({ force: f, clear: c });   // deliberately not awaited
      }
    }
  }

  // ---- worker liveness: staleness triggers a debounced re-`start` (the
  // worker's documented refresh primitive — unchanged sessions reuse their
  // cached cards, so a refresh costs one stat walk + the changed sessions),
  // coalesced with a trailing debounce (matching the writer's own debounce)
  // and never overlapping an in-flight build.
  const RESTART_DEBOUNCE_MS = restartDebounceMs;
  let startTimer = null;
  let startInFlight = false;
  let startQueued = false;
  const sendStart = () => {
    if (!S.worker || !S.alive) return;
    startInFlight = true;
    try { S.worker.postMessage({ type: 'start', projectsDir, cacheDir }); } catch { startInFlight = false; }
  };
  const scheduleStart = () => {
    if (startTimer) clearTimeout(startTimer);
    startTimer = setTimeout(() => {
      startTimer = null;
      if (startInFlight) { startQueued = true; return; }
      sendStart();
    }, RESTART_DEBOUNCE_MS);
    if (startTimer.unref) startTimer.unref();
  };

  // ---- worker lifecycle. The worker deliberately process.exit(1)s on any
  // uncaughtException over untrusted transcript data, so a dead worker is a
  // reachable state by design. The spawn is a function, called from start()
  // AND from every exit/error, with a backoff and a crash-loop cap; the cap
  // is disclosed rather than silent, and a dead worker never claims 'ready'.
  let WorkerCtor = null;
  let workerPath = null;
  let respawnTimer = null;
  let respawnStreak = 0;       // consecutive respawns -> which backoff step
  const respawnTimes = [];     // ms stamps inside the crash window
  let liveTimer = null;        // the stat-walk rescan interval
  let closing = false;         // shutting down: an exit is expected, not a crash

  function spawnWorker() {
    if (closing || !WorkerCtor || !workerPath) return null;
    let w;
    try {
      w = new WorkerCtor(workerPath);
    } catch (e) {
      S.alive = false;
      S.workerExits += 1;
      S.lastWorkerExit = `spawn failed: ${(e && e.message) || e}`;
      bump();
      scheduleRespawn();
      return null;
    }
    // Stopping TRACKING a worker must mean stopping the WORKER: a spawn that
    // supersedes a live instance (two POSTs to /api/reindex inside the window
    // between spawn and the replacement's first message; one POST landing on
    // a backoff respawn that has not spoken yet) must not orphan a thread
    // that nothing ever terminates. The orphan would not be idle: it would
    // complete a whole independent build and write its own index.json through
    // its own writer, surfacing losing renames as `cache-write-failed` on the
    // TRACKED worker — a cache anomaly whose only cause is the app's own
    // leaked threads. close() cannot reclaim them either; it terminates
    // S.worker alone.
    //
    // ASSIGN FIRST, then terminate: the superseded worker's `exit` then
    // deterministically fails the `S.worker !== w` guard in onWorkerGone, so a
    // death we caused can neither inflate S.workerExits nor trigger another
    // scheduleRespawn — independent of the order Node happens to emit in.
    const prev = S.worker;
    S.worker = w;
    if (prev && prev !== w) {
      try { Promise.resolve(prev.terminate()).catch(() => {}); } catch { /* already gone */ }
    }
    // A fresh worker is NOT alive because a constructor returned. It is alive
    // when it says something — the same rule the rest of this app follows about
    // claiming facts it has not been told.
    w.on('message', (m) => {
      if (S.worker !== w) return; // a message from a worker we already replaced
      if (!S.alive) { S.alive = true; bump(); }
      handleWorkerMessage(m);
    });
    // Node emits `error` and THEN `exit` for the same death; one worker dying is
    // one exit, or the census would double-count every errored crash.
    let reported = false;
    const gone = (why) => { if (reported) return; reported = true; onWorkerGone(w, why); };
    w.on('exit', (code) => { gone(`exited with code ${code}`); });
    w.on('error', (e) => { gone(`errored: ${(e && e.message) || e}`); });
    startInFlight = true;
    startQueued = false;
    try { w.postMessage({ type: 'start', projectsDir, cacheDir }); } catch { startInFlight = false; }
    return w;
  }

  function onWorkerGone(w, why) {
    if (S.worker !== w) return; // a superseded worker dying is not news
    if (closing) { S.alive = false; return; } // an expected exit is not a crash
    S.alive = false;
    S.workerExits += 1;
    S.lastWorkerExit = why;
    startInFlight = false;
    bump();
    scheduleRespawn();
  }

  function scheduleRespawn() {
    if (closing || respawnTimer) return;
    const now = Date.now();
    while (respawnTimes.length && now - respawnTimes[0] > crashWindowMs) respawnTimes.shift();
    if (respawnTimes.length >= crashCap) {
      // Stay down — and SAY so. problems() reads S.workerGaveUp live, so this
      // is a claim that stops being made the moment a reindex revives it.
      S.workerGaveUp = true;
      bump();
      return;
    }
    const delay = workerBackoffMs[Math.min(respawnStreak, workerBackoffMs.length - 1)];
    respawnStreak += 1;
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      respawnTimes.push(Date.now());
      spawnWorker();
    }, delay);
    if (respawnTimer.unref) respawnTimer.unref();
  }

  // The one exposed recovery action must actually recover: an operator asking
  // for a re-index while the worker is down gets a fresh worker and a fresh
  // crash budget (they are the evidence that the situation changed).
  function reviveWorker() {
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    respawnTimes.length = 0;
    respawnStreak = 0;
    S.workerGaveUp = false;
    return spawnWorker();
  }

  // Derived, never logged: one row stating what is true about the worker NOW.
  // Appending a record per crash would (a) collapse behind the first message,
  // (b) outlive the condition, and (c) inflate count on every retry.
  function workerProblem() {
    if (!S.hasWorker || S.workerExits === 0) return null;
    const tail = S.lastWorkerExit ? ` Last exit: ${S.lastWorkerExit}.` : '';
    const n = S.workerExits;
    if (S.alive) {
      return {
        code: 'worker-exit', severity: 'warning', scope: 'store',
        message: `the indexer worker exited ${n} time(s) this run and was restarted; a worker is running now and the index has been rebuilt from disk.${tail}`,
        affects: 'aggregates', count: n,
      };
    }
    if (S.workerGaveUp) {
      return {
        code: 'worker-exit', severity: 'error', scope: 'store',
        message: `the indexer worker exited ${n} time(s), ${crashCap} of them inside ${Math.round(crashWindowMs / 1000)}s, so it is staying down. Index-backed routes answer 503 and every figure here is frozen at the last completed build. POST /api/reindex to try again.${tail}`,
        affects: 'aggregates', count: n,
      };
    }
    return {
      code: 'worker-exit', severity: 'error', scope: 'store',
      message: `the indexer worker is not running (${n} exit(s) this run); a replacement is being spawned. Index-backed routes answer 503 and every figure here is frozen until it reports.${tail}`,
      affects: 'aggregates', count: n,
    };
  }

  function handleWorkerMessage(m) {
    if (!m || !m.type) return;
    if (m.type === 'card' && m.card) {
      if (m.card.id) {
        S.cards.set(m.card.id, m.card);
        // The card carries the session's own problem list, so a WARM boot
        // (cards restored from cache, nothing reparsed) has a census instead
        // of a silent []. A card is posted for reused cards too, which is
        // what makes this the retraction event on every build.
        if (Array.isArray(m.card.problems)) setSessionProblems(m.card.id, m.card.problems);
        else S.failed.delete(m.card.id); // a card supersedes any earlier failure
      }
      bump();
    } else if (m.type === 'session-problems') {
      // One batch per summarise attempt, INCLUDING the empty case, and
      // including the failure case where no card is ever posted.
      setSessionProblems(m.id, m.problems);
      bump();
    } else if (m.type === 'progress') {
      S.bytesIndexed = m.bytesDone ?? S.bytesIndexed;
      S.bytesTotal = m.bytesTotal ?? S.bytesTotal;
      if (m.done != null && m.of != null && m.done >= m.of) { S.state = 'ready'; bump(); }
    } else if (m.type === 'ready') {
      // `ready` is only ready when it says ok — a failed build must never
      // present itself as a resolved index (r2 stays pending; the problems
      // ride /api/index).
      S.state = m.ok === false ? 'failed' : 'ready';
      startInFlight = false;
      if (startQueued) { startQueued = false; scheduleStart(); }
      // vanished sessions leave the index with the build that no longer saw
      // them (guarded: an empty scan in degraded mode must not wipe the cards)
      if (S.state === 'ready' && S.sessions.length > 0) {
        const live = new Set(S.sessions.map((s) => s.id));
        for (const id of [...S.cards.keys()]) if (!live.has(id)) { S.cards.delete(id); dropSession(id); }
        // a session that is gone takes its problems with it
        for (const id of [...S.sessionProblems.keys()]) if (!live.has(id)) dropSession(id);
      }
      bump();
    } else if (m.type === 'problem') {
      noteProblem(m.problem);
      bump();
    } else if (m.type === 'stale' && Array.isArray(m.sessionIds)) {
      const live = new Set(S.sessions.map((s) => s.id));
      for (const sid of m.sessionIds) {
        // Dropping the stores is only half a retraction while a parse of the
        // PRE-change bytes is still in flight and joinable — a request
        // arriving after this line would join it and put the dropped rows
        // straight back. Evict it from the in-flight maps and stamp the
        // generation so the parse's own late write is marked, not trusted.
        invalidate(sid);
        S.rowsStore.delete(sid);
        S.details.delete(sid);
        S.failed.delete(sid); // changed on disk — let it try again
        // a session no longer on disk leaves the index with its card
        // (deleted sessions must not keep feeding L0/aggs/dayBands)
        if (!live.has(sid)) { S.cards.delete(sid); dropSession(sid); }
        // stale offset tables die with the session's old bytes
        if (mods.jsonl && typeof mods.jsonl.dropOffsetTable === 'function') {
          const entry = S.sessions.find((s) => s.id === sid);
          for (const rel of entry?.files ?? []) {
            try { mods.jsonl.dropOffsetTable(path.resolve(projectsDir, ...String(rel).split('/'))); } catch { /* best effort */ }
          }
        }
      }
      bump();
      // liveness — re-send the idempotent `start` (debounced) so the changed
      // sessions are re-summarised and the client's Reload bar can fire
      scheduleStart();
    }
  }

  async function start() {
    await rescan();
    if (mods.store && (mods.store.loadIndexVerbose || mods.store.loadIndex)) {
      try {
        // The VERBOSE loader, so a cache file we had to delete is disclosed
        // instead of silently swallowed (SPEC §9 `cache-corrupt`). Duplicate
        // notes with the worker's own load are not a risk — whichever reads
        // first deletes the file, the second gets ENOENT and problem null,
        // and problems() collapses by code|scope regardless.
        const res = mods.store.loadIndexVerbose
          ? await mods.store.loadIndexVerbose(cacheDir)
          : { index: await mods.store.loadIndex(cacheDir), problem: null };
        if (res.problem) { noteProblem(res.problem); bump(); }
        const loaded = res.index;
        // A cache built against a DIFFERENT corpus is not ours to seed from
        // (same guard the worker applies).
        if (loaded && loaded.cards
          && (!loaded.projectsDir || sameDir(loaded.projectsDir, projectsDir))) {
          // one keying convention: bare sessionId (SPEC §2), same as group C
          for (const card of loaded.cards.values()) {
            if (card && card.id) S.cards.set(card.id, card);
          }
          bump();
        }
      } catch { /* corrupt cache is deleted+rebuilt by group C */ }
    }
    // prefer the group C worker thread
    workerPath = path.join(HERE, 'server', 'indexer.worker.mjs');
    let hasWorker = false;
    try { await fsp.access(workerPath); hasWorker = true; } catch { hasWorker = false; }
    // The index.json writer belongs to whichever indexer is actually running.
    // In worker mode the WORKER owns it (it has the full card set); a second
    // writer here would debounce-clobber the worker's complete index with
    // this process's on-demand subset.
    if (!hasWorker && mods.store && mods.store.createIndexWriter) {
      // In fallback mode THIS process owns the writer, so it is the one that
      // sweeps the tmp orphans a crashed earlier run left in the cache dir
      // (the worker does the same on its own boot). Never fatal.
      if (typeof mods.store.sweepStaleTmpFiles === 'function') {
        try { await mods.store.sweepStaleTmpFiles(cacheDir); } catch { /* janitorial */ }
      }
      S.writer = mods.store.createIndexWriter(cacheDir, { projectsDir });
    }
    if (hasWorker) {
      const { Worker } = await import('node:worker_threads');
      WorkerCtor = Worker;
      S.hasWorker = true;
      spawnWorker(); // one spawn path — start() and every exit/error use it
    } else if (mods.parse && mods.jsonl && mods.ledger && mods.summary && mods.scan) {
      indexAll(); // in-process fallback, deliberately not awaited
    } else {
      S.state = 'building'; // nothing can index — routes return 409/503 honestly
      console.error('[lens] group A/B modules not present yet — index routes will answer 409/503 until they land');
    }
    // liveness: stat-walk rescan on an interval (SPEC §9)
    liveTimer = setInterval(() => { rescan().catch(() => {}); }, RESCAN_INTERVAL_MS);
    if (liveTimer.unref) liveTimer.unref();
  }

  // Orderly shutdown. Without it, the respawn path is indistinguishable from
  // a crash loop at teardown: terminating the worker fires `exit`, which
  // correctly builds a replacement, which nothing then owns. Production exits
  // the process instead; tests (and any future embedder) need the door.
  async function close() {
    closing = true;
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    if (startTimer) { clearTimeout(startTimer); startTimer = null; }
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    const w = S.worker;
    S.worker = null;
    S.alive = false;
    if (w) { try { await w.terminate(); } catch { /* already gone */ } }
  }

  const need = (id) => {
    if (S.rowsStore.has(id)) return true;
    // A session that FAILED to parse gets a real error, not an endless 409
    // (the 409 loop promises progress that will never come)
    const fail = S.failed.get(id);
    if (fail) {
      throw new HttpError(500, 'session-unparseable',
        `session ${id} could not be indexed: ${fail.message ?? 'parse failed'}`);
    }
    const pendingBytes = { bytesIndexed: S.bytesIndexed, bytesTotal: S.bytesTotal };
    throw new PendingError({ retryAfterMs: RETRY_AFTER_MS, ...pendingBytes });
  };

  // In-flight parse de-duplication, keyed by session id.
  //
  // Both guards on the cold path are POST-write guards — ensureParsed's
  // `S.rowsStore.has(id)` and parseOne's fingerprint early-return only fire
  // once an earlier parse has already FINISHED writing. The
  // `await parseSession(...)` window itself needs its own guard, and nothing
  // upstream serialises: createHttpServer awaits each handler independently.
  // The cold window is the NORMAL case, not an edge — the worker never ships
  // rows, so every session is row-cold on first open even while /api/index
  // reports state:"ready" — and it is reached by ordinary use: two browser
  // tabs, a refresh mid-load (aborting the fetch does not cancel the
  // server-side parse), or two of the several per-session routes racing.
  // Without the map every such caller pays a full parse of the same file
  // (seconds of dead time plus N times the peak model allocation on a large
  // session; an MCP server multiplies it again).
  //
  // The map holds the .finally()-chained promise, so the entry clears on BOTH
  // settle paths and a later genuine file change still reparses. Joiners that
  // see a rejection each run noteProblem once, which costs nothing: that
  // problem is session-scope, so it routes through setSessionProblems, which
  // REPLACES the session's whole contribution rather than appending.
  //
  // Joining is right ONLY for the ordinary case where the file did not change
  // (keying the map by fingerprint would just restore the dogpile) — so the
  // map is EVICTED by invalidate() at both events that know better (`stale`
  // and reindex), and a parse whose generation moved marks its id `dirty` so
  // the warm guard below stops short-circuiting on it.
  const inflightParse = new Map();

  async function ensureParsed(slug, id) {
    if (S.rowsStore.has(id) && !dirty.has(id)) return;
    const entry = S.sessions.find((s) => s.id === id && (slug == null || s.slug === slug));
    if (!entry) return;
    if (mods.parse && mods.jsonl && mods.ledger && mods.summary) {
      try {
        // on-demand parse beats waiting for the sweep
        let p = inflightParse.get(id);
        if (!p) {
          // The delete is guarded BY IDENTITY. A bare `inflightParse.delete(id)`
          // removes whatever is under the key, so once eviction lets a second
          // promise be inserted, the first promise's settle would drop the
          // SECOND entry and dedup would silently stop working for every
          // caller after it.
          p = parseOne(entry).finally(() => {
            if (inflightParse.get(id) === p) inflightParse.delete(id);
          });
          inflightParse.set(id, p);
        }
        await p;
      } catch (e) {
        // recorded; need() turns this into a structured 500, never a 409 loop
        noteProblem({
          code: 'indexer-crashed', severity: 'error', scope: 'session',
          slug: entry.slug, id, message: `parse failed: ${e && e.message}`,
          affects: 'aggregates', count: 1,
        });
      }
    }
  }

  // The SAME dogpile guard, one route over — an LRU miss on /api/agent has
  // the identical unguarded parse window. Kept in its OWN map, deliberately
  // separate from inflightParse, so the force semantics are never blurred:
  // ensureModel calls parseOne with force:true and must not be handed a
  // non-forced result that an ensureParsed joiner happened to start.
  const inflightModel = new Map();

  // the parsed SessionModel (row heads incl. agent transcripts) — LRU'd; a
  // miss re-parses on demand (median 34 ms, SPEC §11).
  async function ensureModel(slug, id) {
    const entry = S.sessions.find((s) => s.id === id && (slug == null || s.slug === slug));
    if (!entry) return null;
    const card = S.cards.get(id);
    const fp = card?.fingerprint ?? null;
    if (S.models && fp) {
      const hit = S.models.get(S.models.key(entry.slug, id, fp));
      if (hit) return hit;
    }
    if (!(mods.parse && mods.jsonl && mods.ledger && mods.summary)) return null;
    let p = inflightModel.get(id);
    if (!p) {
      // identity-guarded delete, same reason as inflightParse.
      p = parseOne(entry, { force: true }).finally(() => {
        if (inflightModel.get(id) === p) inflightModel.delete(id);
      });
      inflightModel.set(id, p);
    }
    const model = await p;
    return model ?? null;
  }

  // session-relative rel per SPEC §9's /api/file grammar
  const sessionRelOf = (entry, relFromProjects) => {
    if (relFromProjects == null) return null;
    if (relFromProjects === `${entry.slug}/${entry.id}.jsonl`) return `${entry.id}.jsonl`;
    const prefix = `${entry.slug}/${entry.id}/`;
    if (relFromProjects.startsWith(prefix)) return relFromProjects.slice(prefix.length);
    return `frag/${relFromProjects}`; // cross-project fragment file
  };

  return {
    start,
    close, // additive to the ctx.index contract: orderly teardown
    version: () => S.version,
    status: () => ({
      // 'ready' while workerAlive() is false would be two recorded facts
      // contradicting each other in one payload. A dead indexer is a failed one.
      state: S.alive ? S.state : 'failed', // 'building' | 'ready' | 'failed'
      sessionsDone: S.cards.size,
      sessionsTotal: S.sessions.length,
      bytesIndexed: S.bytesIndexed,
      bytesTotal: S.bytesTotal,
    }),
    problems: () => {
      // Problem contract (SPEC §9): identical code+scope records collapse to
      // one row carrying count — an 85-session sweep of unknown-event-type
      // warnings is one line, not 23 KB of payload.
      //
      // The fold is over the CURRENT contributions — scan problems + the
      // store/worker append log + every session's current list + the live
      // worker verdict. Nothing here is a historical record, so a condition
      // that stops holding stops being reported, and re-parsing an unchanged
      // condition cannot inflate `count`. Each collapsed row accumulates the
      // identities that contributed to it, so the drawer can link when — and
      // only when — the row names exactly one of them.
      const collapsed = new Map();
      const wp = workerProblem();
      const feed = [
        ...(S.fileTable.problems ?? []),
        ...S.problems,
        ...(wp ? [wp] : []),
      ];
      for (const list of S.sessionProblems.values()) for (const p of list) feed.push(p);
      const addSource = (row, p) => {
        const src = {};
        if (p.slug != null) src.slug = p.slug;
        if (p.id != null) src.id = p.id;
        if (p.file != null) src.file = p.file;
        if (p.line != null) src.line = p.line;
        if (Object.keys(src).length === 0) return;
        const key = JSON.stringify(src);
        if (row._seen.has(key)) return;
        row._seen.add(key);
        row.sourceCount += 1;
        if (row.sources.length < PROBLEM_SOURCE_CAP) row.sources.push(src);
      };
      for (const p of feed) {
        if (!p) continue;
        const key = `${p.code}|${p.scope}`;
        let row = collapsed.get(key);
        if (!row) {
          row = { ...p, count: 0, sources: [], sourceCount: 0, _seen: new Set() };
          collapsed.set(key, row);
        }
        row.count += p.count ?? 1;
        addSource(row, p);
      }
      // The row cap is applied AFTER the fold — a FIFO on the input log would
      // let 200+ re-posts of one session's note silently evict still-true
      // store-scope errors.
      const rows = [...collapsed.values()].map(({ _seen, ...row }) => row);
      return rows.length > PROBLEMS_CAP ? rows.slice(0, PROBLEMS_CAP) : rows;
    },
    workerAlive: () => S.alive,
    fileTable: () => S.fileTable,
    projects: () => S.projects,
    sessions: () => S.sessions,
    cards: () => S.cards, // keyed by bare sessionId (SPEC §2)
    pending: () => S.sessions.filter((s) => !S.cards.has(s.id)).map((s) => ({ slug: s.slug, id: s.id })),
    detail: async (slug, id) => {
      await ensureParsed(slug, id);
      need(id);
      return S.details.get(id) ?? null;
    },
    rows: async (slug, id) => {
      await ensureParsed(slug, id);
      need(id);
      return S.rowsStore.get(id);
    },
    agentRows: async (slug, id, agentId, { from = 0, count = 300 } = {}) => {
      await ensureParsed(slug, id);
      need(id);
      const entry = S.sessions.find((s) => s.id === id);
      const model = await ensureModel(slug, id);
      if (!model) return null;
      if (agentId === 'main') {
        if (!model.main) return null;
        const rows = model.main.rows ?? [];
        return {
          agentId: 'main',
          rel: entry ? sessionRelOf(entry, model.main.rel) : model.main.rel,
          rows: rows.slice(from, from + count), total: rows.length, from, count,
        };
      }
      const agent = (model.agents ?? []).find((a) => a.agentId === agentId);
      if (!agent) return null;
      const rows = agent.rows ?? [];
      return {
        agentId,
        rel: entry ? sessionRelOf(entry, agent.rel) : agent.rel,
        meta: agent.meta ?? null,
        label: agent.label ?? null,
        state: agent.state ?? null,
        turnIdx: agent.turnIdx ?? null,
        rows: rows.slice(from, from + count), total: rows.length, from, count,
      };
    },
    turnBars: () => {
      // bars ride the cached cards (summary.mjs puts them there), so L0 has
      // its bars on a warm boot without a single session parse.
      const bars = [];
      for (const card of S.cards.values()) {
        for (const t of card.turnBars ?? []) {
          bars.push({ slug: card.slug, id: card.id, idx: t.idx, at: t.at ?? null, endedAt: t.endedAt ?? null });
        }
      }
      return bars;
    },
    reindex: async () => {
      // Clearing the stores does not reach a parse that is already in flight,
      // and a request landing after this point would join it and re-warm
      // rowsStore with pre-reindex bytes — so invalidate those first.
      invalidateInflight();
      S.details.clear();
      S.rowsStore.clear();
      S.failed.clear();
      S.sessionProblems.clear(); // rebuilt by the parse that is about to happen
      if (S.models) S.models.clear();
      // The one exposed recovery action has to be able to recover — a dead
      // Worker object cannot be postMessage'd back to life.
      if (S.hasWorker && !S.alive) { reviveWorker(); bump(); }
      else if (S.worker) { S.worker.postMessage({ type: 'reindex' }); bump(); }
      // The clear is the REBUILD's, not the caller's: clearing here would
      // wipe cards a still-running indexAll() already wrote and would never
      // revisit, while its in-flight guard made this call a silent no-op —
      // permanent 409s for the stranded ids. indexAll owns both.
      else { indexAll({ force: true, clear: true }); bump(); }
    },
    // test seam (not part of the ctx.index contract): drive the worker-message
    // handler without a real worker thread
    _test: {
      state: S,
      handleWorkerMessage,
      setSessionProblems,
      workerPolicy: { workerBackoffMs, crashWindowMs, crashCap },
    },
  };
}

// ------------------------------------------------------------ browser open
function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { console.log(`[lens] open ${url} in your browser`); }
}

// ------------------------------------------------------------ port probe
async function probeHello(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(HELLO_PROBE_TIMEOUT_MS) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app === APP_NAME ? j : null;
  } catch { return null; }
}

// ------------------------------------------------------------ main
async function main() {
  const mods = {
    pricing: await tryImport('shared/pricing.mjs'),
    ledger: await tryImport('server/ledger.mjs'),
    jsonl: await tryImport('server/jsonl.mjs'),
    parse: await tryImport('server/parse.mjs'),
    scan: await tryImport('server/scan.mjs'),
    summary: await tryImport('server/summary.mjs'),
    config: await tryImport('server/config.mjs'),
    store: await tryImport('server/index-store.mjs'),
    lru: await tryImport('server/lru.mjs'),
  };
  const missing = Object.entries(mods).filter(([, m]) => !m).map(([k]) => k);
  if (missing.length) console.log(`[lens] waiting on parallel-build modules: ${missing.join(', ')} (degraded until they land)`);

  const { dir: projectsDir, source } = await resolveProjects(mods);
  console.log(`[lens] projects dir: ${projectsDir}  (from ${source})`);
  try {
    const st = await fsp.stat(projectsDir);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    console.log(`[lens] ${projectsDir} does not exist — the setup screen will ask for a directory`);
  }

  const wantPort = Number(FLAGS.port ?? process.env.PORT ?? DEFAULT_PORT);

  // port probe: double-click twice focuses the running instance (SPEC §9)
  const hello = await probeHello(wantPort);
  if (hello) {
    const url = `http://127.0.0.1:${wantPort}/`;
    console.log(`[lens] ${APP_NAME} is already running (pid ${hello.pid}) — opening ${url}`);
    if (FLAGS.open || !FLAGS.serve) openBrowser(url);
    return;
  }

  // Cache dir via the documented fallback ladder (LENS_CACHE_DIR → <app>/.cache
  // → %LOCALAPPDATA% → tmp), probing writability — never assume the app dir is
  // writable (SPEC §9). Without group C the plain default below serves.
  let cacheDir = process.env.LENS_CACHE_DIR || path.join(HERE, '.cache');
  if (mods.store && typeof mods.store.ensureCacheDir === 'function') {
    try {
      const r = await mods.store.ensureCacheDir();
      if (r && r.dir) cacheDir = r.dir;
      else if (r && r.problem) console.error(`[lens] ${r.problem.message}`);
    } catch { /* keep the fallback */ }
  }
  const index = createIndexState({ projectsDir, cacheDir, mods });

  const ctx = {
    appName: APP_NAME,
    appVersion: APP_VERSION,
    projectsDir,
    projectsDirSource: source,
    // /api/config can only report what ctx carries — the settings page must
    // never say "cache directory — not reported" about a value this process
    // has held all along.
    cacheDir,
    webDir: path.join(HERE, 'web'),
    sharedDir: path.join(HERE, 'shared'),
    pricing: mods.pricing,
    ledger: mods.ledger,
    jsonl: mods.jsonl,
    config: mods.config,
    index,
  };

  const router = createRouter();
  createApi(router, ctx);
  const fallback = createStaticHandler({ webDir: ctx.webDir, sharedDir: ctx.sharedDir });
  const server = createHttpServer({ router, fallback });

  let port = wantPort;
  let addr = null;
  for (let attempt = 0; attempt < PORT_SCAN_ATTEMPTS; attempt++) {
    try { addr = await listen(server, { port, host: '127.0.0.1' }); break; }
    catch (e) {
      if (e && e.code === 'EADDRINUSE' && !FLAGS.port) {
        // Double-click race: another instance may have grabbed the port
        // BETWEEN our probe and this listen. Re-probe before walking on — the
        // rule is focus, don't duplicate (a 2nd instance = a 2nd full scan).
        const running = await probeHello(port);
        if (running) {
          const url2 = `http://127.0.0.1:${port}/`;
          console.log(`[lens] ${APP_NAME} is already running (pid ${running.pid}) — opening ${url2}`);
          if (FLAGS.open || !FLAGS.serve) openBrowser(url2);
          process.exit(0);
        }
        port += 1; continue;
      }
      console.error(`[lens] could not listen on 127.0.0.1:${port}: ${e && e.message}`);
      process.exit(1);
    }
  }
  if (!addr) { console.error('[lens] no free port found near ' + wantPort); process.exit(1); }
  // `addr` is server.address(), so `.port` is the port the OS actually gave
  // us. With `--port 0` (or PORT=0) the local `port` is still literally 0 —
  // the EADDRINUSE walk above is the only other writer and it is gated on
  // `!FLAGS.port` — so both consumers of `url` below (the console line and
  // openBrowser) must read the OS's answer, not name http://127.0.0.1:0/, an
  // address nothing listens on. `?? port` keeps a non-TCP/string address from
  // yielding undefined.
  port = addr.port ?? port;

  const url = `http://127.0.0.1:${port}/`;
  console.log(`[lens] ${APP_NAME} ${APP_VERSION} — ${url}`);
  await index.start();
  if (FLAGS.open) openBrowser(url);
}

// Run only when invoked as the entrypoint (node lens.mjs …) — importing this
// module (tests need createIndexState) must not boot a server.
const invokedDirectly = (() => {
  try { return process.argv[1] && sameDir(fileURLToPath(import.meta.url), path.resolve(process.argv[1])); }
  catch { return false; }
})();
if (invokedDirectly) {
  main().catch((e) => { console.error(`[lens] fatal: ${e && e.stack || e}`); process.exit(1); });
}
