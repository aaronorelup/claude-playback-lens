// tests/web-fixes-round1.test.mjs — named regression tests for the round-1
// UI fix pass (fixer-2, 2026-08-17). One test per fix id; the fake DOM mirrors
// tests/web-dom-smoke.test.mjs (no dependencies allowed).

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * fake document (same shape as web-dom-smoke.test.mjs)
 * ------------------------------------------------------------------ */

// The fake DOM itself lives in tests/helpers/fake-dom.mjs (shared by every
// web test file); it is installed here, BEFORE the web modules are imported.
import { doc } from './helpers/fake-dom.mjs';

globalThis.document = doc;

/* ------------------------------------------------------------------ *
 * imports AFTER the fake document exists
 * ------------------------------------------------------------------ */

const format = await import('../web/js/format.mjs');
const { setPricingModule, tzOffsetLabel, formatBytes, formatUsdLocal } = format;
const { statbar } = await import('../web/js/components/statbar.mjs');
const { buildChips, KNOWN_COUNTERS } = await import('../web/js/components/chips.mjs');
const { repriceCheck, pagerBounds, costfigure } = await import('../web/js/components/costfigure.mjs');
const { timeline, binMarks, axisTicks, occupancy } = await import('../web/js/components/timeline.mjs');
const { rowsPane } = await import('../web/js/components/rows.mjs');
const { sse } = await import('../web/js/api.mjs');
const L0 = await import('../web/js/views/l0.mjs');
const L2 = await import('../web/js/views/l2.mjs');
const L3 = await import('../web/js/views/l3.mjs');
const L4 = await import('../web/js/views/l4.mjs');
const L1 = await import('../web/js/views/l1.mjs');
// round 4: the workflow run page is driven end-to-end below. It must be
// imported HERE — node:test may never run a test registered after the runner
// has begun, and a top-level await placed mid-file orphans everything under it.
const WF = await import('../web/js/views/workflow.mjs');

setPricingModule(null);

const el = () => doc.createElement('div');
const text = (n) => n.textContent;
import { settle } from './helpers/timing.mjs';
const zeroTokens = { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };

/* ================================================================== *
 * proof layer
 * ================================================================== */

test('UI-6: the footnote renders a real ✓ from the payload-level rowsSumToHeader', () => {
  const props = L0.buildStatbarProps({ agg: { requests: 3, usd: { total: 100 }, tokens: zeroTokens }, rowsSumToHeader: true, counts: [] });
  assert.equal(props.footnote.rowsSumToHeader, true);
  const node = el();
  statbar(node, props);
  assert.match(text(node), /rows sum to header ✓/);
});

test('UI-6: an agg-level field is never read — only the payload field feeds the footnote', () => {
  const props = L0.buildStatbarProps({ agg: { requests: 3, usd: { total: 100 }, rowsSumToHeader: true }, counts: [] });
  assert.equal(props.footnote.rowsSumToHeader, null, 'rowsSumToHeader lives on the payload, not the CostAgg');
});

test('UI-19 (repriceCheck side / ACC-3): inherited, synthetic and sidechain rows are excluded and disclosed', () => {
  const priceRow = (r) => ({ unpriced: false, usd: { total: r.tcu ?? 0 } });
  const rows = [
    { tcu: 100 },
    { tcu: 999, billedElsewhere: { sessionId: 'other' } },
    { tcu: 999, synthetic: true },
    { tcu: 999, embeddedSidechain: true },
  ];
  const check = repriceCheck({ rows, total: 4, agg: { usd: { total: 100 } }, priceRow });
  assert.equal(check.ok, true, 'the reprice applies the header\'s own exclusions — no false ✗ on forked sessions');
  assert.equal(check.pageTcu, 100);
  assert.deepEqual(check.excluded, { inherited: 1, synthetic: 1, sidechain: 1, total: 3 });
});

test('ACC-3: a 100%-inherited page reprices to the real $0 header, ok === true', () => {
  const priceRow = (r) => ({ unpriced: false, usd: { total: r.tcu ?? 0 } });
  const rows = [{ tcu: 500, billedElsewhere: { sessionId: 'canon' } }];
  const check = repriceCheck({ rows, total: 1, agg: { usd: { total: 0 } }, priceRow });
  assert.equal(check.ok, true);
  assert.equal(check.pageTcu, 0);
});

test('UI-11 / ACC-19: with no scope timestamp the model table prints "no single date for this scope" — never a Date.now() rate', async () => {
  const pricing = await import('../shared/pricing.mjs');
  setPricingModule(pricing);
  const agg = {
    requests: 1, tokens: zeroTokens, usd: { total: 100 },
    byModel: { 'claude-sonnet-5': { requests: 1, tokens: zeroTokens, usd: { total: 100 } } },
  };
  const node = el();
  costfigure(node, { agg, open: true });
  await settle();
  assert.match(text(node), /no single date for this scope/);
  assert.doesNotMatch(text(node), /interval resolved at/);
  // and WITH a scope timestamp the rate lines resolve at it
  const node2 = el();
  costfigure(node2, { agg, at: Date.parse('2026-08-01T00:00:00Z'), open: true });
  await settle();
  assert.doesNotMatch(text(node2), /no single date for this scope/);
  setPricingModule(null);
});

test('COR-26: the records pager reaches past the 5,000-row page cap', () => {
  assert.equal(pagerBounds(4800, 300, 9000).nextDisabled, false, 'the tail past HARD_CAP stays reachable');
  assert.equal(pagerBounds(8700, 300, 9000).nextDisabled, true);
  assert.equal(pagerBounds(0, 300, 9000).prevDisabled, true);
});

test('ACC-35: records rows the header does not price are tagged in the table (R2/R4)', async () => {
  const payload = {
    rows: [
      { at: 1755400000000, model: 'claude-sonnet-5', input: 1, output: 1, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0, file: 'x.jsonl', line: 3, billedElsewhere: { sessionId: 'abcdef012345' } },
      { at: 1755400000001, model: '<synthetic>', input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0, file: 'x.jsonl', line: 4, synthetic: true },
    ],
    total: 2,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) });
  try {
    const node = el();
    costfigure(node, { agg: { requests: 2, usd: { total: 0 }, tokens: zeroTokens, byModel: {} }, scope: 'session:a/b', requests: 2, open: true });
    await settle();
    const show = node.querySelectorAll('button').find((b) => /show the/.test(text(b)));
    assert.ok(show, 'the records button renders');
    show.dispatch('click');
    await settle(60);
    assert.match(text(node), /billed in abcdef01 · R2/);
    assert.match(text(node), /synthetic · R4/);
    assert.match(text(node), /excluded from the reprice/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('UI-14: the Σ-filtered cost cell opens the stated reason, never "No billed requests"', () => {
  const node = el();
  const bar = statbar(node, {
    agg: { requests: null, tokens: zeroTokens, usd: { total: 42 } },
    costPanel: { enabled: false, reason: 'Σ filtered sums the in-range day bands; the per-model breakdown exists for Σ all — switch back to open it.' },
  });
  bar.openCell('cost');
  assert.match(text(node), /switch back to open it/);
  assert.doesNotMatch(text(node), /No billed requests in this scope/);
});

test('UI-15: the cost cell reason chain reads props.cost.reason before the generic wording', () => {
  const node = el();
  statbar(node, { cost: { tcu: null, reason: 'cost is not computed per event — it lives at this event\'s turn/agent scope' } });
  const unknown = node.querySelector('.lens-unknown');
  assert.ok(unknown);
  assert.match(unknown.getAttribute('title'), /not computed per event/);
});

test('UI-16: contribution bars are SHARE bars — width = value/total, matching the printed %', async () => {
  const node = el();
  const bar = statbar(node, {
    agg: { requests: 4, tokens: zeroTokens, usd: { total: 100 } },
    counts: [{ key: 'x', label: 'x', value: 4 }],
    contributions: { x: Object.assign([{ label: 'a', value: 75 }, { label: 'b', value: 25 }], { of: 5 }) },
  });
  bar.openCell('count:x');
  await settle();
  const bars = node.querySelectorAll('.lens-contrib__bar');
  assert.equal(bars[0].getAttribute('style'), 'width:75.00%', 'the top bar equals its printed share of the total');
  assert.match(text(node), /Showing 2 of 5 children/);
});

test('ACC-22: the thinking-coverage wording names both recorded causes of a null', () => {
  const node = el();
  const bar = statbar(node, { agg: { requests: 1, tokens: zeroTokens, usd: { total: 1 }, thinking: { tokens: 10, recordedOn: 1, notRecordedOn: 2 } } });
  bar.openCell('tokens');
  assert.match(text(node), /pre-2\.1\.229 harness or non-final R3 split row/);
});

/* ================================================================== *
 * chips (ACC-21 + Lite aggs)
 * ================================================================== */

const cleanAgg = {
  requests: 1, tokens: zeroTokens, usd: { total: 1 }, thinking: { tokens: 0, recordedOn: 0, notRecordedOn: 0 },
  unpriced: {}, inherited: {}, embeddedSidechain: { requests: 0, tokens: zeroTokens },
  neverFinalized: 0, synthetic: 0, ttlAssumed: 0, tierAssumed: 0, premiumUnknown: 0, byModel: {},
};

test('ACC-21: the drift guard is an allowlist — ANY unknown numeric counter surfaces', () => {
  const chips = buildChips({ ...cleanAgg, fooCount: 3 });
  assert.equal(chips.length, 1, 'a suffix the old regex never matched still gets the drift chip');
  assert.match(chips[0].text, /fooCount: 3 — this counter has no chip yet/);
});

test('ACC-21: the real R8 metrics are allowlisted, never mistaken for undisclosed counters', () => {
  const chips = buildChips({ ...cleanAgg, webSearchRequests: 5, webFetchRequests: 2 });
  assert.equal(chips.length, 0);
});

test('Lite card aggs: summed inheritedRequests/unpricedRequests still disclose R2/R7', () => {
  const lite = { requests: 10, tokens: zeroTokens, usd: { total: 1 }, inheritedRequests: 4, unpricedRequests: 2 };
  const chips = buildChips(lite);
  assert.ok(chips.some((c) => c.rule === 'R2' && /4 events inherited/.test(c.text)));
  assert.ok(chips.some((c) => c.rule === 'R7' && /2 requests on a model with no rate/.test(c.text)));
});

/* ================================================================== *
 * timeline grammar
 * ================================================================== */

test('UI-3: a view-supplied {at,end,count} bin renders a finite rect with its exact count', () => {
  const node = el();
  timeline(node, {
    lanes: [{ id: 'x', label: 'occupancy' }],
    marks: [{ lane: 'x', kind: 'bin', at: 1000, end: 500000, count: 4, label: '4' }],
    axis: { from: 0, to: 600000 },
    width: 960,
  });
  const rect = node.querySelector('.lens-timeline__bin-rect');
  assert.ok(rect, 'the bin renders');
  assert.ok(Number.isFinite(Number(rect.getAttribute('x'))), 'x is finite, never NaN');
  assert.ok(Number(rect.getAttribute('width')) > 1);
  const title = rect.querySelector('title');
  assert.match(text(title), /→/, 'the tooltip carries both recorded times');
  assert.doesNotMatch(text(title), /—/, 'never the unknown glyph for recorded bounds');
});

test('UI-23: a degenerate (single-timestamp) axis says so instead of printing an invented 1m span', () => {
  const node = el();
  timeline(node, { lanes: [{ id: 'x', label: 'x' }], marks: [{ lane: 'x', at: 1755400000000 }], width: 960 });
  assert.match(text(node), /one recorded timestamp .* axis padded ±30s/);
  assert.doesNotMatch(text(node), /· 1m/);
});

test('UI-24: no gutter track/bar without a known max; an unknown value carries its reason', () => {
  const node = el();
  timeline(node, {
    lanes: [
      { id: 'a', label: 'a', gutter: { value: 5, label: 'turns' } },
      { id: 'b', label: 'b', gutter: { value: null, label: 'turns', reason: 'no day band recorded for this date' } },
    ],
    marks: [{ lane: 'a', at: 0, end: 1000 }],
    axis: { from: 0, to: 2000 }, width: 960,
  });
  assert.equal(node.querySelectorAll('.lens-timeline__gutter-bar').length, 0, 'no fixed scale → no bar');
  assert.equal(node.querySelectorAll('.lens-timeline__gutter-track').length, 0, 'no fixed scale → no track');
  const values = node.querySelectorAll('.lens-timeline__gutter-value');
  assert.match(text(values[0]), /5/, 'the recorded value still prints as text');
  assert.match(text(values[1].querySelector('title')), /no day band recorded/, 'the unknown carries its reason');
});

test('UI-24 companion: with a known max the fixed-scale bar returns', () => {
  const node = el();
  timeline(node, {
    lanes: [{ id: 'a', label: 'a', gutter: { value: 5, label: 'turns' } }],
    marks: [{ lane: 'a', at: 0, end: 1000 }],
    gutter: { max: 10, label: 'turns' },
    axis: { from: 0, to: 2000 }, width: 960,
  });
  assert.equal(node.querySelectorAll('.lens-timeline__gutter-bar').length, 1);
});

test('UI-30: marks without a timestamp are counted out loud, never silently dropped', () => {
  const node = el();
  timeline(node, {
    lanes: [{ id: 'x', label: 'x' }],
    marks: [{ lane: 'x', at: 0, end: 1000 }, { lane: 'x', at: null }, { lane: 'x' }],
    axis: { from: 0, to: 2000 }, width: 960,
  });
  assert.match(text(node), /2 marks record no timestamp and cannot be placed on a time axis/);
});

test('UI-31: inverted marks bypass binning so their ⚠ survives', () => {
  const marks = [
    { lane: 'x', at: 100, end: 50 },            // inverted — a recorded contradiction
    { lane: 'x', at: 10 }, { lane: 'x', at: 20 }, { lane: 'x', at: 30 },
  ];
  const out = binMarks(marks, { from: 0, to: 1000, width: 100, cap: 2 });
  assert.equal(out.binned, true);
  assert.equal(out.marks.length, 1, 'the inverted mark rides beside the bins');
  assert.equal(out.marks[0].at, 100);
});

test('UI-32: day-scale gridlines land on consecutive local calendar days (DST-proof)', () => {
  // a 10-day span forces a day-scale step; every consecutive label is exactly
  // one calendar day later — a fixed 86,400,000 ms step drifts off local
  // midnight across a DST transition.
  const from = Date.parse('2026-10-29T12:00:00');   // spans 2026-11-01 (US fall-back)
  const to = from + 10 * 86400000;
  const ticks = axisTicks(from, to, 900);
  assert.ok(ticks.length >= 8);
  const labels = ticks.map((t) => t.label);
  assert.equal(new Set(labels).size, labels.length, 'no duplicated date label');
  for (let i = 1; i < ticks.length; i++) {
    const a = new Date(ticks[i - 1].at), b = new Date(ticks[i].at);
    const dayDiff = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
    assert.equal(dayDiff, 1, `tick ${i} is exactly one calendar day after tick ${i - 1}`);
    assert.equal(b.getHours(), 0, 'every day gridline sits on local midnight');
  }
});

test('helper unification: ONE occupancy — l2 re-exports the timeline implementation', () => {
  assert.equal(L2.occupancy, occupancy);
  const o = occupancy([{ start: 0, end: 10 }, { start: 5, end: 15 }]);
  assert.deepEqual(o.segments, [{ start: 0, end: 5, n: 1 }, { start: 5, end: 10, n: 2 }, { start: 10, end: 15, n: 1 }]);
});

/* ================================================================== *
 * rows pane
 * ================================================================== */

const rowsFixture = [
  { line: 1, bi: null, kind: 'prompt', at: 1755400000000, head: 'do the thing' },
  { line: 2, bi: '0', kind: 'tool_use', head: 'Read foo.txt' },
  { line: 3, bi: '1', kind: 'text', head: 'hello world' },
];

test('UI-5: an expander without onExpand says so — never a permanent "fetching…"', async () => {
  const node = el();
  rowsPane(node, { fetchPage: async () => ({ rows: rowsFixture, from: 0, count: 300, total: 3 }) });
  await settle();
  node.querySelector('.lens-rows__expand').dispatch('click');
  assert.match(text(node), /this pane does not expand rows/);
  assert.doesNotMatch(text(node), /fetching this line/);
});

test('UI-5 companion: with onExpand the detail resolves to real content', async () => {
  const node = el();
  rowsPane(node, {
    fetchPage: async () => ({ rows: rowsFixture, from: 0, count: 300, total: 3 }),
    onExpand: async () => doc.createTextNode('THE LINE'),
  });
  await settle();
  node.querySelector('.lens-rows__expand').dispatch('click');
  await settle();
  assert.match(text(node), /THE LINE/);
});

test('UI-18: the pager names all three denominators when a kind filter is active', async () => {
  const node = el();
  rowsPane(node, { fetchPage: async () => ({ rows: rowsFixture, from: 0, count: 300, total: 900 }), kinds: 'tool_use' });
  await settle();
  assert.match(text(node), /showing 1 of 3 rows on this page/);
  assert.match(text(node), /900 rows in scope/);
  assert.match(text(node), /the filter applies to the fetched page only/);
});

test('UI-45: "no block index" renders its own glyph with the SPEC §8 fact, never the reserved —', async () => {
  const node = el();
  rowsPane(node, { fetchPage: async () => ({ rows: rowsFixture, from: 0, count: 300, total: 3 }) });
  await settle();
  const bi = node.querySelector('.lens-rows__bi').querySelector('.lens-dim');
  assert.equal(text(bi), '·');
  assert.match(bi.getAttribute('title'), /whole event — no block index \(SPEC §8\)/);
});

test('UI-36: `/` opens an in-pane head filter that names the 220-char limit and escapes to #/find', async () => {
  const node = el();
  const pane = rowsPane(node, {
    fetchPage: async () => ({ rows: rowsFixture, from: 0, count: 300, total: 3 }),
    findScope: 'turn:a/b/3',
  });
  await settle();
  assert.equal(pane.openFilter(), true);
  const bar = node.querySelector('.lens-rows__find');
  assert.ok(!bar.hasAttribute('hidden'));
  assert.match(text(bar), /≤220-char recorded heads of the loaded rows only/);
  const escapeLink = bar.querySelector('a');
  assert.equal(escapeLink.getAttribute('href'), '#/find?scope=turn%3Aa%2Fb%2F3');
  // typing filters the loaded rows' heads
  const input = bar.querySelector('input');
  input.value = 'hello';
  input.dispatch('input');
  assert.equal(node.querySelectorAll('.lens-rows__tr').length, 1, 'only the matching head remains');
});

test('UI-4: rowsPane renders one {} locator per row from locatorHref', async () => {
  const node = el();
  rowsPane(node, {
    fetchPage: async () => ({ rows: rowsFixture, from: 0, count: 300, total: 3 }),
    locatorHref: (r) => `#/p/a/s/b/a/main/e/${r.line}${r.bi ? '.' + r.bi : ''}`,
  });
  await settle();
  const locators = node.querySelectorAll('.lens-rows__locator');
  assert.equal(locators.length, 3);
  assert.equal(locators[1].getAttribute('href'), '#/p/a/s/b/a/main/e/2.0');
});

/* ================================================================== *
 * api.mjs sse lifecycle (COR-3)
 * ================================================================== */

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closedByClient = false;
    FakeEventSource.last = this;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  close() { this.closedByClient = true; this.readyState = 2; }
  emit(type, ev) { for (const fn of this.listeners.get(type) || []) fn(ev); }
}

test('COR-3: a server-sent error event is terminal — the client closes and never reconnects', () => {
  globalThis.EventSource = FakeEventSource;
  const seen = [];
  const stream = sse('/api/find', { q: 'x' }, { error: (e) => seen.push(e) });
  FakeEventSource.last.emit('error', { data: JSON.stringify({ code: 'find-cursor-stale', message: 'stale' }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'find-cursor-stale');
  assert.equal(FakeEventSource.last.closedByClient, true, 'the EventSource is closed so auto-reconnect cannot replay the scan');
  assert.equal(stream.closed, true);
  delete globalThis.EventSource;
});

test('COR-3: a transport error (no payload) closes too, reported as stream-error', () => {
  globalThis.EventSource = FakeEventSource;
  const seen = [];
  sse('/api/audit', null, { error: (e) => seen.push(e) });
  FakeEventSource.last.emit('error', {});   // transport failure — no data
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'stream-error');
  assert.equal(FakeEventSource.last.closedByClient, true);
  delete globalThis.EventSource;
});

/* ================================================================== *
 * router (COR-29, W-10 plumbing)
 * ================================================================== */

test('COR-29: currentHash parses the fragment from location.href, immune to Firefox percent-decoding', async () => {
  const router = await import('../web/js/router.mjs');
  globalThis.location = { href: 'http://127.0.0.1:8791/#/p/a%2Fb/s/x', hash: '#/p/a/b/s/x' };
  assert.equal(router.currentHash(), '#/p/a%2Fb/s/x', 'the encoded segment survives');
  delete globalThis.location;
});

test('W-10: handle404 banners + navigates to the nearest ancestor; 400 stays an error card', async () => {
  const { handle404 } = await import('../web/js/views/l5.mjs');
  const nav = [];
  const ctx = { navigate: (href) => nav.push(href) };
  assert.equal(handle404(ctx, { status: 404, code: 'unknown-turn', message: 'turn 99 is past the end' }, { slug: 's', sid: 'id123', thing: 'turn 99' }), true);
  assert.equal(nav[0], '#/p/s/s/id123');
  assert.equal(handle404(ctx, { status: 400, code: 'bad-param' }, { slug: 's', sid: 'id123' }), false, '400 never resolves upward');
  assert.equal(handle404(ctx, { status: 404, code: 'unknown-session', message: 'no session' }, { slug: 's', sid: 'id123', thing: 'session' }), true);
  assert.equal(nav[1], '#/p/s', 'an unknown session resolves to the project, not to itself');
});

/* ================================================================== *
 * view-level pure fixes
 * ================================================================== */

test('UI-12 / ACC-20 / UI-13: l0 money and bytes delegate to the ONE shared implementation', () => {
  assert.equal(L0.formatUsdTcu(300000), formatUsdLocal(300000), 'half-boundary rounding agrees with the shared rule');
  assert.equal(L0.formatUsdTcu(300000), '$0.0002');
  assert.equal(L0.formatUsdTcu(100000), formatUsdLocal(100000));
  assert.equal(L0.formatUsdTcu(null), null, 'null-preserving for the l0 val() convention');
  assert.equal(L0.fmtBytes(34_700_000), formatBytes(34_700_000));
  assert.equal(L0.tzLabel(-420), tzOffsetLabel(-420));
  assert.equal(L0.h, format.h, 'ONE h() for the whole app');
});

test('UI-21: boundary turns (partly inside the range) are counted for the scope sentence', () => {
  const cal = L0.makeCalendar(0);
  const bars = [
    { slug: 'p', id: 's', idx: 1, at: Date.parse('2026-08-01T23:00:00Z'), endedAt: Date.parse('2026-08-02T01:00:00Z') }, // crosses midnight
    { slug: 'p', id: 's', idx: 2, at: Date.parse('2026-08-01T10:00:00Z'), endedAt: Date.parse('2026-08-01T11:00:00Z') }, // inside
  ];
  const range = L0.parseRange(new URLSearchParams('from=2026-08-01&to=2026-08-01'));
  assert.equal(L0.countTurnBars(bars, { range, cal }), 2, 'both turns touch the range');
  assert.equal(L0.countBoundaryTurns(bars, { range, cal }), 1, 'one is only partly inside it');
});

test('UI-46: recorded depth is read under BOTH shipped names; unrecorded stays null (zero indent)', () => {
  assert.equal(L3.normalizeAgent({ spawnDepth: 3 }).spawnDepth, 3);
  assert.equal(L3.normalizeAgent({ depth: 3 }).spawnDepth, 3, 'the payload alias `depth` is a recorded field, not a default');
  assert.equal(L3.normalizeAgent({}).spawnDepth, null);
});

test('W-8: `superseded` is a named glyph sourced to the journal-vs-manifest arithmetic, and stateFacts feed the signature', () => {
  const g = L3.agentGlyph({ state: 'superseded' });
  assert.equal(g.code, 'superseded');
  assert.equal(g.glyph, L3.STATE_GLYPHS.superseded.glyph);
  assert.match(g.label, /superseded attempt/);
  assert.match(g.source, /journal/);
  assert.ok(!/workflowProgress/.test(g.source), 'a superseded agent is NOT in the manifest — the source must not claim it is');
  // stateFacts are the flattened recorded fallbacks (detailAgents shape)
  const sig = L3.stateSignature({ stateFacts: { journalStarted: 2, journalResult: true, inManifest: false, cached: true } });
  assert.equal(sig.journalStarted, 2);
  assert.equal(sig.hasResult, true);
  assert.equal(sig.inManifest, false);
  assert.equal(sig.cached, true);
  // normalizeAgent reads the flattened cached flag for the — cached tag
  assert.equal(L3.normalizeAgent({ stateFacts: { cached: true } }).cached, true);
  assert.ok(L3.agentTags({ stateFacts: { cached: true } }).some((t) => t.key === 'cached'));
});

test('W-8: buildLanes routes stateFacts.inManifest:false agents into the fact-named split groups', () => {
  const model = L3.buildLanes({
    turnIdx: 1,
    agents: [
      { agentId: 'listed', runId: 'wf_1', state: 'done', stateFacts: { inManifest: true }, firstAt: 1, lastAt: 2 },
      { agentId: 'super', runId: 'wf_1', state: 'superseded', stateFacts: { inManifest: false, journalStarted: 1, journalResult: true }, firstAt: 1, lastAt: 2 },
    ],
    workflows: [{ runId: 'wf_1', turnIdx: 1 }],
  });
  const superseded = model.groups.find((g) => g.kind === 'orphan-superseded');
  assert.ok(superseded, 'the superseded split group exists');
  assert.deepEqual(superseded.agents.map((a) => a.agentId), ['super']);
});

test('W-9: tool names and ids read the parse rows\' recorded extra.tool / extra.toolUseId', () => {
  assert.equal(L4.toolNameOf({ extra: { tool: 'Read' } }), 'Read');
  assert.equal(L4.toolUseIdOf({ kind: 'tool_use', extra: { toolUseId: 'toolu_1' } }), 'toolu_1');
  const { spans } = L4.pairToolSpans([
    { kind: 'tool_use', line: 1, at: 1000, extra: { tool: 'Bash', toolUseId: 'toolu_9' } },
    { kind: 'tool_result', line: 2, at: 2000, extra: { toolUseId: 'toolu_9', isError: true } },
  ]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].matched, true);
  assert.equal(spans[0].name, 'Bash');
  assert.equal(spans[0].isError, true, 'the parse rows record isError, not is_error');
  const hist = L4.toolHistogram([{ kind: 'tool_use', extra: { tool: 'Read' } }, { kind: 'tool_use', extra: { tool: 'Read' } }]);
  assert.deepEqual(hist, [['Read', 2]], 'no "(no name recorded)" for a recorded name');
});

test('UI-53 / F56: the explicit fact pick keeps envelope fields out and lets payload.agent win', () => {
  assert.deepEqual(L4.pickAgentFacts({ state: 'ok', totallyNovelEnvelopeField: 'x', rel: 'a.jsonl' }), { state: 'ok', rel: 'a.jsonl' });
  const merged = { ...L4.pickAgentFacts({ state: 'ok' }), ...L4.pickAgentFacts({ state: 'done' }) };
  assert.equal(L3.agentGlyph(L3.normalizeAgent(merged)).code, 'done', 'the explicit agent state wins over the envelope');
});

test('UI-41: `]` exists only when the payload proves a next turn', () => {
  assert.equal(L3.hasNextTurn(2, 3), true);
  assert.equal(L3.hasNextTurn(3, 3), false, 'turnCount is the last addressable idx (server pins it)');
  assert.equal(L3.hasNextTurn(0, null), false, 'an unknown count disables ], never navigates into a 404');
});

test('UI-48: the flip note pluralises 1 agent', () => {
  const one = L2.chooseSessionView({ turns: [{ idx: 1 }], agents: [{ agentId: 'a' }], agentCount: 1 }, null);
  assert.match(one.note, /1 agent —/);
  assert.doesNotMatch(one.note, /1 agents/);
});

test('UI-38: the session facts row gains the queue-operation cell (the 7th metadata type)', () => {
  const facts = L2.sessionFacts({ inventory: { perType: { 'queue-operation': 12 } } });
  const qo = facts.find((f) => f.key === 'queue-operation');
  assert.ok(qo, 'the cell exists');
  assert.equal(qo.value, 12);
  assert.equal(qo.untimed, false, 'queue-operation is the one REAL timeline event among the seven');
  assert.match(qo.source, /marker lane/);
  // the four untimed types remain flagged at type granularity
  const untimed = facts.filter((f) => f.untimed).map((f) => f.key);
  assert.deepEqual(untimed, ['title', 'mode', 'last-prompt']);
});

test('UI-49: a failed index fetch reads "not resolvable right now", never "session not on disk"', () => {
  const rows = L1.memoryRows([{ name: 'note.md', originSessionId: 'deadbeef-1' }], 'proj', new Map(), { indexAvailable: false });
  assert.equal(rows[0].unresolvable, true);
  assert.match(rows[0].note, /not resolvable right now/);
  const resolved = L1.memoryRows([{ name: 'note.md', originSessionId: 'deadbeef-1' }], 'proj', new Map(), { indexAvailable: true });
  assert.match(resolved[0].note, /session not on disk/);
});

test('UI-1: no view module references the keyboard sheet\'s class for its contact sheets', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['l2', 'l4']) {
    const src = await readFile(new URL(`../web/js/views/${name}.mjs`, import.meta.url), 'utf8');
    assert.ok(!/['"`]lens-sheet/.test(src), `${name}.mjs must not use lens-sheet (the keyboard overlay class)`);
    assert.match(src, /lens-contact/, `${name}.mjs uses the contact-sheet class`);
  }
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.lens-contact \{[^}]*overflow: auto/s, 'the contact sheet is its own scroll box');
});

test('ACC-2: the store view names the r2 pending state in a banner (source pinned)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../web/js/views/l0.mjs', import.meta.url), 'utf8');
  assert.match(src, /r2 === 'pending'/, 'the store header reads status.r2');
  assert.match(src, /R2 fork billing is pending/, 'and says so in the owner\'s words');
});

test('UI-60: register() honours an injected defineRoute and modules do not self-register at import', () => {
  for (const mod of [L0, L1, L2]) {
    const got = [];
    mod.register((pattern) => { got.push(pattern); });
    assert.equal(got.length, 1, 'the injected defineRoute receives the route');
  }
});

/* ================================================================== *
 * round 2 — F48: the canonical side's fork banner reaches the PAGE.
 *
 * F48 was once marked done on the raw /api/session JSON alone: the server
 * shipped forkPartners and nothing under web/js ever read it, so the
 * canonical side of every fork pair rendered with no R2 disclosure at all.
 * These tests drive the real paintSession and read what actually reaches
 * ctx.banner — a revert of the wiring OR of the helper fails them.
 * ================================================================== */

function fakeSessionCtx() {
  const banners = [];
  const base = { el: el(), banners, stale: false, banner: (t2, tone, extra) => banners.push({ text: t2, tone, extra }) };
  // every other render-ctx hook (crumbs, statbar, registerRows, …) is a no-op:
  // this test is about what reaches ctx.banner, not about the rest of the page
  return new Proxy(base, { get: (t2, k) => (k in t2 ? t2[k] : () => {}) });
}

// the shape /api/session actually ships for the CANONICAL side of a fork pair
// (live shape: project …-proj-a, session …0001, partner …0002)
const CANON_ID = '0000000a-0000-4000-8000-000000000001';
const FORK_ID = '0000000a-0000-4000-8000-000000000002';
const CANON_DETAIL = {
  slug: 'C--proj', id: CANON_ID, state: 'ok', badges: ['forked'],
  turns: [{ idx: 0, preamble: true, at: null }, { idx: 1, preamble: false, at: 1755400000000, endedAt: 1755400600000 }],
  agents: [], workflows: [],
  agg: { requests: 43, tokens: zeroTokens, usd: { total: 100 }, inherited: {} },
  forkPartners: { [FORK_ID]: { slug: 'C--proj', sharedMsgIds: 44, billedHere: 43, billedThere: 0, billedElsewhere: 0 } },
  rowsSumToHeader: true,
};
const painted = (detail, sid = CANON_ID, slug = 'C--proj') => {
  const ctx = fakeSessionCtx();
  L2.paintSession(ctx, { detail, slug, sid, query: new URLSearchParams() });
  return { ctx, r2: ctx.banners.filter((b) => / · R2$|R2/.test(b.text || '')) };
};

test('F48: the CANONICAL side renders a fork banner naming its partner — in the rendered page, not just the JSON', () => {
  const { r2 } = painted(CANON_DETAIL);
  assert.equal(r2.length, 1, 'the canonical session banners its fork group');
  assert.match(r2[0].text, /43 of 44 msgIds/, 'the count agrees with the inherited side (billed rows, not raw shared ids)');
  assert.match(r2[0].text, /0000000a/, 'and names the partner file');
  const link = r2[0].extra.querySelectorAll('a')[0];
  assert.equal(link.getAttribute('href'), `#/p/C--proj/s/${FORK_ID}`, 'both-files link (DESIGN §10)');
});

test('F48: forkPartners null (index still building) banners nothing — unknown is never "no fork"', () => {
  assert.equal(painted({ ...CANON_DETAIL, forkPartners: null }).r2.length, 0);
  assert.equal(painted({ ...CANON_DETAIL, forkPartners: {} }).r2.length, 0, 'a real none banners nothing either');
});

test('F48: the INHERITED side still renders exactly the banner it always did', () => {
  const { r2 } = painted({
    ...CANON_DETAIL, id: FORK_ID,
    agg: { requests: 1, tokens: zeroTokens, usd: { total: 0 }, inherited: { [CANON_ID]: { requests: 43, tokens: zeroTokens } } },
    forkPartners: { [CANON_ID]: { slug: 'C--proj', sharedMsgIds: 44, billedHere: 0, billedThere: 43, billedElsewhere: 0 } },
  }, FORK_ID);
  assert.equal(r2.length, 1, 'billedHere === 0 means the canonical banner must NOT double up here');
  assert.match(r2[0].text, /43 of 44 billed rows in this file are inherited/);
  assert.match(r2[0].text, /billed there, not here/);
});

test('F48: a 3-way group renders BOTH banners — inheriting some ids while being canonical for others', () => {
  const { r2 } = painted({
    ...CANON_DETAIL,
    agg: { requests: 5, tokens: zeroTokens, usd: { total: 10 }, inherited: { 'aaaaaaaa-0000-4000-8000-000000000000': { requests: 2, tokens: zeroTokens } } },
    forkPartners: { 'bbbbbbbb-0000-4000-8000-000000000000': { slug: 'C--other', sharedMsgIds: 9, billedHere: 5, billedThere: 0, billedElsewhere: 4 } },
  });
  assert.equal(r2.length, 2, 'both disclosures are true at once — neither gates the other');
  assert.match(r2[1].text, /5 of 9 msgIds/);
  assert.match(r2[1].text, /4 more are billed in a third session/);
  assert.equal(r2[1].extra.querySelectorAll('a')[0].getAttribute('href'),
    '#/p/C--other/s/bbbbbbbb-0000-4000-8000-000000000000', 'the partner links with ITS OWN slug, never the current one');
});

/* ================================================================== *
 * round 2 — ACC-2: the R2-pending chip on a real /api/session payload
 * ================================================================== */

test('ACC-2: a building-state /api/session agg lights the R2-pending chip through the real statbar', () => {
  // exactly what server/api.mjs's /api/session ships while the index builds
  const payload = {
    agg: {
      requests: 12, tokens: zeroTokens, usd: { total: 500 },
      inherited: {}, unpriced: {}, synthetic: 0, neverFinalized: 0,
      inheritedPending: true,
    },
    rowsSumToHeader: null,
    r2: 'pending',
  };
  const node = el();
  statbar(node, L0.buildStatbarProps({
    agg: payload.agg, rowsSumToHeader: payload.rowsSumToHeader,
    st: { done: 1, of: 2, building: true }, counts: [],
  }));
  assert.match(text(node), /duplicate-message group not yet resolved/, 'the chip renders from the payload the session page actually reads');
  assert.match(text(node), /R2/);
});

/* ================================================================== *
 * round 2 — COR-2: the render abort closes the find stream
 * ================================================================== */

test('COR-2: navigating away mid-scan closes the EventSource (ctx.signal is the lifecycle hook)', async () => {
  const { renderFind } = await import('../web/js/views/find.mjs');
  globalThis.EventSource = FakeEventSource;
  FakeEventSource.last = null;
  const ac = new AbortController();
  const ctx = {
    el: el(), query: new URLSearchParams({ q: 'NEEDLE' }), signal: ac.signal,
    crumbs() {}, registerUp() {}, registerScope() {}, scopeSentence() {}, setTitle() {}, navigate() {},
  };
  try {
    await renderFind(ctx);
    assert.ok(FakeEventSource.last, 'the scan opened a stream');
    assert.equal(FakeEventSource.last.closedByClient, false);
    ac.abort();                       // the router aborts the previous ctx on navigation
    assert.equal(FakeEventSource.last.closedByClient, true, 'the stream is closed the moment the render is superseded');
  } finally {
    delete globalThis.EventSource;
  }
});

/* ================================================================== *
 * round 3 — R3-2: L2 rechecks its OWN R2 state until it resolves
 *
 * The round-2 ACC-2 test above hand-built `st: { building: true }` and fed it
 * straight to statbar(), so it never exercised the derivation that actually
 * runs on the page: indexStatus(detail) over a real /api/session payload,
 * which is FALSE for every session payload (the payload ships `r2`, not
 * status/scope/building/pending[]). These drive the real paintSession, the
 * real scheduler and the real refresh path.
 * ================================================================== */

// what /api/session ships while the index is still building
const R2_PENDING_DETAIL = {
  slug: 'C--proj', id: CANON_ID, state: 'ok', badges: [],
  turns: [{ idx: 0, preamble: true, at: null }, { idx: 1, preamble: false, at: 1755400000000, endedAt: 1755400600000 }],
  agents: [], workflows: [],
  agg: {
    requests: 12, tokens: zeroTokens, usd: { total: 500 },
    inherited: {}, unpriced: {}, synthetic: 0, neverFinalized: 0,
    inheritedPending: true,
  },
  forkPartners: null,
  rowsSumToHeader: null,
  r2: 'pending',
};
const R2_RESOLVED_DETAIL = {
  ...R2_PENDING_DETAIL,
  agg: { ...R2_PENDING_DETAIL.agg, inheritedPending: undefined },
  forkPartners: {},
  rowsSumToHeader: true,
  r2: 'resolved',
};

function r2Ctx() {
  const banners = [];
  const stats = [];
  const base = {
    el: el(), banners, stats, stale: false,
    banner: (t2, tone, extra) => banners.push({ text: t2, tone, extra }),
    statbar: (props) => stats.push(props),
  };
  return new Proxy(base, { get: (t2, k) => (k in t2 ? t2[k] : () => {}) });
}

/** Runs `fn` with every timer captured instead of fired, and fetch stubbed. */
async function withCapturedPoll(fn, fetchImpl) {
  const scheduled = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const realFetch = globalThis.fetch;
  globalThis.setTimeout = (cb, ms) => { scheduled.push({ cb, ms }); return { captured: true }; };
  globalThis.clearTimeout = () => {};
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try { await fn(scheduled); } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    if (fetchImpl) globalThis.fetch = realFetch;
  }
}
const jsonRes = (body) => async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) });
const chipText = (props) => { const n = el(); statbar(n, props); return text(n); };
const paintPending = (ctx) => L2.paintSession(ctx, {
  detail: R2_PENDING_DETAIL, slug: 'C--proj', sid: CANON_ID, query: new URLSearchParams(),
});

test('R3-2: indexStatus() is blind to a session payload — the branch the old 1 s poll hung off is dead', async () => {
  const { readFile } = await import('node:fs/promises');
  const st = L0.indexStatus(R2_PENDING_DETAIL);
  assert.equal(st.building, false,
    '/api/session ships no status/scope/building/pending[], so st.building cannot be true for a session');
  assert.equal(L2.r2Pending(R2_PENDING_DETAIL), true, 'the payload discloses its R2 state on its own field');
  assert.equal(L2.r2Pending(R2_RESOLVED_DETAIL), false);
  // and the dead branch stays gone: a 1 s renderSession loop re-renders under
  // the reader, which DESIGN §7 / COR-19 forbid
  const src = await readFile(new URL('../web/js/views/l2.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /if \(st\.building\)/,
    'l2 must not reinstate the st.building -> renderSession poll');
});

test('R3-2: a PENDING, non-live session arms the quiet recheck (it used to arm nothing at all)', async () => {
  await withCapturedPoll(async (scheduled) => {
    const ctx = r2Ctx();
    paintPending(ctx);
    const polls = scheduled.filter((s) => s.ms === L2.R2_POLL_MS);
    assert.equal(polls.length, 1, 'exactly one recheck is armed for the unresolved payload');
    assert.match(chipText(ctx.stats[0]), /duplicate-message group not yet resolved/,
      'and the chip whose claim it will retire is on the band right now');
  });
});

test('R3-2: a RESOLVED session arms no recheck — there is nothing left to watch', async () => {
  await withCapturedPoll(async (scheduled) => {
    const ctx = r2Ctx();
    L2.paintSession(ctx, { detail: R2_RESOLVED_DETAIL, slug: 'C--proj', sid: CANON_ID, query: new URLSearchParams() });
    assert.equal(scheduled.filter((s) => s.ms === L2.R2_POLL_MS).length, 0);
    assert.doesNotMatch(chipText(ctx.stats[0]), /duplicate-message group not yet resolved/);
  });
});

test('R3-2: when the recheck sees R2 resolved it repaints the BAND (chip gone) and stops polling', async () => {
  await withCapturedPoll(async (scheduled) => {
    const ctx = r2Ctx();
    paintPending(ctx);
    const poll = scheduled.find((s) => s.ms === L2.R2_POLL_MS);
    const before = ctx.stats.length;
    const contentBefore = ctx.el.childNodes[0];
    scheduled.length = 0;
    await poll.cb();                                   // the index finished between ticks
    assert.equal(ctx.stats.length, before + 1, 'the disclosure band is repainted from the fresh payload');
    assert.doesNotMatch(chipText(ctx.stats[before]), /duplicate-message group not yet resolved/,
      'the chip is gone the moment its claim stops being true');
    assert.equal(ctx.el.childNodes[0], contentBefore,
      'and the page itself is untouched — DESIGN §7: never re-render under the reader');
    assert.equal(scheduled.filter((s) => s.ms === L2.R2_POLL_MS).length, 0, 'polling stops once resolved');
  }, jsonRes(R2_RESOLVED_DETAIL));
});

test('R3-2: while R2 is STILL pending the recheck re-arms itself and repaints nothing', async () => {
  await withCapturedPoll(async (scheduled) => {
    const ctx = r2Ctx();
    paintPending(ctx);
    const poll = scheduled.find((s) => s.ms === L2.R2_POLL_MS);
    const before = ctx.stats.length;
    scheduled.length = 0;
    await poll.cb();
    assert.equal(ctx.stats.length, before, 'nothing changed, so nothing is repainted');
    assert.equal(scheduled.filter((s) => s.ms === L2.R2_POLL_MS).length, 1, 'it keeps watching');
  }, jsonRes(R2_PENDING_DETAIL));
});


/* ================================================================== *
 * round 4 — R4-2: the quiet R2 watcher owns the page's ONE poll slot, so it
 * has to notice growth and hand the slot back.
 *
 * All four R3-2 cases above hold detail.bytes/events/state FIXED across the
 * mocked tick, which is exactly why the hole survived: watchSessionR2 looked
 * at `r2` and nothing else, and had no route back to the 5 s live watcher.
 * ================================================================== */

const R2_PENDING_SIZED = { ...R2_PENDING_DETAIL, bytes: 1000, events: 10 };
const paintSized = (ctx, detail = R2_PENDING_SIZED) => L2.paintSession(ctx, {
  detail, slug: 'C--proj', sid: CANON_ID, query: new URLSearchParams(),
});
/** The reload bar is real chrome — build the shell so showReloadBar lands. */
async function shellRouter() {
  const R = await import('../web/js/router.mjs');
  if (!R.getShell()) R.buildShell(el());
  R.hideReloadBar();
  return R;
}

test('R4-2: a still-pending tick that GREW and went live reports the growth and hands the slot to the 5 s watcher', async () => {
  const R = await shellRouter();
  await withCapturedPoll(async (scheduled) => {
    const ctx = r2Ctx();
    paintSized(ctx);
    const poll = scheduled.find((s) => s.ms === L2.R2_POLL_MS);
    assert.ok(poll, 'a non-live, R2-pending session arms the quiet watcher — it owns the only poll slot');
    scheduled.length = 0;
    await poll.cb();
    assert.match(R.getShell().reloadEl.textContent, /this session grew on disk/,
      'the growth this watcher previously had no data path that could ever notice');
    assert.equal(scheduled.filter((s) => s.ms === 5000).length, 1,
      'and the live watcher takes the slot, so growth detection never depends on which watcher owns it');
    assert.equal(scheduled.filter((s) => s.ms === L2.R2_POLL_MS).length, 0,
      'the 1 s loop does not also re-arm — one timer, never two');
  }, jsonRes({ ...R2_PENDING_SIZED, bytes: 5000, events: 40, state: 'live' }));
});

test('R4-2: a still-pending tick that grew but stayed idle keeps ONE 1 s watcher (no 5 s bar-spam loop)', async () => {
  const R = await shellRouter();
  await withCapturedPoll(async (scheduled) => {
    const ctx = r2Ctx();
    paintSized(ctx);
    const poll = scheduled.find((s) => s.ms === L2.R2_POLL_MS);
    scheduled.length = 0;
    await poll.cb();
    assert.match(R.getShell().reloadEl.textContent, /this session grew on disk/);
    assert.equal(scheduled.filter((s) => s.ms === 5000).length, 0, 'not live, so no handoff');
    assert.equal(scheduled.length, 1, 'exactly one timer stays armed, at the quiet cadence');
    assert.equal(scheduled[0].ms, L2.R2_POLL_MS);
  }, jsonRes({ ...R2_PENDING_SIZED, bytes: 5000, events: 40 }));
});

test('R4-2: R2 resolving on a session that is NOW live arms the live watcher instead of stopping dead', async () => {
  await shellRouter();
  await withCapturedPoll(async (scheduled) => {
    const ctx = r2Ctx();
    paintSized(ctx);
    const poll = scheduled.find((s) => s.ms === L2.R2_POLL_MS);
    const before = ctx.stats.length;
    scheduled.length = 0;
    await poll.cb();
    assert.equal(ctx.stats.length, before + 1, 'the band is still repainted the moment R2 resolves');
    assert.equal(scheduled.filter((s) => s.ms === 5000).length, 1,
      'a reader who dismisses the R2 bar used to be left with no poll for the rest of the page’s life');
  }, jsonRes({ ...R2_RESOLVED_DETAIL, bytes: 5000, events: 40, state: 'live' }));
});

test('R4-2: a resolved tick on a session that is NOT live still stops polling — nothing is left to watch', async () => {
  await shellRouter();
  await withCapturedPoll(async (scheduled) => {
    const ctx = r2Ctx();
    paintSized(ctx);
    const poll = scheduled.find((s) => s.ms === L2.R2_POLL_MS);
    scheduled.length = 0;
    await poll.cb();
    assert.equal(scheduled.length, 0, 'the R3-2 stop-polling behaviour is unchanged for an idle session');
  }, jsonRes({ ...R2_RESOLVED_DETAIL, bytes: 1000, events: 10 }));
});

/* ================================================================== *
 * round 3 — WF-1 / WF-2, client half: the empty (and then stringly-typed)
 * agents array is what made the run page claim things that are not so.
 * ================================================================== */

test('WF-1: a populated agents array clears the false "manifest entries have no transcript" claim', async () => {
  const { reconcileAgents } = await import('../web/js/views/workflow.mjs');
  const manifestIds = ['a0000000000000001', 'a0000000000000002'];
  // what the COMPLETE envelope ships now: one object per transcript on disk
  const agents = [
    { agentId: 'a0000000000000001', label: { text: 'one' }, model: 'claude-opus-5', firstAt: 1755400000000, lastAt: 1755400600000 },
    { agentId: 'a0000000000000002', label: { text: 'two' }, model: 'claude-sonnet-5', firstAt: 1755400100000, lastAt: 1755400500000 },
  ].map(L3.normalizeAgent);
  const recon = reconcileAgents({ manifestIds, journal: [], transcriptIds: agents.map((x) => x.agentId).filter(Boolean) });
  assert.deepEqual(recon.inManifestNotOnDisk, [],
    'the banner that fabricated a manifest-vs-disk discrepancy on every completed run is gone');
  assert.equal(agents[0].model, 'claude-opus-5', 'normalizeAgent reads raw.model — the server now projects it');
  assert.ok(agents.every((a) => a.agentId), 'and every row links to a real agent page');
  // the pre-fix payload (`agents: []`) is exactly what produced the false claim
  const broken = reconcileAgents({ manifestIds, journal: [], transcriptIds: [] });
  assert.equal(broken.inManifestNotOnDisk.length, 2, 'pinning the mechanism this fix removes');
});

test('WF-2: normalizeAgent over a bare filename yields nothing — the shape the partial branch must never ship', () => {
  const fromString = L3.normalizeAgent('agent-a0000000000000003.jsonl');
  assert.equal(fromString.agentId, null, 'every column of that row rendered as the unknown placeholder');
  assert.equal(fromString.model, null);
  const fromObject = L3.normalizeAgent({ agentId: 'a0000000000000003', model: 'claude-fable-5', firstAt: 1755400000000 });
  assert.equal(fromObject.agentId, 'a0000000000000003');
  assert.equal(fromObject.model, 'claude-fable-5');
});

/* ================================================================== *
 * round 4 — the workflow run page, driven through the REAL renderWorkflow.
 *
 * The round-3 WF-1/WF-2 tests above assert on reconcileAgents()' RETURN
 * VALUE. That is exactly why R4-1 and R4-UI-1 survived round 3: a correct
 * recon object that the DOM path then discards or contradicts still passes a
 * payload-level assertion. Everything below drives renderWorkflow itself and
 * reads what actually reaches the page.
 * ================================================================== */



function wfCtx(params) {
  const banners = [];
  const stats = [];
  const base = {
    el: el(), banners, stats, stale: false,
    params, query: new URLSearchParams(),
    banner: (t2, tone, extra) => banners.push({ text: t2, tone, extra }),
    statbar: (props) => stats.push(props),
  };
  // every other render-ctx hook is a no-op — EXCEPT `then`: a catch-all that
  // hands back a function for `then` makes the ctx look like a thenable, and
  // `await`ing one hangs forever.
  return new Proxy(base, {
    get: (t2, k) => (k in t2 ? t2[k] : (k === 'then' || typeof k === 'symbol' ? undefined : () => {})),
  });
}

const RUN_ID = 'wf_r4000001-abc';

/** Drives the REAL renderWorkflow over one stubbed /api/workflow response. */
async function renderRun(payload, { slug = 'C--proj', sid = CANON_ID, runId = RUN_ID } = {}) {
  const ctx = wfCtx({ slug, sid, runId });
  const realFetch = globalThis.fetch;
  globalThis.fetch = jsonRes(payload);
  try { await WF.renderWorkflow(ctx); } finally { globalThis.fetch = realFetch; }
  return ctx;
}
/** Every unknown() reason on the page — they live in the title attribute. */
const reasonsOn = (root) => root.querySelectorAll('.lens-unknown').map((n) => n.getAttribute('title'));
/** The text of every problem-classified note on the page. */
const problemNotes = (root) => root.querySelectorAll('.lens-note--problem').map((n) => n.textContent);
const notesOn = (root) => root.querySelectorAll('.lens-note').map((n) => n.textContent);

// the shape /api/workflow ships for a COMPLETE run whose journal really does
// record starts and results (live shape: proj-c, wf_00000002-a02)
const AG_A = 'a0000000000000001';
const AG_B = 'a0000000000000002';
const AG_ORPHAN = 'a0000000000000009';
const WF_AGENT = (agentId, over = {}) => ({
  agentId, rel: `x/${agentId}.jsonl`, file: `agent-${agentId}.jsonl`, runId: RUN_ID,
  label: { text: agentId === AG_A ? 'one' : 'two' }, model: 'claude-fable-5',
  // the projection spells the phase phaseTitle/phaseIndex — never `phase`
  phaseTitle: agentId === AG_A ? 'Engine build' : 'Rules audit', phaseIndex: agentId === AG_A ? 1 : 2,
  firstAt: 1755400000000, lastAt: 1755400600000, ...over,
});
const WF_PROGRESS = [
  { type: 'workflow_agent', agentId: AG_A, label: 'one', phaseIndex: 1, phaseTitle: 'Engine build', model: 'claude-fable-5', state: 'done', queuedAt: 1755399990000, startedAt: 1755400000000, durationMs: 600000 },
  { type: 'workflow_agent', agentId: AG_B, label: 'two', phaseIndex: 2, phaseTitle: 'Rules audit', model: 'claude-fable-5', state: 'done', queuedAt: 1755399995000, startedAt: 1755400010000, durationMs: 500000 },
];
const WF_JOURNAL = [
  { type: 'started', key: `v2:${'1'.repeat(64)}`, agentId: AG_A },
  { type: 'result', key: `v2:${'1'.repeat(64)}`, agentId: AG_A, result: { ok: true } },
  { type: 'started', key: `v2:${'2'.repeat(64)}`, agentId: AG_B },
  { type: 'result', key: `v2:${'2'.repeat(64)}`, agentId: AG_B, result: 'the second answer' },
];
const completeRun = (over = {}) => ({
  slug: 'C--proj', id: CANON_ID, runId: RUN_ID, complete: true,
  record: { runId: RUN_ID, workflowName: 'build', status: 'completed', workflowProgress: WF_PROGRESS },
  agents: [WF_AGENT(AG_A), WF_AGENT(AG_B)],
  journal: WF_JOURNAL,
  cost: { requests: 2, tokens: zeroTokens, usd: { total: 100 } },
  rowsSumToHeader: true, problems: [],
  ...over,
});

/* --------------------------------------------------------------- R4-UI-1 */

test('R4-UI-1: a COMPLETE run renders its journal — the section, the entries and the started/result arithmetic', async () => {
  const ctx = await renderRun(completeRun());
  const pageText = text(ctx.el);
  assert.doesNotMatch(pageText, /no journal\.jsonl in this run directory/,
    'the claim that fired on 52 of the 53 completed runs in the corpus, every one of which HAS a journal.jsonl');
  assert.ok(!reasonsOn(ctx.el).includes('no journal.jsonl in this run directory'),
    'and not tucked into an unknown() reason either');
  assert.match(pageText, /journal — 4 entries/, 'the section counts the entries the envelope carries');
  assert.match(pageText, /the second answer/, 'and the recorded result text reaches the table');
  assert.match(pageText, /journal started \/ result2 \/ 2/,
    'the run fact is journal arithmetic over the real entries — it read "0 / 0" for every completed run');
});

test('R4-UI-1: an UNDISCLOSED journal renders unknown — never "0 / 0", never "retried no", never a claim of absence', async () => {
  const full = completeRun();
  delete full.journal;                                    // exactly the pre-fix envelope
  const ctx = await renderRun(full);
  const pageText = text(ctx.el);
  const why = reasonsOn(ctx.el);
  assert.doesNotMatch(pageText, /journal started \/ result0 \/ 0/, 'no invented zero census');
  assert.doesNotMatch(pageText, /retriedno/, 'and no invented "retried: no"');
  assert.ok(!why.includes('no journal.jsonl in this run directory'),
    'an envelope that never mentioned the journal cannot say the file is absent');
  assert.ok(why.filter((r) => /does not disclose the journal/.test(r)).length >= 3,
    'the section, the started/result fact and the retried fact each say what is actually true');
});

test('R4-UI-1: a run directory that provably has no journal.jsonl still says so — [] and null are different facts', async () => {
  const ctx = await renderRun(completeRun({ journal: [] }));
  assert.ok(reasonsOn(ctx.el).includes('no journal.jsonl in this run directory'),
    'a server that looked at the listing and found none keeps the provable wording');
  assert.match(text(ctx.el), /journal started \/ result0 \/ 0/,
    'and 0 / 0 is a real census over a real empty list');
});

test('R4-UI-1: an orphan transcript with a start and no result on a COMPLETE run is called neither "running" nor "superseded attempt"', async () => {
  // shipping the journal on the complete envelope makes recon.running non-empty
  // on FINISHED runs for the first time; SPEC §7 conditions the "running"
  // wording on a run that is still in flight.
  const ctx = await renderRun(completeRun({
    agents: [WF_AGENT(AG_A), WF_AGENT(AG_B), WF_AGENT(AG_ORPHAN)],
    journal: [...WF_JOURNAL, { type: 'started', key: `v2:${'9'.repeat(64)}`, agentId: AG_ORPHAN }],
  }));
  const orphan = notesOn(ctx.el).find((t2) => /absent from the manifest/.test(t2));
  assert.ok(orphan, 'the orphan is still disclosed');
  assert.doesNotMatch(orphan, /running/, 'nothing is running on a run that has written its manifest');
  assert.doesNotMatch(orphan, /superseded attempt/, 'and it is not diagnosed as superseded either');
  assert.match(orphan, /the journal records a start and no result/, 'it states the recorded signature and stops');

  // the in-flight envelope keeps the SPEC §7 wording it is entitled to
  const flying = await renderRun({
    slug: 'C--proj', id: CANON_ID, runId: RUN_ID, complete: false,
    agents: [WF_AGENT(AG_ORPHAN)], journal: [{ type: 'started', key: 'v2:x', agentId: AG_ORPHAN }],
    cost: null, rowsSumToHeader: null, problems: [],
  });
  assert.ok(notesOn(flying.el).some((t2) => /running — journal records a start, no result yet/.test(t2)),
    'an in-flight run is exactly where that wording belongs');
});

/* ------------------------------------------------------------------ R4-1 */

test('R4-1: a completed run whose transcripts are ALL gone still shows the problem banner naming the missing ids', async () => {
  const ids = ['a111111111', 'a222222222', 'a333333333'];
  const ctx = await renderRun(completeRun({
    record: {
      runId: RUN_ID, workflowName: 'build', status: 'completed',
      workflowProgress: ids.map((agentId) => ({ type: 'workflow_agent', agentId, label: agentId, phaseTitle: 'Engine build', state: 'done' })),
    },
    agents: [],
  }));
  const banner = problemNotes(ctx.el).find((t2) => /have no transcript in this directory/.test(t2));
  assert.ok(banner, 'the early return used to drop this banner exactly when every transcript was missing');
  for (const id of ids) assert.match(banner, new RegExp(id), `${id} is named`);
  assert.ok(reasonsOn(ctx.el).includes('no agent transcript in this run directory'),
    'and the empty-table unknown it always printed is still there');
});

test('R4-1: the non-empty rendering is unchanged — the table still comes BEFORE the reconciliation notes', async () => {
  const ctx = await renderRun(completeRun({
    record: {
      runId: RUN_ID, workflowName: 'build', status: 'completed',
      workflowProgress: [...WF_PROGRESS, { type: 'workflow_agent', agentId: 'a444444444', label: 'gone', phaseTitle: 'Fix loop', state: 'done' }],
    },
  }));
  const sec = ctx.el.querySelectorAll('.lens-section')
    .find((s) => /agents in this run/.test(s.childNodes[0] ? s.childNodes[0].textContent : ''));
  assert.ok(sec, 'the agents section exists');
  const kids = sec.childNodes.filter((n) => n.localName === 'table' || n.localName === 'p');
  assert.equal(kids[0].localName, 'table', 'the table is first — hoisting the notes above it would reorder every live run');
  assert.match(kids[1].textContent, /no transcript in this directory/);
  assert.match(kids[1].textContent, /a444444444/);
});

/* --------------------------------------------------------------- R4-UI-2 */

test('R4-UI-2: the workflowProgress table renders the recorded phaseTitle — `phase` is a key the manifest has never had', async () => {
  const ctx = await renderRun(completeRun());
  const pageText = text(ctx.el);
  assert.match(pageText, /Engine build/, 'the recorded phase title reaches the page');
  assert.match(pageText, /Rules audit/);
  assert.ok(!reasonsOn(ctx.el).includes('no phase recorded'),
    '696 of 696 workflow_agent entries in the corpus record phaseTitle; 0 record `phase`');
});

test('R4-UI-2: a phaseIndex of 0 survives, and an empty phaseTitle stays unknown rather than becoming a blank group key', () => {
  assert.equal(L3.phaseLabelOf({ phaseIndex: 0 }), 'phase 0', '`!= null`, never truthiness');
  assert.equal(L3.phaseLabelOf({ phaseTitle: '' }), null, 'a recorded blank is not a known phase');
  assert.equal(L3.phaseLabelOf({ phaseTitle: '', phaseIndex: 3 }), 'phase 3');
  assert.equal(L3.phaseLabelOf({ phase: 'named', phaseTitle: 'other' }), 'named', '`phase` still wins where it exists');
  assert.equal(L3.phaseLabelOf(null), null);
  assert.equal(L3.phaseLabelOf('agent-a1.jsonl'), null, 'a bare string records nothing');
});

test('R4-UI-2 (adjacent): a workflow_phase MARKER row names its recorded title instead of claiming no phase', async () => {
  // found by looking at the live page after the fix landed: the manifest's own
  // phase entries record {type:'workflow_phase', index, title} — a different
  // recorded shape from the agent entries — and the cell printed the same
  // "no phase recorded" over the row that declares the phase.
  assert.equal(L3.phaseLabelOf({ type: 'workflow_phase', index: 1, title: 'Engine build' }), 'Engine build');
  assert.equal(L3.phaseLabelOf({ type: 'workflow_phase', index: 0 }), 'phase 0', 'index 0 is a recorded index');
  assert.equal(L3.phaseLabelOf({ type: 'workflow_phase' }), null, 'and a marker recording neither stays unknown');

  const ctx = await renderRun(completeRun({
    record: {
      runId: RUN_ID, workflowName: 'build', status: 'completed',
      workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'Engine build' }, ...WF_PROGRESS],
    },
  }));
  assert.ok(!reasonsOn(ctx.el).includes('no phase recorded'),
    'every row of the live wf_00000002-a02 table said this, including the three phase markers');
});

test('R4-UI-2: normalizeAgent and the run page read the SAME phase alias — one helper, no fourth spelling', () => {
  assert.equal(L3.normalizeAgent({ agentId: AG_A, phaseTitle: 'Engine build' }).phase, 'Engine build');
  assert.equal(L3.normalizeAgent({ agentId: AG_A, phaseIndex: 2 }).phase, 'phase 2');
});

/* --------------------------------------------------------------- R4-UI-3 */

test('R4-UI-3: an agent whose stateFacts record a result no longer reads "the journal records no result for this agent"', () => {
  const f = L4.journalResultFact(undefined, { manifestState: 'done', journalStarted: 1, journalResult: true, resultEmpty: false });
  assert.notEqual(f.value, null, 'the fact was unknown for EVERY agent — the argument was always undefined');
  assert.match(f.value, /recorded/);
  assert.equal(f.reason, undefined, 'so no reason is printed at all');
  assert.match(f.source, /stateFacts/, 'and the provenance names where the fact actually came from');
});

test('R4-UI-3: a recorded-and-genuinely-empty result gets the ∅ wording, not the absence wording', () => {
  const f = L4.journalResultFact(undefined, { journalResult: true, resultEmpty: true });
  assert.equal(f.value, '(recorded, and genuinely empty)');
});

test('R4-UI-3: with NO stateFacts (main, or an unprojected agent) the fact is unknown for the honest reason', () => {
  const f = L4.journalResultFact(undefined, null);
  assert.equal(f.value, null);
  assert.match(f.reason, /this envelope carries no journal facts/);
  assert.doesNotMatch(f.reason, /records no result/, 'never a claim about what the journal says');
});

test('R4-UI-3: stateFacts that DO say there is no result keep the original reason — now provable', () => {
  const f = L4.journalResultFact(undefined, { journalStarted: 1, journalResult: false, resultEmpty: null });
  assert.equal(f.value, null);
  assert.equal(f.reason, 'the journal records no result for this agent');
});

test('R4-UI-3: a real journal object still wins — it carries the result TEXT the flattened facts do not', () => {
  const f = L4.journalResultFact({ result: 'the second answer' }, { journalResult: true, resultEmpty: false });
  assert.equal(f.value, 'the second answer');
  assert.equal(f.source, 'journal.jsonl result entry');
});

test('R4-UI-3: the l4 census row is BUILT from journalResultFact — a revert to the inline call fails here', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../web/js/views/l4.mjs', import.meta.url), 'utf8');
  assert.match(src, /journalResultFact\(payload\.journal \?\? ag\.journal, ag\.stateFacts \?\? null\)/,
    'the fact row reads the recorded stateFacts, not a `journal` key no envelope has ever carried');
  assert.doesNotMatch(src, /value: journalResultText\(payload\.journal \?\? ag\.journal\)/,
    'the old always-null, always-the-same-reason row is gone');
});


/* R4-UI-3, at the real render path — the payload-level tests above pin the
 * derivation, these pin the CALL SITE. Round 2 exists because a correct helper
 * that the page never reaches is not a fix. */

/** Routes the stubbed fetch by pathname: /api/agent/… vs /api/session/…. */
const routedRes = (byPath) => async (u) => {
  const url = String(u);
  const hit = Object.entries(byPath).find(([k]) => url.startsWith(k));
  const body = hit ? hit[1] : {};
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
};

async function renderAgentPage({ slug, sid, agentId, agent, sessionAgents }) {
  const ctx = wfCtx({ slug, sid, agentId });
  ctx.query = new URLSearchParams();
  ctx.path = `/p/${slug}/s/${sid}/a/${agentId}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = routedRes({
    '/api/agent/': { agentId, rel: `${slug}/${sid}/subagents/agent-${agentId}.jsonl`, rows: [], total: 0, from: 0, count: 300, agg: null, rowsSumToHeader: null, problems: [], ...agent },
    '/api/session/': {
      slug, id: sid, state: 'ok', badges: [], turns: [], workflows: [],
      agents: sessionAgents, agg: null, forkPartners: {}, rowsSumToHeader: null, r2: 'resolved',
    },
    '/api/line': { event: {} },
  });
  try { await L4.renderAgent(ctx); } finally { globalThis.fetch = realFetch; }
  return ctx;
}

const STATE_FACTS_WITH_RESULT = {
  manifestState: 'done', inManifest: true, cached: false, attempt: null,
  journalStarted: 1, journalResult: true, resultEmpty: false, spawnStatus: 'launched',
};

test('R4-UI-3 (render path): the agent page stops printing "the journal records no result" over a recorded result', async () => {
  const sid = '5f000000-0000-4000-8000-0000000000a1';
  const agentId = 'a57c107e58af1c8c3';
  const ctx = await renderAgentPage({
    slug: 'C--proj', sid, agentId,
    sessionAgents: [{ agentId, firstAt: 1755400000000, lastAt: 1755400600000, stateFacts: STATE_FACTS_WITH_RESULT }],
  });
  const why = reasonsOn(ctx.el);
  assert.ok(!why.includes('the journal records no result for this agent'),
    'this reason reached EVERY agent page, including agents whose journal records a full, non-empty result');
  assert.match(text(ctx.el), /journal result/, 'the fact is still on the page');
  assert.match(text(ctx.el), /\(recorded/, 'and it now states what the recorded stateFacts say');
});

test('R4-UI-3 (render path): main has no stateFacts, so its journal-result fact is unknown for the honest reason', async () => {
  const sid = '5f000000-0000-4000-8000-0000000000a2';
  const ctx = await renderAgentPage({
    slug: 'C--proj', sid, agentId: 'main',
    agent: { agentId: 'main', rel: `C--proj/${sid}.jsonl` },
    sessionAgents: [],
  });
  const why = reasonsOn(ctx.el);
  assert.ok(!why.includes('the journal records no result for this agent'),
    'the main thread has no journal entry by construction — claiming the journal says so was never founded');
});

/* --------------------------------------------------------------- R4-UI-4 */

test('R4-UI-4: the L4 queuedAt / startedAt facts render a time once the server stops dropping numeric epochs', () => {
  const ag = L3.normalizeAgent({ agentId: AG_A, queuedAt: 1755399990000, startedAtRecorded: 1755400000000 });
  const facts = L4.headerFacts(ag);
  const q = facts.find((f) => f.label === 'queuedAt');
  const s = facts.find((f) => f.label === 'startedAt (manifest)');
  assert.notEqual(q.value, null, 'this printed "—" for every workflow agent in the corpus');
  assert.notEqual(s.value, null);
  assert.match(q.source, /workflowProgress\[\]\.queuedAt/);
});
