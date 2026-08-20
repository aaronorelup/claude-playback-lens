// web/js/router.mjs — hash-only, hand-rolled router + app shell + keyboard map.
//
// ============================================================================
// VIEW REGISTRATION MECHANISM  (read this first — groups F and G code to it)
// ============================================================================
//
// router.mjs owns the module list (VIEW_MODULES below). At start() it imports
// every `./views/<name>.mjs` with Promise.allSettled and, for each module that
// loaded, calls:
//
//     module.register(defineRoute)          <-- CANONICAL. Export this.
//
// Fallbacks, accepted so a half-finished module still links:
//   * `export default function (defineRoute) {…}`  is called the same way;
//   * a module that instead imports { defineRoute } from '../router.mjs' and
//     calls it at top level also works — same module instance, registration
//     happens at import time and register() is simply absent.
//
// A view module that fails to import does NOT take the app down: its routes
// are simply unregistered, the failure is recorded, and any hash that would
// have landed there resolves to the nearest ancestor with a banner naming the
// missing module. Add a module by adding its name to VIEW_MODULES.
//
// So a view file looks like:
//
//     export function register(defineRoute) {
//       defineRoute('/p/:slug/s/:sid/t/:idx', async (ctx) => { … });
//     }
//
// ============================================================================
// ROUTE PATTERN GRAMMAR (DESIGN §0) — owned by ./router/pattern.mjs, which
// documents the full ':name' / '*rest' / 'x' / 'e' grammar. Unknown routes
// resolve to the nearest registered ancestor and ctx.fallback describes what
// was missing. Query params are never rewritten by the router, so unknown
// ones are preserved and ignored (DESIGN §0).
// ============================================================================

import { h, clear, replace, on, formatBytes, formatPercent, formatInt } from './format.mjs';
import { chrome as buildChrome, crumbs as mountCrumbs, scopeSentence as mountScope } from './components/scope.mjs';
import { statbar as mountStatbar } from './components/statbar.mjs';

/** Every view module the app knows about. Missing ones degrade, never crash. */
export const VIEW_MODULES = [
  'l0', 'l1', 'l2', 'l3', 'l4', 'l5',
  'workflow', 'inv', 'find', 'audit', 'settings', 'memory',
];

/** DESIGN §5, rendered by the `?` sheet and dispatched below. */
export const KEYMAP = [
  { keys: 'j / k', what: 'move between rows' },
  { keys: 'Enter', what: 'drill into the selected row' },
  { keys: 'u', what: 'up one level (the button says where)' },
  { keys: '[ / ]', what: 'previous / next sibling — turn at L3, agent at L4, block at L5' },
  { keys: '/', what: 'find in scope' },
  { keys: '\\', what: 'raw JSON for what is on screen' },
  { keys: 'g0 … g5', what: 'jump to store / project / session / turn / agent / event' },
  { keys: 't', what: 'cycle the views of this level' },
  { keys: '?', what: 'this sheet' },
  { keys: 'Esc', what: 'close a panel, popover or sheet' },
];

const routes = new Map();        // pattern string -> { compiled, render, opts }
const moduleFailures = [];       // { name, error }
const pendingBanners = [];       // one-shot banners that survive ONE navigation
let shell = null;                // { root, crumbEl, scopeEl, statEl, bannerEl, contentEl, sheetEl, reloadEl }
let renderToken = 0;
let currentCtx = null;
let gPrefixAt = 0;
let started = false;

/* ------------------------------------------------------------------ *
 * pattern compilation + matching + link building — pure, owned by
 * ./router/pattern.mjs and re-exported here so every import site (views,
 * tests) keeps its path.
 * ------------------------------------------------------------------ */

import {
  splitPath, parseHash, compilePattern, matchCompiled, matchRoute,
  splitEventRef, ancestorsOf, resolveRoute, bestMatch, href, queryString, withQuery,
} from './router/pattern.mjs';
export {
  splitPath, parseHash, compilePattern, matchCompiled, matchRoute,
  splitEventRef, ancestorsOf, resolveRoute, href, queryString, withQuery,
};

export function currentHash() {
  // Never read location.hash — Firefox returns it percent-DECODED, so
  // a '%2F' inside a segment would be split as a real '/'. location.href keeps
  // the fragment exactly as written; parse from there.
  if (typeof location === 'undefined') return '#/';
  const href = String(location.href || '');
  const i = href.indexOf('#');
  if (i === -1) return location.hash || '#/';
  const frag = href.slice(i);
  return frag === '#' || frag === '' ? '#/' : frag;
}

/** Queue a banner for the NEXT render — it survives exactly one navigation. */
export function queueBanner(message, tone = 'warn') { pendingBanners.push({ message, tone }); }

export function navigate(hash, { replace: doReplace = false } = {}) {
  const target = String(hash).startsWith('#') ? hash : '#' + hash;
  if (currentHash() === target) { render(); return; }
  if (doReplace && typeof location.replace === 'function') location.replace(target);
  else location.hash = target;
}

/* ------------------------------------------------------------------ *
 * route table
 * ------------------------------------------------------------------ */

/**
 * defineRoute(pattern, render, opts?)
 * render(ctx) may be async. opts: { level:0..5, title }
 */
export function defineRoute(pattern, render, opts = {}) {
  if (typeof render !== 'function') throw new TypeError(`defineRoute(${pattern}): render must be a function`);
  const compiled = compilePattern(pattern);
  routes.set(compiled.pattern, { pattern: compiled.pattern, compiled, render, opts });
  return compiled.pattern;
}

export function routeTable() { return [...routes.values()]; }
export function clearRoutes() { routes.clear(); }
export function viewModuleFailures() { return moduleFailures.slice(); }

/** Import every view module and let it register. Never throws. */
export async function loadViewModules(names = VIEW_MODULES) {
  moduleFailures.length = 0;
  const results = await Promise.allSettled(
    names.map((name) => import(`./views/${name}.mjs`).then((mod) => ({ name, mod })))
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      moduleFailures.push({ name: names[i], error: r.reason });
      continue;
    }
    const { name, mod } = r.value;
    try {
      if (typeof mod.register === 'function') mod.register(defineRoute);
      else if (typeof mod.default === 'function') mod.default(defineRoute);
      // else: the module registered at import time — nothing to do.
    } catch (e) {
      moduleFailures.push({ name, error: e });
    }
  }
  return moduleFailures.slice();
}

/* ------------------------------------------------------------------ *
 * the shell (three fixed bands, DESIGN §1) + render pipeline
 * ------------------------------------------------------------------ */

export function buildShell(root) {
  shell = buildChrome(root);
  return shell;
}

export function getShell() { return shell; }

/**
 * start({ root, viewModules }) — mounts the shell, loads the views, wires the
 * keyboard, then renders once. Every render AFTER this one is driven by
 * `hashchange` and nothing else (DESIGN §0).
 */
export async function start({ root, viewModules = VIEW_MODULES } = {}) {
  if (started) return;
  started = true;
  buildShell(root || document.getElementById('lens-app') || document.body);
  await loadViewModules(viewModules);
  if (routes.size === 0) defineRoute('/', renderNoViews);
  window.addEventListener('hashchange', () => { render(); });
  window.addEventListener('keydown', onKeydown);
  if (!location.hash || location.hash === '#') {
    // Set the canonical hash without a second render: replace() fires hashchange.
    location.replace('#/');
    return;
  }
  render();
}

function renderNoViews(ctx) {
  const list = h('ul', { class: 'lens-card__list' },
    ...moduleFailures.map((f) => h('li', null,
      h('code', null, `views/${f.name}.mjs`), ' — ', String((f.error && f.error.message) || f.error))));
  replace(ctx.el, h('div', { class: 'lens-card lens-card--error' },
    h('h2', { class: 'lens-card__title' }, 'No view modules are registered'),
    h('p', { class: 'lens-card__body' },
      'The foundation loaded, but no view module registered a route. '
      + 'This is what the app looks like before groups F and G land their files.'),
    moduleFailures.length ? list : null));
}

/** Abortable per-render controller so a slow view cannot paint over a newer one. */
function newRenderScope() {
  const token = ++renderToken;
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : { abort() {}, signal: undefined };
  return { token, ac, get stale() { return token !== renderToken; } };
}

export async function render() {
  if (!shell) return;
  hideReloadBar();   // a navigation supersedes any pending reload offer
  const { segments, query, path } = parseHash(currentHash());
  const scope = newRenderScope();
  if (currentCtx && currentCtx._abort) currentCtx._abort.abort();

  const resolved = resolveRoute(segments, routeTable());
  const entry = resolved.pattern ? routes.get(resolved.pattern) : null;

  clear(shell.bannerEl);
  clear(shell.contentEl);
  clear(shell.crumbEl);
  clear(shell.scopeEl);
  clear(shell.statEl);
  shell.root.setAttribute('data-route', resolved.pattern || 'none');

  // One-shot banners queued by the PREVIOUS render (a within-pattern 404
  // navigates to its ancestor and the banner must survive that navigation).
  for (const b of pendingBanners.splice(0)) {
    shell.bannerEl.appendChild(h('div', { class: `lens-banner lens-banner--${b.tone}`, role: 'status' },
      h('span', { class: 'lens-banner__icon', 'aria-hidden': 'true' }, '⚠'),
      h('span', { class: 'lens-banner__text' }, b.message)));
  }

  if (resolved.fallback) renderFallbackBanner(resolved.fallback);

  const ctx = makeContext({ resolved, segments, query, path, scope });
  currentCtx = ctx;

  // DESIGN §7 — chrome first; the CONTENT placeholder waits 150ms so a fast
  // render shows nothing at all.
  const loadingTimer = setTimeout(() => {
    if (scope.stale || ctx._settled) return;
    ctx._loadingNode = h('div', { class: 'lens-loading' },
      h('span', { class: 'lens-loading__label' }, 'reading the index…'));
    shell.contentEl.appendChild(ctx._loadingNode);
  }, 150);

  try {
    if (!entry) { renderNoViews(ctx); return; }
    await entry.render(ctx);
  } catch (err) {
    if (scope.stale) return;
    renderRouteError(ctx, err);
  } finally {
    clearTimeout(loadingTimer);
    ctx._settled = true;
    if (ctx._loadingNode && ctx._loadingNode.parentNode) ctx._loadingNode.parentNode.removeChild(ctx._loadingNode);
  }
}

function renderFallbackBanner(fb) {
  shell.bannerEl.appendChild(h('div', { class: 'lens-banner lens-banner--warn', role: 'status' },
    h('span', { class: 'lens-banner__icon', 'aria-hidden': 'true' }, '⚠'),
    h('span', { class: 'lens-banner__text' },
      'There is no page at ', h('code', null, fb.requested), ' — ', fb.reason, '. Showing ',
      h('a', { href: fb.resolved }, fb.resolved), ' instead.')));
}

function renderRouteError(ctx, err) {
  const status = err && err.status;
  // A view that throws before mounting its crumbs would otherwise strand
  // the reader on an error card with no rail. Mount fallback crumbs derived
  // from the hash segments; leave any crumbs the view already mounted alone.
  if (shell && shell.crumbEl && !shell.crumbEl.firstChild) {
    const items = [{ label: 'the store', href: '#/' }];
    const segs = ctx.segments || [];
    for (let n = 1; n <= segs.length; n++) {
      let label;
      try { label = decodeURIComponent(segs[n - 1]); } catch { label = segs[n - 1]; }
      items.push({ label, href: n < segs.length ? '#/' + segs.slice(0, n).join('/') : null });
    }
    mountCrumbs(clear(shell.crumbEl), { items, up: { href: '#/', label: 'the store' } });
  }
  // DESIGN §0 / SPEC §9: 400 and 403 render an error card and never resolve upward.
  const card = h('div', { class: 'lens-card lens-card--error' },
    h('h2', { class: 'lens-card__title' }, status ? `${status} · ${err.code || 'error'}` : 'This page could not be built'),
    h('p', { class: 'lens-card__body' }, String((err && err.message) || err)),
    err && err.detail ? h('pre', { class: 'lens-card__pre' }, JSON.stringify(err.detail, null, 2)) : null,
    h('p', { class: 'lens-card__body' }, h('a', { href: '#/' }, 'back to the store')));
  replace(ctx.el, card);
  if (!status) console.error('[lens] route render failed', err);
}

/* ------------------------------------------------------------------ *
 * the render context handed to every view
 * ------------------------------------------------------------------ */

function makeContext({ resolved, segments, query, path, scope }) {
  const bindings = {
    siblings: null,     // { prev, next, label }
    rowsRoot: null,     // element whose [data-lens-row] children j/k walk
    views: null,        // [{ key, label }] for `t`
    raw: null,          // href for `\`
    scope: null,        // SPEC §9 scope string for `/`
    find: null,         // in-pane head filter opener for `/` (DESIGN §3 Search)
    up: null,           // { href, label } for `u`
    levels: null,       // { 0:'#/', 1:'#/p/x', … } for g0..g5
    escape: null,
  };

  const ctx = {
    // contracted surface
    params: resolved.params,
    query,
    el: shell.contentEl,
    navigate,
    // The tab title is the shell's, not this render's. A superseded
    // render whose fetch finally resolves used to rename the page the reader
    // is actually on.
    setTitle: (t) => { if (!scope.stale) setTitle(t); },

    // routing facts
    route: resolved.pattern,
    hash: '#' + path + (query.toString() ? '?' + query.toString() : ''),
    path,
    segments,
    fallback: resolved.fallback,
    signal: scope.ac.signal,
    get stale() { return scope.stale; },

    // the three fixed bands (DESIGN §1) — mount straight into these, or use
    // the convenience wrappers below.
    //
    // STALE-RENDER RULE. These wrappers write into the shell's OWN persistent nodes, not
    // into anything this render owns — `clear(shell.crumbEl)` is the live
    // band, and `el` below is shell.contentEl itself (page() merely orphans
    // whatever body was there). So a render that has been superseded but whose
    // fetch is still running used to repaint the CURRENT page's crumb rail,
    // scope sentence and cost/token band with the ABANDONED page's figures —
    // reproduced live: the right agent's crumb over a different agent's real
    // money, durable until the next navigation. The token check belongs here,
    // at the one shared site, so the class cannot come back the next time a
    // view is added.
    //
    // This is belt and braces, NOT a replacement for the `if (ctx.stale)
    // return;` in each view: a stale view that keeps running still burns CPU
    // and can still call navigate().
    bands: { crumbEl: shell.crumbEl, scopeEl: shell.scopeEl, statEl: shell.statEl, bannerEl: shell.bannerEl },
    crumbs: (props) => (scope.stale ? null : mountCrumbs(clear(shell.crumbEl), props)),
    scopeSentence: (props) => (scope.stale ? null : mountScope(clear(shell.scopeEl), props)),
    statbar: (props) => (scope.stale ? null : mountStatbar(clear(shell.statEl), props)),

    banner: (message, tone = 'note', extra) => {
      if (scope.stale) return null;
      const node = h('div', { class: `lens-banner lens-banner--${tone}`, role: 'status' },
        h('span', { class: 'lens-banner__text' }, message), extra || null);
      shell.bannerEl.appendChild(node);
      return node;
    },
    ready: () => { ctx._settled = true; if (ctx._loadingNode && ctx._loadingNode.parentNode) ctx._loadingNode.parentNode.removeChild(ctx._loadingNode); },

    /** Determinate progress only (DESIGN §7). No spinners anywhere. */
    loading: ({ label = 'indexing…', done, of, bytesDone, bytesTotal } = {}) => {
      // `el` IS shell.contentEl, so a superseded pending envelope
      // would replace the live page's body with a progress bar for a route
      // the reader already left.
      if (scope.stale) return null;
      ctx.ready();
      const bar = h('div', { class: 'lens-progress__bar' });
      const frac = bytesTotal ? (bytesDone || 0) / bytesTotal : (of ? (done || 0) / of : null);
      if (frac !== null) bar.setAttribute('style', `width:${Math.max(0, Math.min(1, frac)) * 100}%`);
      const denom = bytesTotal
        ? `${formatBytes(bytesDone || 0)} of ${formatBytes(bytesTotal)} (${formatPercent(bytesDone || 0, bytesTotal)})`
        : of ? `${formatInt(done || 0)} of ${formatInt(of)}` : 'measuring…';
      const node = h('div', { class: 'lens-progress', role: 'status' },
        h('div', { class: 'lens-progress__label' }, label),
        h('div', { class: 'lens-progress__track' }, bar),
        h('div', { class: 'lens-progress__denom' }, denom));
      replace(ctx.el, node);
      return node;
    },

    // keyboard registration (DESIGN §5) — the map lives in the router, the
    // targets are supplied by the view.
    registerSiblings: (s) => { bindings.siblings = s; ctx._refreshHints(); },
    registerRows: (rootEl, opts) => { bindings.rowsRoot = rootEl; bindings.rowsOpts = opts || {}; },
    registerViews: (views) => { bindings.views = views; ctx._refreshHints(); },
    registerRaw: (hrefStr) => { bindings.raw = hrefStr; },
    registerScope: (scopeStr) => { bindings.scope = scopeStr; },
    /** `/` opens this view's in-pane find over loaded rows when one exists
     *  (DESIGN §3 Search); return false to fall through to `#/find`. */
    registerFind: (fn) => { bindings.find = fn; },
    registerUp: (hrefStr, label) => { bindings.up = { href: hrefStr, label }; },
    registerLevels: (levels) => { bindings.levels = levels; },
    onEscape: (fn) => { bindings.escape = fn; },

    _bindings: bindings,
    _abort: scope.ac,
    _settled: false,
    _loadingNode: null,
    _refreshHints() { /* the crumb rail renders `u`'s label; views re-mount it */ },
  };
  return ctx;
}

export function setTitle(t) {
  document.title = t ? `${t} · Claude Playback Lens` : 'Claude Playback Lens';
}

export function getContext() { return currentCtx; }

/* ------------------------------------------------------------------ *
 * keyboard (DESIGN §5)
 * ------------------------------------------------------------------ */

function isTyping(target) {
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

export function onKeydown(ev) {
  if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (isTyping(ev.target)) {
    if (ev.key === 'Escape' && ev.target.blur) ev.target.blur();
    return;
  }
  const ctx = currentCtx;
  const b = (ctx && ctx._bindings) || {};
  const key = ev.key;

  // g-prefix: g0..g5 jump to level
  if (key === 'g') { gPrefixAt = Date.now(); return; }
  if (gPrefixAt && Date.now() - gPrefixAt < 900 && /^[0-5]$/.test(key)) {
    gPrefixAt = 0;
    const target = levelHref(Number(key), ctx);
    if (target) { ev.preventDefault(); navigate(target); }
    return;
  }
  gPrefixAt = 0;

  switch (key) {
    case '?': ev.preventDefault(); toggleSheet(); return;
    case 'Escape':
      if (closeTopLayer()) { ev.preventDefault(); return; }
      if (b.escape) { ev.preventDefault(); b.escape(); }
      return;
    case 'j': case 'ArrowDown': if (moveRow(b, +1)) ev.preventDefault(); return;
    case 'k': case 'ArrowUp': if (moveRow(b, -1)) ev.preventDefault(); return;
    case 'Enter': if (activateRow(b)) ev.preventDefault(); return;
    case 'u': {
      const up = (b.up && b.up.href) || defaultUpHref(ctx);
      if (up) { ev.preventDefault(); navigate(up); }
      return;
    }
    case '[': if (b.siblings && b.siblings.prev) { ev.preventDefault(); goSibling(b.siblings.prev); } return;
    case ']': if (b.siblings && b.siblings.next) { ev.preventDefault(); goSibling(b.siblings.next); } return;
    case '/': {
      ev.preventDefault();
      // DESIGN §3 Search: in-scope `/` filters the LOADED rows in place when
      // the view has a rows pane; the pane's own escape hatch offers the full
      // byte scan. Views without one keep the old jump to #/find.
      if (typeof b.find === 'function' && b.find() !== false) return;
      const scopeStr = b.scope;
      navigate(scopeStr ? `#/find?scope=${encodeURIComponent(scopeStr)}` : '#/find');
      return;
    }
    case '\\': if (b.raw) { ev.preventDefault(); navigate(b.raw); } return;
    case 't': if (cycleViews(b, ctx)) ev.preventDefault(); return;
    default:
  }
}

function goSibling(target) {
  if (typeof target === 'function') target();
  else navigate(target);
}

function cycleViews(b, ctx) {
  if (!b.views || b.views.length < 2 || !ctx) return false;
  const keys = b.views.map((v) => (typeof v === 'string' ? v : v.key));
  const cur = ctx.query.get('v') || keys[0];
  const at = keys.indexOf(cur);
  const next = keys[(at + 1 + keys.length) % keys.length];
  navigate(withQuery(currentHash(), { v: next === keys[0] ? null : next }));
  return true;
}

function rowNodes(b) {
  const root = b.rowsRoot || (shell && shell.contentEl);
  if (!root || !root.querySelectorAll) return [];
  return [...root.querySelectorAll('[data-lens-row]')].filter((n) => !n.hasAttribute('hidden'));
}

function moveRow(b, delta) {
  const nodes = rowNodes(b);
  if (!nodes.length) return false;
  let at = nodes.findIndex((n) => n.classList && n.classList.contains('is-active'));
  at = at === -1 ? (delta > 0 ? 0 : nodes.length - 1) : Math.max(0, Math.min(nodes.length - 1, at + delta));
  for (const n of nodes) { n.classList.remove('is-active'); n.removeAttribute('aria-selected'); }
  const node = nodes[at];
  node.classList.add('is-active');
  node.setAttribute('aria-selected', 'true');
  if (node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  if (b.rowsOpts && b.rowsOpts.onMove) b.rowsOpts.onMove(node, at);
  return true;
}

function activateRow(b) {
  const node = rowNodes(b).find((n) => n.classList && n.classList.contains('is-active'));
  if (!node) return false;
  if (b.rowsOpts && b.rowsOpts.onEnter) { b.rowsOpts.onEnter(node); return true; }
  const link = node.matches && node.matches('a[href]') ? node : node.querySelector && node.querySelector('a[data-lens-drill], a[href]');
  if (link && link.getAttribute) { navigate(link.getAttribute('href')); return true; }
  return false;
}

/** g0..g5 — derived from the current hash, so it works without view help. */
export function levelHref(level, ctx) {
  const b = ctx && ctx._bindings;
  if (b && b.levels && b.levels[level]) return b.levels[level];
  const p = (ctx && ctx.params) || {};
  switch (level) {
    case 0: return '#/';
    case 1: return p.slug ? href('p', p.slug) : null;
    case 2: return p.slug && p.sid ? href('p', p.slug, 's', p.sid) : null;
    case 3: return p.slug && p.sid && p.idx !== undefined ? href('p', p.slug, 's', p.sid, 't', p.idx) : null;
    case 4: return p.slug && p.sid && p.agentId ? href('p', p.slug, 's', p.sid, 'a', p.agentId) : null;
    case 5: return p.slug && p.sid && p.agentId && p.eventRefRaw
      ? href('p', p.slug, 's', p.sid, 'a', p.agentId, 'e', p.eventRefRaw) : null;
    default: return null;
  }
}

function defaultUpHref(ctx) {
  if (!ctx) return '#/';
  const segs = ctx.segments;
  const table = routeTable();
  for (const anc of ancestorsOf(segs)) {
    if (bestMatch(anc, table)) return '#/' + anc.join('/');
  }
  return '#/';
}

/* ------------------------------------------------------------------ *
 * layers: the `?` sheet and any open popover/panel
 * ------------------------------------------------------------------ */

function closeTopLayer() {
  if (!shell) return false;
  if (shell.sheetEl && !shell.sheetEl.hasAttribute('hidden')) { shell.sheetEl.setAttribute('hidden', ''); return true; }
  const open = shell.root.querySelectorAll ? shell.root.querySelectorAll('[data-lens-layer]:not([hidden])') : [];
  if (open.length) { open[open.length - 1].setAttribute('hidden', ''); return true; }
  return false;
}

export function toggleSheet() {
  if (!shell || !shell.sheetEl) return;
  const el = shell.sheetEl;
  if (!el.hasAttribute('hidden')) { el.setAttribute('hidden', ''); return; }
  replace(el,
    h('div', { class: 'lens-sheet__panel', role: 'dialog', 'aria-label': 'Keyboard' },
      h('h2', { class: 'lens-sheet__title' }, 'Keyboard'),
      h('dl', { class: 'lens-sheet__list' },
        ...KEYMAP.flatMap((k) => [
          h('dt', { class: 'lens-sheet__key' }, h('kbd', null, k.keys)),
          h('dd', { class: 'lens-sheet__what' }, k.what),
        ])),
      h('button', { class: 'lens-btn', type: 'button', onclick: () => el.setAttribute('hidden', '') }, 'close')));
  el.removeAttribute('hidden');
  on(el, 'click', (ev) => { if (ev.target === el) el.setAttribute('hidden', ''); });
}

/* ------------------------------------------------------------------ *
 * the non-modal reload bar (DESIGN §7) — never re-renders under the reader
 * ------------------------------------------------------------------ */

// The 5s re-offer cadence is BY DESIGN (DESIGN §7 takes it as the baseline,
// and l2.mjs's live watcher does exactly the same thing). The bar is
// idempotent on (visible && same message) — the nodes, and any keyboard focus
// in them, survive a re-offer — while the handler is ALWAYS refreshed,
// because the newest snapshot is the one Reload must apply. hideReloadBar
// clears the remembered message so a dismissed bar can be offered again,
// which DESIGN §7 requires.
const reloadOffer = { message: null, onReload: null };

export function showReloadBar(message, onReload) {
  if (!shell || !shell.reloadEl) return;
  reloadOffer.onReload = onReload; // ALWAYS: newest snapshot wins
  if (!shell.reloadEl.hasAttribute('hidden') && reloadOffer.message === message) return;
  reloadOffer.message = message;
  replace(shell.reloadEl,
    h('span', { class: 'lens-reload__text' }, message),
    h('button', {
      class: 'lens-btn lens-btn--primary', type: 'button',
      onclick: () => { hideReloadBar(); (reloadOffer.onReload || render)(); },
    }, 'Reload'),
    h('button', {
      class: 'lens-btn', type: 'button',
      onclick: () => hideReloadBar(),
    }, 'dismiss'));
  shell.reloadEl.removeAttribute('hidden');
}

export function hideReloadBar() {
  if (!shell || !shell.reloadEl) return;
  shell.reloadEl.setAttribute('hidden', '');
  reloadOffer.message = null; // next offer re-shows (DESIGN §7)
}
