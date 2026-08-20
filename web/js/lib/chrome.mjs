// web/js/lib/chrome.mjs — the drill views' page chrome: crumb/statbar
// mounting through ctx, the page skeleton, error/pending cards, the 404
// upward-resolution rule (DESIGN §0), sibling pagers and the progress bar.
// The three fixed bands live in the router's shell (DESIGN §1) — a view
// mounts into them through ctx rather than drawing its own.

import { h, replace, formatUsd } from '../format.mjs';
import { queueBanner } from '../router.mjs';
import { costfigure } from '../components/costfigure.mjs';
import { vtable } from '../components/vtable.mjs';
import { a, simpleTable } from './dom.mjs';
import { num, fmtInt, fmtBytes, fmtDur, shortId } from './fmt.mjs';
import { routes } from './links.mjs';

let _renders = 0;
export function noteRender() { _renders++; }
export function renderCount() { return _renders; }

/** Band 1 — crumb rail. Also registers `u` (DESIGN §5) with its destination. */
export function mountCrumbs(ctx, items) {
  const list = items.filter(Boolean);
  const up = list.length > 1 ? list[list.length - 2] : null;
  ctx.crumbs?.({
    items: list.map((it) => ({ label: it.label, id: it.sub || null, href: it.href || null })),
    up: up ? { href: up.href, label: up.label } : null,
  });
  if (up?.href) ctx.registerUp?.(up.href, up.label);
}

/**
 * Bands 2 + 3 — the scope sentence and the one stat header.
 *
 * props = { agg, tokens, span:{ms,from,to,label,reason}, active, scope,
 *           counts:[{key,label,value,reason,href}], scopeSentence, rule,
 *           filters, footnote:{requests,rowsSumToHeader}, masses, at }
 */
export function statHeader(ctx, props = {}) {
  // DESIGN §7 chrome-first: `pending: true` paints '—' pips at final widths
  // BEFORE the fetch, exactly as L0/L1/L2 do.
  if (props.pending) {
    ctx.statbar?.({ pending: true, counts: props.counts ?? [] });
    return;
  }
  const agg = props.agg ?? null;
  ctx.scopeSentence?.({
    subject: props.subject ?? null,
    counts: props.sentenceCounts ?? [],
    rule: props.rule ?? null,
    filters: props.filters ?? [],
    extra: props.scopeSentence ? [props.scopeSentence] : [],
  });
  ctx.statbar?.({
    agg,
    tokens: props.tokens ?? agg?.tokens ?? null,
    span: props.span ?? null,
    active: props.active ?? null,
    counts: props.counts ?? [],
    chips: agg,
    masses: props.masses ?? null,
    scope: props.scope ?? null,
    at: props.at ?? null,
    costUnknownReason: props.costUnknownReason ?? null,   // the caller's reason survives to the cell
    footnote: props.footnote ?? (agg ? { requests: agg.requests, rowsSumToHeader: props.rowsSumToHeader } : null),
  });
  if (props.scope) ctx.registerScope?.(props.scope);
}

/**
 * DESIGN §0: "unknown routes resolve to the nearest ancestor with a
 * banner (404 from the API)". For a 404 raised INSIDE a registered pattern
 * (bad sid, past-the-end turn, unknown agent), banner + navigate to the
 * nearest ancestor that can exist. 400/403 (and everything else) return false
 * so the caller keeps its error card. Returns true when it handled the error.
 */
export function handle404(ctx, err, { slug, sid, thing = 'page' } = {}) {
  // STALE-RENDER backstop at the one shared site: escalating to ctx.navigate()
  // is the single chrome surface the router cannot no-op, so a superseded
  // render is "handled" here — the caller returns and paints nothing. Never a
  // substitute for each view's own `if (ctx.stale) return;`.
  if (ctx?.stale) return true;
  if (!err || err.status !== 404) return false;
  const ancestor = sid && err.code !== 'unknown-session'
    ? { href: routes.session(slug, sid), label: `session ${shortId(sid)}` }
    : slug
      ? { href: routes.project(slug), label: `project ${slug}` }
      : { href: routes.store(), label: 'the store' };
  // The banner must survive the navigation — the router replays it once after
  // its next render (queueBanner is a one-shot queue).
  queueBanner(`no ${thing} — ${err.message ?? 'the API answered 404'} · showing ${ancestor.label}`, 'warn');
  ctx.navigate?.(ancestor.href, { replace: true });
  return true;
}

/** A dollar figure: costfigure is a button → the DESIGN §6 breakdown panel. */
export function costCell(el, agg, scope) {
  try { return costfigure(el, { agg, scope }); }
  catch (err) {
    console.error('costfigure failed', err);
    el.appendChild(h('span', { class: 'lens-cost', text: formatUsd(agg?.usd?.total ?? null) }));
    return { update() {}, destroy() {} };
  }
}

/**
 * Page skeleton: the body area only — the three bands belong to the shell and
 * the router clears them before every render. `ctx.ready()` is deliberately NOT
 * called here: leaving it to the router keeps DESIGN §7's rule intact (a render
 * under 150 ms shows nothing; a slower one gets the router's determinate
 * placeholder, which its own `finally` removes).
 */
export function page(ctx, className) {
  noteRender();
  const body = h('div', { class: 'lens-page__body' });
  const root = h('main', { class: `lens-page ${className}` }, body);
  replace(ctx.el, root);
  return { root, body };
}

export function errorCard(err, { retry } = {}) {
  const box = h('section', { class: 'lens-card lens-card--error' },
    h('h2', { class: 'lens-error__title', text: err?.code ? `${err.status ?? ''} ${err.code}`.trim() : 'error' }),
    h('p', { class: 'lens-error__msg', text: err?.message ?? String(err) }));
  if (retry) box.appendChild(h('button', { class: 'lens-btn', onclick: retry, text: 'retry' }));
  return box;
}

/**
 * 409 not-indexed-yet — the router's determinate loading state, re-polled.
 * Never a spinner (DESIGN §7).
 */
export function pendingCard(ctx, pending, onRetry) {
  ctx.loading?.({
    label: 'indexing — this route is not indexed yet',
    bytesDone: pending?.bytesIndexed, bytesTotal: pending?.bytesTotal,
    done: pending?.sessionsDone, of: pending?.sessionsOf,
  });
  const ms = num(pending?.retryAfterMs) ?? 1000;
  if (onRetry) {
    setTimeout(() => { if (!ctx.stale) onRetry(); }, ms > 0 ? ms : 1000);
  }
  return null;
}

/** Determinate SSE progress (bytes/sessions/elapsed) — DESIGN §7. */
export function progressBar() {
  const bar = h('div', { class: 'lens-progress__bar', style: 'width:0%' });
  const label = h('div', { class: 'lens-progress__denom', text: 'starting…' });
  const box = h('div', { class: 'lens-progress', role: 'status' },
    h('div', { class: 'lens-progress__track' }, bar), label);
  return {
    el: box,
    update(p) {
      const of = num(p?.ofBytes) ?? 0;
      const done = num(p?.bytesDone) ?? 0;
      const pct = of > 0 ? Math.min(100, (done / of) * 100) : 0;
      bar.setAttribute('style', `width:${pct}%`);
      const parts = [];
      if (p?.of !== undefined) parts.push(`${fmtInt(p.sessionsDone ?? 0)} of ${fmtInt(p.of)} sessions`);
      if (of > 0) parts.push(`${fmtBytes(done)} of ${fmtBytes(of)}`);
      if (p?.elapsedMs !== undefined) parts.push(fmtDur(p.elapsedMs));
      label.textContent = parts.join(' · ') || 'scanning…';
    },
    done(text) { bar.setAttribute('style', 'width:100%'); label.textContent = text; },
  };
}

/** The DESIGN §4 table behaviour, via group E's vtable. */
export async function table(el, props) {
  try { return vtable(el, props); }
  catch (err) {
    console.error('vtable failed', err);
    el.appendChild(simpleTable(props.columns ?? [], props.rows ?? []));
    return { update() {}, destroy() {} };
  }
}

/* =================================================== keyboard siblings == */

/** DESIGN §5 — `[` / `]`. The map lives in the router; the targets here. */
export function registerSiblings(ctx, { prev, next } = {}) {
  ctx.registerSiblings?.({ prev: prev ?? null, next: next ?? null });
}

/** The prev/next pager UI (real <a href>s; a disabled end carries its reason). */
export function siblingPager(prev, next, { prevLabel = 'prev', nextLabel = 'next', endReason = 'no sibling in this scope' } = {}) {
  const box = h('nav', { class: 'lens-pager' });
  box.appendChild(prev
    ? a(prev, `[ ${prevLabel}`, { class: 'lens-link lens-pager__prev' })
    : h('span', { class: 'lens-pager__prev lens-pager__end', title: endReason, text: `[ ${prevLabel}` }));
  box.appendChild(next
    ? a(next, `${nextLabel} ]`, { class: 'lens-link lens-pager__next' })
    : h('span', { class: 'lens-pager__next lens-pager__end', title: endReason, text: `${nextLabel} ]` }));
  return box;
}
