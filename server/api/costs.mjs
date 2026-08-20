// server/api/costs.mjs — read-time cost derivation shared by every costed
// route: the R2 canonical map + fork evidence (memoized per index version),
// the ONE row-exclusion rule (priceRowTcu), row/bucket tcu sums, the
// header-vs-rows verdict, and the turn-membership predicate.

// The empty memo shape every per-index-version cache starts from.
export function makeMemo() { return { version: -1, value: null }; }

export const zeroTokens = () => ({ input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 });
export const addTok = (t, s) => { for (const k of Object.keys(t)) t[k] += s?.[k] ?? 0; };

export const isAgentFile = (f) => /(^|\/)subagents\//.test(String(f));
export const agentIdOfFile = (f) => {
  const m = /agent-([A-Za-z0-9]+)\.jsonl$/.exec(String(f));
  return m ? m[1] : null;
};

// R2 canonical map (msgId -> owning sessionId), memoized per index version.
export function getCanonical(ctx, memo) {
  const v = ctx.index.version();
  if (memo.version === v && memo.value) return memo.value;
  const msgIds = new Map();
  const tsRel = new Map();
  for (const card of ctx.index.cards().values()) {
    msgIds.set(card.id, card.mainMsgIds ?? []);
    tsRel.set(card.id, {
      // R2(ii) wants the first TIMESTAMPED record's ts, not a bar-derived
      // startedAt (which inherits and ties on forks); summary.mjs records
      // r2FirstTsMs on every card natively, startedAt is the degraded fallback
      // for a card written before INDEX_VERSION 2.
      firstTsMs: card.r2FirstTsMs ?? card.startedAt ?? null,
      rel: card.mainRel ?? `${card.slug}/${card.id}.jsonl`,
      // clause (i) evidence: msgIds recorded under a foreign sessionId in this
      // main file (SPEC §9 SessionCard.foreignMsgIds)
      foreignMsgIds: card.foreignMsgIds ?? undefined,
    });
  }
  let map = new Map();
  try {
    const res = ctx.ledger.resolveCanonical(msgIds, tsRel);
    map = res instanceof Map ? res : (res && res.map instanceof Map ? res.map : new Map());
  } catch { /* group A absent — canonical stays empty; noted by r2 state */ }
  memo.version = v;
  memo.value = map;
  return map;
}

export function r2State(ctx) {
  return ctx.index.status().state === 'building' ? 'pending' : 'resolved';
}

// Which sessions hold each DUPLICATED msgId (the canonicalOf reverse map's
// raw material), memoized per index version. Only ids resolveCanonical
// actually contested appear; single-owner ids never do.
export function getDupHolders(ctx, memo, canonicalOf) {
  const v = ctx.index.version();
  if (memo.version === v && memo.value) return memo.value;
  const holders = new Map(); // msgId -> [{slug, id}]
  for (const card of ctx.index.cards().values()) {
    for (const mid of new Set(card.mainMsgIds ?? [])) {
      if (!canonicalOf.has(mid)) continue;
      let list = holders.get(mid);
      if (!list) holders.set(mid, list = []);
      list.push({ slug: card.slug, id: card.id });
    }
  }
  memo.version = v;
  memo.value = holders;
  return holders;
}

// The msgIds of THIS session's main tier that actually bill something in
// THIS file: the SAME exclusion aggregate() and priceRowTcu apply, in the same
// order (R4 synthetic and §3 embedded-sidechain rows are dropped BEFORE the R2
// gate, so they are billed in no file at all and belong to neither side of a
// fork). Sources, in order: the rows the caller already loaded, else the card's
// cached ledgerLite.dupRows (buildLedgerLite keeps every main-tier row
// individually, so it carries the same msgId/synthetic/embeddedSidechain
// facts without a parse). null = neither source available — unknown.
export function billedMsgIdsOf(ctx, sessionId, rows) {
  const src = rows ?? ctx.index.cards().get(sessionId)?.ledgerLite?.dupRows ?? null;
  if (!src) return null;
  const out = new Set();
  for (const r of src) {
    if (r.synthetic || r.embeddedSidechain === true) continue;
    if (isAgentFile(r.file ?? '')) continue; // agent tier is never contested
    out.add(r.msgId);
  }
  return out;
}

// forkPartners for ONE session: every session sharing a duplicated msgId with
// it, with exact per-partner counts of where those ids are billed (R2). This
// is what lets the CANONICAL side of a fork pair render its banner — its own
// CostAgg has no `inherited` channel to learn the partners from.
//
// sharedMsgIds is the RAW superset (ids recorded in both files). billedHere /
// billedThere / billedElsewhere count only ids this file bills in the
// priceRowTcu sense, so billedThere equals the CostAgg's own inherited channel
// for the same partner and the two banners on a fork pair print one number.
// The shortfall (shared − the three) is exactly this file's $0 copies.
export function forkPartnersOf(ctx, canonMemo, dupMemo, sessionId, rows = null) {
  if (r2State(ctx) !== 'resolved') return null; // unknown while building, never a false {}
  const canonicalOf = getCanonical(ctx, canonMemo);
  const holders = getDupHolders(ctx, dupMemo, canonicalOf);
  const card = ctx.index.cards().get(sessionId);
  const billsHere = billedMsgIdsOf(ctx, sessionId, rows);
  if (!card || billsHere === null) return null; // no billing evidence — unknown, never a false {}
  const out = {};
  for (const mid of new Set(card.mainMsgIds ?? [])) {
    const canon = canonicalOf.get(mid);
    if (canon === undefined) continue;
    const billed = billsHere.has(mid);
    for (const other of holders.get(mid) ?? []) {
      if (other.id === sessionId) continue;
      let e = out[other.id];
      if (!e) e = out[other.id] = { slug: other.slug, sharedMsgIds: 0, billedHere: 0, billedThere: 0, billedElsewhere: 0 };
      e.sharedMsgIds += 1;
      if (!billed) continue; // R4/§3: this copy bills nothing in any file
      if (canon === sessionId) e.billedHere += 1;
      else if (canon === other.id) e.billedThere += 1;
      else e.billedElsewhere += 1; // 3-way group: canonical is a third session
    }
  }
  return out;
}

// The read-time `forked` badge. Summary time only sees the keep-original fork
// evidence (server/summary.mjs tags the side whose file physically carries
// foreign sessionId events), so BOTH /api/index and /api/session OR in group
// membership from the contested-msgId set. `contested` is any object with Set
// semantics keyed by msgId (the canonicalOf map's keys ARE the contested
// ids). Returns the input array untouched when nothing is added, so a payload
// that never carried badges does not grow an empty one.
export function forkedBadgeOf(badges, mainMsgIds, contested) {
  if (Array.isArray(badges) && badges.includes('forked')) return badges;
  if (!contested || !contested.size || !Array.isArray(mainMsgIds)) return badges;
  if (!mainMsgIds.some((mid) => contested.has(mid))) return badges;
  return [...(badges ?? []), 'forked'];
}

// The ONE row-exclusion rule, identical to aggregate()'s routing: synthetic
// (R4), billed elsewhere (R2), embedded sidechain (§3) rows contribute $0 to
// row sums — they live in their disclosed channels instead.
export function priceRowTcu(ctx, row) {
  if (row.synthetic || row.billedElsewhere || row.embeddedSidechain === true) return 0;
  const p = ctx.pricing.priceRow(row);
  return p && p.unpriced !== true && p.usd ? p.usd.total : 0;
}

// Row sums in exact integer tcu — the SAME exclusion rule as priceRowTcu
// (synthetic | billed-elsewhere | embedded-sidechain), derived from
// canonicalOf. Feeds rowsSumToHeader everywhere a header is served.
export function rowsSumTcuOf(ctx, rows, sessionId, canonicalOf) {
  let sum = 0;
  for (const row of rows ?? []) {
    if (row.synthetic || row.embeddedSidechain === true) continue;
    const contestable = !isAgentFile(row.file ?? '');
    const canon = contestable && canonicalOf ? canonicalOf.get(row.msgId) : undefined;
    if (canon !== undefined && canon !== sessionId) continue;
    if (row.billedElsewhere) continue;
    const p = ctx.pricing.priceRow(row);
    if (p && p.unpriced !== true && p.usd) sum += p.usd.total;
  }
  return sum;
}

// The same sum from a cached ledgerLite — which is what lets /api/index and
// /api/project report rowsSumToHeader without forcing a corpus parse.
export function liteRowSumTcu(ctx, card, canonicalOf) {
  const liteL = card.ledgerLite;
  if (!liteL) return null;
  let sum = rowsSumTcuOf(ctx, liteL.dupRows, card.id, canonicalOf);
  for (const bk of liteL.buckets ?? []) {
    if (!bk || bk.synthetic) continue;
    sum += bucketTcu(ctx, bk);
  }
  return sum;
}

// header-vs-rows verdict from exact integers (null = not computable — unknown)
export const sumVerdict = (headerTcu, rowTcu) => (headerTcu == null || rowTcu == null
  ? null
  : (headerTcu === rowTcu ? true : { delta: headerTcu - rowTcu }));

export function bucketPseudoRow(ctx, bk) {
  const t = bk.tokens ?? {};
  return {
    model: bk.model, speed: bk.speed ?? null, serviceTier: bk.serviceTier ?? null,
    at: ctx.ledger && typeof ctx.ledger.bucketAtMs === 'function'
      ? ctx.ledger.bucketAtMs(bk.utcDate)
      : (typeof bk.utcDate === 'string' ? Date.parse(`${bk.utcDate}T12:00:00Z`) : null),
    input: t.input || 0, output: t.output || 0, cacheRead: t.cacheRead || 0,
    cache5m: t.cache5m || 0, cache1h: t.cache1h || 0, cacheFlat: t.cacheFlat || 0,
    webSearch: bk.webSearch || 0, webFetch: bk.webFetch || 0,
    synthetic: false, billedElsewhere: null,
  };
}

export function bucketTcu(ctx, bk) {
  // exact: tcu is rateUnits x tokens summed per component, so pricing the
  // bucket's summed tokens equals the per-row sum (single rate per bucket —
  // the key carries the utcDate the R10 interval resolves on)
  if (!ctx.pricing) return 0;
  const p = ctx.pricing.priceRow(bucketPseudoRow(ctx, bk));
  return p && p.unpriced !== true && p.usd ? p.usd.total : 0;
}

// Membership predicate for one turn's billed rows. Main-thread rows partition
// by KEPT-LINE POSITION on the opener boundaries (SPEC §9: "main-thread rows
// by kept-line position") — the same rule summary.mjs uses for turn token
// sums, so turn aggs and the cached turn usage agree by construction. Agent
// rows follow their agent's recorded turn attribution (turn.agentIds).
// Details without openerLine (older cache shapes) fall back to lineRange,
// then to the turn's total time window (the disclosed fallback).
export function turnRowPredicate(detail, idx) {
  const turns = detail?.turns ?? [];
  const turn = turns[idx];
  if (!turn) return () => false;
  const agentIds = new Set(turn.agentIds ?? []);
  const openers = turns
    .filter((t) => !t.preamble && t.openerLine != null)
    .map((t) => ({ idx: t.idx, line: t.openerLine }));
  const haveOpeners = openers.length > 0 && openers.length === turns.filter((t) => !t.preamble).length;
  const turnOfLine = (line) => {
    let k = 0;
    for (const o of openers) { if (o.line <= line) k = o.idx; else break; }
    return k;
  };
  const next = turns[idx + 1];
  return (r) => {
    const f = String(r.file);
    if (isAgentFile(f)) {
      const aid = agentIdOfFile(f);
      return aid !== null && agentIds.has(aid);
    }
    if (haveOpeners && typeof r.line === 'number') return turnOfLine(r.line) === idx;
    if (turn.lineRange) return r.line >= turn.lineRange[0] && r.line <= turn.lineRange[1];
    const a = turn.at ?? -Infinity;
    const z = next?.at ?? Infinity;
    return r.at != null && r.at >= a && r.at < z;
  };
}
