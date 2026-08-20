// tests/fixes-round8.test.mjs — named regressions for the round-8 fix pass.
// One group per validated finding id:
//
//   R8-WORKER (blocker)
//       lens.mjs spawned the indexer worker exactly once, at boot. The `exit`
//       and `error` handlers set S.alive = false and NOTHING anywhere ever
//       built a replacement or set it back, so a single crash 503'd every
//       index-backed route for the life of the process — and the worker
//       deliberately process.exit(1)s on any uncaughtException over untrusted
//       transcript data, so that state was reachable by design. The one exposed
//       recovery action, POST /api/reindex, was itself gated on a live worker,
//       and /api/index (the only route carrying problems[]) 503'd too, so the
//       failure could not even be diagnosed.
//
//   R8-PROB-1
//       The store-level problems census was an append-only log with a 200-entry
//       FIFO: a session that stopped exhibiting a condition kept its row
//       forever (disagreeing with that session's own /api/session payload),
//       re-parsing an UNCHANGED condition inflated `count` every few seconds,
//       and 200+ re-posts silently evicted still-true store-scope errors. A
//       warm boot showed the opposite failure: an empty census while the
//       sessions had real problems.
//
//   R8-SYMLINK
//       scanStore's walk recursed isDirectory() and tabled isFile(); a
//       symlink/junction Dirent is neither, and fell through both branches with
//       no file-table entry AND no Problem — a session-UUID-shaped junction
//       vanished from the store with zero disclosure.
//
//   R8-SKEW
//       localDateOf() does not zero-pad the year, so 'YYYY-MM-DD' strings from
//       different-digit-count years neither sort nor compare correctly; and
//       nextLocalDay() rebuilt a Date from the parsed year, hitting JS's legacy
//       [0,99] -> 1900+y remap. Together they mis-ordered day bands (a year-99
//       band emitted as the NEWEST) and derailed the per-day turn walk.
//
//   R8-BOM
//       /api/lines performed the same line-1 BOM strip /api/line discloses, and
//       reported neither a `bom` flag nor a `bom-stripped` note — on the one
//       endpoint whose product is billed to the reader as raw JSONL.
//
//   R8-PROB-2
//       The L0 problems drawer dropped every problem's identity, so a
//       session-scoped row offered no route to the session it named. The row
//       must know its SOURCES before it can link: the census collapses by
//       code|scope across sessions, so linking the first contributor would be
//       an inference.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createIndexState } from '../lens.mjs';
import { readLineRange } from '../server/jsonl.mjs';
import { localDateOf, dateOfDay, dayStartMsOf, finishBands, makeBands } from '../server/api.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import * as store from '../server/index-store.mjs';
import { startServer, getJson } from './fixtures/api/helpers.mjs';

const J = JSON.stringify;
const MODS = { pricing, ledger, jsonl, parse, scan, summary };

import { sleep, waitUntil } from './helpers/timing.mjs';

/** ms of a LOCAL wall-clock date — timezone-independent, and free of the
 *  legacy two-digit-year remap (`new Date(99, …)` is 1999). */
function localMs(y, m, d, h = 12, mi = 0) {
  const dt = new Date(2000, m - 1, d, h, mi, 0, 0);
  dt.setFullYear(y);
  return dt.getTime();
}
const isoOf = (ms) => new Date(ms).toISOString();

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage, makeUser, asstStd as asst } from './fixtures/api/make-store.mjs';
const user = makeUser("C:\\r8\\proj");

/** A real createIndexState wired to the real group A/B modules, with the store
 *  walk already done — the round-7 harness, unchanged. No worker thread. */
async function realIndexOver(storeDir, opts = {}) {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-cache-'));
  const idx = createIndexState({ projectsDir: storeDir, cacheDir, mods: MODS, restartDebounceMs: 30, ...opts });
  const table = await scan.scanStore(storeDir);
  const groups = scan.groupSessions(table);
  const S = idx._test.state;
  S.fileTable = table;
  S.projects = groups.projects;
  S.sessions = groups.sessions;
  S.bytesTotal = groups.sessions.reduce((a, s) => a + (s.bytes ?? 0), 0);
  S.state = 'ready';
  S.version += 1;
  return { idx, cacheDir };
}

async function serveIndex(storeDir, idx) {
  return startServer({
    appName: 'lens-r8', appVersion: 'test',
    projectsDir: storeDir, projectsDirSource: 'fixture',
    webDir: path.join(storeDir, 'no-web'), sharedDir: path.join(storeDir, 'no-shared'),
    pricing, ledger, jsonl, config: null, index: idx,
  });
}

/* ============================================================ R8-BOM */

describe('R8-BOM — /api/lines discloses the same strip /api/line does', () => {
  const SLUG = 'C--r8-bom';
  const SID1 = '88000000-0000-4000-8000-000000000001'; // BOM on line 1
  const SIDM = '88000000-0000-4000-8000-000000000002'; // BOM on line 3 (corrupt)
  const SID0 = '88000000-0000-4000-8000-000000000003'; // no BOM anywhere
  const BOM = '\uFEFF';
  const T = (s) => `2026-08-01T${s}.000Z`;
  let storeDir, cacheDir, idx, srv, url, absFirst, absMid, absNone;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-bom-'));
    absFirst = path.join(storeDir, SLUG, `${SID1}.jsonl`);
    absMid = path.join(storeDir, SLUG, `${SIDM}.jsonl`);
    absNone = path.join(storeDir, SLUG, `${SID0}.jsonl`);
    await fsp.mkdir(path.dirname(absFirst), { recursive: true });
    await fsp.writeFile(absFirst, [
      BOM + user({ sid: SID1, uuid: 'r8-b1', at: T('10:00:00'), text: 'bom on line one' }),
      asst({ sid: SID1, uuid: 'r8-b2', at: T('10:00:10'), msgId: 'msg_R8B1', text: 'ok' }),
      asst({ sid: SID1, uuid: 'r8-b3', at: T('10:00:20'), msgId: 'msg_R8B2', text: 'ok two' }),
    ].join('\n') + '\n', 'utf8');
    await fsp.writeFile(absMid, [
      user({ sid: SIDM, uuid: 'r8-m1', at: T('11:00:00'), text: 'clean line one' }),
      asst({ sid: SIDM, uuid: 'r8-m2', at: T('11:00:10'), msgId: 'msg_R8M1', text: 'clean line two' }),
      BOM + asst({ sid: SIDM, uuid: 'r8-m3', at: T('11:00:20'), msgId: 'msg_R8M2', text: 'BOMMED LINE THREE' }),
    ].join('\n') + '\n', 'utf8');
    await fsp.writeFile(absNone, [
      user({ sid: SID0, uuid: 'r8-n1', at: T('12:00:00'), text: 'no bom at all' }),
      asst({ sid: SID0, uuid: 'r8-n2', at: T('12:00:10'), msgId: 'msg_R8N1', text: 'ok' }),
    ].join('\n') + '\n', 'utf8');

    ({ idx, cacheDir } = await realIndexOver(storeDir));
    for (const s of [SID1, SIDM, SID0]) await idx.detail(SLUG, s);
    srv = await serveIndex(storeDir, idx);
    url = srv.url;
  });

  after(async () => {
    if (srv) await srv.close();
    await fsp.rm(storeDir, { recursive: true, force: true });
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  test('R8-BOM — a from=1 window over a BOM-on-line-1 file says so, and hands back the stripped text', async () => {
    const r = await getJson(`${url}/api/lines?slug=${SLUG}&id=${SID1}&file=${SID1}.jsonl&from=1&count=3`);
    assert.equal(r.status, 200);
    assert.equal(r.body.bom, true, 'the strip is disclosed, not silent');
    const notes = r.body.problems.filter((p) => p.code === 'bom-stripped');
    assert.equal(notes.length, 1, 'exactly one bom-stripped note');
    assert.equal(notes[0].severity, 'note');
    assert.equal(notes[0].scope, 'line');
    assert.equal(notes[0].line, 1);
    assert.equal(notes[0].affects, 'nothing');
    assert.notEqual(r.body.lines[0].charCodeAt(0), 0xfeff, 'and the byte really is gone from the text');
    assert.equal(typeof JSON.parse(r.body.lines[0]), 'object');

    // /api/line, same bytes, same claim — the asymmetry this finding is about.
    const one = await getJson(`${url}/api/line?slug=${SLUG}&id=${SID1}&file=${SID1}.jsonl&line=1`);
    assert.equal(one.body.bom, r.body.bom, 'two endpoints, one file, one answer');
  });

  test('R8-BOM — the flag is a fact about the WINDOW: from=2 on that same file reports false', async () => {
    const r = await getJson(`${url}/api/lines?slug=${SLUG}&id=${SID1}&file=${SID1}.jsonl&from=2&count=2`);
    assert.equal(r.status, 200);
    assert.equal(r.body.bom, false, 'a window that never returned line 1 makes no claim about it');
    assert.deepEqual(r.body.problems, [], 'no window, no note');
  });

  test('R8-BOM — a MID-FILE BOM is not a stripped BOM: from=1 reports false while the byte stays visible', async () => {
    const r = await getJson(`${url}/api/lines?slug=${SLUG}&id=${SIDM}&file=${SIDM}.jsonl&from=1&count=3`);
    assert.equal(r.status, 200);
    assert.equal(r.body.bom, false, 'nothing was stripped — a naive "any line starts with FEFF" check fails here');
    assert.deepEqual(r.body.problems, []);
    assert.equal(r.body.lines[2].charCodeAt(0), 0xfeff, 'and round 7 stays pinned: line 3 keeps its byte');
  });

  test('R8-BOM — readLineRange over a BOM-free file reports false (a fact, not decoration)', async () => {
    const win = await readLineRange(absNone, 1, 2);
    assert.equal(win.bom, false);
    assert.equal(Object.hasOwn(win, 'bom'), true, 'the key is present unconditionally, so the shape never moves with the data');
    const first = await readLineRange(absFirst, 1, 1);
    assert.equal(first.bom, true);
    const second = await readLineRange(absFirst, 2, 1);
    assert.equal(second.bom, false);
  });
});

/* ========================================================= R8-SYMLINK */

describe('R8-SYMLINK — a symlink/junction is disclosed, never silently dropped', () => {
  let storeDir, made = false, why = '';

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-link-'));
    const proj = path.join(storeDir, 'C--r8-link');
    const target = path.join(storeDir, 'elsewhere');
    await fsp.mkdir(proj, { recursive: true });
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, 'secret.jsonl'), '{}\n', 'utf8');
    // A valid session-UUID-shaped directory name, so the walk would otherwise
    // have produced a session card for it.
    const link = path.join(proj, '33333333-3333-4333-8333-333333333333');
    try {
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      made = fs.lstatSync(link).isSymbolicLink();
    } catch (e) { made = false; why = (e && e.code) || String(e); }
  });

  after(async () => { await fsp.rm(storeDir, { recursive: true, force: true }).catch(() => {}); });

  test('R8-SYMLINK — the walk raises unclassified-file for it, and does NOT follow it', async (t) => {
    if (!made) { t.skip(`this platform would not create a directory link (${why})`); return; }
    const table = await scan.scanStore(storeDir);
    const notes = (table.problems ?? []).filter((p) => p.code === 'unclassified-file');
    assert.equal(notes.length, 1, 'exactly one disclosure for the one link');
    assert.equal(notes[0].severity, 'note');
    assert.equal(notes[0].scope, 'file');
    assert.equal(notes[0].affects, 'display');
    assert.match(notes[0].file, /33333333-3333-4333-8333-333333333333$/, 'and it names the entry that was skipped');
    assert.match(notes[0].message, /symlink|junction/i);

    // Disclose, do not follow: nothing reached THROUGH the link is tabled, so
    // resolveFileRef's string-prefix containment guard cannot be walked around.
    const throughLink = [...table.keys()].filter((k) => k.includes('33333333-3333-4333-8333-333333333333'));
    assert.deepEqual(throughLink, [], 'the link target is not tabled through the link');
    const grouped = scan.groupSessions(table);
    assert.equal(grouped.sessions.some((s) => s.id === '33333333-3333-4333-8333-333333333333'), false,
      'and it is still not a session — the fix discloses the gap, it does not invent a card');
  });
});

/* ============================================================ R8-SKEW */

describe('R8-SKEW — day bands order and terminate on milliseconds, never on the label', () => {
  test('R8-SKEW — dateOfDay does not hit the legacy two-digit-year remap', () => {
    assert.equal(new Date(99, 5, 15, 12).getFullYear(), 1999, 'precondition: the constructor remaps [0,99]');
    assert.equal(dateOfDay('99-06-15').getFullYear(), 99, 'dateOfDay does not');
    assert.equal(dateOfDay('99-06-15').getMonth(), 5);
    assert.equal(dateOfDay('99-06-15').getDate(), 15);
    assert.equal(dateOfDay('2026-01-01').getFullYear(), 2026);
    assert.equal(dateOfDay('-0005-06-15').getFullYear(), -5, 'a negative year survives the split');
    assert.equal(dateOfDay('50000-01-02').getFullYear(), 50000);
  });

  test('R8-SKEW — the numeric key orders days the label cannot', () => {
    // Each of these is a pair the STRING compare gets wrong.
    assert.equal('99-06-15' >= '2026-01-01', true, 'precondition: the label says year 99 is newer than 2026');
    assert.equal(dayStartMsOf('99-06-15') < dayStartMsOf('2026-01-01'), true, 'the number does not');
    assert.equal('10000-01-01' >= '9999-12-31', false, 'precondition: padding would not have saved this either');
    assert.equal(dayStartMsOf('10000-01-01') > dayStartMsOf('9999-12-31'), true);
    assert.equal(dayStartMsOf('2026-08-18') < dayStartMsOf('2026-08-19'), true, 'and ordinary days still order');
    assert.equal(dayStartMsOf('NaN-NaN-NaN'), null, 'a label that names no instant is unknown, never a fabricated 0');
  });

  test('R8-SKEW — a band whose label names no instant sorts LAST, it does not pretend to be 1970', () => {
    const acc = makeBands();
    acc.get(localDateOf(localMs(2026, 8, 18)));
    acc.get('NaN-NaN-NaN');
    acc.get(localDateOf(localMs(2026, 8, 17)));
    const bands = finishBands(acc, [], []);
    assert.equal(bands[bands.length - 1].localDate, 'NaN-NaN-NaN');
    assert.equal(bands[0].localDate, localDateOf(localMs(2026, 8, 18)));
  });

  test('R8-SKEW — a year-99 band is emitted as the OLDEST, not the newest', () => {
    const acc = makeBands();
    const old = localDateOf(localMs(99, 6, 15));
    const mid = localDateOf(localMs(2026, 1, 1));
    const now = localDateOf(localMs(2026, 8, 18));
    for (const d of [old, mid, now]) acc.get(d);
    const bands = finishBands(acc, [], []);
    assert.deepEqual(bands.map((b) => b.localDate), [now, mid, old],
      'newest first, by the numeric key — the year-99 band used to sort ahead of a real 2026 date');
    for (const b of bands) assert.equal(Number.isFinite(b.startMs), true, 'every band ships its numeric key');
    assert.equal(bands[0].startMs > bands[2].startMs, true);
  });

  test('R8-SKEW — the per-day walk counts every day a bar touches, in milliseconds', () => {
    const acc = makeBands();
    const d1 = localDateOf(localMs(2026, 3, 1, 23));
    const d2 = localDateOf(localMs(2026, 3, 2, 12));
    const d3 = localDateOf(localMs(2026, 3, 3, 1));
    for (const d of [d1, d2, d3]) acc.get(d);
    const bands = finishBands(acc, [{ at: localMs(2026, 3, 1, 23), endedAt: localMs(2026, 3, 3, 1) }], []);
    const by = Object.fromEntries(bands.map((b) => [b.localDate, b.turnCount]));
    assert.deepEqual(by, { [d1]: 1, [d2]: 1, [d3]: 1 }, 'once per distinct local day, including the day it merely crosses');

    const same = makeBands();
    same.get(d2);
    const one = finishBands(same, [{ at: localMs(2026, 3, 2, 9), endedAt: localMs(2026, 3, 2, 17) }], []);
    assert.equal(one[0].turnCount, 1, 'and a same-day bar still counts exactly once');
  });

  test('R8-SKEW — an absurd recorded span degrades DISCLOSED instead of looping', () => {
    const acc = makeBands();
    const old = localDateOf(localMs(99, 6, 15));
    acc.get(old);
    const problems = [];
    const t0 = Date.now();
    const bands = finishBands(acc, [{ at: localMs(99, 6, 15), endedAt: localMs(2026, 1, 1) }], problems);
    const took = Date.now() - t0;
    assert.equal(bands[0].turnCount, 1, 'the bar is still counted where it starts');
    assert.equal(problems.length, 1, 'and the truncation is stated, not swallowed');
    assert.equal(problems[0].code, 'day-span-capped');
    assert.equal(problems[0].affects, 'aggregates');
    assert.equal(problems[0].severity, 'warning');
    assert.equal(took < 10000, true, `the capped walk must stay bounded (took ${took}ms)`);
  });

  test('R8-SKEW — end < start is not a walk: the bar counts on its start day only', () => {
    const acc = makeBands();
    const d = localDateOf(localMs(2026, 5, 5));
    acc.get(d);
    const bands = finishBands(acc, [{ at: localMs(2026, 5, 5, 12), endedAt: localMs(2026, 5, 1, 12) }], []);
    assert.equal(bands[0].turnCount, 1);
  });

  test('R8-SKEW — a bar whose timestamps are not instants cannot spin the walk', () => {
    const acc = makeBands();
    const good = localDateOf(localMs(2026, 5, 5));
    acc.get(good);
    const problems = [];
    const t0 = Date.now();
    const bands = finishBands(acc, [
      { at: NaN, endedAt: NaN },
      { at: localMs(2026, 5, 5, 12), endedAt: NaN },
    ], problems);
    assert.equal(Date.now() - t0 < 2000, true, 'no 100k-iteration spin on a non-instant');
    assert.deepEqual(problems, [], 'and nothing was capped, because nothing was walked');
    assert.equal(bands.find((b) => b.localDate === good).turnCount, 1,
      'the bar with a real start still counts on its own day; the unusable end is not a span');
  });
});

describe('R8-SKEW — end to end over a skewed corpus', () => {
  const SLUG = 'C--r8-skew';
  const SID = '88000000-0000-4000-8000-0000000000a1';
  let storeDir, cacheDir, idx, srv, url;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-skew-'));
    const abs = path.join(storeDir, SLUG, `${SID}.jsonl`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, [
      user({ sid: SID, uuid: 'r8-s1', at: isoOf(localMs(99, 6, 15, 10)), text: 'a dead RTC wrote this' }),
      asst({ sid: SID, uuid: 'r8-s2', at: isoOf(localMs(99, 6, 15, 11)), msgId: 'msg_R8S1', text: 'year ninety-nine' }),
      user({ sid: SID, uuid: 'r8-s3', at: isoOf(localMs(2026, 1, 1, 10)), text: 'and this one is real' }),
      asst({ sid: SID, uuid: 'r8-s4', at: isoOf(localMs(2026, 1, 1, 11)), msgId: 'msg_R8S2', text: 'twenty twenty-six' }),
    ].join('\n') + '\n', 'utf8');

    ({ idx, cacheDir } = await realIndexOver(storeDir));
    await idx.detail(SLUG, SID);
    srv = await serveIndex(storeDir, idx);
    url = srv.url;
  });

  after(async () => {
    if (srv) await srv.close();
    await fsp.rm(storeDir, { recursive: true, force: true });
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  test('R8-SKEW — /api/index dayBands put 2026 ahead of year 99', async () => {
    const r = await getJson(`${url}/api/index`);
    assert.equal(r.status, 200);
    const bands = r.body.dayBands;
    assert.equal(bands.length >= 2, true, `expected both days, saw ${J(bands.map((b) => b.localDate))}`);
    assert.match(bands[0].localDate, /^2026-/, 'the NEWEST band is the 2026 one');
    assert.match(bands[bands.length - 1].localDate, /^99-/, 'and the year-99 band is the oldest');
    for (let i = 1; i < bands.length; i++) {
      assert.equal(bands[i - 1].startMs > bands[i].startMs, true, 'strictly descending by the numeric key');
    }
    const skewed = bands.find((b) => /^99-/.test(b.localDate));
    assert.equal(skewed.turnCount >= 1, true, 'and the skewed turn is COUNTED, not walked past');
  });

  test('R8-SKEW — /api/project reuses one computation per index version', async () => {
    const a = await getJson(`${url}/api/project/${SLUG}`);
    assert.equal(a.status, 200);
    const t0 = Date.now();
    const b = await getJson(`${url}/api/project/${SLUG}`);
    const took = Date.now() - t0;
    assert.deepEqual(b.body.dayBands, a.body.dayBands, 'same version, same bands');
    assert.equal(took < 1000, true, `the second request must not rebuild the whole walk (took ${took}ms)`);
    assert.match(b.body.dayBands[0].localDate, /^2026-/);
  });
});

/* ========================================================== R8-WORKER */

describe('R8-WORKER — a crashed indexer worker is replaced, and the failure is legible', () => {
  const SLUG = 'C--r8-worker';
  const SID = '88000000-0000-4000-8000-0000000000b1';
  let storeDir, cacheDir, idx, srv, url, S;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-wrk-'));
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-wrkc-'));
    const abs = path.join(storeDir, SLUG, `${SID}.jsonl`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, [
      user({ sid: SID, uuid: 'r8-w1', at: '2026-08-01T10:00:00.000Z', text: 'hello' }),
      asst({ sid: SID, uuid: 'r8-w2', at: '2026-08-01T10:00:10.000Z', msgId: 'msg_R8W1', text: 'hi' }),
    ].join('\n') + '\n', 'utf8');

    idx = createIndexState({
      projectsDir: storeDir, cacheDir, mods: { ...MODS, store },
      restartDebounceMs: 30,
      // The shipped policy on a compressed clock — same code paths, same rules.
      workerBackoffMs: [10, 20, 40], crashWindowMs: 5000, crashCap: 5,
    });
    S = idx._test.state;
    await idx.start();
    await waitUntil(() => idx.workerAlive() && idx.cards().size === 1, 20000, 'the first build');
    srv = await serveIndex(storeDir, idx);
    url = srv.url;
  });

  after(async () => {
    if (srv) await srv.close();
    await idx.close();
    await fsp.rm(storeDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  test('R8-WORKER — the shipped respawn policy is 1s/2s/5s, 5 crashes in 60s', () => {
    const fresh = createIndexState({ projectsDir: storeDir, cacheDir, mods: {} });
    assert.deepEqual(fresh._test.workerPolicy.workerBackoffMs, [1000, 2000, 5000]);
    assert.equal(fresh._test.workerPolicy.crashWindowMs, 60000);
    assert.equal(fresh._test.workerPolicy.crashCap, 5);
  });

  test('R8-WORKER — killing the worker takes the index down, discloses it, and a REPLACEMENT rebuilds', async () => {
    const first = S.worker;
    assert.ok(first, 'precondition: worker mode');
    assert.equal(idx.workerAlive(), true);
    assert.equal(idx.status().state, 'ready');

    await first.terminate(); // Node's own crash-equivalent 'exit'
    await waitUntil(() => idx.workerAlive() === false, 5000, 'the exit to register');

    // While it is down, the app says so instead of quietly serving stale truth.
    assert.equal(idx.status().state, 'failed', "'ready' while the indexer is dead was two facts contradicting each other");
    const down = idx.problems().find((p) => p.code === 'worker-exit');
    assert.ok(down, 'worker-exit was in SPEC\u00a0\u00a79\'s enum and emitted nowhere before round 8');
    assert.equal(down.severity, 'error');
    assert.equal(down.scope, 'store');
    assert.equal(down.affects, 'aggregates');

    // Prove the replacement really re-indexed rather than merely existing.
    idx.cards().clear();
    await waitUntil(() => idx.workerAlive() === true, 8000, 'a replacement worker');
    assert.notEqual(S.worker, first, 'a NEW Worker object, not the corpse');
    await waitUntil(() => idx.cards().size === 1 && idx.status().state === 'ready', 20000, 'the rebuild');

    const after = idx.problems().find((p) => p.code === 'worker-exit');
    assert.ok(after, 'the crash is still disclosed after recovery — it happened');
    assert.equal(after.severity, 'warning', 'but it no longer claims the indexer is down');
    assert.match(after.message, /restarted/);
  });

  test('R8-WORKER — /api/index answers degraded while the worker is down; /api/session does not', async () => {
    const alive = await getJson(`${url}/api/index`);
    assert.equal(alive.status, 200);

    const w = S.worker;
    await w.terminate();
    await waitUntil(() => idx.workerAlive() === false, 5000, 'the exit to register');

    const idxRes = await getJson(`${url}/api/index`);
    assert.equal(idxRes.status, 200, 'problems[] is only reachable here — a blanket 503 made the failure undiagnosable');
    assert.equal(idxRes.body.status.state, 'failed');
    assert.equal(idxRes.body.problems.some((p) => p.code === 'worker-exit'), true);

    const sess = await getJson(`${url}/api/session/${SLUG}/${SID}`);
    assert.equal(sess.status, 503, 'every other index-backed route still refuses honestly');
    assert.equal(sess.body.error.code, 'indexer-down');

    await waitUntil(() => idx.workerAlive() === true, 8000, 'a replacement worker');
  });

});

describe('R8-WORKER — a crash LOOP is capped, disclosed, and recoverable', () => {
  // A dedicated instance so the respawn budget is pristine and the arithmetic
  // in the assertions is exact.
  const SLUG = 'C--r8-loop';
  const SID = '88000000-0000-4000-8000-0000000000b2';
  let storeDir, cacheDir, idx, srv, url, S;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-loop-'));
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-loopc-'));
    const abs = path.join(storeDir, SLUG, `${SID}.jsonl`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, [
      user({ sid: SID, uuid: 'r8-l1', at: '2026-08-01T10:00:00.000Z', text: 'hello' }),
      asst({ sid: SID, uuid: 'r8-l2', at: '2026-08-01T10:00:10.000Z', msgId: 'msg_R8L1', text: 'hi' }),
    ].join('\n') + '\n', 'utf8');
    idx = createIndexState({
      projectsDir: storeDir, cacheDir, mods: { ...MODS, store },
      restartDebounceMs: 30,
      workerBackoffMs: [10, 20, 40], crashWindowMs: 60000, crashCap: 5,
    });
    S = idx._test.state;
    await idx.start();
    await waitUntil(() => idx.workerAlive() && idx.cards().size === 1, 20000, 'the first build');
    srv = await serveIndex(storeDir, idx);
    url = srv.url;
  });

  after(async () => {
    if (srv) await srv.close();
    await idx.close();
    await fsp.rm(storeDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  test('R8-WORKER — 5 respawns inside the window, then it stays down and says so', async () => {
    let kills = 0;
    for (let i = 0; i < 10; i++) {
      let came = true;
      try { await waitUntil(() => idx.workerAlive() === true, 2000, `worker #${i + 1}`); }
      catch { came = false; }
      if (!came) break;
      const w = S.worker;
      await w.terminate();
      kills += 1;
      await waitUntil(() => idx.workerAlive() === false, 5000, `exit #${kills}`);
    }
    await sleep(300);
    assert.equal(idx.workerAlive(), false, 'the respawn loop is capped, not infinite');
    assert.equal(kills, 6, 'exactly crashCap respawns were granted, and the 6th crash was refused');
    assert.equal(S.workerGaveUp, true);

    const gaveUp = idx.problems().find((p) => p.code === 'worker-exit');
    assert.ok(gaveUp);
    assert.equal(gaveUp.severity, 'error');
    assert.equal(gaveUp.scope, 'store');
    assert.match(gaveUp.message, /staying down/, 'a silent give-up would be the worst version of this bug');
    assert.match(gaveUp.message, /reindex/, 'and it names the way out');
    assert.equal(gaveUp.count, kills, 'count is the real number of exits');

    // Index-backed routes refuse honestly; the diagnosis route still answers.
    const sess = await getJson(`${url}/api/session/${SLUG}/${SID}`);
    assert.equal(sess.status, 503);
    const idxRes = await getJson(`${url}/api/index`);
    assert.equal(idxRes.status, 200);
    assert.equal(idxRes.body.status.state, 'failed');
  });

  test('R8-WORKER — POST /api/reindex revives a worker that gave up', async () => {
    assert.equal(idx.workerAlive(), false, 'precondition: down and given up');
    idx.cards().clear();
    const r = await getJson(`${url}/api/reindex`, { method: 'POST' });
    assert.equal(r.status, 200, '/api/reindex was itself gated on a live worker and 503’d before it could recover anything');
    await waitUntil(() => idx.workerAlive() === true, 8000, 'the revived worker');
    assert.equal(S.workerGaveUp, false);
    await waitUntil(() => idx.cards().size === 1 && idx.status().state === 'ready', 20000, 'the rebuild after revival');
    const back = idx.problems().find((p) => p.code === 'worker-exit');
    assert.equal(back.severity, 'warning', 'and the claim stops being made the moment it stops being true');
    assert.match(back.message, /restarted/);
  });
});

/* ========================================================== R8-PROB-1 */

describe('R8-PROB-1 — the problems census is a current-state view, not a log', () => {
  const SLUG = 'C--r8-prob';
  const SID = '88000000-0000-4000-8000-0000000000c1';
  let storeDir, cacheDir, idx, srv, url, strayAbs;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-prob-'));
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r8-probc-'));
    const abs = path.join(storeDir, SLUG, `${SID}.jsonl`);
    await fsp.mkdir(path.join(storeDir, SLUG, SID), { recursive: true });
    await fsp.writeFile(abs, [
      user({ sid: SID, uuid: 'r8-p1', at: '2026-08-01T10:00:00.000Z', text: 'hello' }),
      asst({ sid: SID, uuid: 'r8-p2', at: '2026-08-01T10:00:10.000Z', msgId: 'msg_R8P1', text: 'hi' }),
    ].join('\n') + '\n', 'utf8');
    // A file inside the session dir matching none of the 10 store patterns:
    // parse.mjs raises one session-scope unclassified-file note for it.
    strayAbs = path.join(storeDir, SLUG, SID, 'notes-from-the-void.txt');
    await fsp.writeFile(strayAbs, 'not a transcript\n', 'utf8');

    idx = createIndexState({
      projectsDir: storeDir, cacheDir, mods: { ...MODS, store }, restartDebounceMs: 30,
    });
    await idx.start();
    await waitUntil(() => idx.cards().size === 1 && idx.status().state === 'ready', 20000, 'the first build');
    srv = await serveIndex(storeDir, idx);
    url = srv.url;
  });

  after(async () => {
    if (srv) await srv.close();
    await idx.close();
    await fsp.rm(storeDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  const strayRows = () => idx.problems().filter((p) => p.code === 'unclassified-file' && p.scope === 'session');

  test('R8-PROB-1 — the store census and the session\'s own payload answer the same question the same way', async () => {
    const index = await getJson(`${url}/api/index`);
    assert.equal(index.status, 200);
    const session = await getJson(`${url}/api/session/${SLUG}/${SID}`);
    assert.equal(session.status, 200);

    const mine = (session.body.problems ?? []).filter((p) => p.scope === 'session');
    assert.equal(mine.length >= 1, true, 'precondition: this session has a problem of its own');
    const collapse = (list) => {
      const m = new Map();
      for (const p of list) m.set(`${p.code}|${p.scope}`, (m.get(`${p.code}|${p.scope}`) ?? 0) + (p.count ?? 1));
      return [...m.entries()].sort();
    };
    const storeSide = collapse((index.body.problems ?? []).filter((p) => p.scope === 'session'));
    assert.deepEqual(storeSide, collapse(mine),
      'one session in the store, so the two payloads must agree code-for-code and count-for-count');
  });

  test('R8-PROB-1 — re-parsing an UNCHANGED condition does not inflate count', async () => {
    assert.equal(strayRows().length, 1);
    const before = strayRows()[0].count;
    for (let i = 0; i < 3; i++) {
      await idx.reindex();
      await waitUntil(() => idx.cards().size === 1 && idx.status().state === 'ready', 20000, `rebuild ${i + 1}`);
      await waitUntil(() => strayRows().length === 1, 20000, `the row after rebuild ${i + 1}`);
    }
    assert.equal(strayRows()[0].count, before,
      'count is "how many records exist now", not "how many times this process re-read them"');
  });

  test('R8-PROB-1 — a condition that stops holding drops out of the census', async () => {
    assert.equal(strayRows().length, 1, 'precondition: the condition holds');
    await fsp.rm(strayAbs, { force: true });
    await idx.reindex();
    await waitUntil(() => idx.cards().size === 1 && idx.status().state === 'ready', 20000, 'the rebuild');
    await waitUntil(() => strayRows().length === 0, 20000, 'the retraction');
    assert.deepEqual(strayRows(), [], 'the store census no longer asserts something the session disproves');

    // The in-process indexer keeps its OWN file table (a 5 s stat walk), so
    // wait for it to see the deletion before asking it to re-parse; what is
    // being pinned here is that neither side is a permanent log.
    await waitUntil(() => ![...idx.fileTable().keys()].some((k) => k.endsWith('notes-from-the-void.txt')),
      20000, "the parent's stat walk to see the deletion");
    const session = await getJson(`${url}/api/session/${SLUG}/${SID}`);
    assert.equal(session.status, 200);
    assert.equal((session.body.problems ?? []).some((p) => p.code === 'unclassified-file'), false,
      'and the two sides still agree');
  });

  test('R8-PROB-1 — a warm boot has a census, not a silent zero', async () => {
    // Cards restored from index.json with matching fingerprints are never
    // re-parsed, so before round 8 a warm boot reported [] no matter what the
    // corpus contained. The list rides the persisted card now.
    await fsp.writeFile(strayAbs, 'back again\n', 'utf8');
    await idx.reindex();
    await waitUntil(() => strayRows().length === 1, 20000, 'the condition to come back');
    const w = idx._test.state.worker;
    // let the writer's debounce flush the card to disk
    await waitUntil(async () => {
      try { const j = await store.loadIndex(cacheDir); return !!(j && j.cards && j.cards.get(SID)); } catch { return false; }
    }, 20000, 'index.json to carry the card');
    const persisted = await store.loadIndex(cacheDir);
    const card = persisted.cards.get(SID);
    assert.equal(Array.isArray(card.problems), true, 'the persisted card carries the session\'s problem list');
    assert.equal(card.problems.some((p) => p.code === 'unclassified-file'), true);

    const warm = createIndexState({ projectsDir: storeDir, cacheDir, mods: { ...MODS, store }, restartDebounceMs: 30 });
    try {
      warm._test.handleWorkerMessage({ type: 'card', card });
      const rows = warm.problems().filter((p) => p.code === 'unclassified-file' && p.scope === 'session');
      assert.equal(rows.length, 1, 'a card alone is enough to populate the census');
      assert.equal(rows[0].count, 1);
    } finally {
      await warm.close();
    }
    void w;
  });

  test('R8-PROB-1 — no volume of re-posting can evict a still-true store-scope error', () => {
    const scratch = createIndexState({ projectsDir: storeDir, cacheDir: path.join(cacheDir, 'nope'), mods: {} });
    const H = scratch._test.handleWorkerMessage;
    H({ type: 'problem', problem: { code: 'cache-write-failed', severity: 'error', scope: 'store', message: 'disk full', affects: 'aggregates', count: 1 } });
    for (let i = 0; i < 250; i++) {
      H({
        type: 'session-problems', id: `sess-${i}`, slug: 'p',
        problems: [{ code: 'unclassified-file', severity: 'note', scope: 'session', slug: 'p', id: `sess-${i}`, message: 'stray', affects: 'display', count: 1 }],
      });
    }
    const rows = scratch.problems();
    assert.equal(rows.some((p) => p.code === 'cache-write-failed'), true,
      'the 200-cap is applied AFTER the fold — it used to be a FIFO on the input log');
    const note = rows.find((p) => p.code === 'unclassified-file');
    assert.equal(note.count, 250, 'and 250 distinct sessions really are 250 records');

    // Re-posting the SAME session's batch is a replacement, not an append.
    for (let i = 0; i < 250; i++) {
      H({
        type: 'session-problems', id: 'sess-0', slug: 'p',
        problems: [{ code: 'unclassified-file', severity: 'note', scope: 'session', slug: 'p', id: 'sess-0', message: 'stray', affects: 'display', count: 1 }],
      });
    }
    assert.equal(scratch.problems().find((p) => p.code === 'unclassified-file').count, 250,
      're-reading the same unchanged corpus must not move the number');
  });
});

/* ========================================================== R8-PROB-2 */

describe('R8-PROB-2 — a collapsed problem row knows which sources it came from', () => {
  test('R8-PROB-2 — one contributor is nameable; three are counted, never guessed', () => {
    const idx = createIndexState({ projectsDir: '/nowhere', cacheDir: '/nowhere', mods: {} });
    const H = idx._test.handleWorkerMessage;
    const note = (slug, id) => ({ code: 'workflow-call-unresolved', severity: 'note', scope: 'session', slug, id, message: `names wf_1 (${id})`, affects: 'nothing', count: 1 });
    for (const [slug, id] of [['projA', 'AAAA'], ['projB', 'BBBB'], ['projC', 'CCCC']]) {
      H({ type: 'session-problems', id, slug, problems: [note(slug, id)] });
    }
    H({ type: 'session-problems', id: 'DDDD', slug: 'projD', problems: [{ code: 'torn-line', severity: 'error', scope: 'session', slug: 'projD', id: 'DDDD', message: 'one torn line', affects: 'aggregates', count: 1 }] });

    const rows = idx.problems();
    const many = rows.find((p) => p.code === 'workflow-call-unresolved');
    assert.equal(many.count, 3);
    assert.equal(many.sourceCount, 3, 'the row knows it has three contributors');
    assert.deepEqual(many.sources.map((s) => s.id).sort(), ['AAAA', 'BBBB', 'CCCC'],
      'and names all of them — the collapsed row used to keep only the first');

    const one = rows.find((p) => p.code === 'torn-line');
    assert.equal(one.sourceCount, 1);
    assert.deepEqual(one.sources, [{ slug: 'projD', id: 'DDDD' }]);
  });

  test('R8-PROB-2 — the source list is capped, and the count still tells the truth', () => {
    const idx = createIndexState({ projectsDir: '/nowhere', cacheDir: '/nowhere', mods: {} });
    const H = idx._test.handleWorkerMessage;
    for (let i = 0; i < 300; i++) {
      H({
        type: 'session-problems', id: `s${i}`, slug: 'p',
        problems: [{ code: 'unknown-event-type', severity: 'warning', scope: 'session', slug: 'p', id: `s${i}`, message: 'x', affects: 'display', count: 1 }],
      });
    }
    const row = idx.problems().find((p) => p.code === 'unknown-event-type');
    assert.equal(row.sourceCount, 300, 'the census is exact');
    assert.equal(row.sources.length, 25, 'the payload is not');
  });
});
