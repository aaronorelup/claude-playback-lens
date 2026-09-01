// tests/web-pass5.test.mjs — KAN-105 pass 5: the image gallery lightbox.
//
// The owner's named complaint (brief §1.8.1): clicking an image left the
// gallery for L5, where nothing went back and nothing went on to the next
// image; and the gallery drew 106 tiles for 54 images while the sentence
// above it said the twin was "noted rather than drawn again".
//
// What this file pins:
//
//   * THE DEDUPE. The Tea-House session's shape — 106 records, 52 of them
//     `twin: true` — must fold to 54 tiles, with the twin surviving as a FACT
//     on the record it duplicates. A twin with no partner is NEVER dropped.
//   * THE COVERAGE SENTENCE states BOTH numbers, in `.lens-num` figures.
//   * GALLERY-ORDER pager arithmetic, clamped at both ends, with the end
//     states carrying their reason.
//   * THE LAYER CONTRACT with the router: `[data-lens-layer]`, so
//     closeTopLayer() closes it on Escape BEFORE the pass-4 `returnTo`
//     binding can navigate; and the component's own handler calls
//     preventDefault(), which router.onKeydown honours as "already handled".
//   * FOCUS RESTORE to the tile that opened it, on every close path.
//   * VIRTUALIZATION SURVIVES: rendering the session gallery over a 54-image
//     list still materialises only the visible window of tiles.
//
// Browser-verified alongside these (the fake DOM has no layout, no
// MutationObserver and no network): on the live Tea-House session the grid
// shows 54 tiles and the sentence reads "54 distinct images; 106 recorded
// appearances"; opening tile 3 of the 1,194-image session issues exactly
// three /api/image requests (the open image and its two neighbours) and
// leaves the grid at 8 rendered tiles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { doc, FakeElement } from './helpers/fake-dom.mjs';
globalThis.document = doc;

const ORIGIN = 'http://127.0.0.1:8791/';
const loc = {
  _hash: '#/',
  get href() { return ORIGIN + this._hash; },
  set href(v) { const i = String(v).indexOf('#'); this._hash = i === -1 ? '#/' : String(v).slice(i); },
  get hash() { return this._hash; },
  set hash(v) { this._hash = String(v).startsWith('#') ? String(v) : `#${v}`; },
  replace(v) { this.hash = v; },
};
globalThis.location = loc;
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
class FakeEventSource {
  constructor(url) { this.url = String(url); this.readyState = 0; }
  addEventListener() {}
  close() { this.readyState = 2; }
}
globalThis.EventSource = FakeEventSource;

// The fake element's focus() is a no-op; make it observable so "focus went
// back to the tile" is a fact this suite can check rather than a hope.
let lastFocused = null;
FakeElement.prototype.focus = function focus() { lastFocused = this; };

/* imports AFTER the fake document exists */
const Lightbox = await import('../web/js/components/lightbox.mjs');
const Router = await import('../web/js/router.mjs');

import { sleep } from './helpers/timing.mjs';
const settle = (ms = 30) => sleep(ms);
const text = (n) => n.textContent;

/* ==================================================================== *
 * 0. the fixture shape
 * ==================================================================== */

const SLUG = 'C--Users-userx-Organized-Personal-My-Projects-Tea-House-Homepage';
const SID = '676bf186-25da-4b29-9e74-f03205cd03ba';
const REL = `${SID}.jsonl`;

/**
 * The live shape of GET /api/session/<slug>/<id>/images on the Tea-House
 * session, reproduced exactly: 2 standalone `content` images (bi '0') and 52
 * `tool_result` images (bi '0.0') each shadowed by its `toolUseResult`
 * sidecar (bi 'r', twin: true, identical bytes) — 106 records, 54 distinct.
 */
function teaHouseImages() {
  const out = [
    { file: REL, line: 3, bi: '0', bytes: 135504, source: 'content', mediaType: 'image/webp', twin: false },
  ];
  for (let k = 0; k < 52; k++) {
    const line = 321 + k * 7;
    const bytes = 130000 + k * 137;
    out.push({ file: REL, line, bi: '0.0', bytes, source: 'tool_result', mediaType: 'image/jpeg', twin: false });
    out.push({ file: REL, line, bi: 'r', bytes, source: 'toolUseResult', mediaType: 'image/jpeg', twin: true });
  }
  out.push({ file: REL, line: 1200, bi: '0', bytes: 90210, source: 'content', mediaType: 'image/png', twin: false });
  return out;
}

const items = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  file: REL, line: 10 + i, bi: '0.0', bytes: 1000 + i, source: 'tool_result', mediaType: 'image/png',
  src: `/api/image?line=${10 + i}`, href: `#/p/${SLUG}/s/${SID}/a/main/e/${10 + i}.0.0`,
  alt: `image at line ${10 + i}`, ...extra,
}));

/* ==================================================================== *
 * 1. the dedupe — the census, and what it must never lose
 * ==================================================================== */

test('the Tea-House shape folds 106 records to 54 tiles — the count the copy always claimed', () => {
  const records = teaHouseImages();
  assert.equal(records.length, 106, 'the fixture is the live shape');
  assert.equal(records.filter((r) => r.twin).length, 52);

  const census = Lightbox.dedupeTwins(records);
  assert.equal(census.records, 106, 'the record count is kept, not overwritten');
  assert.equal(census.distinct, 54);
  assert.equal(census.folded, 52);
  assert.equal(census.tiles.length, 54);
  assert.equal(census.tiles.filter((t) => t.twin).length, 0, 'no twin is drawn as a tile');
});

test('a folded twin survives on the record it duplicates — the data is moved, never dropped', () => {
  const census = Lightbox.dedupeTwins(teaHouseImages());
  const host = census.tiles.find((t) => t.line === 321);
  assert.ok(host, 'the tool_result block keeps its tile');
  assert.equal(host.bi, '0.0');
  assert.equal(host.twins.length, 1);
  assert.equal(host.twins[0].bi, 'r');
  assert.equal(host.twins[0].source, 'toolUseResult');
  // and the standalone images carry no twin at all
  assert.equal(census.tiles.find((t) => t.line === 3).twins, undefined);
});

test('gallery ORDER is the recorded order of the surviving records', () => {
  const census = Lightbox.dedupeTwins(teaHouseImages());
  const lines = census.tiles.map((t) => t.line);
  assert.equal(lines[0], 3);
  assert.equal(lines[1], 321);
  assert.equal(lines[lines.length - 1], 1200);
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b), 'file order, untouched');
});

test('a twin with NO partner keeps its own tile — folding it would be a silent census loss', () => {
  const orphan = [
    { file: REL, line: 5, bi: 'r', bytes: 42, source: 'toolUseResult', twin: true },
    { file: REL, line: 9, bi: '0.0', bytes: 77, source: 'tool_result', twin: false },
    { file: REL, line: 9, bi: 'r', bytes: 77, source: 'toolUseResult', twin: true },
  ];
  const census = Lightbox.dedupeTwins(orphan);
  assert.equal(census.records, 3);
  assert.equal(census.distinct, 2, 'the partnered twin folds, the unpartnered one does not');
  assert.equal(census.folded, 1);
  assert.ok(census.tiles.some((t) => t.line === 5 && t.twin === true));
});

test('pairing is file + line + recorded bytes — two different images on one line stay two tiles', () => {
  const sameLine = [
    { file: REL, line: 12, bi: '0.0', bytes: 100, source: 'tool_result', twin: false },
    { file: REL, line: 12, bi: '0.1', bytes: 200, source: 'tool_result', twin: false },
    { file: REL, line: 12, bi: 'r', bytes: 200, source: 'toolUseResult', twin: true },
  ];
  const census = Lightbox.dedupeTwins(sameLine);
  assert.equal(census.distinct, 2);
  const host = census.tiles.find((t) => t.bi === '0.1');
  assert.equal(host.twins.length, 1, 'the twin folds into the record with the SAME recorded byte count');
  assert.equal(census.tiles.find((t) => t.bi === '0.0').twins, undefined);
});

test('dedupeTwins is total on empty and rubbish input', () => {
  for (const bad of [null, undefined, [], 'nope', 7]) {
    const c = Lightbox.dedupeTwins(bad);
    assert.equal(c.tiles.length, 0);
    assert.equal(c.records, 0);
    assert.equal(c.folded, 0);
  }
});

/* ==================================================================== *
 * 2. the coverage sentence — both numbers, or one honest one
 * ==================================================================== */

test('the coverage sentence states BOTH numbers, as .lens-num figures', () => {
  const census = Lightbox.dedupeTwins(teaHouseImages());
  const p = doc.createElement('p');
  for (const n of Lightbox.imageCoverageNodes(census)) {
    p.appendChild(typeof n === 'string' ? doc.createTextNode(n) : n);
  }
  const said = text(p);
  assert.match(said, /54 distinct images/);
  assert.match(said, /106 recorded appearances/);
  assert.match(said, /the twin is noted on the image rather than drawn again/);
  const figures = p.querySelectorAll('.lens-num').map(text);
  assert.deepEqual(figures, ['54', '106'], 'both figures render in the number vocabulary');
});

test('with nothing folded the sentence states ONE number and claims no twins', () => {
  const p = doc.createElement('p');
  for (const n of Lightbox.imageCoverageNodes({ records: 2, distinct: 2, folded: 0 })) {
    p.appendChild(typeof n === 'string' ? doc.createTextNode(n) : n);
  }
  assert.equal(text(p), '2 image blocks recorded.');
  assert.doesNotMatch(text(p), /twin/, 'a payload with no twin flag is never said to have twins');
});

/* ==================================================================== *
 * 3. the twin as a fact
 * ==================================================================== */

test('the twin reads as a recorded fact, built from the recorded sources', () => {
  const census = Lightbox.dedupeTwins(teaHouseImages());
  const fact = Lightbox.twinFact(census.tiles.find((t) => t.line === 321));
  assert.equal(fact.label, 'twin');
  assert.equal(fact.value, 'recorded twice on this line: tool_result block + toolUseResult sidecar');
  assert.match(fact.note, /verified corpus-wide at spec time, not re-checked per line/,
    'the wording must not claim a per-line byte check that never ran');
  assert.equal(Lightbox.twinFact(census.tiles.find((t) => t.line === 3)), null, 'no twin, no fact');
  assert.equal(Lightbox.twinFact(null), null);
});

test('an image with no recorded source names the block index instead of inventing one', () => {
  const census = Lightbox.dedupeTwins([
    { file: REL, line: 4, bi: '0.0', bytes: 8, twin: false },
    { file: REL, line: 4, bi: 'r', bytes: 8, twin: true },
  ]);
  assert.equal(Lightbox.twinFact(census.tiles[0]).value,
    'recorded twice on this line: block 0.0 + block r');
});

/* ==================================================================== *
 * 4. the facts panel — unknown is '—' with a reason, zero is not
 * ==================================================================== */

test('every unrecorded fact carries its own reason, and the locator is mono', () => {
  const facts = Lightbox.imageFacts({ file: REL, line: 321, bi: '0.0', bytes: 133760, mediaType: 'image/jpeg', source: null, at: null });
  const byLabel = Object.fromEntries(facts.map((f) => [f.label, f]));
  assert.equal(byLabel.time.value, null);
  assert.match(byLabel.time.reason, /no timestamp is recorded/);
  assert.equal(byLabel.source.value, null);
  assert.match(byLabel.source.reason, /no source is recorded/);
  assert.equal(byLabel['media type'].value, 'image/jpeg');
  assert.equal(byLabel.locator.value.getAttribute('class'), 'lens-locator');
  assert.equal(text(byLabel.locator.value), `${REL}:321.0.0`);
});

test('a payload-specific fact rides along without being invented for payloads that lack it', () => {
  const withB64 = Lightbox.imageFacts({ line: 1, bi: '0', facts: [{ label: 'base64', value: '180,672 chars' }] });
  assert.ok(withB64.some((f) => f.label === 'base64'));
  const without = Lightbox.imageFacts({ line: 1, bi: '0' });
  assert.equal(without.some((f) => f.label === 'base64'), false);
});

/* ==================================================================== *
 * 5. the layer — open, walk, close, and the focus that comes back
 * ==================================================================== */

function mount(n = 6, extra = {}) {
  const host = doc.createElement('div');
  const lb = Lightbox.lightbox(host, { images: items(n, extra), prefetch: false });
  const tile = doc.createElement('button');
  host.appendChild(tile);
  return { host, lb, tile, root: lb.el };
}

test('the layer is a labelled modal dialog, hidden until a tile opens it', () => {
  const { lb, root, tile } = mount();
  assert.equal(root.getAttribute('role'), 'dialog');
  assert.equal(root.getAttribute('aria-modal'), 'true');
  assert.equal(root.getAttribute('data-lens-layer'), 'lightbox');
  assert.equal(root.hasAttribute('hidden'), true);
  assert.equal(lb.isOpen(), false);

  lb.open(2, tile);
  assert.equal(root.hasAttribute('hidden'), false);
  assert.equal(lb.isOpen(), true);
  assert.equal(root.getAttribute('aria-label'), `image 3 of 6 — ${REL}:12.0.0`,
    'the label carries the counter, so a screen reader hears the position');
  assert.equal(text(root.querySelector('.lens-lightbox__count')), 'image 3 of 6');
  assert.equal(lastFocused.getAttribute('class'), 'lens-btn lens-lightbox__close',
    'focus moves into the dialog');
});

test('prev/next walk GALLERY order and clamp at both ends, with the end reason on the control', () => {
  const { lb, root, tile } = mount(6);
  const prev = root.querySelector('.lens-pager__prev');
  const next = root.querySelector('.lens-pager__next');
  const count = () => text(root.querySelector('.lens-lightbox__count'));

  lb.open(0, tile);
  assert.equal(count(), 'image 1 of 6');
  assert.equal(prev.hasAttribute('disabled'), true);
  assert.match(prev.getAttribute('title'), /first image in the recorded gallery order/);
  assert.equal(lb.go(-1), false, 'there is nothing before the first');
  assert.equal(lb.index(), 0);

  for (let i = 1; i < 6; i++) {
    assert.equal(lb.go(1), true);
    assert.equal(lb.index(), i);
    assert.equal(count(), `image ${i + 1} of 6`);
  }
  assert.equal(next.hasAttribute('disabled'), true);
  assert.match(next.getAttribute('title'), /last image in the recorded gallery order/);
  assert.equal(lb.go(1), false, 'and nothing after the last');
  assert.equal(lb.index(), 5);

  // the buttons drive the same arithmetic as the keys
  prev.dispatch('click');
  assert.equal(count(), 'image 5 of 6');
});

test('ArrowLeft/ArrowRight walk it, and preventDefault stops the page keymap from firing too', () => {
  const { lb, root, tile } = mount(4);
  lb.open(1, tile);
  const key = (k) => {
    let prevented = false;
    root.dispatch('keydown', { key: k, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(key('ArrowRight'), true);
  assert.equal(lb.index(), 2);
  assert.equal(key('ArrowLeft'), true);
  assert.equal(lb.index(), 1);
  // a key the lightbox does NOT claim is left alone for the page (DESIGN §5)
  assert.equal(key(']'), false, 'the sibling pager keys keep their meaning');
  assert.equal(key('u'), false);
  assert.equal(lb.index(), 1);
});

test('Escape closes and gives focus back to the tile that opened it', () => {
  const { lb, root, tile } = mount(4);
  lb.open(2, tile);
  lastFocused = null;
  let prevented = false;
  root.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'router.onKeydown returns on defaultPrevented — close can never also navigate');
  assert.equal(root.hasAttribute('hidden'), true);
  assert.equal(lb.isOpen(), false);
  assert.equal(lastFocused, tile);
});

test('the close control and a backdrop click close it the same way', () => {
  const { lb, root, tile } = mount(4);

  lb.open(1, tile);
  lastFocused = null;
  root.querySelector('.lens-lightbox__close').dispatch('click');
  assert.equal(root.hasAttribute('hidden'), true);
  assert.equal(lastFocused, tile);

  lb.open(1, tile);
  lastFocused = null;
  root.dispatch('click', { target: root });          // the scrim IS the root
  assert.equal(root.hasAttribute('hidden'), true);
  assert.equal(lastFocused, tile);

  // a click INSIDE the panel is not a backdrop click
  lb.open(1, tile);
  root.dispatch('click', { target: root.querySelector('.lens-lightbox__panel') });
  assert.equal(root.hasAttribute('hidden'), false);
});

test('the raw-event link is built with withReturn, so L5 offers the way back', () => {
  const { lb, root, tile } = mount(3);
  loc.hash = `#/p/${SLUG}/s/${SID}?v=images`;
  lb.open(0, tile);
  // the fake DOM's selector engine is single-compound: descend in two steps
  const out = root.querySelector('.lens-lightbox__out').querySelector('a');
  const href = out.getAttribute('href');
  assert.ok(href.startsWith(`#/p/${SLUG}/s/${SID}/a/main/e/10.0.0?returnTo=`), href);
  assert.equal(decodeURIComponent(href.split('returnTo=')[1]), `#/p/${SLUG}/s/${SID}?v=images`);
  assert.match(out.getAttribute('title'), /offers a way back/);
});

test('an image with no locator gets an em-dash with its reason, never a broken frame', () => {
  const host = doc.createElement('div');
  const lb = Lightbox.lightbox(host, {
    images: [{ file: null, line: null, bi: null, bytes: null, src: null, href: null }],
    prefetch: false,
  });
  const tile = doc.createElement('button');
  lb.open(0, tile);
  const well = lb.el.querySelector('.lens-lightbox__well');
  assert.equal(well.querySelectorAll('img').length, 0);
  assert.equal(well.querySelector('.lens-unknown').getAttribute('title'),
    'no file/line locator is recorded for this image, so /api/image cannot address it');
  assert.match(lb.el.querySelector('.lens-lightbox__out').querySelector('.lens-unknown').getAttribute('title'),
    /no raw event can be addressed/);
});

test('the layer holds ONE <img>: walking the gallery re-points it, it never accumulates', () => {
  const { lb, root, tile } = mount(20);
  lb.open(0, tile);
  for (let i = 0; i < 19; i++) lb.go(1);
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.equal(root.querySelector('img').getAttribute('src'), '/api/image?line=29');
});

test('an empty gallery mounts a layer that cannot be opened', () => {
  const host = doc.createElement('div');
  const lb = Lightbox.lightbox(host, { images: [] });
  assert.equal(lb.open(0, doc.createElement('button')), false);
  assert.equal(lb.el.hasAttribute('hidden'), true);
});

test('destroy() takes the layer off the page', () => {
  const { lb, host, root } = mount(2);
  assert.equal(host.childNodes.includes(root), true);
  lb.destroy();
  assert.equal(host.childNodes.includes(root), false);
});

/* ==================================================================== *
 * 6. the contract with the router's layer system
 * ==================================================================== */

test('the router closes it on Escape as a layer, before any page binding runs', () => {
  const shell = Router.buildShell(doc.createElement('div'));
  const lb = Lightbox.lightbox(shell.contentEl, { images: items(3), prefetch: false });
  const tile = doc.createElement('button');
  lb.open(1, tile);

  // exactly what closeTopLayer() looks for
  const open = shell.root.querySelectorAll('[data-lens-layer]:not([hidden])');
  assert.equal(open.length, 1);
  assert.equal(open[0], lb.el);

  const ev = { key: 'Escape', target: { tagName: 'DIV' }, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; } };
  Router.onKeydown(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(lb.el.hasAttribute('hidden'), true, 'closeTopLayer hid the layer — for free');

  // that path only sets `hidden`; syncHidden() is what the MutationObserver
  // calls to finish the job, and it is what restores focus in the browser.
  lastFocused = null;
  lb.syncHidden();
  assert.equal(lb.isOpen(), false);
  assert.equal(lastFocused, tile);
  lb.destroy();
});

test('with the layer closed, Escape falls through to the page again', () => {
  const shell = Router.buildShell(doc.createElement('div'));
  const lb = Lightbox.lightbox(shell.contentEl, { images: items(3), prefetch: false });
  lb.open(0, doc.createElement('button'));
  lb.close();
  const ev = { key: 'Escape', target: { tagName: 'DIV' }, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; } };
  Router.onKeydown(ev);
  assert.equal(ev.defaultPrevented, false, 'nothing left to close — the page keeps Escape');
  lb.destroy();
});

/* ==================================================================== *
 * 7. the two galleries, rendered
 * ==================================================================== */

const noHeaders = { get: () => null };
const json = (body) => ({ ok: true, status: 200, statusText: 'OK', headers: noHeaders, text: async () => JSON.stringify(body), json: async () => body });

const AGENT_ROWS = [
  { line: 3, bi: '0', kind: 'image', at: 1785792042097, head: 'image image/webp', extra: { mediaType: 'image/webp', base64Length: 180672, bytes: 135504 } },
  { line: 321, bi: '0.0', kind: 'image', at: 1785793312492, head: 'image image/jpeg', extra: { mediaType: 'image/jpeg', base64Length: 178348, bytes: 133760 } },
  { line: 322, bi: null, kind: 'text', at: 1785793312500, head: 'ok' },
];

function installFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init && init.signal && init.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const u = String(url);
    if (u.includes('/images')) return json({ slug: SLUG, id: SID, images: teaHouseImages() });
    if (u.includes('/api/agent/')) return json({ slug: SLUG, id: SID, agentId: 'main', rel: REL, rows: AGENT_ROWS, total: AGENT_ROWS.length, agg: null, problems: [] });
    if (u.includes('/api/session/')) return json({ slug: SLUG, id: SID, agents: [], turns: [], workflows: [], rows: [], rowsTotal: 0, agg: null, problems: [], imagesTotal: 106 });
    if (u.includes('/api/index')) {
      return json({
        version: 7, boot: 'pass5',
        status: { state: 'ready', sessionsDone: 1, sessionsTotal: 1, bytesIndexed: 1, bytesTotal: 1 },
        agg: null, projects: [{ slug: SLUG, label: SLUG, sessions: 1 }],
        sessions: [{ slug: SLUG, id: SID, state: 'ok', badges: [] }],
        turnBars: [], dayBands: [], pending: [], problems: [],
      });
    }
    return json({});
  };
  return () => { globalThis.fetch = real; };
}

test('L2 ?v=images: 54 tiles from 106 records, the sentence says both, and the tiles are BUTTONS', async () => {
  const restore = installFetch();
  const shell = Router.buildShell(doc.createElement('div'));
  await Router.loadViewModules();
  loc.hash = `#/p/${SLUG}/s/${SID}?v=images`;
  await Router.render();
  await settle(60);

  const cov = shell.contentEl.querySelector('.lens-coverage');
  assert.match(text(cov), /54 distinct images/);
  assert.match(text(cov), /106 recorded appearances/);

  // VIRTUALIZATION: the spacer is sized for all 54, the window holds a few.
  const spacer = shell.contentEl.querySelector('.lens-contact__spacer');
  assert.equal(spacer.style.height, `${54 * 132}px`, 'the scroll box is sized for the whole deduped list');
  const tiles = shell.contentEl.querySelectorAll('.lens-contact__tile');
  assert.ok(tiles.length > 0 && tiles.length < 54, `only the visible window is drawn (got ${tiles.length})`);

  // D1: a tile opens the layer in place. It is not a link, so it cannot navigate.
  const openers = shell.contentEl.querySelectorAll('.lens-contact__link');
  assert.ok(openers.length > 0);
  for (const o of openers) {
    assert.equal(o.localName, 'button', 'the tile opener is a button — clicking an image never leaves the gallery');
    assert.equal(o.getAttribute('href'), null);
  }
  assert.match(openers[0].getAttribute('title'), /open image 1 of 54/);

  const layer = shell.contentEl.querySelector('[data-lens-layer="lightbox"]');
  assert.ok(layer, 'the gallery mounts the lightbox');
  assert.equal(layer.hasAttribute('hidden'), true);

  // clicking tile 2 opens it at position 2, and the caption's twin tag survives
  openers[1].dispatch('click', { currentTarget: openers[1] });
  assert.equal(layer.hasAttribute('hidden'), false);
  assert.equal(text(layer.querySelector('.lens-lightbox__count')), 'image 2 of 54');
  assert.match(text(layer.querySelector('.lens-facts')), /recorded twice on this line: tool_result block \+ toolUseResult sidecar/);
  restore();
});

test('L4 ?v=images: the same component, the same behaviour — the images are clickable at last (D2)', async () => {
  const restore = installFetch();
  const shell = Router.buildShell(doc.createElement('div'));
  await Router.loadViewModules();
  loc.hash = `#/p/${SLUG}/s/${SID}/a/main?v=images`;
  await Router.render();
  await settle(60);

  const openers = shell.contentEl.querySelectorAll('.lens-contact__link');
  assert.equal(openers.length, 2, 'both recorded image rows are openable');
  assert.equal(openers[0].localName, 'button');

  const layer = shell.contentEl.querySelector('[data-lens-layer="lightbox"]');
  assert.ok(layer, 'L4 mounts the same lightbox as L2');
  openers[1].dispatch('click', { currentTarget: openers[1] });
  assert.equal(layer.hasAttribute('hidden'), false);
  assert.equal(text(layer.querySelector('.lens-lightbox__count')), 'image 2 of 2');
  // the row index records no `source` for an image block — '—' with the reason
  assert.match(text(layer.querySelector('.lens-facts')), /base64/);
  const raw = layer.querySelector('.lens-lightbox__out').querySelector('a').getAttribute('href');
  assert.ok(raw.includes('/e/321.0.0?returnTo='), raw);

  // ArrowRight/Escape behave exactly as they do at L2
  layer.dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(text(layer.querySelector('.lens-lightbox__count')), 'image 1 of 2');
  lastFocused = null;
  layer.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(layer.hasAttribute('hidden'), true);
  assert.equal(lastFocused, openers[1], 'focus returns to the tile that opened it');
  restore();
});
