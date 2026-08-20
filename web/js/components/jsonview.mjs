// web/js/components/jsonview.mjs — raw JSON, rendered as a collapsible tree
// with one path highlighted. "Nothing in the app lacks a raw view."
//
//   jsonview(el, { value, highlightPath })  -> { update, destroy, expandAll }
//
// highlightPath accepts either an explicit array path (['message','content',2])
// or a SPEC §8 dotted block locator `bi` ('2', '2.3', 'r', 'r.3'), which
// biToPath() converts to the real JSON path. Raw text is the default here and
// everywhere — nothing is markdown-rendered unless a view asks for it.

import { h, clear, replace, formatInt, formatBytes } from '../format.mjs';

export const DEFAULT_OPEN_DEPTH = 2;

/**
 * SPEC §8 block locator -> JSON path. PURE.
 *   '2'    -> ['message','content',2]
 *   '2.3'  -> ['message','content',2,'content',3]
 *   'r'    -> ['toolUseResult']
 *   'r.3'  -> ['toolUseResult',3]
 * Anything else returns null rather than a fabricated path.
 */
export function biToPath(bi) {
  if (bi === null || bi === undefined || bi === '') return null;
  const s = String(bi);
  if (s === 'r') return ['toolUseResult'];
  let m = /^r\.(\d+)$/.exec(s);
  if (m) return ['toolUseResult', Number(m[1])];
  m = /^(\d+)$/.exec(s);
  if (m) return ['message', 'content', Number(m[1])];
  m = /^(\d+)\.(\d+)$/.exec(s);
  if (m) return ['message', 'content', Number(m[1]), 'content', Number(m[2])];
  return null;
}

/** The inverse, for building copy-locators. Returns null when not addressable. */
export function pathToBi(path) {
  if (!Array.isArray(path)) return null;
  const p = path;
  if (p.length === 1 && p[0] === 'toolUseResult') return 'r';
  if (p.length === 2 && p[0] === 'toolUseResult' && typeof p[1] === 'number') return `r.${p[1]}`;
  if (p.length === 3 && p[0] === 'message' && p[1] === 'content') return String(p[2]);
  if (p.length === 5 && p[0] === 'message' && p[1] === 'content' && p[3] === 'content') return `${p[2]}.${p[4]}`;
  return null;
}

export function pathKey(path) { return (path || []).join('\u0000'); }

/** True when `path` is exactly `target` or an ancestor of it. PURE. */
export function pathRelation(path, target) {
  if (!target) return 'none';
  const a = path || [], b = target;
  if (a.length > b.length) return 'none';
  for (let i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return 'none';
  return a.length === b.length ? 'exact' : 'ancestor';
}

/** Normalise the highlightPath prop (array | dotted bi | null). */
export function normalisePath(highlightPath) {
  if (!highlightPath) return null;
  if (Array.isArray(highlightPath)) return highlightPath;
  return biToPath(highlightPath);
}

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function jsonview(el, props) {
  const state = { props: props || {}, target: normalisePath(props && props.highlightPath) };
  const root = h('div', { class: 'lens-json' });
  el.appendChild(root);

  function draw() {
    state.target = normalisePath(state.props.highlightPath);
    clear(root);
    const openDepth = state.props.openDepth === undefined ? DEFAULT_OPEN_DEPTH : state.props.openDepth;
    root.appendChild(node(state.props.value, [], openDepth, null));
  }

  function node(value, path, openDepth, key) {
    const rel = pathRelation(path, state.target);
    const t = typeOf(value);
    const wrap = h('div', {
      class: ['lens-json__node', `lens-json__node--${t}`,
        rel === 'exact' ? 'is-highlighted' : null,
        rel === 'ancestor' ? 'is-onpath' : null],
    });

    if (t !== 'object' && t !== 'array') {
      wrap.appendChild(h('span', { class: 'lens-json__row' },
        key !== null ? h('span', { class: 'lens-json__key' }, String(key), ': ') : null,
        scalar(value, t)));
      if (rel === 'exact') wrap.appendChild(locatorNote(path));
      return wrap;
    }

    const entries = t === 'array'
      ? value.map((v, i) => [i, v])
      : Object.keys(value).map((k) => [k, value[k]]);
    const open = openDepth > 0 || rel !== 'none';
    const summary = t === 'array'
      ? `[ ${formatInt(entries.length)} ${entries.length === 1 ? 'item' : 'items'} ]`
      : `{ ${formatInt(entries.length)} ${entries.length === 1 ? 'key' : 'keys'} }`;

    const toggle = h('button', {
      class: 'lens-json__toggle', type: 'button', 'aria-expanded': open ? 'true' : 'false',
    }, open ? '▾' : '▸');
    const kids = h('div', { class: 'lens-json__children' });
    if (!open) kids.setAttribute('hidden', '');

    wrap.appendChild(h('span', { class: 'lens-json__row' },
      toggle,
      key !== null ? h('span', { class: 'lens-json__key' }, String(key), ': ') : null,
      h('span', { class: 'lens-json__summary' }, summary),
      rel === 'exact' ? h('span', { class: 'lens-json__here' }, ' ← addressed block') : null));
    wrap.appendChild(kids);
    if (rel === 'exact') wrap.appendChild(locatorNote(path));

    for (const [k, v] of entries) kids.appendChild(node(v, path.concat([k]), openDepth - 1, k));

    toggle.addEventListener('click', () => {
      const hidden = kids.hasAttribute('hidden');
      if (hidden) { kids.removeAttribute('hidden'); replace(toggle, '▾'); toggle.setAttribute('aria-expanded', 'true'); }
      else { kids.setAttribute('hidden', ''); replace(toggle, '▸'); toggle.setAttribute('aria-expanded', 'false'); }
    });
    return wrap;
  }

  function scalar(value, t) {
    if (t === 'string') {
      const long = value.length > 400;
      const span = h('span', { class: 'lens-json__string', title: long ? `${formatBytes(value.length)} of text` : null },
        long ? value.slice(0, 400) + '…' : value);
      if (!long) return span;
      const more = h('button', { class: 'lens-json__more', type: 'button' }, `show all ${formatInt(value.length)} chars`);
      const holder = h('span', null, span, ' ', more);
      more.addEventListener('click', () => { replace(holder, h('span', { class: 'lens-json__string' }, value)); });
      return holder;
    }
    return h('span', { class: `lens-json__${t}` }, t === 'string' ? value : String(value));
  }

  function locatorNote(path) {
    const bi = pathToBi(path);
    const locator = state.props.line
      ? `${state.props.file || 'line'} ${state.props.line}${bi ? '.' + bi : ''}`
      : (bi ? `block ${bi}` : null);
    if (!locator) return null;
    const btn = h('button', { class: 'lens-json__copy', type: 'button', title: 'copy this locator' }, locator, ' ⧉');
    btn.addEventListener('click', () => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(locator);
    });
    return h('div', { class: 'lens-json__locator' }, btn);
  }

  draw();

  return {
    update(next) { state.props = Object.assign({}, state.props, next); draw(); },
    element: root,
    destroy() { if (root.parentNode) root.parentNode.removeChild(root); },
  };
}
