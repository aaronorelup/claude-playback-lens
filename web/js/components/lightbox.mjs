// web/js/components/lightbox.mjs — ONE image lightbox for both galleries
// (L2 `?v=images`, the virtualized contact sheet, and L4 `?v=images`).
//
// KAN-105 §2.4.2 fixes D1/D2: clicking a tile used to LEAVE the gallery for
// L5, where nothing offered a way back and nothing walked the images. A tile
// now opens this in-page layer instead — no route change, no history entry —
// and the layer carries the way onward (prev/next over GALLERY order) and the
// way out (an "open the raw event" link built with withReturn, so the L5 page
// renders its own "back to …" control).
//
// Three pieces, and only the third touches the DOM:
//
//   dedupeTwins(records)  -> { tiles, records, distinct, folded }   (pure)
//   imageCoverageNodes(census) -> [Node…] — the census sentence, BOTH numbers
//   lightbox(host, props) -> { open, close, go, update, destroy, … }
//
// THE TWIN RULE. The images endpoint records the same bytes twice when a line
// carries both a `tool_result` block and its `toolUseResult` sidecar (the
// second record is flagged `twin: true`). The gallery drew both, while the
// sentence above it said the twin was "noted rather than drawn again". The
// code is what changes: a twin is folded into the record it duplicates and
// surfaces as a FACT on the panel. A twin whose partner is NOT in the list is
// never folded — it keeps its own tile, because dropping it would be exactly
// the silent census loss the house rule forbids.
//
// PERF (SPEC §11). The layer holds ONE <img>. Opening tile N loads image N and
// (optionally) prefetches N±1 through detached Image objects. It never asks
// the grid to materialise: the tile list is data, and the tiles the reader
// cannot see stay unrendered exactly as before.

import { h, replace } from '../format.mjs';
import { unknown } from '../lib/dom.mjs';
import { fmtInt, fmtBytes, fmtLocalTime } from '../lib/fmt.mjs';
import { withReturn } from '../lib/links.mjs';
import { copyLocator } from '../lib/locator.mjs';

/* ===================================================== pure: the census == */

/** A figure in a sentence: `.lens-num` so it reads as a recorded count. */
function num(n) { return h('span', { class: 'lens-num', text: fmtInt(n) ?? String(n) }); }

/**
 * Fold `twin: true` records into the record they duplicate.
 *
 * Pairing key is file + line + recorded byte count — precisely the claim the
 * sentence makes ("the same bytes appear twice on one line"). A twin with no
 * non-twin partner under that key stays in `tiles`; nothing is dropped that
 * was not drawn somewhere else.
 *
 * Returns { tiles, records, distinct, folded } where a folded host carries
 * `twins: [record…]` — the only place the twin survives.
 */
export function dedupeTwins(records) {
  const list = Array.isArray(records) ? records.slice() : [];
  const groups = new Map();
  for (const r of list) {
    if (!r) continue;
    const key = `${r.file ?? ''}|${r.line ?? ''}|${r.bytes ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const folded = new Set();
  const twinsOf = new Map();
  for (const group of groups.values()) {
    const host = group.find((r) => !r.twin);
    if (!host) continue;                       // an unpartnered twin keeps its tile
    for (const r of group) {
      if (r === host || !r.twin) continue;
      folded.add(r);
      if (!twinsOf.has(host)) twinsOf.set(host, []);
      twinsOf.get(host).push(r);
    }
  }
  const tiles = list
    .filter((r) => r && !folded.has(r))
    .map((r) => (twinsOf.has(r) ? { ...r, twins: twinsOf.get(r) } : r));
  return { tiles, records: list.length, distinct: tiles.length, folded: folded.size };
}

/**
 * The coverage sentence, as nodes. Every figure is a `.lens-num`.
 *
 * When twins were folded the sentence states BOTH numbers — the tiles drawn
 * and the records the endpoint returned — because a census that quietly
 * reports the smaller number is a census that lies.
 */
export function imageCoverageNodes({ records = 0, distinct = 0, folded = 0, noun = 'image' } = {}) {
  if (folded > 0) {
    return [
      num(distinct), ` distinct ${noun}${distinct === 1 ? '' : 's'}; `,
      num(records), ` recorded appearance${records === 1 ? '' : 's'}`,
      ' — where the same bytes appear twice on one line (tool_result block + toolUseResult sidecar), ',
      'the twin is noted on the image rather than drawn again.',
    ];
  }
  return [num(records), ` ${noun} block${records === 1 ? '' : 's'} recorded.`];
}

/**
 * The twin, as a recorded fact — or null when this image has none.
 * Wording is built from the recorded `source` of each appearance; where a
 * source is not recorded the block index stands in, and nothing is invented.
 */
export function twinFact(image) {
  const twins = (image && image.twins) || [];
  if (!twins.length) return null;
  const times = twins.length + 1;
  const word = times === 2 ? 'twice' : `${times} times`;
  const host = image.source ? `${image.source} block` : `block ${image.bi ?? '?'}`;
  const rest = twins.map((t) => (t.source ? `${t.source} sidecar` : `block ${t.bi ?? '?'}`)).join(' + ');
  return {
    label: 'twin',
    value: `recorded ${word} on this line: ${host} + ${rest}`,
    note: 'drawn once here; byte-identity was verified corpus-wide at spec time, not re-checked per line',
  };
}

/** The recorded facts of one image, in caption order + the locator. */
export function imageFacts(image) {
  const im = image || {};
  const facts = [
    { label: 'time', value: fmtLocalTime(im.at), reason: 'no timestamp is recorded on this line' },
    { label: 'source', value: im.source ?? null, reason: 'no source is recorded on this payload' },
    { label: 'bytes', value: fmtBytes(im.bytes), reason: 'byte size is not recorded' },
    { label: 'media type', value: im.mediaType ?? null, reason: 'no media type is recorded on this payload' },
    // Whatever else THIS payload recorded about the image (L4's rows carry a
    // base64 length the images endpoint does not) — passed through, never
    // synthesised here.
    ...(Array.isArray(im.facts) ? im.facts : []),
    {
      label: 'locator',
      value: im.line === null || im.line === undefined
        ? null
        : h('span', { class: 'lens-locator', text: copyLocator(im.file ?? null, im.line, im.bi ?? null) }),
      reason: 'no file/line locator is recorded for this image',
    },
  ];
  const twin = twinFact(im);
  if (twin) facts.push(twin);
  return facts;
}

/* ==================================================== the layer itself == */

const FOCUSABLE = 'button,a[href]';

function setEnabled(node, on) {
  if (on) node.removeAttribute('disabled');
  else node.setAttribute('disabled', '');
}

/**
 * lightbox(host, { images, prefetch }) — mounts a hidden layer into `host`.
 *
 * images[i] = { src, alt, href, file, line, bi, at, source, bytes, mediaType,
 *               twins? }   — `src` is the /api/image URL the gallery already
 *               builds; `href` is the RAW L5 event hash (withReturn is applied
 *               here, once, so both galleries carry the same return state).
 *
 * Returns { el, open(i, origin), close(), go(delta), showAt(i), index(),
 *           isOpen(), update(props), destroy() }.
 *
 * ESCAPE, TWICE OVER. The root is marked `[data-lens-layer]`, which is what
 * the router's closeTopLayer() looks for — so Escape closes it before any of
 * the page's own bindings run (the pass-4 `returnTo` control included), and it
 * closes even when focus has wandered outside the panel. That path only sets
 * `hidden`, so a MutationObserver (where the platform has one) finishes the
 * job: the bookkeeping and the focus restore. The root's own keydown handler
 * covers the common case and calls preventDefault(), which the router honours
 * as "already handled" — so the layer can never both close AND navigate.
 */
export function lightbox(host, props = {}) {
  let images = Array.isArray(props.images) ? props.images.slice() : [];
  const prefetch = props.prefetch !== false;
  let idx = -1;
  let opened = false;
  let origin = null;

  const img = h('img', { class: 'lens-lightbox__img', alt: '', decoding: 'async' });
  const well = h('div', { class: 'lens-lightbox__well' }, img);
  const count = h('p', { class: 'lens-lightbox__count' });
  const closeBtn = h('button', {
    class: 'lens-btn lens-lightbox__close', type: 'button',
    title: 'close this image and return to the tile (Esc)',
    onclick: () => close(),
  }, 'close ✕');
  const prevBtn = h('button', {
    class: 'lens-btn lens-pager__prev lens-lightbox__step', type: 'button',
    onclick: () => go(-1),
  }, '← prev');
  const nextBtn = h('button', {
    class: 'lens-btn lens-pager__next lens-lightbox__step', type: 'button',
    onclick: () => go(1),
  }, 'next →');
  const pager = h('nav', { class: 'lens-pager lens-lightbox__pager', 'aria-label': 'images' }, prevBtn, nextBtn);
  const panelFacts = h('div', { class: 'lens-lightbox__facts' });
  const out = h('p', { class: 'lens-lightbox__out' });

  const panel = h('div', { class: 'lens-lightbox__panel' },
    h('header', { class: 'lens-lightbox__head' }, count, closeBtn),
    h('div', { class: 'lens-lightbox__body' },
      well,
      h('div', { class: 'lens-lightbox__side' }, pager, panelFacts, out)));

  const root = h('div', {
    class: 'lens-lightbox',
    'data-lens-layer': 'lightbox',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'image',
    hidden: true,
    // Backdrop: the scrim IS the root, exactly as the keyboard sheet does it,
    // so "clicked the backdrop" is "the click landed on the root itself".
    onclick: (ev) => { if (ev && ev.target === root) close(); },
    onkeydown: onKeydown,
  }, panel);

  if (host && host.appendChild) host.appendChild(root);

  /* -- the hidden-attribute bridge to the router's closeTopLayer() -------- */
  /** What the observer calls: "someone else hid me — finish the close." */
  function syncHidden() {
    if (opened && root.hasAttribute('hidden')) finishClose();
    return !opened;
  }
  let mo = null;
  if (typeof MutationObserver === 'function') {
    mo = new MutationObserver(syncHidden);
    try { mo.observe(root, { attributes: true, attributeFilter: ['hidden'] }); } catch { mo = null; }
  }

  /**
   * closeTopLayer()'s own precedence, asked from this side: the keyboard sheet
   * first, then the LAST open layer. If something opened over this one, its
   * Escape is not ours to take — we let the event through to the router.
   */
  function coveredByAnotherLayer() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false;
    try {
      if (document.querySelector('.lens-sheet:not([hidden])')) return true;
      const open = Array.from(document.querySelectorAll('[data-lens-layer]:not([hidden])'));
      return open.length > 0 && open[open.length - 1] !== root;
    } catch { return false; }
  }

  function onKeydown(ev) {
    if (!ev || !opened) return;
    const key = ev.key;
    if (key === 'Escape') {
      if (coveredByAnotherLayer()) return;      // the sheet on top closes first
      stop(ev); close(); return;
    }
    if (key === 'ArrowRight') { stop(ev); go(1); return; }
    if (key === 'ArrowLeft') { stop(ev); go(-1); return; }
    if (key === 'Tab') trap(ev);
  }

  // preventDefault() is load-bearing, not decoration: router.onKeydown()
  // returns immediately on `ev.defaultPrevented`, so closing here can never
  // also fire the page's Escape → returnTo navigation.
  function stop(ev) {
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
  }

  function focusables() {
    try {
      const found = panel.querySelectorAll ? Array.from(panel.querySelectorAll(FOCUSABLE)) : [];
      return found.filter((n) => !n.hasAttribute('disabled') && !n.hasAttribute('hidden'));
    } catch { return []; }
  }

  /** aria-modal without a trap is a promise the layer does not keep. */
  function trap(ev) {
    const list = focusables();
    if (list.length < 2) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const at = list.indexOf(active);
    const last = list.length - 1;
    if (ev.shiftKey && (at <= 0)) { stop(ev); list[last].focus?.(); }
    else if (!ev.shiftKey && at === last) { stop(ev); list[0].focus?.(); }
  }

  function describe(i) {
    const im = images[i];
    const loc = im && im.line !== null && im.line !== undefined
      ? ` — ${copyLocator(im.file ?? null, im.line, im.bi ?? null)}`
      : '';
    return `image ${i + 1} of ${images.length}${loc}`;
  }

  function paintCount(i) {
    replace(count,
      'image ', num(i + 1), ' of ', num(images.length));
  }

  function paintOut(im) {
    if (im && im.href) {
      replace(out, h('a', {
        class: 'lens-link lens-lightbox__raw',
        href: withReturn(im.href),
        title: 'the raw recorded event behind this image — the page it opens offers a way back here',
      }, 'open the raw event →'));
    } else {
      replace(out, unknown('no file/line locator is recorded for this image, so no raw event can be addressed'));
    }
  }

  function paintFacts(im) {
    const dl = h('dl', { class: 'lens-facts' });
    for (const f of imageFacts(im)) {
      dl.appendChild(h('dt', { class: 'lens-facts__key', text: f.label }));
      const dd = h('dd', { class: 'lens-facts__val' });
      if (f.value === null || f.value === undefined) dd.appendChild(unknown(f.reason ?? 'not recorded'));
      else if (typeof f.value === 'object' && f.value.nodeType) dd.appendChild(f.value);
      else dd.appendChild(document.createTextNode(String(f.value)));
      if (f.note) dd.appendChild(h('span', { class: 'lens-facts__note', text: f.note }));
      dl.appendChild(dd);
    }
    replace(panelFacts, dl);
  }

  function paintWell(im) {
    if (im && im.src) {
      img.setAttribute('src', im.src);
      img.setAttribute('alt', im.alt || describe(idx));
      replace(well, img);
    } else {
      replace(well, unknown('no file/line locator is recorded for this image, so /api/image cannot address it'));
    }
  }

  /** ONE image loads; its neighbours are warmed, and nothing else is touched. */
  function warm(i) {
    if (!prefetch || typeof Image !== 'function') return;
    for (const j of [i - 1, i + 1]) {
      const im = images[j];
      if (im && im.src) { try { new Image().src = im.src; } catch { /* warming is best-effort */ } }
    }
  }

  function showAt(i) {
    if (!images.length) return false;
    const next = Math.max(0, Math.min(images.length - 1, Number(i) || 0));
    idx = next;
    const im = images[idx];
    paintCount(idx);
    paintWell(im);
    paintFacts(im);
    paintOut(im);
    // ATTRIBUTES, not properties: the fake DOM the suite runs on reflects
    // neither, and `[disabled]` is what both the CSS and focusables() read.
    setEnabled(prevBtn, idx > 0);
    setEnabled(nextBtn, idx < images.length - 1);
    prevBtn.setAttribute('title', idx === 0
      ? 'this is the first image in the recorded gallery order'
      : `previous image (${idx} of ${images.length}) — ArrowLeft`);
    nextBtn.setAttribute('title', idx === images.length - 1
      ? 'this is the last image in the recorded gallery order'
      : `next image (${idx + 2} of ${images.length}) — ArrowRight`);
    root.setAttribute('aria-label', describe(idx));
    warm(idx);
    return true;
  }

  function open(i, originEl = null) {
    if (!images.length) return false;
    origin = originEl
      || (typeof document !== 'undefined' && document.activeElement ? document.activeElement : null);
    if (!showAt(i)) return false;
    opened = true;
    root.removeAttribute('hidden');
    closeBtn.focus?.();
    return true;
  }

  function finishClose() {
    opened = false;
    const back = origin;
    origin = null;
    // A tile recycled by the virtualiser while the layer was open is gone from
    // the document; focus goes to the sheet it lived in rather than nowhere.
    if (back && back.isConnected === false) props.fallbackFocus?.focus?.();
    else if (back && back.focus) back.focus();
    else props.fallbackFocus?.focus?.();
  }

  function close() {
    if (!opened) return false;
    root.setAttribute('hidden', '');
    finishClose();
    return true;
  }

  function go(delta) {
    if (!opened) return false;
    const next = idx + (Number(delta) || 0);
    if (next < 0 || next > images.length - 1) return false;
    return showAt(next);
  }

  return {
    el: root,
    open,
    close,
    go,
    showAt,
    syncHidden,
    index: () => idx,
    isOpen: () => opened,
    update(next = {}) {
      if (Array.isArray(next.images)) images = next.images.slice();
      if (opened) showAt(Math.min(idx, images.length - 1));
    },
    destroy() {
      if (mo) { try { mo.disconnect(); } catch { /* already gone */ } mo = null; }
      opened = false;
      origin = null;
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
