// web/js/components/chips.mjs — the DESIGN §1 disclosure chips.
//
// EVERY CostAgg disclosure counter has exactly one chip; every chip cites its
// R-number and carries the affected token mass IN THE OWNER'S WORDS. Masses are
// labelled as RECORDED values, never estimates. Render ONLY when nonzero.
//
// The drift rule (SPEC §9): a new CostAgg counter requires a new chip here AND
// a new audit census. If a counter arrives that this module does not know, it
// still renders — as an "undisclosed counter" chip — rather than vanishing.
//
//   buildChips(agg, opts) -> [{ key, text, rule, tone, href?, title? }]   (pure)
//   chipsRow(el, { agg, links, masses }) -> { update, destroy }

import { h, clear, formatInt, formatTokens, formatUsd, tokensTotal, UNKNOWN, isKnown } from '../format.mjs';

/** Every counter this module knows how to disclose. The two CostAgg MASSES
 *  (neverFinalizedOutput, ttlDeltaTcu — SPEC §9) are not counters and get no
 *  chip of their own: they render INSIDE the R6/R5 chips' wording. */
export const KNOWN_COUNTERS = [
  'inherited', 'synthetic', 'ttlAssumed', 'neverFinalized',
  'unpriced', 'tierAssumed', 'premiumUnknown', 'embeddedSidechain',
  'inheritedRequests', 'unpricedRequests', 'inheritedPending',
];

/** CostAgg keys that are NOT disclosure counters: structure, masses,
 *  and the real request/token counts the Lite card agg now carries. Anything
 *  numeric > 0 outside this list and KNOWN_COUNTERS gets the drift chip. */
export const NON_COUNTER_KEYS = [
  'requests', 'tokens', 'usd', 'thinking', 'byModel',
  'neverFinalizedOutput', 'ttlDeltaTcu',
  'webSearchRequests', 'webFetchRequests',
];

/**
 * Disclosure masses. The CostAgg now carries both (SPEC §9:
 * neverFinalizedOutput + ttlDeltaTcu) and they are
 * read off the agg by default; an explicit `masses` prop still wins. Anything
 * absent renders '—' with a reason — NEVER a fabricated number.
 *   masses = { neverFinalizedOutput, ttlDeltaTcu }
 */
function mass(value, reason) {
  return isKnown(value) ? formatTokens(value) : UNKNOWN;
}
function massTitle(value, reason) {
  return isKnown(value) ? null : (reason || 'the server did not report this mass; it is not estimated here');
}

/**
 * buildChips(agg, { links, masses }) — PURE.
 * `links.session(sid)` / `links.model(raw)` / `links.audit(name)` are optional
 * href builders; a chip without one simply renders unlinked.
 */
export function buildChips(agg, { links = {}, masses: massesIn } = {}) {
  const out = [];
  if (!agg || typeof agg !== 'object') return out;
  // recorded masses ride the CostAgg itself; an explicit masses prop overrides
  const masses = {
    neverFinalizedOutput: massesIn?.neverFinalizedOutput ?? agg.neverFinalizedOutput,
    ttlDeltaTcu: massesIn?.ttlDeltaTcu ?? agg.ttlDeltaTcu,
  };

  // R2 — inherited copies, billed in their canonical session. A Lite card agg
  // (/api/index) carries only the summed
  // `inheritedRequests`; the per-session split lives on the session payload.
  const inherited = agg.inherited || {};
  if (!Object.keys(inherited).length && typeof agg.inheritedRequests === 'number' && agg.inheritedRequests > 0) {
    out.push({
      key: 'inheritedRequests',
      rule: 'R2',
      tone: 'note',
      text: `↷ ${formatInt(agg.inheritedRequests)} events inherited from another session — billed there · R2`,
      title: 'this Lite aggregate carries the summed count only; the per-session split (and the partner links) are on the session page (SPEC R2)',
    });
  }
  for (const sid of Object.keys(inherited)) {
    const e = inherited[sid] || {};
    if (!e.requests) continue;
    const toks = tokensTotal(e.tokens);
    out.push({
      key: `inherited:${sid}`,
      rule: 'R2',
      tone: 'note',
      href: links.session ? links.session(sid) : null,
      text: `↷ ${formatInt(e.requests)} events inherited from ${shortId(sid)} — billed there; `
        + `${isKnown(toks) ? formatTokens(toks) : UNKNOWN} tokens excluded here · R2`,
      title: `${sid} · the copies still display here; their usage is billed in the canonical file (SPEC R2)`,
    });
  }

  // R2 pending — the index is still building, so canonicality is not resolved.
  if (agg.inheritedPending) {
    out.push({
      key: 'inherited:pending',
      rule: 'R2',
      tone: 'warn',
      text: `↷ duplicate-message group not yet resolved — its partner session is still indexing · R2`,
      title: 'a session\'s billed total is only defined against a complete index (SPEC R2)',
    });
  }

  // R4 — <synthetic> API-error events.
  if (agg.synthetic) {
    out.push({
      key: 'synthetic',
      rule: 'R4',
      tone: 'note',
      text: `synthetic ${formatInt(agg.synthetic)} — API-error events, zero usage, excluded from billing · R4`,
      title: 'usage.iterations === null is the exact discriminator (SPEC R4)',
    });
  }

  // R5 — cache TTL not recorded, priced at the 5-minute rate.
  if (agg.ttlAssumed) {
    const delta = masses.ttlDeltaTcu;
    out.push({
      key: 'ttlAssumed',
      rule: 'R5',
      tone: 'warn',
      text: `ttl assumed on ${formatInt(agg.ttlAssumed)} rows (±${isKnown(delta) ? formatUsd(delta) : UNKNOWN} if 1h) · R5`,
      title: isKnown(delta)
        ? 'the recorded rows carry only the flat cache_creation counter; billed at the 5-minute rate (SPEC R5)'
        : 'the 1-hour delta was not reported by the server and is not estimated here (SPEC R5)',
    });
  }

  // R6 — never-finalized responses. The recorded output is a stub, not a count.
  if (agg.neverFinalized) {
    const of = agg.requests;
    const recorded = masses.neverFinalizedOutput;
    out.push({
      key: 'neverFinalized',
      rule: 'R6',
      tone: 'warn',
      text: `≈ ${formatInt(agg.neverFinalized)} of ${isKnown(of) ? formatInt(of) : UNKNOWN} responses stopped mid-stream — `
        + `output recorded on them is a stub, not a final count `
        + `(${mass(recorded)} output tokens recorded; the shortfall is not measurable and never estimated) · R6`,
      title: massTitle(recorded, 'the recorded stub mass was not reported by the server; it is never estimated'),
    });
  }

  // R7 — a model with no rate. Tokens are counted, never priced, never $0.
  // Same Lite-agg fallback as R2: summed count only, split on the session page.
  const unpriced = agg.unpriced || {};
  if (!Object.keys(unpriced).length && typeof agg.unpricedRequests === 'number' && agg.unpricedRequests > 0) {
    out.push({
      key: 'unpricedRequests',
      rule: 'R7',
      tone: 'error',
      text: `+⚠ ${formatInt(agg.unpricedRequests)} requests on a model with no rate — not priced, never $0 · R7`,
      title: 'this Lite aggregate carries the summed count only; the per-model split is on the session page (SPEC R7)',
    });
  }
  for (const model of Object.keys(unpriced)) {
    const e = unpriced[model] || {};
    if (!e.requests) continue;
    const toks = tokensTotal(e.tokens);
    out.push({
      key: `unpriced:${model}`,
      rule: 'R7',
      tone: 'error',
      href: links.model ? links.model(model) : null,
      text: `+⚠ ${formatInt(e.requests)} requests on a model with no rate — `
        + `${isKnown(toks) ? formatTokens(toks) : UNKNOWN} tokens not priced · R7`,
      title: `${model} — a missing rate is never $0 and never blended (SPEC R7)`,
    });
  }

  // R9 — a non-standard raw tier priced at standard sticker rates.
  if (agg.tierAssumed) {
    out.push({
      key: 'tierAssumed',
      rule: 'R9',
      tone: 'warn',
      text: `tier assumed on ${formatInt(agg.tierAssumed)} rows · R9`,
      title: 'a recognised non-standard (speed, service_tier) pair with no rate row, priced at standard rates (SPEC R9)',
    });
  }

  // Long context on a model whose >200K tier is unverified.
  if (agg.premiumUnknown) {
    out.push({
      key: 'premiumUnknown',
      rule: 'SPEC §5',
      tone: 'warn',
      text: `>200K on an unverified-tier model: ${formatInt(agg.premiumUnknown)} rows · SPEC §5 premiumUnknown`,
      title: 'a rate exists and is applied; only the long-context tier is unknown (distinct from R7)',
    });
  }

  // §3 — old-style embedded sidechain rows found inside a main file.
  const emb = agg.embeddedSidechain;
  if (emb && emb.requests) {
    out.push({
      key: 'embeddedSidechain',
      rule: 'SPEC §3',
      tone: 'note',
      text: `embedded sidechain: ${formatInt(emb.requests)} foreign rows · SPEC §3`,
      title: 'isSidechain:true runs inside a main file — excluded from turn billing, accumulated in their own channel',
    });
  }

  // Drift guard: the stated purpose is ANY unknown counter, so the
  // gate is an allowlist of known non-counter keys — not a suffix pattern a
  // future counter could dodge. Any other numeric > 0 renders the drift chip.
  for (const key of Object.keys(agg)) {
    if (KNOWN_COUNTERS.includes(key)) continue;
    if (NON_COUNTER_KEYS.includes(key)) continue;
    if (out.some((c) => c.key === key)) continue;
    const v = agg[key];
    if (typeof v === 'number' && v > 0) {
      out.push({
        key, rule: 'undisclosed', tone: 'error',
        text: `${key}: ${formatInt(v)} — this counter has no chip yet · SPEC §9 drift rule`,
        title: 'a new CostAgg counter requires a chip here and an audit census',
      });
    }
  }

  return out;
}

function shortId(sid) {
  const s = String(sid || '');
  return s.length > 8 ? s.slice(0, 8) : s;
}

/**
 * chipsRow(el, { agg, links, masses }) -> { update, destroy }
 * Renders nothing at all when every counter is zero — a clean scope shows a
 * clean band, and silence here means "nothing to disclose", not "unknown".
 */
export function chipsRow(el, props) {
  const state = { props: props || {} };

  function draw() {
    clear(el);
    const chips = buildChips(state.props.agg, state.props);
    if (!chips.length) { el.setAttribute('hidden', ''); return; }
    el.removeAttribute('hidden');
    el.setAttribute('class', 'lens-chips');
    for (const c of chips) {
      const inner = [h('span', { class: 'lens-chip__text' }, c.text)];
      el.appendChild(c.href
        ? h('a', { class: `lens-chip lens-chip--${c.tone}`, href: c.href, title: c.title || null, 'data-rule': c.rule }, inner)
        : h('span', { class: `lens-chip lens-chip--${c.tone}`, title: c.title || null, 'data-rule': c.rule }, inner));
    }
  }

  draw();
  return {
    update(next) { state.props = Object.assign({}, state.props, next); draw(); },
    destroy() { clear(el); },
  };
}
