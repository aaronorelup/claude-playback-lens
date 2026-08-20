// tests/views-overview-l0.test.mjs — group F (overview views), L0 pure logic.
//
// The view modules import group E's foundation (router/api/components) with
// static specifiers, which is correct for the browser but unresolvable (and
// DOM-dependent) under node:test. These tests therefore load each view module
// with its `../`-specifier imports stripped and evaluate it from a data: URL;
// route registration in the views is guarded by `typeof document !== 'undefined'`
// so nothing browser-side runs here. Only the exported pure functions are
// exercised — no DOM is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const VIEW_DIR = new URL('../web/js/views/', import.meta.url);
const JS_DIR = new URL('../web/js/', import.meta.url);
// router.mjs / api.mjs are the DOM-facing shell — stripped as before. The
// LEAF modules (format.mjs, components/*.mjs) are node-loadable and are the
// helper-unification sources (one h/bytes/money/tzLabel/occupancy), so their
// imports are rewritten to real file: URLs instead of stripped.
const STRIP_IMPORT = /^import\s+[^;]*\s+from\s+'\.\.\/(?:router|api)\.mjs';[ \t]*$/gm;

async function strippedSource(name) {
  let src = await readFile(new URL(`${name}.mjs`, VIEW_DIR), 'utf8');
  src = src.replace(STRIP_IMPORT, '');
  src = src.replace(/from\s+'\.\.\/((?:format|components\/[^']+)\.mjs)'/g,
    (m, rel) => `from '${new URL(rel, JS_DIR).href}'`);
  return src;
}
function dataUrl(code) { return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code).replace(/'/g, '%27'); }
export async function loadView(name) {
  let code = await strippedSource(name);
  if (name !== 'l0') {
    const l0 = dataUrl(await strippedSource('l0'));
    code = code.replace(/from\s+'\.\/l0\.mjs'/g, `from '${l0}'`);
  }
  return import(dataUrl(code));
}

const L0 = await loadView('l0');
const CAL = L0.makeCalendar(-420);        // UTC−7, the corpus's recorded zone
const T = (iso) => Date.parse(iso);

/* ---------------------------------------------------------------- calendar */

test('calendar keys and day starts round-trip at a fixed offset', () => {
  assert.equal(CAL.key(T('2026-08-17T06:59:59.999Z')), '2026-08-16');
  assert.equal(CAL.key(T('2026-08-17T07:00:00.000Z')), '2026-08-17');
  assert.equal(CAL.dayStartMs('2026-08-17'), T('2026-08-17T07:00:00.000Z'));
  assert.equal(CAL.key(CAL.dayStartMs('2026-01-01')), '2026-01-01');
});

test('addDays / daysBetween / monthKey are exact across month and year ends', () => {
  assert.equal(L0.addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(L0.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(L0.daysBetween('2026-07-01', '2026-08-01'), 31);
  assert.equal(L0.daysBetween('2026-08-17', '2026-08-17'), 0);
  assert.equal(L0.monthKey('2026-08-17'), '2026-08');
  assert.equal(L0.monthLabel('2026-08'), 'August 2026');
});

test('tzLabel prints the axis label DESIGN §2 asks for', () => {
  assert.equal(L0.tzLabel(-420), '(UTC−7)');
  assert.equal(L0.tzLabel(0), '(UTC)');
  assert.equal(L0.tzLabel(330), '(UTC+5:30)');
  assert.equal(L0.tzLabel(NaN), '(UTC?)');
});

/* -------------------------------------------------------------- formatting */

test('integer, byte and span formatting', () => {
  assert.equal(L0.fmtInt(0), '0');
  assert.equal(L0.fmtInt(29741), '29,741');
  assert.equal(L0.fmtInt(6307164218), '6,307,164,218');
  assert.equal(L0.fmtInt(null), null);
  assert.equal(L0.fmtBytes(0), '0 B');
  // UI-13: ONE bytes formatter (format.mjs, ÷1024) — 1,150,000,000 B is 1.07 GiB.
  assert.equal(L0.fmtBytes(1150000000), '1.07 GB');
  assert.equal(L0.fmtBytes(null), null);
  assert.equal(L0.fmtSpan(0), '0');
  assert.equal(L0.fmtSpan(8040000), '2h 14m');
  assert.equal(L0.fmtSpan(45000), '45s');
  assert.equal(L0.fmtSpan(null), null);
});

test('SPEC §6 money display: exact zero is 0, sub-threshold is <$0.0001, unknown is null', () => {
  assert.equal(L0.formatUsdTcu(0), '0');                 // reachable: a 100%-inherited session bills a real $0
  assert.equal(L0.formatUsdTcu(1), '<$0.0001');
  assert.equal(L0.formatUsdTcu(2e9), '$1.0000');
  assert.equal(L0.formatUsdTcu(2469135800), '$1.2346');
  assert.equal(L0.formatUsdTcu(null), null);             // unknown is never the zero glyph
  assert.notEqual(L0.formatUsdTcu(0), L0.formatUsdTcu(null));
});

test('tokens are never collapsed to one figure; cache-write is 5m + 1h + flat', () => {
  const t = { input: 1, output: 2, cache5m: 3, cache1h: 4, cacheFlat: 5, cacheRead: 6 };
  assert.deepEqual(L0.tokens4(t), { input: 1, output: 2, cacheWrite: 12, cacheRead: 6 });
  assert.equal(L0.tokens4(null), null);
  assert.deepEqual(L0.addTokens(t, t).cache1h, 8);
  assert.equal(L0.usdTotal(1234), 1234);
  assert.equal(L0.usdTotal({ total: 99 }), 99);
  assert.equal(L0.usdTotal({ input: 5 }), null);
});

/* ------------------------------------------------------- from/to filtering */

test('parseRange validates dates and reports what it ignored', () => {
  const ok = L0.parseRange(new URLSearchParams('from=2026-07-01&to=2026-07-31'));
  assert.deepEqual([ok.from, ok.to, ok.active, ok.invalid.length], ['2026-07-01', '2026-07-31', true, 0]);

  const bad = L0.parseRange(new URLSearchParams('from=last-tuesday'));
  assert.equal(bad.from, null);
  assert.equal(bad.active, false);
  assert.deepEqual(bad.invalid, [{ param: 'from', value: 'last-tuesday' }]);

  const impossible = L0.parseRange(new URLSearchParams('from=2026-02-30'));
  assert.equal(impossible.from, null);
  assert.equal(impossible.invalid.length, 1);

  const inverted = L0.parseRange(new URLSearchParams('from=2026-08-01&to=2026-07-01'));
  assert.equal(inverted.active, false);
  assert.equal(inverted.invalid.length, 1);

  const none = L0.parseRange(new URLSearchParams(''));
  assert.deepEqual([none.from, none.to, none.active], [null, null, false]);
});

test('inRange is inclusive on both bounds', () => {
  const r = L0.parseRange(new URLSearchParams('from=2026-07-01&to=2026-07-31'));
  assert.equal(L0.inRange('2026-07-01', r), true);
  assert.equal(L0.inRange('2026-07-31', r), true);
  assert.equal(L0.inRange('2026-06-30', r), false);
  assert.equal(L0.inRange('2026-08-01', r), false);
  assert.equal(L0.inRange('1999-01-01', { active: false }), true);
});

test('withQuery preserves unknown params and drops emptied ones (DESIGN §0)', () => {
  const q = new URLSearchParams('v=table&from=2026-07-01&mystery=keep');
  assert.equal(L0.withQuery('#/', q, { v: null }), '#/?from=2026-07-01&mystery=keep');
  assert.equal(L0.withQuery('#/', q, { v: 'sessions' }), '#/?v=sessions&from=2026-07-01&mystery=keep');
  assert.equal(L0.withQuery('#/', new URLSearchParams(''), { v: null }), '#/');
});

/* -------------------------------------------------- midnight-split of bars */

test('a turn inside one local day yields one segment', () => {
  const segs = L0.splitBarAcrossDays({ slug: 'p', id: 's', idx: 1, at: T('2026-08-17T18:00:00Z'), endedAt: T('2026-08-17T19:00:00Z') }, CAL);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].localDate, '2026-08-17');
  assert.equal(segs[0].clippedStart, false);
  assert.equal(segs[0].clippedEnd, false);
});

test('a turn crossing local midnight splits rather than double-counting', () => {
  const segs = L0.splitBarAcrossDays({ at: T('2026-08-17T06:00:00Z'), endedAt: T('2026-08-17T08:00:00Z') }, CAL);
  assert.deepEqual(segs.map((s) => s.localDate), ['2026-08-16', '2026-08-17']);
  assert.equal(segs[0].endMs, T('2026-08-17T07:00:00Z'));
  assert.equal(segs[1].startMs, T('2026-08-17T07:00:00Z'));
  assert.equal(segs[0].clippedEnd, true);
  assert.equal(segs[1].clippedStart, true);
  // the two segments tile the bar exactly — no overlap, no gap
  assert.equal((segs[0].endMs - segs[0].startMs) + (segs[1].endMs - segs[1].startMs),
    T('2026-08-17T08:00:00Z') - T('2026-08-17T06:00:00Z'));
});

test('a bar spanning two midnights yields three segments', () => {
  const segs = L0.splitBarAcrossDays({ at: T('2026-08-16T20:00:00Z'), endedAt: T('2026-08-18T20:00:00Z') }, CAL);
  assert.deepEqual(segs.map((s) => s.localDate), ['2026-08-16', '2026-08-17', '2026-08-18']);
});

test('a bar with only one recorded timestamp is a tick — no invented width', () => {
  const segs = L0.splitBarAcrossDays({ at: T('2026-08-17T18:00:00Z'), endedAt: null }, CAL);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].tick, true);
  assert.equal(segs[0].endMs, null);
  assert.deepEqual(L0.splitBarAcrossDays({ at: null }, CAL), []);
});

/* ------------------------------------------------------- band assembly */

const DAY_BANDS = [
  { localDate: '2026-08-17', turnCount: 5, tokens: { input: 10, output: 20, cache5m: 1, cache1h: 2, cacheFlat: 0, cacheRead: 100 }, usd: 4e9, sessionsTouched: ['s1', 's2'] },
  { localDate: '2026-08-16', turnCount: 2, tokens: { input: 5, output: 5, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 50 }, usd: 2e9, sessionsTouched: ['s2'] },
  { localDate: '2026-08-04', turnCount: 1, tokens: { input: 1, output: 1, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 }, usd: 1e9, sessionsTouched: ['s3'] },
  { localDate: '2026-07-31', turnCount: 3, tokens: { input: 2, output: 2, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 }, usd: 5e8, sessionsTouched: ['s4'] },
];
const TURN_BARS = [
  { slug: 'proj-a', id: 's1', idx: 1, at: T('2026-08-17T18:00:00Z'), endedAt: T('2026-08-17T18:30:00Z') },
  { slug: 'proj-b', id: 's2', idx: 2, at: T('2026-08-17T06:00:00Z'), endedAt: T('2026-08-17T08:00:00Z') },
  { slug: 'proj-a', id: 's3', idx: 1, at: T('2026-08-04T20:00:00Z'), endedAt: null },
];

test('band gutters come exclusively from the server dayBands payload', () => {
  const bands = L0.assembleBands({ dayBands: DAY_BANDS, turnBars: TURN_BARS }, { cal: CAL });
  const aug17 = bands.find((b) => b.localDate === '2026-08-17');
  // two bar segments land on 2026-08-17 but the gutter still reads the server's 5
  assert.equal(aug17.segments.length, 2);
  assert.equal(aug17.gutter.turnCount, 5);
  assert.equal(aug17.gutter.usd, 4e9);
  assert.equal(aug17.gutter.recorded, true);
});

test('bands are newest-first and segments are ordered within a band', () => {
  const bands = L0.assembleBands({ dayBands: DAY_BANDS, turnBars: TURN_BARS }, { cal: CAL });
  assert.deepEqual(bands.map((b) => b.localDate), ['2026-08-17', '2026-08-16', '2026-08-04', '2026-07-31']);
  const aug17 = bands[0];
  assert.ok(aug17.segments[0].startMs <= aug17.segments[1].startMs);
});

test('a day with bars but no recorded dayBand gets an unknown gutter with a reason', () => {
  const bands = L0.assembleBands({
    dayBands: [],
    turnBars: [{ slug: 'p', id: 's', idx: 1, at: T('2026-08-17T18:00:00Z'), endedAt: T('2026-08-17T18:30:00Z') }],
  }, { cal: CAL });
  assert.equal(bands.length, 1);
  assert.equal(bands[0].gutter.recorded, false);
  assert.equal(bands[0].gutter.turnCount, null);
  assert.match(bands[0].gutter.reason, /no day band recorded/);
});

test('from/to filters bands and their bars together', () => {
  const range = L0.parseRange(new URLSearchParams('from=2026-08-05&to=2026-08-17'));
  const bands = L0.assembleBands({ dayBands: DAY_BANDS, turnBars: TURN_BARS }, { cal: CAL, range });
  assert.deepEqual(bands.map((b) => b.localDate), ['2026-08-17', '2026-08-16']);
  // the 2026-08-16 half of the midnight-crossing turn survives; the 08-04 tick does not
  assert.equal(bands.find((b) => b.localDate === '2026-08-16').segments.length, 1);
});

test('a legend filter hides other projects’ bars but never the recorded gutter', () => {
  const bands = L0.assembleBands({ dayBands: DAY_BANDS, turnBars: TURN_BARS }, { cal: CAL, slugs: ['proj-a'] });
  const aug17 = bands.find((b) => b.localDate === '2026-08-17');
  assert.equal(aug17.segments.length, 1);
  assert.equal(aug17.gutter.turnCount, 5);
});

/* ------------------------------------------------- separators + subtotals */

test('month rows carry subtotals and sit directly above their bands', () => {
  const bands = L0.assembleBands({ dayBands: DAY_BANDS, turnBars: TURN_BARS }, { cal: CAL });
  const rows = L0.withSeparators(bands);
  const kinds = rows.map((r) => `${r.kind}:${r.kind === 'band' ? r.localDate : r.kind === 'month' ? r.month : r.days}`);
  assert.deepEqual(kinds, [
    'month:2026-08', 'band:2026-08-17', 'band:2026-08-16',
    'gap:11', 'band:2026-08-04',
    'gap:3', 'month:2026-07', 'band:2026-07-31',
  ]);
  const aug = rows.find((r) => r.kind === 'month' && r.month === '2026-08');
  assert.equal(aug.subtotal.turnCount, 8);            // 5 + 2 + 1
  assert.equal(aug.subtotal.usd, 7e9);
  assert.equal(aug.subtotal.tokens.cacheRead, 150);
  assert.equal(aug.subtotal.tokens.input, 16);
  assert.equal(aug.subtotal.sessionsTouched, 3);      // union of ids, not a sum
  assert.equal(aug.label, 'August 2026');
});

test('gap rows count the missing days and pluralise', () => {
  const bands = L0.assembleBands({
    dayBands: [{ localDate: '2026-08-17', turnCount: 1, usd: 0, tokens: null, sessionsTouched: [] },
      { localDate: '2026-08-15', turnCount: 1, usd: 0, tokens: null, sessionsTouched: [] }],
    turnBars: [],
  }, { cal: CAL });
  const gap = L0.withSeparators(bands).find((r) => r.kind === 'gap');
  assert.equal(gap.days, 1);
  assert.equal(gap.label, '— 1 day —');

  const wide = L0.withSeparators(L0.assembleBands({
    dayBands: [{ localDate: '2026-08-17', turnCount: 1, usd: 0, tokens: null, sessionsTouched: [] },
      { localDate: '2026-08-04', turnCount: 1, usd: 0, tokens: null, sessionsTouched: [] }],
    turnBars: [],
  }, { cal: CAL })).find((r) => r.kind === 'gap');
  assert.equal(wide.label, '— 12 days —');
});

test('adjacent days get no gap row', () => {
  const bands = L0.assembleBands({
    dayBands: [{ localDate: '2026-08-17', turnCount: 1, usd: 0, tokens: null, sessionsTouched: [] },
      { localDate: '2026-08-16', turnCount: 1, usd: 0, tokens: null, sessionsTouched: [] }],
    turnBars: [],
  }, { cal: CAL });
  assert.equal(L0.withSeparators(bands).filter((r) => r.kind === 'gap').length, 0);
});

test('sumBands refuses to sum a per-day session COUNT and says why', () => {
  const bands = L0.assembleBands({
    dayBands: [{ localDate: '2026-08-17', turnCount: 1, usd: 10, tokens: null, sessionsTouched: 3 },
      { localDate: '2026-08-16', turnCount: 1, usd: 20, tokens: null, sessionsTouched: 3 }],
    turnBars: [],
  }, { cal: CAL });
  const s = L0.sumBands(bands);
  assert.equal(s.turnCount, 2);
  assert.equal(s.usd, 30);
  assert.equal(s.sessionsTouched, null);
  assert.match(s.sessionsReason, /double-count/);
});

test('a subtotal reports the days it could not cover', () => {
  const bands = L0.assembleBands({
    dayBands: [{ localDate: '2026-08-17', turnCount: 4, usd: 8, tokens: null, sessionsTouched: [] }],
    turnBars: [{ slug: 'p', id: 's', idx: 1, at: T('2026-08-15T18:00:00Z'), endedAt: T('2026-08-15T19:00:00Z') }],
  }, { cal: CAL });
  const s = L0.sumBands(bands);
  assert.equal(s.days, 2);
  assert.equal(s.partialDays, 1);
  assert.equal(s.turnCount, 4);
});

test('bandRuns splits contiguous bands at every separator', () => {
  const bands = L0.assembleBands({ dayBands: DAY_BANDS, turnBars: TURN_BARS }, { cal: CAL });
  const runs = L0.bandRuns(L0.withSeparators(bands));
  assert.deepEqual(runs.map((r) => r.kind), ['month', 'run', 'gap', 'run', 'gap', 'month', 'run']);
  assert.equal(runs[1].bands.length, 2);
});

/* ------------------------------------------------------------- badges */

test('badges derive from recorded fields, in the designed order', () => {
  const b = L0.deriveBadges({ badges: ['live', 'no reply', 'forked'], state: 'ok' });
  assert.deepEqual(b.map((x) => x.key), ['forked', 'no-reply', 'live']);
  assert.deepEqual(b.map((x) => x.label), ['forked', 'no reply', 'live']);
  assert.ok(b.every((x) => x.title.length > 0));
});

test('badge keys normalise and state implies its own badge, without duplicating', () => {
  const b = L0.deriveBadges({ badges: { noReply: true, retried: false, cached: true }, state: 'live' });
  assert.deepEqual(b.map((x) => x.key), ['no-reply', 'cached', 'live']);
  const frag = L0.deriveBadges({ badges: ['fragment'], state: 'fragment' });
  assert.deepEqual(frag.map((x) => x.key), ['fragment']);
});

test('there is NO lost-agents badge — it is dropped and reported', () => {
  const b = L0.deriveBadges({ badges: ['lost agents', 'forked'] });
  assert.deepEqual(b.map((x) => x.key), ['forked']);
  assert.deepEqual(b.dropped, ['lost agents']);
});

test('an unrecognised recorded badge renders verbatim rather than vanishing', () => {
  const b = L0.deriveBadges({ badges: ['compacted'] });
  assert.equal(b.length, 1);
  assert.equal(b[0].label, 'compacted');
  assert.equal(b[0].known, false);
});

test('no card, no badges', () => {
  assert.deepEqual(L0.deriveBadges(null), []);
  assert.deepEqual(L0.deriveBadges({}).length, 0);
});

/* ------------------------------------------------------ projects + rows */

const INDEX = {
  version: 7,
  scope: { sessions: 61, of: 85, bytes: 800, ofBytes: 1000 },
  projects: [
    { slug: 'C--Users-a-proj', cwd: 'C:\\Users\\a\\proj', sessions: 2, bytes: 300 },
    { slug: 'C--Users-a-memory-only', memoryFiles: [{ name: 'a.md', bytes: 10 }] },
  ],
  sessions: [
    { slug: 'C--Users-a-proj', id: 's1', startedAt: T('2026-08-17T18:00:00Z'), endedAt: T('2026-08-17T19:00:00Z'), turnCount: 4, agentCount: 3, workflowCount: 1, bytes: 200, files: 5, customTitle: 'the rebuild', badges: ['forked'], usageByModel: { 'opus-5': { input: 10, output: 20, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 5 } } },
    { slug: 'C--Users-a-proj', id: 's2', startedAt: T('2026-08-16T18:00:00Z'), turnCount: 1, agentCount: 0, workflowCount: 0, bytes: 100, files: 2, aiTitle: 'a title', state: 'live' },
  ],
  problems: [
    { code: 'unclassified-file', severity: 'warning', scope: 'file', message: 'x', affects: 'nothing', count: 2 },
    { code: 'unclassified-file', severity: 'warning', scope: 'file', message: 'y', affects: 'nothing' },
    { code: 'model-unpriced', severity: 'error', scope: 'session', message: 'no rate', affects: 'aggregates' },
  ],
};

test('projectsFromIndex labels by the recorded cwd and falls back with a reason', () => {
  const rows = L0.projectsFromIndex(INDEX);
  const proj = rows.find((r) => r.slug === 'C--Users-a-proj');
  assert.equal(proj.label, 'C:\\Users\\a\\proj');
  assert.equal(proj.labelReason, null);
  const mem = rows.find((r) => r.slug === 'C--Users-a-memory-only');
  assert.equal(mem.label, 'C--Users-a-memory-only');
  assert.match(mem.labelReason, /re-encodes/);
});

test('a project with no declared label takes the recorded cwd that re-encodes to its dir name', () => {
  // SPEC §2: the slug is cwd with [\/:. ] -> '-'; SPACE is included in that class
  assert.equal(L0.slugOfCwd('C:\\Users\\a\\My Projects\\Lens'), 'C--Users-a-My-Projects-Lens');
  assert.equal(L0.slugOfCwd(null), null);

  const cards = [{ cwd: 'C:\\Users\\a\\My Projects\\Lens' }, { cwd: 'D:\\elsewhere' }];
  assert.equal(L0.labelFromCards('C--Users-a-My-Projects-Lens', cards), 'C:\\Users\\a\\My Projects\\Lens');
  assert.equal(L0.labelFromCards('C--no-such-dir', cards), null);

  const rows = L0.projectsFromIndex({
    projects: [{ slug: 'C--Users-a-My-Projects-Lens' }],           // /api/index ships no label
    sessions: [{ slug: 'C--Users-a-My-Projects-Lens', id: 's', cwd: 'C:\\Users\\a\\My Projects\\Lens' }],
  });
  assert.equal(rows[0].label, 'C:\\Users\\a\\My Projects\\Lens');
  assert.equal(rows[0].labelReason, null);
});

test('a cwd that does not re-encode to the dir name is never used as its label', () => {
  const rows = L0.projectsFromIndex({
    projects: [{ slug: 'C--Users-a-worktree-dir' }],
    sessions: [{ slug: 'C--Users-a-worktree-dir', id: 's', cwd: 'D:\\somewhere\\else' }],
  });
  assert.equal(rows[0].label, 'C--Users-a-worktree-dir');
  assert.match(rows[0].labelReason, /re-encodes/);
});

test('memory-only projects carry — stats, not zeros', () => {
  const mem = L0.projectsFromIndex(INDEX).find((r) => r.memoryOnly);
  assert.equal(mem.sessions, 0);
  assert.equal(mem.turns, null);
  assert.equal(mem.agents, null);
  assert.equal(mem.tokens, null);
  assert.equal(mem.usd, null);
  assert.equal(mem.memoryFiles, 1);
});

test('project counts come from the payload, else from the recorded cards', () => {
  const proj = L0.projectsFromIndex(INDEX).find((r) => r.slug === 'C--Users-a-proj');
  assert.equal(proj.sessions, 2);
  assert.equal(proj.turns, 5);
  assert.equal(proj.agents, 3);
  assert.equal(proj.bytes, 300);                 // the payload's own figure wins over Σ cards
  assert.equal(proj.tokens.input, 10);
  assert.equal(proj.usd, null);
  assert.match(proj.usdReason, /CostAgg/);
  assert.deepEqual(proj.badges.map((b) => b.key).sort(), ['forked', 'live']);
});

test('session rows are newest-first, titled by source precedence, and honest about cost', () => {
  const rows = L0.sessionRowsFromIndex(INDEX);
  assert.deepEqual(rows.map((r) => r.id), ['s1', 's2']);
  assert.equal(rows[0].title, 'the rebuild');
  assert.equal(rows[0].titleSource, 'custom-title');
  assert.equal(rows[1].titleSource, 'ai-title');
  assert.equal(rows[0].span, 3600000);
  assert.equal(rows[1].span, null);
  assert.equal(rows[0].usd, null);
  assert.match(rows[0].usdReason, /CostAgg/);
  assert.deepEqual(rows[1].badges.map((b) => b.key), ['live']);
});

test('session rows honour from/to by the recorded start', () => {
  const range = L0.parseRange(new URLSearchParams('from=2026-08-17'));
  const rows = L0.sessionRowsFromIndex(INDEX, { range, cal: CAL });
  assert.deepEqual(rows.map((r) => r.id), ['s1']);
});

test('session rows can be scoped to one project', () => {
  assert.equal(L0.sessionRowsFromIndex(INDEX, { slug: 'nope' }).length, 0);
  assert.equal(L0.sessionRowsFromIndex(INDEX, { slug: 'C--Users-a-proj' }).length, 2);
});

test('projectPalette gives the top 12 a stable colour and the rest grey', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ slug: `p${i}`, turns: 100 - i }));
  const pal = L0.projectPalette(many);
  assert.equal(pal.get('p0').index, 0);
  assert.equal(pal.get('p0').overflow, false);
  assert.equal(pal.get('p12').overflow, true);
  assert.equal(pal.get('p13').overflow, true);
  // stable: recomputing from a shuffled input gives the same assignment
  const pal2 = L0.projectPalette([...many].reverse());
  assert.equal(pal2.get('p0').index, 0);
  assert.equal(pal2.get('p11').index, 11);
});

/* ------------------------------------------------------------ inventory */

test('denominator sentence states the coverage while indexing', () => {
  assert.equal(L0.denominatorSentence({ done: 61, of: 85, building: true }), 'totals over 61 of 85 sessions — indexing…');
  assert.equal(L0.denominatorSentence({ done: 85, of: 85, building: false }), 'totals over 85 of 85 sessions');
  assert.equal(L0.denominatorSentence({ building: false }), null);
});

test('indexStatus reads the scope denominators and infers building', () => {
  const st = L0.indexStatus(INDEX);
  assert.deepEqual([st.done, st.of, st.bytesDone, st.bytesTotal, st.building], [61, 85, 800, 1000, true]);
  const done = L0.indexStatus({ scope: { sessions: 85, of: 85 } });
  assert.equal(done.building, false);
});

test('problems collapse by code+scope and keep their counts and affects', () => {
  const rows = L0.collapseProblems(INDEX.problems);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, 'model-unpriced');     // errors first
  assert.equal(rows[0].affects, 'aggregates');
  const unc = rows.find((r) => r.code === 'unclassified-file');
  assert.equal(unc.count, 3);                       // 2 (explicit) + 1 (implicit)
});

test('the corpus ledger counts files, bytes and censuses from recorded values only', () => {
  const inv = L0.buildInventory(INDEX);
  assert.equal(inv.files.sessionFiles, 7);
  assert.equal(inv.files.projectFiles, 1);
  assert.equal(inv.files.found, 8);
  assert.equal(inv.files.unclassified, 3);
  assert.equal(inv.files.classified, 5);
  assert.equal(inv.bytes.sessionBytes, 300);
  assert.equal(inv.bytes.projectBytes, 10);
  assert.equal(inv.cache, null);
  assert.match(inv.cacheReason, /not recorded/);
  const lost = inv.censuses.find((c) => c.key === 'lostAgents');
  assert.equal(lost.value, null);                   // no census recorded → — with a reason, never a fabricated 0
  assert.match(lost.reason, /not recorded|census/);
  const torn = inv.censuses.find((c) => c.key === 'tornLines');
  assert.equal(torn.value, 0);                      // no torn-line problems recorded
  assert.equal(torn.expected, 0);
});

test('the ledger reports the recorded censuses when the server ships them', () => {
  const inv = L0.buildInventory({ ...INDEX, censuses: { lostAgents: 0, tornLines: 0 } });
  assert.equal(inv.censuses.find((c) => c.key === 'lostAgents').value, 0);
});

// W-11(a): the branch the LIVE server actually feeds is the flat top-level
// `lostAgents` (server/api.mjs buildIndexView) — /api/index ships no
// `censuses` object at all. The censuses.* branch above is deliberate
// forward-compat (l0.mjs documents these accessors as defensive), so all three
// sources stay; what was missing was a test aimed at the real one.
test('W-11: the lost-agents census reads the flat /api/index lostAgents the server really ships', () => {
  const inv = L0.buildInventory({ ...INDEX, lostAgents: 3 });   // no `censuses` key, as live
  const lost = inv.censuses.find((c) => c.key === 'lostAgents');
  assert.equal(lost.value, 3);
  assert.equal(lost.reason, null);
  assert.equal(lost.source, '/api/index lostAgents (Σ card.lostAgents)');
  const zero = L0.buildInventory({ ...INDEX, lostAgents: 0 }).censuses.find((c) => c.key === 'lostAgents');
  assert.equal(zero.value, 0, 'a provable 0 renders 0, never —');
  assert.equal(zero.reason, null);
});

test('W-11: with no server census the cards are summed — and the source says so', () => {
  const inv = L0.buildInventory({
    ...INDEX,
    sessions: INDEX.sessions.map((s, i) => ({ ...s, lostAgents: i + 1 })),
  });
  const lost = inv.censuses.find((c) => c.key === 'lostAgents');
  assert.equal(lost.value, 3, 'Σ over every session card (1 + 2)');
  assert.equal(lost.reason, null);
  assert.equal(lost.source, 'Σ card.lostAgents over every session card');
  // one card missing the field makes the sum underivable — — with a reason
  const partial = L0.buildInventory({
    ...INDEX,
    sessions: [{ ...INDEX.sessions[0], lostAgents: 1 }, INDEX.sessions[1]],
  }).censuses.find((c) => c.key === 'lostAgents');
  assert.equal(partial.value, null);
  assert.match(partial.reason, /not recorded on \/api\/index or on every session card/);
});

test('duplicate-id sessions and fragments are enumerated', () => {
  const inv = L0.buildInventory({
    sessions: [
      { slug: 'a', id: 'dup', state: 'ok' },
      { slug: 'b', id: 'dup', state: 'fragment' },
      { slug: 'a', id: 'solo', state: 'ok' },
    ],
  });
  assert.deepEqual(inv.duplicateIds, [{ id: 'dup', slugs: ['a', 'b'] }]);
  assert.deepEqual(inv.fragments.map((f) => f.slug), ['b']);
});

/* ------------------------------------------------------- scope sentence */

test('the L0 scope sentence props name the rule, the split, the filter and both totals', () => {
  const s = L0.scopeSentenceL0({
    view: 'timeline', st: { done: 61, of: 85, building: true },
    range: L0.parseRange(new URLSearchParams('from=2026-07-01&to=2026-07-31')),
    bandCount: 31, tzText: '(UTC−7)', filteredTurns: 120, allTurns: 372, projectFilter: [],
    projects: 22, sessions: 85, turns: 372,
  });
  assert.equal(s.subject, 'the store');
  assert.deepEqual(s.counts, [{ n: 372, noun: 'turn' }, { n: 85, noun: 'session' }, { n: 22, noun: 'project' }]);
  assert.match(s.rule, /31 local calendar days/);
  assert.match(s.rule, /\(UTC−7\)/);
  assert.match(s.rule, /split between days/);
  assert.match(s.rule, /the server’s day total/);
  assert.deepEqual(s.filters, [{ label: 'date', value: '2026-07-01 → 2026-07-31' }]);
  assert.deepEqual(s.totals, { all: 372, filtered: 120 });          // DESIGN §4: name both counts
  assert.ok(s.extra.some((e) => /totals over 61 of 85 sessions — indexing…/.test(e)));
});

test('the scope props carry no filter and no totals when no filter is active', () => {
  const s = L0.scopeSentenceL0({
    view: 'sessions', st: { done: 85, of: 85, building: false }, range: { active: false },
    bandCount: 0, tzText: '(UTC)', projects: 22, sessions: 85, turns: 372,
  });
  assert.deepEqual(s.filters, []);
  assert.equal(s.totals, undefined);
  assert.match(s.rule, /one row per session/);
  assert.ok(!s.extra.some((e) => /indexing/.test(e)));
});

test('an unrecorded count is omitted from the scope props, never printed as zero', () => {
  const s = L0.scopeSentenceL0({ view: 'table', st: {}, range: { active: false }, bandCount: 0, projects: 3 });
  assert.deepEqual(s.counts, [{ n: 3, noun: 'project' }]);
});

test('the legend filter is disclosed as not changing the header', () => {
  const s = L0.scopeSentenceL0({ view: 'timeline', st: {}, range: { active: false }, bandCount: 2, projectFilter: ['a', 'b'] });
  assert.deepEqual(s.filters, [{ label: 'projects', value: '2 selected' }]);
  assert.ok(s.extra.some((e) => /does not change the header/.test(e)));
});

test('marks project onto a shared 24-hour axis by time of day, clamped to the day', () => {
  const ref = CAL.dayStartMs('2026-08-17');
  const dayStart = CAL.dayStartMs('2026-08-04');
  assert.equal(L0.projectToAxis(dayStart + 3600000, dayStart, ref), ref + 3600000);
  assert.equal(L0.projectToAxis(dayStart, dayStart, ref), ref);
  assert.equal(L0.projectToAxis(dayStart + 2 * L0.MS_DAY, dayStart, ref), ref + L0.MS_DAY);   // clamped
  assert.equal(L0.projectToAxis(null, dayStart, ref), null);
});
