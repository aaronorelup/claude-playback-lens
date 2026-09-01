// web/js/lib/dom.mjs — the drill views' DOM leaf builders: the shared h()
// re-export, the SVG builder, links, sections, fact lists, kind chips, the
// plain census table and the copy button. No fetches, no routing state.

import { h as sharedH, clear as sharedClear, unknownNode } from '../format.mjs';

/** h('div', {class:'x', text:'y'}, child, …). `text: 0` renders "0" — a real
 *  zero. ONE h() for the whole app: format.mjs's, re-exported so every drill
 *  view builds nodes through the same element factory. */
export const h = sharedH;

/** SVG element builder (geometry attributes — DESIGN's inline-style carve-out). */
export function s(tag, attrs, ...kids) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') node.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
  }
  add(node, kids);
  return node;
}

function add(node, kids) {
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.appendChild(typeof kid === 'object' && kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
}

export const clear = sharedClear;

/** An unknown value: em-dash carrying its reason (house rule 3). */
export function unknown(reason) { return unknownNode(reason ?? 'not recorded'); }

/** A real <a href> (DESIGN §0: every internal link is one). */
export function a(href, label, attrs) {
  return h('a', { href, class: 'lens-link', ...(attrs || {}) }, label);
}

export function section(title, ...kids) {
  return h('section', { class: 'lens-section' },
    title ? h('h2', { class: 'lens-section__title', text: title }) : null, ...kids);
}

/** Labelled definition list — the L4 header-facts primitive. */
export function factList(facts, className = 'lens-facts') {
  const dl = h('dl', { class: className });
  for (const f of facts) {
    if (!f) continue;
    dl.appendChild(h('dt', { class: `${className}__key`, text: f.label }));
    const dd = h('dd', { class: `${className}__val` });
    if (f.value === null || f.value === undefined) dd.appendChild(unknown(f.reason ?? 'not recorded'));
    else if (typeof f.value === 'object' && f.value.nodeType) dd.appendChild(f.value);
    else dd.appendChild(document.createTextNode(String(f.value)));
    if (f.source) dd.appendChild(h('span', { class: `${className}__src`, text: `source: ${f.source}` }));
    if (f.note) dd.appendChild(h('span', { class: `${className}__note`, text: f.note }));
    dl.appendChild(dd);
  }
  return dl;
}

/** Kind chip (SPEC §3 vocabulary). */
export function kindChip(kind) {
  const family = String(kind ?? 'unknown').split(':')[0];
  return h('span', { class: `lens-kind lens-kind--${family}`, text: String(kind ?? 'unknown') });
}

/**
 * Every emitted table goes in one of these: a wide census must scroll inside
 * its own box rather than push the page sideways. Structure is deliberately
 * one div — the <table> stays the wrapper's only child.
 */
export function tablewrap(table) {
  return h('div', { class: 'lens-tablewrap' }, table);
}

/** Plain table for small recorded censuses; vtable() drives the sortable ones. */
export function simpleTable(columns, rows) {
  const t = h('table', { class: 'lens-table' });
  const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.numeric ? 'lens-table__num' : '', text: c.label }))));
  const tbody = h('tbody');
  for (const r of rows) {
    const tr = h('tr');
    for (const c of columns) {
      const v = typeof c.value === 'function' ? c.value(r) : r[c.key];
      const td = h('td', { class: c.numeric ? 'lens-table__num' : '' });
      if (v === null || v === undefined) td.appendChild(unknown(c.reason ?? 'not recorded'));
      else if (typeof v === 'object' && v.nodeType) td.appendChild(v);
      else td.appendChild(document.createTextNode(String(v)));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.append(thead, tbody);
  return tablewrap(t);
}

/* ==================================================== disclosures ==
 * ONE expandable in the app, on native <details>/<summary>: free keyboard
 * (Enter/Space on the summary), free find-in-page, free print behaviour, and
 * one rotating marker from `.lens-details`.
 *
 * NOT for the timetable's expand-in-place rows (a <details> cannot live in a
 * <tbody>) and NOT for the statbar contribution panels (those are popovers,
 * not disclosures) — both keep their own mechanism deliberately.
 */

/**
 * disclosure(summary, body, { open, className, count })
 *   summary — a string or a node; a string may be paired with `count`, which
 *             renders as a separate dim part so the reader knows the size of
 *             what is behind the fold BEFORE opening it.
 *   body    — one node, an array of nodes, or a function returning either.
 */
export function disclosure(summary, body, { open = false, className = '', count = null } = {}) {
  const det = h('details', { class: `lens-details${className ? ` ${className}` : ''}`, open: open === true });
  const sum = h('summary', { class: 'lens-details__summary' });
  if (summary && typeof summary === 'object' && summary.nodeType) sum.appendChild(summary);
  else sum.appendChild(h('span', { class: 'lens-details__label', text: String(summary ?? '') }));
  if (count !== null && count !== undefined) {
    sum.appendChild(h('span', { class: 'lens-details__count', text: String(count) }));
  }
  det.appendChild(sum);
  const kids = typeof body === 'function' ? body() : body;
  for (const k of (Array.isArray(kids) ? kids : [kids])) if (k) det.appendChild(k);
  return det;
}

/**
 * The expand-all / collapse-all control for a host holding 3+ sibling
 * disclosures. Real <button>s, so it is keyboard-operable by construction;
 * `open` is toggled as an ATTRIBUTE, which is what a native <details> reads.
 * Renders nothing below the threshold — a control for two boxes is noise.
 */
export function disclosureTools(host, { min = 3, label = 'sections' } = {}) {
  const all = () => (host && host.querySelectorAll ? [...host.querySelectorAll('details.lens-details')] : []);
  if (all().length < min) return null;
  const set = (openIt) => { for (const d of all()) { if (openIt) d.setAttribute('open', ''); else d.removeAttribute('open'); } };
  return h('div', { class: 'lens-disclosures' },
    h('button', {
      class: 'lens-btn lens-btn--expand', type: 'button',
      title: `open every one of these ${label}`, text: 'expand all',
      onclick: () => set(true),
    }),
    h('button', {
      class: 'lens-btn lens-btn--expand', type: 'button',
      title: `close every one of these ${label}`, text: 'collapse all',
      onclick: () => set(false),
    }));
}

/** Copy-to-clipboard that states exactly what it copied. */
export function copyButton(value, label = 'copy') {
  return h('button', {
    class: 'lens-btn lens-btn--copy',
    title: `copy ${value}`,
    text: label,
    onclick: (ev) => {
      const b = ev.currentTarget;
      const done = () => { b.textContent = 'copied'; setTimeout(() => { b.textContent = label; }, 1200); };
      try { navigator.clipboard.writeText(value).then(done, () => { b.textContent = 'copy failed'; }); }
      catch { b.textContent = 'copy failed'; }
    },
  });
}
