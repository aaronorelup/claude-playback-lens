// tests/fixes-round14.test.mjs — named regressions for the round-14 fix pass,
// SERVER side. (The browser-side R14-D1 staleness cases live in
// tests/web-stale-render.test.mjs.)
//
//   R14-F2 (lens.mjs — reindex() / indexAll(), no-worker fallback path only)
//       reindex()'s fallback branch ran `S.cards.clear()` from OUTSIDE the
//       loop, unconditionally, and then called indexAll({force:true}) — whose
//       very first line is `if (S.indexing) return;`. So a rebuild requested
//       while one was already running wiped the card map and then rebuilt
//       NOTHING: the surviving loop never revisits sessions it has already
//       passed, so those cards were gone for the life of the process. The loop
//       still set state:'ready' at the end of its pass, so /api/index reported
//       a complete index (state:'ready', r2:'resolved') while sessionsDone sat
//       short of sessionsTotal and every stranded session answered
//       409 not-indexed-yet at /api/session — permanently. Worker mode is
//       protected by the worker's own generation counter; this is
//       fallback-specific, and the trigger is broader than a double click:
//       start() fires indexAll() un-awaited at boot, so ONE reindex landing
//       during the initial build takes the identical path.
//
//   R14-F1 (server/find.mjs — makeMatcher() / runFind())
//       The matcher case-folded but never normalized, so a query composed in
//       NFC (a keyboard, a browser <input>, an IME) could not match text stored
//       in NFD. 'café' as caf+U+00E9 vs caf+e+U+0301 is the same word and the
//       same glyphs, and the scan answered a clean `done {matches:0}` — a
//       zero indistinguishable from a real absence. The fix normalizes at the
//       CALL SITE so `index` and the emitted `ctx` snippet are offsets into the
//       same string; the second assertion in each case below (the ctx contains
//       what was matched) is what catches the offset half of it.
//
// The R14-F2 fixture is a REAL createIndexState over the REAL group A/B mods,
// with no worker (no start() is called, so S.hasWorker stays false and
// reindex() takes the fallback branch — the shipped path, not a model of it).
// The only instrumentation is a gate around parse.parseSession so the test,
// not the scheduler, decides when the first pass is mid-flight.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createIndexState } from '../lens.mjs';
import { runFind } from '../server/find.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import * as config from '../server/config.mjs';
import * as store from '../server/index-store.mjs';
import * as lru from '../server/lru.mjs';

const J = JSON.stringify;

/* ==================================================================== R14-F2 */

const F2_SLUG = 'C--r14-fallback';

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage } from './fixtures/api/make-store.mjs';

function sessionLines(sid, turns) {
  const lines = [];
  const pad = 'x'.repeat(200);
  for (let i = 0; i < turns; i++) {
    const at = new Date(Date.UTC(2026, 7, 1, 10, 0, i)).toISOString();
    lines.push(J({
      parentUuid: null, isSidechain: false, type: 'user', uuid: `u${i}`,
      timestamp: at, sessionId: sid, origin: { kind: 'human' }, cwd: 'C:\\r14\\proj',
      message: { role: 'user', content: `request ${i} ${pad}` },
    }));
    lines.push(J({
      parentUuid: null, isSidechain: false, type: 'assistant', uuid: `a${i}`,
      timestamp: at, sessionId: sid,
      message: {
        id: `msg_${sid.slice(0, 8)}_${i}`, model: 'claude-fable-5', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: `answer ${i} ${pad}` }],
        stop_reason: 'end_turn', usage: usage(100, 50),
      },
    }));
  }
  return lines.join('\n') + '\n';
}

/**
 * parse.parseSession, wrapped so the test can park the Nth parse of a pass
 * AFTER its real work — which is what makes "mid-flight" deterministic and,
 * crucially, guarantees the first N-1 cards are already WRITTEN when the gate
 * is reached. Those already-written cards are exactly what the old
 * clear-from-outside destroyed. No logic is changed; the count is the only
 * instrumentation.
 */
function makeGatedParse() {
  const st = { count: 0, gate: null };
  st.reset = () => { st.count = 0; st.gate = null; };
  st.holdNth = (n) => {
    let reached, release;
    const g = {
      n,
      reached: new Promise((r) => { reached = r; }),
      held: new Promise((r) => { release = r; }),
      released: false,
    };
    g.signalReached = () => reached();
    g.release = () => { if (!g.released) { g.released = true; release(); } };
    st.gate = g;
    return g;
  };
  return {
    st,
    mod: {
      ...parse,
      parseSession: async (...args) => {
        const nth = ++st.count;
        const model = await parse.parseSession(...args);
        const g = st.gate;
        if (g && g.n === nth) { st.gate = null; g.signalReached(); await g.held; }
        return model;
      },
    },
  };
}

/** The stat walk lens.mjs's own rescan() does (same helper rounds 3/13 use). */
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

/** Poll until the fallback indexer is idle, SAMPLING THE INVARIANT throughout.
 *  The assertion is not about the race — it is about the payload the race used
 *  to produce, so every sample counts, not just the last one. */
async function settleIndex(index, { timeoutMs = 15000 } = {}) {
  const S = index._test.state;
  const t0 = Date.now();
  const samples = [];
  for (;;) {
    const st = index.status();
    samples.push(st);
    assert.ok(
      !(st.state === 'ready' && st.sessionsDone !== st.sessionsTotal),
      `state:'ready' with ${st.sessionsDone} of ${st.sessionsTotal} sessions — `
      + 'the index claimed completeness it does not have (R14-F2)');
    if (!S.indexing && st.state === 'ready') return samples;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`the fallback index never settled: ${J(st)} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('R14-F2 — a repeat reindex in the no-worker fallback strands no session', () => {
  const IDS = Array.from({ length: 8 }, (_, i) =>
    `f2000000-0000-4000-8000-0000000000${i.toString(16).padStart(2, '0')}`);
  let projectsDir, cacheDir, index, P;

  before(async () => {
    projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r14-f2-proj-'));
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r14-f2-cache-'));
    await fsp.mkdir(path.join(projectsDir, F2_SLUG), { recursive: true });
    for (const sid of IDS) {
      await fsp.writeFile(path.join(projectsDir, F2_SLUG, `${sid}.jsonl`), sessionLines(sid, 20), 'utf8');
    }
    P = makeGatedParse();
    // No start(): no worker thread, so S.hasWorker stays false and reindex()
    // takes the in-process fallback branch — the branch under test.
    index = createIndexState({
      projectsDir, cacheDir,
      mods: { pricing, ledger, jsonl, parse: P.mod, scan, summary, config, store, lru },
      restartDebounceMs: 30,
    });
    await rescanInto(index, projectsDir);
  });

  after(async () => {
    try { await index.close(); } catch { /* best effort */ }
    try { await fsp.rm(projectsDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { await fsp.rm(cacheDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('R14-F2: the fixture really is in fallback mode (no worker) — otherwise this file proves nothing', () => {
    const S = index._test.state;
    assert.equal(S.hasWorker, false, 'no worker was spawned, so reindex() takes the fallback branch');
    assert.equal(S.worker, null);
    assert.equal(index.status().sessionsTotal, IDS.length);
  });

  test('R14-F2: a reindex fired MID-BUILD leaves every session indexed, and never reports a false ready', async () => {
    const S = index._test.state;
    const HOLD_AT = 3;              // two sessions are already written when we park
    P.st.reset();
    const g = P.st.holdNth(HOLD_AT);
    let doneMidflight = null, samples = null;
    try {
      // Rebuild #1, parked partway through — the seconds-long window a real
      // 240 MB store has, made deterministic.
      await index.reindex();
      await g.reached;
      assert.equal(S.indexing, true, 'rebuild #1 is mid-flight — the window this is about');
      doneMidflight = S.cards.size;

      // …and the reader clicks re-index again while the progress bar is still
      // moving. In fallback mode that is ordinary behaviour, not an exotic
      // double click: start() fires the initial indexAll() un-awaited too.
      await index.reindex();
    } finally {
      g.release();                  // never leave the fixture parked, even on failure
    }
    samples = await settleIndex(index);

    assert.equal(doneMidflight, HOLD_AT - 1,
      'the sessions rebuild #1 had already written — precisely what the old S.cards.clear() destroyed');
    assert.ok(samples.length > 1, 'the invariant was sampled while the rebuild ran, not only at the end');

    const st = index.status();
    assert.equal(st.state, 'ready');
    assert.equal(st.sessionsDone, IDS.length,
      'every session survived the repeat reindex — the old code stranded the ones rebuild #1 had already passed');
    for (const sid of IDS) {
      assert.ok(S.cards.has(sid), `session ${sid} is present in the card map (it used to 409 forever)`);
    }
  });

  test('R14-F2: the superseded click is QUEUED, not swallowed — a second full pass really runs', async () => {
    // Merely refusing the concurrent call is outcome-correct too, but it makes
    // the one exposed recovery action a silent no-op. The queued rerun is the
    // difference, so it gets its own assertion.
    const S = index._test.state;
    await settleIndex(index);
    P.st.reset();
    const g = P.st.holdNth(3);
    try {
      await index.reindex();
      await g.reached;
      await index.reindex();        // superseded — must be remembered, not dropped
    } finally { g.release(); }
    await settleIndex(index);

    assert.ok(P.st.count >= IDS.length * 2,
      `two full passes ran, not one (saw ${P.st.count} parses for ${IDS.length} sessions)`);
    assert.equal(index.status().sessionsDone, IDS.length);
    assert.equal(S.cards.size, IDS.length);
  });

  test('R14-F2: an ordinary single reindex still rebuilds the whole store', async () => {
    P.st.reset();
    await settleIndex(index);
    await index.reindex();
    await settleIndex(index);
    const st = index.status();
    assert.equal(st.state, 'ready');
    assert.equal(st.sessionsDone, st.sessionsTotal);
    assert.equal(P.st.count, IDS.length, 'exactly one pass — no runaway rerun loop');
  });
});

/* ==================================================================== R14-F1 */

const F1_SLUG = 'C--r14-nfc';
const F1_ID = 'f1000000-0000-4000-8000-00000000000a';

const NFC = 'caf\u00e9';          // caf + é
const NFD = 'cafe\u0301';         // caf + e + combining acute
const LIGATURE = '\ufb01';        // 'ﬁ' — compatibility-equivalent to 'fi', NOT canonical

/** One scan over a one-line, one-file fixture. Returns the emitted events. */
async function scanFor(dir, lineText, { q, re = false, caseSensitive = false }) {
  const rel = `${F1_SLUG}/${F1_ID}.jsonl`;
  await fsp.mkdir(path.join(dir, F1_SLUG), { recursive: true });
  await fsp.writeFile(path.join(dir, F1_SLUG, `${F1_ID}.jsonl`), lineText + '\n', 'utf8');
  const events = [];
  await runFind({
    projectsDir: dir,
    sessions: [{ slug: F1_SLUG, id: F1_ID, mainRel: rel, files: [rel] }],
    fileTable: new Map([[rel, { size: Buffer.byteLength(lineText) + 1, mtimeMs: 1 }]]),
    q, re, caseSensitive, scope: { kind: 'store' },
    emit: (ev, d) => events.push({ ev, d }),
  });
  return events;
}
const matchesOf = (events) => events.filter((e) => e.ev === 'match').map((e) => e.d);

/** A line whose BLOCK text carries the needle, with combining marks ahead of it
 *  — the arrangement that shifts a context window if index and text disagree
 *  about normalization form. */
function blockLine(text) {
  return J({
    parentUuid: null, isSidechain: false, type: 'assistant', uuid: 'a0',
    timestamp: '2026-08-01T10:00:00.000Z', sessionId: F1_ID,
    message: {
      id: 'msg_nfc_0', model: 'claude-fable-5', type: 'message', role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

describe('R14-F1 — find matches canonically equivalent text, and its context window agrees', () => {
  let dir;
  before(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r14-f1-')); });
  after(async () => { try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('R14-F1: sanity — the two spellings really are different strings that look identical', () => {
    assert.notEqual(NFC, NFD, 'if these were equal the whole finding would be vacuous');
    assert.equal(NFC.normalize('NFC'), NFD.normalize('NFC'));
    assert.equal(NFC.length, 4);
    assert.equal(NFD.length, 5, 'the decomposed form is one code unit longer — the offset trap');
  });

  test('R14-F1: an NFC query finds text stored DECOMPOSED (the reported silent zero)', async () => {
    const events = await scanFor(dir, blockLine(`notes about the ${NFD} shop on main street`), { q: NFC });
    const m = matchesOf(events);
    assert.equal(m.length, 1, 'this used to be a clean done {matches:0}, indistinguishable from a real absence');
    assert.equal(m[0].line, 1);
    assert.match(m[0].ctx.normalize('NFC'), new RegExp(NFC),
      'the emitted snippet must actually contain what was matched');
  });

  test('R14-F1: a DECOMPOSED query finds text stored in NFC (the same gap, mirrored)', async () => {
    const events = await scanFor(dir, blockLine(`notes about the ${NFC} shop on main street`), { q: NFD });
    assert.equal(matchesOf(events).length, 1);
  });

  test('R14-F1: the ctx window still CONTAINS the match when combining marks precede it', async () => {
    // 30 combining marks ahead of the needle: normalizing the haystack for the
    // match but cutting ctx from the raw string slides the window 30 units left
    // and can drop the match out of the snippet entirely — an honest-address app
    // emitting a quotation that does not contain what it says it found.
    const runway = `${NFD} `.repeat(30);
    const events = await scanFor(dir, blockLine(`${runway}the ${NFD} shop`), { q: NFC });
    const m = matchesOf(events);
    assert.equal(m.length, 1);
    assert.match(m[0].ctx.normalize('NFC'), new RegExp(NFC),
      'index and ctx must be offsets into the SAME string, whatever the form');
  });

  test('R14-F1: a line-level (non-block) match normalizes too — metadata keys keep matching', async () => {
    // cwd is envelope metadata, outside any content block: bi must stay null.
    const line = J({
      parentUuid: null, isSidechain: false, type: 'user', uuid: 'u0',
      timestamp: '2026-08-01T10:00:00.000Z', sessionId: F1_ID,
      cwd: `C:\\users\\${NFD}\\proj`,
      message: { role: 'user', content: 'plain ascii body' },
    });
    const m = matchesOf(await scanFor(dir, line, { q: NFC }));
    assert.equal(m.length, 1);
    assert.equal(m[0].bi, null, 'a match outside any block is addressed by line only — never a fabricated bi');
  });

  test('R14-F1: case-sensitive search normalizes as well — the two knobs are independent', async () => {
    const events = await scanFor(dir, blockLine(`the ${NFD} shop`), { q: NFC, caseSensitive: true });
    assert.equal(matchesOf(events).length, 1);
    const miss = await scanFor(dir, blockLine(`the ${NFD} shop`), { q: NFC.toUpperCase(), caseSensitive: true });
    assert.equal(matchesOf(miss).length, 0, 'case-sensitivity still means what it says');
  });

  test('R14-F1: a REGEX subject is normalized, and the pattern itself is left exactly as typed', async () => {
    const events = await scanFor(dir, blockLine(`the ${NFD} shop`), { q: NFC, re: true });
    assert.equal(matchesOf(events).length, 1, 'the subject text is NFC, so an ordinary typed regex matches it');
    // The pattern is syntax, not text: normalizing it would rewrite the regex.
    // Pinned here so a future "normalize both sides" edit has to argue with a test.
    const meta = await scanFor(dir, blockLine('literal a+b here'), { q: 'a\\+b', re: true });
    assert.equal(matchesOf(meta).length, 1, 'escapes in the pattern survive untouched');
  });

  test('R14-F1: normalization is CANONICAL only — "fi" still does not match the ﬁ ligature', async () => {
    // NFKC would fold these together. Deliberately not applied: a compatibility
    // fold would silently change what a literal search means (SPEC §9).
    const events = await scanFor(dir, blockLine(`the ${LIGATURE}le was opened`), { q: 'file' });
    assert.equal(matchesOf(events).length, 0,
      'canonical equivalence is the whole scope of R14-F1 — this zero is a true zero');
  });

  test('R14-F1: a plain-ASCII query is completely unaffected', async () => {
    const m = matchesOf(await scanFor(dir, blockLine('notes about the shop on main street'), { q: 'main street' }));
    assert.equal(m.length, 1);
    assert.match(m[0].ctx, /main street/);
  });
});
