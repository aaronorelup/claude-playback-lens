// server/api/index-view.mjs — the store-wide index view (/api/index's payload)
// and its per-project slice memo, both keyed on the index version. This is the
// one place cards are aggregated, badged and stripped for HTTP.

import { makeBands, bandsFromRows, bandsFromLite, finishBands } from './bands.mjs';
import {
  getCanonical, r2State, forkedBadgeOf,
  rowsSumTcuOf, liteRowSumTcu, sumVerdict,
} from './costs.mjs';

// makeIndexView(ctx, { canonMemo, boot }) -> { buildIndexView, projectSlice }.
// canonMemo is the cross-route R2 memo owned by createApi; viewMemo/projMemo
// live here because nothing else reads them.
export function makeIndexView(ctx, { canonMemo, boot }) {
  const viewMemo = { version: -1, value: null };
  // Per-slug slice of /api/project's own (non-view) computation, keyed on the
  // index version like every other memo — the per-project day walk is far too
  // expensive to rebuild per request (multi-second on a skewed session).
  const projMemo = { version: -1, bySlug: new Map() };

  async function projectSlice(version, slug, build) {
    if (projMemo.version !== version) { projMemo.version = version; projMemo.bySlug = new Map(); }
    const hit = projMemo.bySlug.get(slug);
    if (hit) return hit;
    const value = await build();
    projMemo.bySlug.set(slug, value);
    return value;
  }

  // Slim per-card agg for /api/index (payload budget): requests, the full
  // token object, usd total, and every disclosure counter — the maps
  // (byModel/unpriced/inherited) and component usd stay on the full CostAgg
  // served at store/project/session/turn/agent scope.
  function cardAggLite(agg) {
    if (!agg) return null;
    const lite = {
      requests: agg.requests,
      tokens: agg.tokens,
      usd: { total: agg.usd?.total ?? 0 },
      neverFinalized: agg.neverFinalized ?? 0,
      synthetic: agg.synthetic ?? 0,
      ttlAssumed: agg.ttlAssumed ?? 0,
      tierAssumed: agg.tierAssumed ?? 0,
      premiumUnknown: agg.premiumUnknown ?? 0,
      neverFinalizedOutput: agg.neverFinalizedOutput ?? 0,
      ttlDeltaTcu: agg.ttlDeltaTcu ?? 0,
      webSearchRequests: agg.webSearchRequests ?? 0,
      webFetchRequests: agg.webFetchRequests ?? 0,
      inheritedRequests: Object.values(agg.inherited ?? {}).reduce((n, e) => n + (e.requests ?? 0), 0),
      unpricedRequests: Object.values(agg.unpriced ?? {}).reduce((n, e) => n + (e.requests ?? 0), 0),
    };
    if (agg.inheritedPending) lite.inheritedPending = true;
    return lite;
  }

  // one card -> { agg, rowSum, bands contribution } — ledgerLite first (no
  // parse), full rows as the disclosed fallback for a card without one.
  // rowSum is the priceRowTcu-rule sum of the session's rows (integer tcu),
  // null when it cannot be derived — feeding rowsSumToHeader at index level.
  async function cardAggInto(card, canonicalOf, bandAcc) {
    const canAgg = !!(ctx.ledger && ctx.pricing);
    const canLite = canAgg && typeof ctx.ledger.aggregateLite === 'function';
    const key = `${card.slug}/${card.id}`;
    if (canLite && card.ledgerLite) {
      try {
        const agg = ctx.ledger.aggregateLite(card.ledgerLite, {
          canonicalOf, sessionId: card.id, priceRow: ctx.pricing.priceRow,
        });
        if (bandAcc) bandsFromLite(ctx, bandAcc, key, card.id, card.ledgerLite, canonicalOf);
        return { agg, rowSum: liteRowSumTcu(ctx, card, canonicalOf) };
      } catch { /* fall through to rows */ }
    }
    if (!canAgg) return { agg: null, rowSum: null };
    try {
      const rows = await ctx.index.rows(card.slug, card.id);
      const agg = ctx.ledger.aggregate(rows, { canonicalOf, sessionId: card.id, priceRow: ctx.pricing.priceRow });
      if (bandAcc) bandsFromRows(ctx, bandAcc, key, card.id, rows, canonicalOf);
      return { agg, rowSum: rowsSumTcuOf(ctx, rows, card.id, canonicalOf) };
    } catch { return { agg: null, rowSum: null }; /* pending — denominator discloses */ }
  }

  // HTTP copy of a card: strip the cache-only bulk (ledgerLite, msgId sets,
  // the card's own turnBars — the index-level turnBars[] ships them once), OR
  // in the index-level `forked` badge (summary time only sees the
  // keep-original fork evidence), attach the read-time agg.
  function cardOut(card, dupIds, agg) {
    // `problems` is cache-only card state — it feeds the store-level census
    // (index.problems()) and ships at session scope on /api/session. SPEC §9's
    // SessionCard does not list it, so it is stripped here rather than
    // duplicated per card inside /api/index.
    const { ledgerLite, mainMsgIds, foreignMsgIds, turnBars: cardBars, problems: cardProblems, ...slim } = card;
    const badges = forkedBadgeOf(slim.badges, mainMsgIds, dupIds);
    if (badges !== slim.badges) slim.badges = badges;
    slim.agg = agg; // null = not computable yet (unknown, never 0)
    return slim;
  }

  async function buildIndexView(version) {
    if (viewMemo.version === version && viewMemo.value) return viewMemo.value;
    const status = ctx.index.status();
    const cards = [...ctx.index.cards().values()];
    const canonicalOf = getCanonical(ctx, canonMemo);
    const dupIds = new Set(canonicalOf.keys());
    const building = status.state !== 'ready';

    const bandAcc = makeBands();
    const cardsOut = [];
    const perCardAgg = new Map(); // id -> CostAgg|null
    let aggSessions = 0;
    let lostAgents = 0; // census, provable 0 (Σ card.lostAgents) — never `—`
    let rowSumTcu = 0;
    let rowSumComplete = true; // every counted card contributed a lite row sum
    for (const card of cards) {
      const { agg, rowSum } = await cardAggInto(card, canonicalOf, bandAcc);
      if (agg) aggSessions += 1;
      if (typeof card.lostAgents === 'number') lostAgents += card.lostAgents;
      // R2 pending (SPEC): while building, a session in an ALREADY-DETECTED
      // duplicate group flags inheritedPending — its figures may shift when
      // the partner lands. (A partner never seen before is undecidable; the
      // aggScope denominator is that disclosure.)
      if (building && agg && Array.isArray(card.mainMsgIds)
        && card.mainMsgIds.some((mid) => dupIds.has(mid))) {
        agg.inheritedPending = true;
      }
      if (agg) {
        if (rowSum === null) rowSumComplete = false; else rowSumTcu += rowSum;
      }
      perCardAgg.set(card.id, agg);
      cardsOut.push(cardOut(card, dupIds, cardAggLite(agg)));
    }

    // store + project aggs = Σ children by construction (addCostAgg)
    let storeAgg = null;
    const projAgg = new Map();
    if (ctx.ledger && typeof ctx.ledger.addCostAgg === 'function') {
      for (const card of cards) {
        const a = perCardAgg.get(card.id);
        if (!a) continue;
        storeAgg = storeAgg === null ? a : ctx.ledger.addCostAgg(storeAgg, a);
        const prev = projAgg.get(card.slug);
        projAgg.set(card.slug, prev ? ctx.ledger.addCostAgg(prev, a) : a);
      }
    }
    // rows-sum-to-header at store scope, from the cached tallies (exact
    // integer tcu; null when any counted card's row sum was underivable)
    const rowsSumToHeader = storeAgg === null || !rowSumComplete
      ? null
      : sumVerdict(storeAgg.usd.total, rowSumTcu);

    // project label per SPEC §2: the recorded cwd that re-encodes exactly to
    // the dir name (summary.mjs already stores the matching cwd on the card)
    const labelBySlug = new Map();
    for (const card of cards) {
      if (card.cwd && !labelBySlug.has(card.slug)) labelBySlug.set(card.slug, card.cwd);
    }
    const projectsOut = ctx.index.projects().map((p) => ({
      ...p,
      label: p.label ?? labelBySlug.get(p.slug) ?? null, // null -> raw slug + reason (client rule)
      agg: projAgg.get(p.slug) ?? null,
    }));

    const turnBars = ctx.index.turnBars ? ctx.index.turnBars() : [];
    // The day walk can only degrade in a disclosed way — its problems are
    // collected here and ride the same problems[] as everything else.
    const bandProblems = [];
    const dayBands = finishBands(bandAcc, turnBars, bandProblems);
    const view = {
      version,
      boot, // pair with `since` on the next poll (?since=N&boot=…)
      status: { ...status, r2: r2State(ctx) },
      agg: storeAgg,
      aggScope: { sessions: aggSessions, of: ctx.index.sessions().length },
      rowsSumToHeader, // store-scope header-vs-rows verdict in exact tcu (null = not computable)
      lostAgents, // census, Σ card.lostAgents — a provable 0 renders 0, never `—`
      projects: projectsOut,
      sessions: cardsOut,
      turnBars,
      dayBands,
      dayBandsScope: { sessions: aggSessions, of: ctx.index.sessions().length },
      pending: ctx.index.pending(),
      problems: [...(ctx.index.problems ? ctx.index.problems() : []), ...bandProblems],
    };
    viewMemo.version = version;
    viewMemo.value = view;
    return view;
  }

  return { buildIndexView, projectSlice };
}
