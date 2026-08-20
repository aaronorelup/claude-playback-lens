// tests/fixes-round13.test.mjs — named regressions for the round-13 fix pass.
//
//   R13-D1 (lens.mjs — ensureParsed()/ensureModel()/parseOne()/reindex())
//       A REGRESSION planted by R12-F1's in-flight dedup. Before it, a request
//       arriving after handleWorkerMessage's `stale` handler cleared
//       S.rowsStore ran its own parse and had a real chance at fresh data.
//       After it, that request UNCONDITIONALLY joined whatever promise was
//       already in the map for the id — a parse of the PRE-change bytes — and
//       when that parse resolved, parseOne's unconditional writes put the
//       cleared rows straight back, fingerprinted with bytes that were no
//       longer on disk. ensureParsed's only warm guard was
//       `S.rowsStore.has(id)`, and the worker reports a session's staleness
//       exactly once per change, so every later request then short-circuited
//       on the resurrected rows until the file happened to change AGAIN. That
//       is the R3-1 contract ("the rows are gone — the next request
//       reparses", tests/fixes-round3.test.mjs) silently inverted.
//
//       reindex() carried the identical hole: it clears the same stores and
//       likewise left the in-flight maps populated, so a request landing after
//       POST /api/reindex joined the pre-reindex parse and re-warmed
//       S.rowsStore with pre-reindex data.
//
// The fix must hold TWO properties at once, and this file pins both:
//   (a) an invalidation EVICTS the id from inflightParse/inflightModel, so the
//       next caller parses the current bytes instead of joining a superseded
//       parse — and a superseded parse's own late write is MARKED `dirty`
//       (never suppressed: suppressing it would leave need() throwing
//       PendingError forever for any session being appended to, the 409 loop
//       COR-15 exists to prevent), so the request after it reparses;
//   (b) R12-F1's dogpile dedup still works — including AFTER an eviction,
//       which is exactly where an unguarded `.finally(() => map.delete(id))`
//       silently breaks it by deleting the NEWER entry when the OLDER promise
//       settles. tests/fixes-round12-dogpile.test.mjs pins the same property
//       over a real server; this file pins it across the eviction seam.
//
// Like tests/fixes-round3.test.mjs, these drive the REAL index over a
// throwaway store and drive the worker's own `stale` message through the
// documented `_test.handleWorkerMessage` seam — no worker thread, so the
// timing is the test's and not a 5 s rescan tick's. The ONLY instrumentation
// is a wrapper around parse.parseSession that counts calls and can hold a
// FINISHED parse in flight; no logic is changed, and the count is the
// assertion.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createIndexState } from '../lens.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import * as config from '../server/config.mjs';
import * as store from '../server/index-store.mjs';
import * as lru from '../server/lru.mjs';

const SLUG = 'C--r13-stale';
const J = JSON.stringify;
const APPENDED = 'msg_APPENDED_R13';

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage } from './fixtures/api/make-store.mjs';

/** A session with enough lines that a parse is real work, not a lucky tick. */
function sessionLines(sid, turns) {
  const lines = [];
  const pad = 'x'.repeat(400);
  for (let i = 0; i < turns; i++) {
    const at = new Date(Date.UTC(2026, 7, 1, 10, 0, i)).toISOString();
    lines.push(J({
      parentUuid: null, isSidechain: false, type: 'user', uuid: `u${i}`,
      timestamp: at, sessionId: sid, origin: { kind: 'human' }, cwd: 'C:\\r13\\proj',
      message: { role: 'user', content: `request ${i} ${pad}` },
    }));
    lines.push(J({
      parentUuid: null, isSidechain: false, type: 'assistant', uuid: `a${i}`,
      timestamp: at, sessionId: sid,
      message: {
        id: `msg_${sid.slice(0, 4)}_${i}`, model: 'claude-fable-5', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: `answer ${i} ${pad}` }],
        stop_reason: 'end_turn', usage: usage(100, 50),
      },
    }));
  }
  return lines.join('\n') + '\n';
}

/** The one line that only a parse of the CURRENT bytes can possibly report. */
function appendedTurn(sid) {
  const at = new Date(Date.UTC(2026, 7, 1, 11, 0, 0)).toISOString();
  return [
    J({
      parentUuid: null, isSidechain: false, type: 'user', uuid: 'uAPPENDED',
      timestamp: at, sessionId: sid, origin: { kind: 'human' }, cwd: 'C:\\r13\\proj',
      message: { role: 'user', content: 'one more request, written while a parse was in flight' },
    }),
    J({
      parentUuid: null, isSidechain: false, type: 'assistant', uuid: 'aAPPENDED',
      timestamp: at, sessionId: sid,
      message: {
        id: APPENDED, model: 'claude-fable-5', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'the appended answer' }],
        stop_reason: 'end_turn', usage: usage(100, 50),
      },
    }),
  ].join('\n') + '\n';
}

/**
 * parse.parseSession, wrapped so a test can (a) count parses and (b) hold a
 * COMPLETED parse in flight. Holding it AFTER the real read is what makes the
 * fixture deterministic: the held parse provably carries the pre-change bytes,
 * and the test alone decides when its write lands.
 */
function makeGatedParse() {
  const st = { count: 0, live: 0, peak: 0, queue: [] };
  st.arm = () => {
    let reached, release;
    const g = {
      reached: new Promise((r) => { reached = r; }),
      held: new Promise((r) => { release = r; }),
    };
    g.signalReached = () => reached();
    g.release = () => release();
    st.queue.push(g);
    return g;
  };
  const wrapped = {
    ...parse,
    parseSession: async (...args) => {
      st.count += 1;
      st.live += 1;
      if (st.live > st.peak) st.peak = st.live;
      const gate = st.queue.shift() ?? null;
      try {
        const model = await parse.parseSession(...args);
        if (gate) { gate.signalReached(); await gate.held; }
        return model;
      } finally { st.live -= 1; }
    },
  };
  return { mod: wrapped, st };
}

/** One turn of the event loop — the map decision is synchronous, this is slack. */
const settle = () => new Promise((r) => setImmediate(r));

/**
 * Fail LOUDLY, not by hanging. Against the unfixed code the post-invalidation
 * request does not merely get stale data — it joins a parse this fixture is
 * deliberately holding open, so it never settles at all. Without this a
 * regression reads as a hung suite instead of a named failure.
 */
function withDeadline(promise, ms, what) {
  let t;
  const bell = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} (still unsettled after ${ms}ms)`)), ms);
    if (t.unref) t.unref();
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(t));
}

/** The stat walk lens.mjs's own rescan() does; the fileTable moves
 *  independently of the parsed cards (same helper tests/fixes-round3 uses). */
async function rescanInto(index, root) {
  const table = await scan.scanStore(root);
  const groups = scan.groupSessions(table);
  const S = index._test.state;
  S.fileTable = table;
  S.projects = groups.projects;
  S.sessions = groups.sessions;
  S.bytesTotal = groups.sessions.reduce((a, s) => a + (s.bytes ?? 0), 0);
  S.version += 1;
}

/** The fingerprint parseOne would compute for this session RIGHT NOW. */
function liveFingerprint(index, id) {
  const S = index._test.state;
  const entry = S.sessions.find((s) => s.id === id);
  const files = entry.files.map((rel) => ({ rel, ...(S.fileTable.get(rel) ?? { size: 0, mtimeMs: 0 }) }));
  return scan.fingerprint(files.slice().sort((a, b) => (a.rel < b.rel ? -1 : 1)));
}

async function makeFixture(prefix, sessionIds) {
  const projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), `lens-r13-${prefix}-proj-`));
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), `lens-r13-${prefix}-cache-`));
  await fsp.mkdir(path.join(projectsDir, SLUG), { recursive: true });
  for (const sid of sessionIds) {
    await fsp.writeFile(path.join(projectsDir, SLUG, `${sid}.jsonl`), sessionLines(sid, 120), 'utf8');
  }
  const P = makeGatedParse();
  // No start(): no worker thread and no 5 s liveness tick, so every event in
  // these tests is one the test itself fired. `stale` still arrives through
  // the real handler, which is the seam under test.
  const index = createIndexState({
    projectsDir, cacheDir,
    mods: { pricing, ledger, jsonl, parse: P.mod, scan, summary, config, store, lru },
    restartDebounceMs: 30,
  });
  await rescanInto(index, projectsDir);
  return { projectsDir, cacheDir, index, P };
}

async function dropFixture(f) {
  try { await f.index.close(); } catch { /* best effort */ }
  try { await fsp.rm(f.projectsDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { await fsp.rm(f.cacheDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ R13-D1 */

describe('R13-D1 — a `stale` message that lands mid-parse is not undone by the parse it interrupted', () => {
  const SID = 'd1000000-0000-4000-8000-00000000000a';
  const SID2 = 'd1000000-0000-4000-8000-00000000000b';
  let f;

  before(async () => { f = await makeFixture('stale', [SID, SID2]); });
  after(async () => { await dropFixture(f); });

  test('R13-D1: a request arriving AFTER `stale` runs its own parse and is served FRESH data', async () => {
    const { index, P, projectsDir } = f;
    const file = path.join(projectsDir, SLUG, `${SID}.jsonl`);

    // call 1: a cold parse, held in flight the moment it has read the file —
    // the seconds-long window a 240 MB session really has.
    const g1 = P.st.arm();
    const call1 = index.rows(SLUG, SID);
    await g1.reached;
    assert.equal(P.st.count, 1, 'one parse is in flight, holding the PRE-change bytes');

    // the session grows on disk while that parse is in flight, and the stat
    // walk notices — this is the ordinary 5 s tick landing inside a cold parse
    await fsp.appendFile(file, appendedTurn(SID), 'utf8');
    await rescanInto(index, projectsDir);

    // exactly the message the worker sends when it sees a fingerprint move
    index._test.handleWorkerMessage({ type: 'stale', sessionIds: [SID] });
    assert.ok(!index._test.state.rowsStore.has(SID),
      'the rows are dropped — the R3-1 contract, unchanged');

    // call 2 arrives strictly after the staleness signal. It must NOT be
    // handed the in-flight parse of bytes the process already knows are stale.
    const rows2 = await withDeadline(index.rows(SLUG, SID), 10000,
      'the post-stale request joined the parse this test is holding open instead of starting its own');
    assert.equal(P.st.count, 2,
      'the post-stale caller ran its OWN parse — joining the superseded one is a dedup serving known-stale data');
    assert.ok(rows2.some((r) => r.msgId === APPENDED),
      'and it was served the appended line: only a parse of the CURRENT bytes can report it');

    // The superseded parse's own write still lands — the data is real and is
    // fingerprinted with the bytes it actually read, and dropping it would
    // strand need() in a PendingError loop for any session being appended to.
    g1.release();
    const rows1 = await call1;
    assert.ok(!rows1.some((r) => r.msgId === APPENDED),
      'call 1 read the pre-change bytes and reports the pre-change lines, honestly');

    // …but it does not get to STAND. It is marked superseded, so the next
    // request reparses instead of short-circuiting on it — which is precisely
    // what R12-F1 broke and what R3-1 says must happen.
    const before = P.st.count;
    const rows3 = await index.rows(SLUG, SID);
    assert.equal(P.st.count, before + 1,
      'the request after a superseded write reparses — a stale write is marked, never trusted');
    assert.ok(rows3.some((r) => r.msgId === APPENDED), 'and it is fresh again');
    assert.equal(index.cards().get(SID).fingerprint, liveFingerprint(index, SID),
      'and the stored card now names the bytes that are actually on disk');

    // and once the index has caught up, the warm guard short-circuits again:
    // `dirty` is a retraction, not a permanent reparse tax
    const settled = P.st.count;
    await index.rows(SLUG, SID);
    assert.equal(P.st.count, settled, 'a caught-up session parses zero times');
  });

  test('R13-D1: eviction must not break R12-F1 dedup — the older promise settling cannot delete the newer entry', async () => {
    const { index, P, projectsDir } = f;
    const file = path.join(projectsDir, SLUG, `${SID2}.jsonl`);

    const gA = P.st.arm();
    const callA = index.rows(SLUG, SID2);
    await gA.reached;
    const base = P.st.count;

    await fsp.appendFile(file, appendedTurn(SID2), 'utf8');
    await rescanInto(index, projectsDir);
    index._test.handleWorkerMessage({ type: 'stale', sessionIds: [SID2] });

    // B is evicted onto its own parse…
    const gB = P.st.arm();
    const callB = index.rows(SLUG, SID2);
    await withDeadline(gB.reached, 10000,
      'the post-stale caller joined the held parse instead of starting one of its own');
    assert.equal(P.st.count, base + 1, 'the post-stale caller started a second parse');

    // …and C, arriving while B is in flight, JOINS it. R12-F1's whole point.
    const callC = index.rows(SLUG, SID2);
    await settle();
    assert.equal(P.st.count, base + 1,
      'a caller arriving during the fresh parse joins it — the dogpile fix still holds after an eviction');

    // A settles FIRST, and its `.finally` runs against a map key now holding
    // B's promise. An unguarded `map.delete(id)` deletes B's entry here, and
    // every caller after this point starts a parse of its own.
    gA.release();
    await callA;
    const callD = index.rows(SLUG, SID2);
    await settle();
    assert.equal(P.st.count, base + 1,
      'the older promise settling must not evict the NEWER map entry — that silently restores the dogpile');

    gB.release();
    const [rowsB, rowsC, rowsD] = await Promise.all([callB, callC, callD]);
    for (const [name, rows] of [['B', rowsB], ['C', rowsC], ['D', rowsD]]) {
      assert.ok(rows.some((r) => r.msgId === APPENDED), `caller ${name} was served the fresh parse's rows`);
    }
    // Exactly TWO parses ran for four callers across an invalidation: the
    // superseded one, and the one the eviction correctly allowed.
    assert.equal(P.st.count, base + 1, 'four callers, one eviction, one extra parse');
  });
});

describe('R13-D1 (reindex twin) — POST /api/reindex evicts the in-flight parse too', () => {
  const SID = 'd1000000-0000-4000-8000-00000000000c';
  let f;

  before(async () => {
    f = await makeFixture('reindex', [SID]);
    // reindex() branches on indexer mode. Worker mode is the shipped one, and
    // it is the branch that only clears the stores — the fallback branch
    // re-runs indexAll() and would parse in the background, which is not the
    // seam under test. A no-op stand-in puts reindex() on the shipped branch
    // without a thread whose timing the test does not own.
    const S = f.index._test.state;
    S.hasWorker = true;
    S.worker = { postMessage() {}, terminate() {} };
  });
  after(async () => { await dropFixture(f); });

  test('R13-D1: a request arriving AFTER reindex() reparses instead of joining the pre-reindex parse', async () => {
    const { index, P, projectsDir } = f;
    const file = path.join(projectsDir, SLUG, `${SID}.jsonl`);

    const gA = P.st.arm();
    const callA = index.rows(SLUG, SID);
    await gA.reached;
    assert.equal(P.st.count, 1);

    await fsp.appendFile(file, appendedTurn(SID), 'utf8');
    await rescanInto(index, projectsDir);

    await index.reindex();
    assert.ok(!index._test.state.rowsStore.has(SID), 'reindex drops every parsed row');

    const rowsB = await withDeadline(index.rows(SLUG, SID), 10000,
      'the post-reindex request joined the pre-reindex parse this test is holding open');
    assert.equal(P.st.count, 2,
      'the post-reindex caller reparses — joining the pre-reindex parse would re-warm the store it just cleared');
    assert.ok(rowsB.some((r) => r.msgId === APPENDED), 'and it is served the current bytes');

    gA.release();
    await callA;

    const before = P.st.count;
    const rowsC = await index.rows(SLUG, SID);
    assert.equal(P.st.count, before + 1,
      'the pre-reindex parse\'s late write is marked superseded, so the next request reparses');
    assert.ok(rowsC.some((r) => r.msgId === APPENDED));
  });
});
