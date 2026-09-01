// web/js/lib/footer.mjs — the app footer: global nav + the two facts that
// qualify every number in the app.
//
// The footer is part of the SHELL, not of a render: it is built once by
// buildShell() and survives every navigation, which is what makes `#/find`,
// `#/audit` and `#/settings` reachable from every page including L0 (the
// "no global nav" dead end).
//
// NO POLLING (DESIGN §7). Nothing here fetches. The rate-table version comes
// from the pricing module index.html already loads at boot, and the index
// state is whatever the last view that fetched `/api/index` recorded through
// noteIndexState(). Until one has, the cell reads '—' with its reason.

import { h, clear, formatInt, unknownNode, pricingVersion } from '../format.mjs';
import { pricingOrNull } from '../api.mjs';
import { routes } from './links.mjs';

const NAV = [
  { key: 'store', label: 'the store', href: () => routes.store(), title: 'every project in the store' },
  { key: 'find', label: 'find', href: () => routes.find(), title: 'scan every byte of the corpus' },
  { key: 'audit', label: 'audit', href: () => routes.audit(), title: 'the independent re-derivation of the totals' },
  { key: 'settings', label: 'settings', href: () => routes.settings(), title: 'the rate table, the store root and the keyboard map' },
];

/** The last index state any view recorded. `null` = nothing has fetched one. */
let indexState = null;
const mounted = new Set();

/**
 * Record the index state a view ALREADY fetched (l0.paintStore /
 * l1.paintProject hand over the same `indexStatus()` object they render from).
 * Never triggers a fetch of its own.
 */
export function noteIndexState(st) {
  if (!st || typeof st !== 'object') return indexState;
  indexState = {
    done: Number.isFinite(st.done) ? st.done : null,
    of: Number.isFinite(st.of) ? st.of : null,
    building: st.building === true,
    version: st.version === undefined ? null : st.version,
  };
  for (const redraw of [...mounted]) {
    try { redraw(); } catch { /* one bad footer must not stop the rest */ }
  }
  return indexState;
}

/** Test/reset hook — the shell is rebuilt per test file. */
export function resetFooterState() { indexState = null; mounted.clear(); }

/** PURE: the index-state sentence, or null with the reason it is not known. */
export function indexStateText(st) {
  if (!st) return null;
  if (Number.isFinite(st.done) && Number.isFinite(st.of)) {
    return `index ${formatInt(st.done)} of ${formatInt(st.of)} sessions${st.building ? ' — indexing…' : ''}`;
  }
  return st.building ? 'index building…' : null;
}

/**
 * mountFooter(el) — draws the nav and the meta strip into the shell's footer.
 * Idempotent: mounting again replaces what is there.
 */
export function mountFooter(el, { current = null } = {}) {
  if (!el) return null;
  const state = { current };

  function draw() {
    clear(el);

    const nav = h('nav', { class: 'lens-foot__nav', 'aria-label': 'Sections' });
    for (const item of NAV) {
      const here = state.current === item.key;
      nav.appendChild(h('a', {
        class: 'lens-link lens-foot__link',
        href: item.href(),
        title: item.title,
        ...(here ? { 'aria-current': 'page' } : {}),
      }, item.label));
    }
    el.appendChild(nav);

    const meta = h('p', { class: 'lens-foot__meta' });
    const version = pricingVersion();
    meta.appendChild(h('span', { class: 'lens-foot__fact' },
      'PRICING_VERSION ',
      version
        ? h('code', null, String(version))
        : unknownNode('shared/pricing.mjs has not loaded in this tab yet, so no rate-table version is recorded')));
    const text = indexStateText(indexState);
    meta.appendChild(h('span', { class: 'lens-foot__fact' },
      text || unknownNode('no page in this tab has read /api/index yet, so the index state is not recorded here')));
    el.appendChild(meta);
  }

  draw();
  mounted.add(draw);
  // One-shot, not a poll: the rate table is already being imported by
  // index.html, so this resolves off the cached promise and never re-fetches.
  if (!pricingVersion()) {
    try { pricingOrNull().then(() => { if (mounted.has(draw)) draw(); }, () => {}); }
    catch { /* no pricing module served — the cell says so */ }
  }
  return {
    /** Which nav entry the reader is standing in — 'store' | 'find' | 'audit' | 'settings' | null. */
    setCurrent(key) { if (state.current === key) return; state.current = key ?? null; draw(); },
    update: draw,
    destroy() { mounted.delete(draw); clear(el); },
  };
}

/** The nav key for a hash — route shape only. `null` when it is none of them. */
export function navKeyForHash(hash) {
  const raw = String(hash ?? '');
  const path = raw.replace(/^#/, '').split('?')[0];
  if (path === '' || path === '/') return 'store';
  if (path === '/find' || path.startsWith('/find/')) return 'find';
  if (path === '/audit' || path.startsWith('/audit/')) return 'audit';
  if (path === '/settings') return 'settings';
  return null;
}
