// tests/fixes-round6.test.mjs — named regressions for the round-6 fix pass
// (fixer, 2026-08-18). One test group per validated finding id:
//
//   F1  Two writers owned S.bytesIndexed with no reconciliation. In WORKER
//       mode the worker's `progress` message OVERWRITES the field, but the
//       worker only ships cards — never rows — so the main thread's rowsStore
//       is empty after a build and EVERY first ensureParsed took the !hadRows
//       branch and ADDED a whole session's bytes on top of a counter already
//       at 100%. Measured on an isolated instance: 100.0% → 147.8% after one
//       ordinary session open → 200.0% after two, and it stayed there until
//       the next worker rebuild. /api/progress emits the number directly and
//       the 409 not-indexed-yet payload feeds an UNCLAMPED formatPercent, so
//       "1.0 MB of 683.2 KB (147.8%)" was reachable on screen.
//   F2  contextAround() sliced UTF-16 text at raw code-unit offsets. A window
//       edge landing inside an astral character's surrogate pair emitted a
//       LONE surrogate into the snippet — JSON.stringify escapes it as a bare
//       \uXXXX and the browser paints U+FFFD. Reproduced live against the real
//       corpus: 8 of 500 matches for one ordinary query carried \uDDED at
//       index 1 of ctx.
//   F3  scopeSessionList compared slugs with `===` while findSession uses
//       slugEq (case-insensitive on win32), so the SAME session was 200 on
//       /api/session/:slug/:id and 404 on /api/records|find|audit. The fix
//       canonicalises the scope's slug at the edge rather than loosening the
//       comparison — the parsed scope is forwarded to consumers that do their
//       own `===` (find.mjs, audit.mjs, buildPathA, lens.mjs ensureParsed),
//       and merely loosening here would have turned find's honest 404 into a
//       200 with `matches: 0`: a false real-zero for a scan that covered
//       nothing.
//   F4  A corrupt .cache/index.json was deleted and rebuilt in SILENCE at both
//       real load sites; loadIndexVerbose — the loader that exists to report
//       the recovery — had zero callers, which made SPEC §9's documented
//       `cache-corrupt` code unreachable in production.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createIndexState } from '../lens.mjs';
import { runFind } from '../server/find.mjs';
import { INDEX_VERSION, indexPath, loadIndex, loadIndexVerbose } from '../server/index-store.mjs';
import * as store from '../server/index-store.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import { startServer, getJson, sseCollect } from './fixtures/api/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const J = JSON.stringify;
const ts = (s) => `2026-08-01T${s}.000Z`;

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage, makeUser, asstStd as asst } from './fixtures/api/make-store.mjs';
const user = makeUser("C:\\r6\\proj");


/* ===================================================================== F1 */

describe('F1 — bytesIndexed has exactly one writer per mode', () => {
  const SLUG = 'C--r6-proj';
  const SA = '6f000000-0000-4000-8000-00000000000a';
  const SB = '6f000000-0000-4000-8000-00000000000b';

  let store6, cacheDir, idx;

  const w = async (rel, text) => {
    const abs = path.join(store6, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  };

  /** The stat walk lens.mjs's own rescan() does, without booting a worker. */
  async function rescan() {
    const table = await scan.scanStore(store6);
    const groups = scan.groupSessions(table);
    const S = idx._test.state;
    S.fileTable = table;
    S.projects = groups.projects;
    S.sessions = groups.sessions;
    S.bytesTotal = groups.sessions.reduce((a, s) => a + (s.bytes ?? 0), 0);
    S.version += 1;
  }

  /** Put the state back in the shape a finished WORKER build leaves it in:
   *  cards present, rowsStore EMPTY (the worker ships cards, never rows), and
   *  the progress message having overwritten bytesIndexed to exactly 100%. */
  function asFinishedWorkerBuild() {
    const S = idx._test.state;
    S.worker = { postMessage() {} }; // truthy = worker mode; never messaged here
    S.rowsStore.clear();
    S.details.clear();
    idx._test.handleWorkerMessage({
      type: 'progress', bytesDone: S.bytesTotal, bytesTotal: S.bytesTotal, done: 2, of: 2,
    });
  }

  before(async () => {
    store6 = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-store-'));
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-cache-'));
    await w(`${SLUG}/${SA}.jsonl`, [
      user({ sid: SA, uuid: 'r6-a-1', at: ts('10:00:00'), text: 'first session' }),
      asst({ sid: SA, uuid: 'r6-a-2', at: ts('10:00:10'), msgId: 'msg_R6A', text: 'done' }),
    ].join('\n') + '\n');
    await w(`${SLUG}/${SB}.jsonl`, [
      user({ sid: SB, uuid: 'r6-b-1', at: ts('11:00:00'), text: 'second session' }),
      asst({ sid: SB, uuid: 'r6-b-2', at: ts('11:00:10'), msgId: 'msg_R6B', text: 'done' }),
    ].join('\n') + '\n');
    idx = createIndexState({
      projectsDir: store6, cacheDir,
      mods: { pricing, ledger, jsonl, parse, scan, summary },
      restartDebounceMs: 30,
    });
    await rescan();
  });

  after(async () => {
    await fsp.rm(store6, { recursive: true, force: true });
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  test('F1 — in worker mode an on-demand parse never advances bytesIndexed past bytesTotal', async () => {
    asFinishedWorkerBuild();
    const total = idx.status().bytesTotal;
    assert.ok(total > 0, 'the fixture corpus has real bytes');
    assert.equal(idx.status().bytesIndexed, total, 'precondition: the worker build reported 100%');

    await idx.detail(SLUG, SA); // an ORDINARY first session open — no reindex, no concurrency
    assert.equal(idx.status().bytesIndexed, total,
      'one session open shipped 147.8% of total before this fix, and it stayed there');

    await idx.detail(SLUG, SB); // the second open is where it reached 200.0%
    assert.equal(idx.status().bytesIndexed, total,
      'the worker\'s progress message is the SOLE authority for this field in worker mode');
    assert.ok(idx.status().bytesIndexed <= total,
      'a byte counter past its own denominator is a documented SPEC §9 figure that is provably false');
  });

  test('F1 — concurrent opens are the same unconditional double-count, not a race', async () => {
    asFinishedWorkerBuild();
    const total = idx.status().bytesTotal;
    // The original write-up reached ~193% by racing POST /api/reindex against
    // 10 concurrent /api/records. That is just this, N times over: every caller
    // passes the rowsStore guard before any of them finishes.
    await Promise.all([
      idx.detail(SLUG, SA), idx.detail(SLUG, SA), idx.detail(SLUG, SA),
      idx.detail(SLUG, SB), idx.detail(SLUG, SB), idx.detail(SLUG, SB),
    ]);
    assert.equal(idx.status().bytesIndexed, total);
  });

  test('F1 — the in-process fallback still counts on demand: with no worker it IS the only writer', async () => {
    const S = idx._test.state;
    S.worker = null;
    S.rowsStore.clear();
    S.details.clear();
    S.bytesIndexed = 0;

    const a = S.sessions.find((s) => s.id === SA);
    const b = S.sessions.find((s) => s.id === SB);
    assert.ok(a.bytes > 0 && b.bytes > 0);

    await idx.detail(SLUG, SA);
    assert.equal(idx.status().bytesIndexed, a.bytes,
      'the fallback path has no worker progress message to overwrite it — gating on !S.worker must not silence it');
    await idx.detail(SLUG, SB);
    assert.equal(idx.status().bytesIndexed, a.bytes + b.bytes);
    assert.equal(idx.status().bytesIndexed, idx.status().bytesTotal,
      'the fallback converges to exactly 100%, as it always did');
  });
});

/* ===================================================================== F2 */

describe('F2 — contextAround never emits a lone surrogate', () => {
  const SLUG = 'C--r6-find';
  const SID = '6f000000-0000-4000-8000-0000000000f2';
  const Q = 'R6NEEDLE';              // 8 code units
  const EMOJI = '\u{1F9ED}';         // 🧭 = \uD83E\uDDED — the live corpus character
  const HI = 0xd83e;
  const LO = 0xddec + 1;             // 0xDDED

  // contextAround(text, index, len, width=80): half = floor((80-8)/2) = 36,
  // so a = index-36 and b = index+8+36 = index+44. Each fixture below places
  // the emoji so that ONE of those boundaries falls between its two surrogate
  // code units. Every filler run is ASCII (1 code unit each), and no line
  // contains "data"/"base64"/"signature", so stripHeavy leaves them untouched.
  const LEFT = 'x'.repeat(12) + EMOJI + 'y'.repeat(35) + Q + 'z'.repeat(60);
  //            [0..11]         [12,13]  [14..48]        [49..56]
  //            a = 49-36 = 13 → the LOW surrogate. b = 93 ('z'), unaffected.
  const RIGHT = 'x'.repeat(20) + Q + 'y'.repeat(35) + EMOJI + 'z'.repeat(60);
  //            [0..19]          [20..27] [28..62]     [63,64]
  //            b = 20+44 = 64 → charCodeAt(63) is the HIGH surrogate. a = 0.
  const BOTH = 'x'.repeat(12) + EMOJI + 'y'.repeat(35) + Q + 'w'.repeat(35) + EMOJI + 'z'.repeat(60);
  //            a = 13 (low) and b = 93, charCodeAt(92) = high — both edges at once.
  const CLEAN = 'x'.repeat(40) + Q + 'z'.repeat(40); // no astral char: the control

  let root, sessions, fileTable;

  const hasLoneSurrogate = (s) => {
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = s.charCodeAt(i + 1);
        if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
        i += 1;
      } else if (c >= 0xdc00 && c <= 0xdfff) return true;
    }
    return false;
  };

  async function find(q = Q) {
    const out = [];
    await runFind({
      projectsDir: root, sessions, fileTable, q,
      emit: (ev, data) => { if (ev === 'match') out.push(data); },
    });
    return out;
  }

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-find-'));
    const rel = `${SLUG}/${SID}.jsonl`;
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const body = [LEFT, RIGHT, BOTH, CLEAN]
      .map((text, i) => asst({ sid: SID, uuid: `r6-f2-${i}`, at: ts('10:00:0' + i), msgId: `msg_R6F2${i}`, text }))
      .join('\n') + '\n';
    await fsp.writeFile(abs, body, 'utf8');
    const st = await fsp.stat(abs);
    fileTable = new Map([[rel, { size: st.size, mtimeMs: st.mtimeMs }]]);
    sessions = [{ slug: SLUG, id: SID, mainRel: rel, files: [rel] }];
  });

  after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('F2 — the fixture really does straddle the window edges (the test bites)', () => {
    // Guard the arithmetic itself: if these drift, the regression stops proving
    // anything and would pass against the un-fixed slice.
    const half = Math.floor((80 - Q.length) / 2);
    const li = LEFT.indexOf(Q);
    assert.equal(LEFT.charCodeAt(li - half), LO, 'LEFT: window start lands on the emoji\'s low surrogate');
    const ri = RIGHT.indexOf(Q);
    assert.equal(RIGHT.charCodeAt(ri + Q.length + half - 1), HI, 'RIGHT: window end cuts after the high surrogate');
    assert.ok(ri + Q.length + half < RIGHT.length, 'and the window really is interior, so the guard applies');
  });

  test('F2 — an emoji straddling the window edge yields no lone surrogate and valid JSON', async () => {
    const matches = await find();
    assert.equal(matches.length, 4, 'one match per fixture line');
    for (const m of matches) {
      assert.equal(typeof m.ctx, 'string');
      assert.ok(m.ctx.includes(Q), 'the match itself is still inside the window');
      assert.ok(!hasLoneSurrogate(m.ctx),
        `line ${m.line} ctx carried a lone surrogate: ${J(m.ctx)}`);
      // What the wire actually carries: JSON.stringify escapes a lone surrogate
      // as a bare \uD800-\uDFFF, which survives JSON.parse and paints U+FFFD.
      const wire = J(m.ctx);
      assert.doesNotMatch(wire, /\\u[dD][89abAB][0-9a-fA-F]{2}/,
        'no unpaired high-surrogate escape on the wire');
      assert.doesNotMatch(wire, /\\u[dD][c-fC-F][0-9a-fA-F]{2}/,
        'no unpaired low-surrogate escape on the wire');
      assert.equal(JSON.parse(wire), m.ctx, 'round-trips exactly');
    }
  });

  test('F2 — the guard SHRINKS the window: width stays a real bound and the emoji is dropped whole', async () => {
    const byLine = new Map((await find()).map((m) => [m.line, m.ctx]));
    // Every ctx is bounded by the ellipses + at most `width` characters of body.
    for (const [line, ctx] of byLine) {
      const body = ctx.replace(/^…/, '').replace(/…$/, '');
      assert.ok(body.length <= 80, `line ${line} body grew to ${body.length} — the fix must never WIDEN the window`);
    }
    // The emoji is excluded, not half-included: a partial character is exactly
    // the thing that would have been a fabricated glyph on screen.
    assert.ok(!byLine.get(1).includes(EMOJI), 'LEFT: the bisected emoji is dropped, not half-kept');
    assert.ok(!byLine.get(2).includes(EMOJI), 'RIGHT: same on the trailing edge');
    assert.ok(!byLine.get(3).includes(EMOJI), 'BOTH edges at once');
    assert.match(byLine.get(1), /^…y+R6NEEDLEz+…$/, 'LEFT: the snippet is clean ASCII on both sides of the match');
    assert.match(byLine.get(4), /^…x+R6NEEDLEz+…$/, 'the control line is untouched by the guard');
  });
});

/* ===================================================================== F3 */

describe('F3 — scopeSessionList canonicalises the slug instead of comparing it strictly', () => {
  // Driven against the REAL index (createIndexState over real parse/ledger/
  // summary/scan) rather than the stub ctx, because the defect lives in the
  // seam between the resolver and the consumers that re-match the slug
  // themselves — find.mjs, audit.mjs, buildPathA and lens.mjs ensureParsed.
  const SLUG = 'C--R6-Case-Proj';     // mixed case on purpose
  const LC = SLUG.toLowerCase();
  const SID = '6f000000-0000-4000-8000-0000000000f3';
  const NEEDLE = 'R6CASENEEDLE';

  let store6, cacheDir, idx, srv, url;
  const win = process.platform === 'win32';

  before(async () => {
    store6 = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-case-store-'));
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-case-cache-'));
    const abs = path.join(store6, SLUG, `${SID}.jsonl`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, [
      user({ sid: SID, uuid: 'r6-f3-1', at: ts('10:00:00'), text: `${NEEDLE} please build the thing` }),
      asst({ sid: SID, uuid: 'r6-f3-2', at: ts('10:00:10'), msgId: 'msg_R6F3', text: `the ${NEEDLE} result is ready` }),
    ].join('\n') + '\n', 'utf8');

    idx = createIndexState({
      projectsDir: store6, cacheDir,
      mods: { pricing, ledger, jsonl, parse, scan, summary },
      restartDebounceMs: 30,
    });
    const table = await scan.scanStore(store6);
    const groups = scan.groupSessions(table);
    const S = idx._test.state;
    S.fileTable = table;
    S.projects = groups.projects;
    S.sessions = groups.sessions;
    S.bytesTotal = groups.sessions.reduce((a, s) => a + (s.bytes ?? 0), 0);
    S.state = 'ready';
    S.version += 1;
    await idx.detail(SLUG, SID);

    srv = await startServer({
      appName: 'lens-r6', appVersion: 'test',
      projectsDir: store6, projectsDirSource: 'fixture',
      webDir: path.join(store6, 'no-web'), sharedDir: path.join(store6, 'no-shared'),
      pricing, ledger, jsonl, config: null, index: idx,
    });
    url = srv.url;
  });

  after(async () => {
    if (srv) await srv.close();
    await fsp.rm(store6, { recursive: true, force: true });
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  test('F3 — the fixture slug really has case to lose, and the store spells it the canonical way', () => {
    assert.notEqual(LC, SLUG, 'a lowercased slug must differ from the canonical spelling');
    assert.equal(idx.sessions()[0].slug, SLUG, 'the store\'s own spelling is what everything downstream compares against');
  });

  test('F3 — /api/records agrees with /api/session on a differently-cased slug', async (t) => {
    if (!win) { t.skip('slugEq is exact off win32 — one case rule per platform'); return; }
    const detail = await getJson(`${url}/api/session/${LC}/${SID}`);
    assert.equal(detail.status, 200, '/api/session already honoured slugEq — this half was never broken');

    const lc = await getJson(`${url}/api/records?scope=session:${LC}/${SID}`);
    assert.equal(lc.status, 200, 'the identical session 404\'d here while /api/session served it 200');
    const exact = await getJson(`${url}/api/records?scope=session:${SLUG}/${SID}`);
    assert.equal(exact.status, 200);
    assert.ok(exact.body.total > 0, 'precondition: the canonical-case request has real rows');
    assert.equal(lc.body.total, exact.body.total, 'same session, same row count — no new figure was invented');
    assert.deepEqual(lc.body.rows, exact.body.rows, 'byte-for-byte the same rows');
    assert.equal(lc.body.rowsSumToHeader, exact.body.rowsSumToHeader);
    assert.equal(lc.body.rows[0].slug, SLUG,
      'rows carry the CANONICAL spelling, never the one the caller happened to type');
  });

  test('F3 — a project scope resolves case-insensitively too', async (t) => {
    if (!win) { t.skip('slugEq is exact off win32'); return; }
    const lc = await getJson(`${url}/api/records?scope=project:${LC}`);
    const exact = await getJson(`${url}/api/records?scope=project:${SLUG}`);
    assert.equal(lc.status, 200);
    assert.equal(exact.status, 200);
    assert.ok(exact.body.total > 0);
    assert.equal(lc.body.total, exact.body.total);
    assert.deepEqual(lc.body.rows, exact.body.rows);
  });

  test('F3 — /api/find returns REAL matches on a lowercased slug, never a 200 with zero', async (t) => {
    if (!win) { t.skip('slugEq is exact off win32'); return; }
    // The trap the validator called out: merely loosening the comparison in
    // scopeSessionList would have let the request past the 404 and then handed
    // find.mjs a slug its own `===` session filter matches nothing against — a
    // scan that covered no files, reported as a confident real zero. That is
    // strictly worse than the honest 404 it replaced.
    const lc = await sseCollect(`${url}/api/find?q=${NEEDLE}&scope=session:${LC}/${SID}`);
    const exact = await sseCollect(`${url}/api/find?q=${NEEDLE}&scope=session:${SLUG}/${SID}`);
    const count = (r) => r.events.filter((e) => e.event === 'match').length;
    assert.equal(lc.status, 200);
    assert.ok(count(exact) > 0, 'precondition: the canonical-case scan finds matches');
    assert.equal(count(lc), count(exact), 'a 200 with matches:0 here would be a false real-zero');
    const done = (r) => r.events.find((e) => e.event === 'done');
    assert.equal(done(lc).data.matches, done(exact).data.matches);
    // …and the scan really covered bytes, rather than walking an empty list.
    const prog = lc.events.filter((e) => e.event === 'progress').pop();
    assert.ok(prog.data.ofBytes > 0, 'the scan had files to walk');
    assert.equal(prog.data.bytesDone, prog.data.ofBytes, 'and it walked all of them');
  });

  test('F3 — /api/audit opens its stream on a lowercased slug and Path A still resolves', async (t) => {
    if (!win) { t.skip('slugEq is exact off win32'); return; }
    const r = await sseCollect(`${url}/api/audit?scope=session:${LC}/${SID}`);
    assert.equal(r.status, 200, 'the 404 fired before the stream opened');
    assert.ok(r.events.length > 0);
    assert.ok(!r.events.some((e) => e.event === 'error'), 'no audit-failed on the canonicalised scope');
  });

  test('F3 — a genuinely unknown slug is still an honest 404, not a canonicalised guess', async () => {
    const bad = await getJson(`${url}/api/records?scope=session:C--no-such-project/${SID}`);
    assert.equal(bad.status, 404);
    assert.equal(bad.body.error.code, 'unknown-session');
    const badProj = await getJson(`${url}/api/records?scope=project:C--no-such-project`);
    assert.equal(badProj.status, 404);
    assert.equal(badProj.body.error.code, 'unknown-project');
    const badId = await getJson(`${url}/api/records?scope=session:${SLUG}/00000000-0000-4000-8000-000000000000`);
    assert.equal(badId.status, 404, 'a right slug with a wrong id is still unknown');
  });
});

/* ===================================================================== F4 */

describe('F4 — a deleted cache file is disclosed, not swallowed', () => {
  const SLUG = 'C--r6-cache';
  const SID = '6f000000-0000-4000-8000-0000000000f4';
  const GARBAGE = 'this is not json {{{';

  test('F4 — loadIndexVerbose is the single implementation and loadIndex is its .index', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-cv-'));
    try {
      await fsp.writeFile(indexPath(dir), GARBAGE, 'utf8');
      const { index, problem } = await loadIndexVerbose(dir);
      assert.equal(index, null);
      assert.equal(problem.code, 'cache-corrupt');
      assert.equal(problem.scope, 'store');
      assert.equal(problem.affects, 'nothing', 'the served numbers were never wrong — only the cache was');
      await assert.rejects(fsp.stat(indexPath(dir)), (e) => e.code === 'ENOENT', 'and it is still deleted');

      // Happy path: the verbose form used to readFile+JSON.parse the file and
      // THEN call loadIndex, which read and parsed it again — two full reads of
      // a ~5.8 MB file on every boot. It is now the one implementation.
      const good = J({ indexVersion: INDEX_VERSION, cards: [{ id: 'c1', fingerprint: 'f' }], projectsDir: 'C:\\x' });
      await fsp.writeFile(indexPath(dir), good, 'utf8');
      const v = await loadIndexVerbose(dir);
      assert.equal(v.problem, null);
      assert.equal(v.index.cards.size, 1);
      const plain = await loadIndex(dir);
      assert.deepEqual([...plain.cards.keys()], [...v.index.cards.keys()],
        'loadIndex() delegates — same read, note dropped');
      assert.equal(plain.projectsDir, 'C:\\x');
      const src = await fsp.readFile(new URL('../server/index-store.mjs', import.meta.url), 'utf8');
      assert.match(src, /export async function loadIndex\(cacheDir\) \{\s*return \(await loadIndexVerbose\(cacheDir\)\)\.index;/,
        'ONE reader: loadIndex is a thin projection, so the two can never drift apart again');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('F4 — an INDEX_VERSION mismatch is NOT a problem: a designed invalidation is not an anomaly', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-cvv-'));
    try {
      const body = J({ indexVersion: INDEX_VERSION + 99, cards: [{ id: 'x' }] });
      await fsp.writeFile(indexPath(dir), body, 'utf8');
      const { index, problem } = await loadIndexVerbose(dir);
      assert.equal(index, null);
      assert.equal(problem, null, 'a version bump invalidating the cache is the designed path');
      assert.equal(await fsp.readFile(indexPath(dir), 'utf8'), body, 'and the file is left alone');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('F4 — indexer.worker.mjs posts the cache-corrupt problem from its boot load', async () => {
    // The worker's own load site, driven directly with the store stubs so this
    // needs neither group A/B nor a real corpus.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-wk-'));
    const cacheDir = path.join(root, 'cache');
    const projectsDir = path.join(root, 'projects');
    const worldPath = path.join(root, 'world.json');
    const callsPath = path.join(root, 'calls.log');
    const STUBS = path.join(HERE, 'stubs', 'store');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(worldPath, J({ files: [{ rel: `proj-a/${SID}.jsonl`, size: 100, mtimeMs: 1000 }] }));
    await fsp.writeFile(callsPath, '');
    await fsp.writeFile(indexPath(cacheDir), GARBAGE, 'utf8');

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
    const inbox = [];
    try {
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; saw ${J(inbox.map((m) => m.type))}`)), 15000);
        worker.on('message', (m) => { inbox.push(m); if (m.type === 'ready') { clearTimeout(timer); resolve(m); } });
        worker.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      worker.postMessage({ type: 'start', projectsDir, cacheDir });
      await ready;

      const notes = inbox.filter((m) => m.type === 'problem' && m.problem?.code === 'cache-corrupt');
      assert.equal(notes.length, 1, 'the worker deleted the file in silence before this fix');
      assert.equal(notes[0].problem.scope, 'store');
      assert.equal(notes[0].problem.affects, 'nothing');
      assert.match(notes[0].problem.message, /index\.json/);
      assert.ok(inbox.some((m) => m.type === 'card'), 'and the rebuild still happened');
    } finally {
      await worker.terminate();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test('F4 — lens.mjs\'s pre-worker seed forwards the note into problems(), and the cache is rebuilt', async () => {
    const store6 = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-seed-store-'));
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r6-seed-cache-'));
    let idx = null;
    try {
      const abs = path.join(store6, SLUG, `${SID}.jsonl`);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, [
        user({ sid: SID, uuid: 'r6-f4-1', at: ts('10:00:00'), text: 'hello' }),
        asst({ sid: SID, uuid: 'r6-f4-2', at: ts('10:00:10'), msgId: 'msg_R6F4', text: 'hi' }),
      ].join('\n') + '\n', 'utf8');
      await fsp.writeFile(indexPath(cacheDir), GARBAGE, 'utf8');

      idx = createIndexState({
        projectsDir: store6, cacheDir,
        mods: { pricing, ledger, jsonl, parse, scan, summary, store },
        restartDebounceMs: 30,
      });
      await idx.start(); // the seed load is awaited inside start(), before the worker spawns

      const notes = idx.problems().filter((p) => p.code === 'cache-corrupt');
      assert.equal(notes.length, 1,
        'startup logged nothing and /api/index came back with problems: [] before this fix');
      assert.equal(notes[0].scope, 'store');
      assert.equal(notes[0].severity, 'note');
      assert.equal(notes[0].affects, 'nothing');

      // …and the recovery itself still works: the worker rebuilds a valid cache.
      const deadline = Date.now() + 20000;
      let text = null;
      while (Date.now() < deadline) {
        try {
          const t = await fsp.readFile(indexPath(cacheDir), 'utf8');
          const obj = JSON.parse(t);
          if (obj.indexVersion === INDEX_VERSION && obj.cards.length > 0) { text = t; break; }
        } catch { /* not written yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(text, 'the corrupt cache was replaced by a valid one');

      // The duplicate-note worry the queue names: whichever load runs first
      // deletes the file, the second gets ENOENT and reports nothing — and
      // problems() collapses by code|scope regardless, so count stays 1.
      const after = idx.problems().filter((p) => p.code === 'cache-corrupt');
      assert.equal(after.length, 1);
      assert.equal(after[0].count, 1, 'one recovery, one note');
    } finally {
      const wk = idx?._test?.state?.worker;
      if (wk) await wk.terminate();
      await fsp.rm(store6, { recursive: true, force: true });
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });
});
