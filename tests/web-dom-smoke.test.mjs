// tests/web-dom-smoke.test.mjs — dependency-free DOM smoke test.
//
// No JSDOM (no dependencies allowed). A ~120-line fake document is installed on
// globalThis BEFORE the components are imported, which is enough to prove the
// BUILD-CONTRACTS mount signature holds for every component group E owns:
//
//     mount(el, props) -> { update(props), destroy() }
//
// and that each one paints the class names groups F and G style against.

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * the fake document
 * ------------------------------------------------------------------ */

// The fake DOM itself lives in tests/helpers/fake-dom.mjs (shared by every
// web test file); it is installed here, BEFORE the web modules are imported.
import { doc, FakeElement } from './helpers/fake-dom.mjs';

globalThis.document = doc;

/* ------------------------------------------------------------------ *
 * imports AFTER the fake document exists (h() reads it at call time,
 * but importing late is the honest way to prove the ordering works)
 * ------------------------------------------------------------------ */

const { h, setPricingModule } = await import('../web/js/format.mjs');
const { chrome, crumbs, scopeSentence } = await import('../web/js/components/scope.mjs');
const { statbar, CELL_ORDER } = await import('../web/js/components/statbar.mjs');
const { chipsRow } = await import('../web/js/components/chips.mjs');
const { vtable } = await import('../web/js/components/vtable.mjs');
const { timeline } = await import('../web/js/components/timeline.mjs');
const { rowsPane } = await import('../web/js/components/rows.mjs');
const { jsonview } = await import('../web/js/components/jsonview.mjs');
const { costfigure } = await import('../web/js/components/costfigure.mjs');

setPricingModule(null);

const el = () => doc.createElement('div');
const text = (node) => node.textContent;
const classes = (node) => {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c instanceof FakeElement) { const cl = c.getAttribute('class'); if (cl) out.push(...cl.split(/\s+/)); walk(c); }
    }
  };
  walk(node);
  return out;
};

const zeroTokens = { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };
const agg = {
  requests: 29741,
  tokens: { input: 730264, output: 31396469, cache5m: 82301772, cache1h: 91056006, cacheFlat: 0, cacheRead: 6307164218 },
  usd: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, webSearch: 0, total: 2e9 },
  thinking: { tokens: 1234, recordedOn: 100, notRecordedOn: 900 },
  unpriced: {}, inherited: {}, embeddedSidechain: { requests: 0, tokens: zeroTokens },
  neverFinalized: 1584, synthetic: 28, ttlAssumed: 0, tierAssumed: 0, premiumUnknown: 0,
  byModel: { 'claude-opus-5': { requests: 10, tokens: zeroTokens, usd: { total: 2e9 } } },
};

function assertHandle(handle, name) {
  assert.equal(typeof handle, 'object', `${name} must return a handle`);
  assert.equal(typeof handle.update, 'function', `${name}.update is part of the contract`);
  assert.equal(typeof handle.destroy, 'function', `${name}.destroy is part of the contract`);
}

/* ------------------------------------------------------------------ */

test('chrome() builds the three fixed bands plus the banner/content slots', () => {
  const root = el();
  const shell = chrome(root);
  for (const key of ['crumbEl', 'scopeEl', 'statEl', 'bannerEl', 'contentEl', 'sheetEl', 'footEl', 'reloadEl']) {
    assert.ok(shell[key], `chrome() must expose ${key}`);
  }
  assert.equal(root.getAttribute('class'), 'lens-app');
  assert.equal(shell.contentEl.getAttribute('id'), 'lens-content');
});

test('crumbs: last segment is not a link, and ↑ is labelled with its destination', () => {
  const node = el();
  const handle = crumbs(node, {
    up: { href: '#/p/blog', label: 'project proj-h' },
    items: [
      { label: 'store', href: '#/' },
      { label: 'proj-h', href: '#/p/blog', id: 'blog' },
      { label: 'session', id: '0000000b' },
    ],
  });
  assertHandle(handle, 'crumbs');
  const links = node.querySelectorAll('a');
  assert.equal(links.length, 3, 'up + two ancestors — the current crumb is not a link');
  assert.match(text(node), /project proj-h/);
  assert.ok(node.querySelector('.lens-crumbs__item--current'));
  handle.update({ items: [{ label: 'store' }] });
  assert.equal(node.querySelectorAll('a').length, 1);
  handle.destroy();
  assert.equal(node.childNodes.length, 0);
});

test('scopeSentence renders the generated sentence and the Σ toggle only when filtered', () => {
  const node = el();
  const handle = scopeSentence(node, { subject: 'the whole store', counts: [{ n: 85, noun: 'session' }] });
  assertHandle(handle, 'scopeSentence');
  assert.match(text(node), /Showing 85 sessions in the whole store\./);
  assert.equal(node.querySelectorAll('.lens-scope__sigma-btn').length, 0);

  let picked = null;
  handle.update({ filters: [{ label: 'dates', value: 'x' }], totals: { all: 85, filtered: 3 }, onSigma: (k) => { picked = k; } });
  const btns = node.querySelectorAll('.lens-scope__sigma-btn');
  assert.equal(btns.length, 2);
  btns[1].dispatch('click');
  assert.equal(picked, 'filtered');
});

test('statbar paints cost | in·out·cache-w·cache-r | span | counts, every cell a button', () => {
  const node = el();
  const handle = statbar(node, {
    agg,
    span: { ms: 3600000, from: 1, to: 3600001 },
    active: { ms: 1800000 },
    counts: [{ key: 'sessions', label: 'sessions', value: 85 }, { key: 'turns', label: 'turns', value: 372 }],
    footnote: { requests: 29741, rowsSumToHeader: true },
    scope: 'store',
  });
  assertHandle(handle, 'statbar');
  assert.deepEqual(CELL_ORDER, ['cost', 'tokens', 'span', 'counts']);

  const cells = node.querySelectorAll('.lens-statbar__cell');
  assert.equal(cells.length, 5, 'cost + tokens + span + two counts');
  for (const c of cells) assert.equal(c.localName, 'button', 'every cell is a button');

  const body = text(node);
  assert.match(body, /\$1\.0000/);
  for (const label of ['in', 'out', 'cache-w', 'cache-r']) assert.ok(body.includes(label), `missing token label ${label}`);
  assert.match(body, /29,741 billed requests · deduped by message\.id \(R1\) ·/);
  assert.match(body, /rows sum to header ✓/);
  assert.match(body, /totals are exact; rows shown rounded to 4 dp/);
  assert.match(body, /active/);

  // the disclosure chips ride under the footnote and cite their rules
  assert.match(body, /synthetic 28 — API-error events, zero usage, excluded from billing · R4/);
  assert.match(body, /responses stopped mid-stream/);
});

test('statbar pending state paints — pips at final widths and no fabricated numbers', () => {
  const node = el();
  const handle = statbar(node, { pending: true, counts: [{ key: 'sessions', label: 'sessions' }] });
  const pips = node.querySelectorAll('.lens-pip');
  assert.ok(pips.length >= 5, 'cost, four token slots, span, count and the footnote all show pips');
  assert.doesNotMatch(text(node), /\$0/, 'a pending figure is never rendered as zero');
  handle.update({ pending: false, agg, footnote: { requests: 1, rowsSumToHeader: true } });
  assert.equal(node.querySelectorAll('.lens-pip').length, 0);
});

test('statbar cell click opens its contribution panel', () => {
  const node = el();
  statbar(node, {
    agg,
    counts: [{ key: 'sessions', label: 'sessions', value: 3 }],
    contributions: { sessions: [{ label: 'session a', href: '#/p/x/s/a', value: 2 }, { label: 'session b', value: 1 }] },
  });
  const panel = node.querySelector('.lens-statbar__panel');
  assert.equal(panel.hasAttribute('hidden'), true);
  const countCell = node.querySelectorAll('.lens-statbar__cell--count')[0];
  countCell.dispatch('click');
  assert.equal(panel.hasAttribute('hidden'), false);
  assert.equal(countCell.getAttribute('aria-expanded'), 'true');
});

test('chipsRow hides itself entirely when there is nothing to disclose', () => {
  const node = el();
  const handle = chipsRow(node, { agg: { requests: 5, unpriced: {}, inherited: {} } });
  assertHandle(handle, 'chipsRow');
  assert.equal(node.hasAttribute('hidden'), true);
  handle.update({ agg: { requests: 5, synthetic: 2, unpriced: {}, inherited: {} } });
  assert.equal(node.hasAttribute('hidden'), false);
  assert.equal(node.querySelectorAll('.lens-chip').length, 1);
});

test('vtable: sortable headers, filter box, → column, sum footer, paging label', () => {
  const node = el();
  const rows = Array.from({ length: 420 }, (_, i) => ({ title: `row ${i}`, slug: i % 2 ? 'a' : 'b', turns: i, cost: i * 1e9 }));
  const handle = vtable(node, {
    columns: [
      { key: 'title', label: 'title', type: 'text' },
      { key: 'slug', label: 'project', type: 'text', groupable: true },
      { key: 'turns', label: 'turns', type: 'num', sum: true },
      { key: 'cost', label: 'cost', type: 'money', sum: true },
    ],
    rows,
    navHref: (r) => `#/p/${r.slug}`,
  });
  assertHandle(handle, 'vtable');
  assert.equal(node.querySelectorAll('.lens-vtable__tr').length, 300, '300-row paging, not infinite scroll');
  assert.match(text(node), /showing 300 of 420/);
  assert.ok(node.querySelector('.lens-vtable__filter'));
  assert.ok(node.querySelector('.lens-vtable__tfoot'));
  assert.equal(node.querySelectorAll('.lens-vtable__nav').length, 300);

  // click-sort
  const th = node.querySelectorAll('.lens-vtable__th--sortable')[2];
  th.dispatch('click', {});
  assert.deepEqual(handle.getState().sort, [{ key: 'turns', dir: 'asc' }]);
  th.dispatch('click', {});
  assert.deepEqual(handle.getState().sort, [{ key: 'turns', dir: 'desc' }]);
  node.querySelectorAll('.lens-vtable__th--sortable')[0].dispatch('click', { shiftKey: true });
  assert.equal(handle.getState().sort.length, 2, 'shift-click adds a secondary key');
});

test('vtable group-by paints sticky subtotal subheaders', () => {
  const node = el();
  vtable(node, {
    columns: [
      { key: 'title', label: 'title', type: 'text' },
      { key: 'slug', label: 'project', type: 'text', groupable: true },
      { key: 'turns', label: 'turns', type: 'num', sum: true },
    ],
    rows: [{ title: 'a', slug: 'x', turns: 1 }, { title: 'b', slug: 'y', turns: 2 }, { title: 'c', slug: 'x', turns: 3 }],
    group: 'slug',
  });
  assert.equal(node.querySelectorAll('.lens-vtable__subtotal').length, 2);
  assert.match(text(node), /2 rows/);
});

test('timeline draws SVG lanes, ticks, spans, a gutter and the (UTC±) label once', () => {
  const node = el();
  const T = Date.UTC(2026, 7, 17, 8, 0, 0);
  const handle = timeline(node, {
    lanes: [
      { id: 'main', label: 'main thread', gutter: { value: 40 } },
      { id: 'a1', label: 'agent a1', href: '#/p/x/s/y/a/a1', gutter: { value: 12 } },
    ],
    marks: [
      { lane: 'main', at: T, end: T + 600000, href: '#/p/x/s/y/t/1', label: 'turn 1' },
      { lane: 'main', at: T + 900000, href: '#/p/x/s/y/t/2' },
      { lane: 'a1', at: T + 300000, end: T + 200000, href: '#/p/x/s/y/a/a1' },   // inverted
    ],
    gutter: { max: 40, label: 'tool calls' },
    width: 900,
  });
  assertHandle(handle, 'timeline');
  const all = classes(node);
  assert.ok(all.includes('lens-timeline__svg'));
  assert.ok(all.includes('lens-timeline__span'), 'two recorded timestamps -> span');
  assert.ok(all.includes('lens-timeline__tick'), 'one recorded timestamp -> tick, no invented width');
  assert.ok(all.includes('lens-timeline__inverted'), 'end < start -> ⚠, never a repaired bar');
  assert.ok(all.includes('lens-timeline__gutter-value'), 'magnitude lives in the right gutter');
  assert.match(text(node), /\(UTC[+−]\d/);
  assert.equal(node.querySelectorAll('a').length >= 3, true, 'every mark and lane label links to its drill route');
  assert.equal(handle.getWindow(), null);
  handle.setWindow({ from: T, to: T + 60000 });
  assert.deepEqual(handle.getWindow(), { from: T, to: T + 60000 });
  handle.resetWindow();
  assert.equal(handle.getWindow(), null, 'zoom is ephemeral and resettable — it never enters the URL');
});

test('timeline with nothing recorded says so instead of inventing an axis', () => {
  const node = el();
  timeline(node, { lanes: [{ id: 'a', label: 'a' }], marks: [] });
  assert.match(text(node), /No timestamps are recorded/);
});

test('timeline bins above the cap and prints the exact counts', () => {
  const node = el();
  const T = Date.UTC(2026, 7, 17, 8, 0, 0);
  const marks = Array.from({ length: 4000 }, (_, i) => ({ lane: 'main', at: T + i * 1000 }));
  timeline(node, { lanes: [{ id: 'main', label: 'main' }], marks, width: 900, binsCap: 500 });
  assert.ok(classes(node).includes('lens-timeline__bin-rect'));
  assert.match(text(node), /4,000 marks exceed the 500-mark budget/);
});

test('rowsPane pages 300 rows, chips the kinds present, and expands in place', async () => {
  const node = el();
  const page = {
    from: 0, count: 300, total: 900,
    rows: [
      { line: 1, bi: null, kind: 'prompt', at: Date.UTC(2026, 7, 17), head: 'do the thing', href: '#/e/1' },
      { line: 2, bi: '0', kind: 'tool_use', at: null, head: 'Read', href: '#/e/2.0' },
      { line: 3, bi: 'r', kind: 'attachment:task_reminder', at: null, head: '', href: '#/e/3.r' },
    ],
  };
  let expanded = null;
  const handle = rowsPane(node, {
    fetchPage: async () => page,
    onExpand: async (row) => { expanded = row; return h('pre', null, 'raw json'); },
  });
  assertHandle(handle, 'rowsPane');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(node.querySelectorAll('.lens-rows__tr').length, 3);
  assert.match(text(node), /showing 3 of 3 rows on this page · 900 rows in scope/);
  assert.ok(node.querySelectorAll('.lens-kind').length >= 3);
  assert.match(text(node), /attachment:task_reminder/);

  node.querySelectorAll('.lens-rows__expand')[0].dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(expanded.line, 1);
  assert.ok(node.querySelector('.lens-rows__detail'));
  assert.match(text(node), /raw json/);
});

test('jsonview highlights the addressed block and lights its ancestors', () => {
  const node = el();
  const value = { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', name: 'Read' }] } };
  const handle = jsonview(node, { value, highlightPath: '1', line: 42, file: 'main.jsonl' });
  assertHandle(handle, 'jsonview');
  const all = classes(node);
  assert.ok(all.includes('is-highlighted'), 'the addressed block is marked');
  assert.ok(all.includes('is-onpath'), 'its ancestors are opened along the way');
  assert.match(text(node), /← addressed block/);
  assert.match(text(node), /main\.jsonl 42\.1/, 'the copy-locator is 1-based file:line.bi');
  handle.update({ highlightPath: 'r' });
  assert.doesNotMatch(text(node), /← addressed block/, 'a bi that is not present highlights nothing');
});

test('costfigure is a button that opens a breakdown panel', () => {
  const node = el();
  const handle = costfigure(node, { agg, scope: 'store', at: Date.UTC(2026, 7, 17), rowsSumToHeader: true, requests: 29741 });
  assertHandle(handle, 'costfigure');
  const btn = node.querySelector('.lens-cost__figure');
  assert.equal(btn.localName, 'button');
  assert.match(text(btn), /\$1\.0000/);
  assert.equal(node.querySelector('.lens-cost__panel').hasAttribute('hidden'), true);
  btn.dispatch('click');
  assert.equal(node.querySelector('.lens-cost__panel').hasAttribute('hidden'), false);
});

test('every component honours the mount(el, props) -> {update, destroy} contract', () => {
  const mounts = [
    ['crumbs', () => crumbs(el(), { items: [] })],
    ['scopeSentence', () => scopeSentence(el(), { subject: 'x' })],
    ['statbar', () => statbar(el(), { pending: true })],
    ['chipsRow', () => chipsRow(el(), { agg: null })],
    ['vtable', () => vtable(el(), { columns: [{ key: 'a', label: 'a', type: 'text' }], rows: [] })],
    ['timeline', () => timeline(el(), { lanes: [], marks: [] })],
    ['rowsPane', () => rowsPane(el(), { fetchPage: async () => ({ rows: [], total: 0, from: 0 }) })],
    ['jsonview', () => jsonview(el(), { value: {} })],
    ['costfigure', () => costfigure(el(), { agg: null })],
  ];
  for (const [name, mount] of mounts) {
    const handle = mount();
    assertHandle(handle, name);
    assert.doesNotThrow(() => handle.update({}), `${name}.update({}) must be safe`);
    assert.doesNotThrow(() => handle.destroy(), `${name}.destroy() must be safe`);
  }
});
