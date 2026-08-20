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
  return t;
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
