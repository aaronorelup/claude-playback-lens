// mcp/pricing-gap.mjs — which recorded models have NO rate, store-wide.
//
// The failure this exists for: a model ships after the rate table was cut
// (Fable 5.1 against a table that knows fable-5), every request on it lands in
// the unpriced channel, and a cost report that reads only the dollar column
// leaves out what can be 90% of the bill. The ledger already keeps those rows
// out of $ (never $0) and counts them; this module NAMES the models so the
// tools can put a repair instruction at the TOP of the answer, where an agent
// writing a report cannot miss it.
//
// Source: each session card's cached billed-row buckets (ledgerLite.buckets
// and dupRows) — the same rows the ledger prices — run through the SAME
// resolveRate the ledger uses, so a gap here is exactly a row that lands in
// the unpriced channel (unknown model, unshipped speed tier, or a date outside
// every interval). Synthetic rows are not billed and are skipped.

/** -> [{ model, key, sessions }] sorted by sessions desc. Empty when all rated or no index. */
export function unratedModels(ctx, pricing) {
  if (!ctx || !ctx.index || typeof ctx.index.cards !== 'function' || !pricing) return [];
  const seen = new Map();
  const memo = new Map();
  const rated = (r) => {
    const k = `${r.model}|${r.speed}|${r.serviceTier}|${r.day}`;
    if (!memo.has(k)) {
      const atMs = r.day ? Date.parse(`${r.day}T12:00:00Z`) : null;
      memo.set(k, !!pricing.resolveRate({ key: pricing.modelKey(r.model), speed: r.speed, serviceTier: r.serviceTier, atMs }));
    }
    return memo.get(k);
  };
  for (const card of ctx.index.cards().values()) {
    const lite = card && card.ledgerLite;
    if (!lite) continue;
    const rows = [
      ...(lite.buckets || []).map((b) => ({ model: b.model, speed: b.speed, serviceTier: b.serviceTier, day: b.utcDate, synthetic: b.synthetic })),
      ...(lite.dupRows || []).map((d) => ({ model: d.model, speed: d.speed, serviceTier: d.serviceTier, day: Number.isFinite(d.at) ? new Date(d.at).toISOString().slice(0, 10) : null, synthetic: d.synthetic })),
    ];
    const inCard = new Set();
    for (const r of rows) {
      if (r.synthetic || typeof r.model !== 'string' || r.model === '' || r.model === '<synthetic>') continue;
      if (rated(r)) continue;
      const tier = r.speed && r.speed !== 'standard' ? `@${r.speed}` : r.serviceTier && r.serviceTier !== 'standard' ? ` (service tier ${r.serviceTier})` : '';
      const label = `${r.model}${tier}`;
      if (inCard.has(label)) continue;
      inCard.add(label);
      const e = seen.get(label) || { model: label, key: `${pricing.modelKey(r.model)}${r.speed && r.speed !== 'standard' ? `@${r.speed}` : ''}`, sessions: 0 };
      e.sessions += 1;
      seen.set(label, e);
    }
  }
  return [...seen.values()].sort((a, b) => b.sessions - a.sessions);
}

/**
 * The block every cost-bearing answer leads with while a gap exists. Written
 * as an instruction to the agent, because the agent is the one who can close
 * the gap in the same turn.
 */
export function gapBanner(gaps) {
  if (!gaps || gaps.length === 0) return null;
  const list = gaps.map((g) => `${g.model} (${g.sessions} session${g.sessions === 1 ? '' : 's'})`).join(', ');
  return [
    `⚠ PRICING GAP — ${gaps.length} model${gaps.length === 1 ? '' : 's'} in this corpus ha${gaps.length === 1 ? 's' : 've'} NO RATE: ${list}.`,
    '  Their requests are EXCLUDED from every $ figure below (counted as "unpriced", never $0). Any dollar total is INCOMPLETE until this is fixed.',
    '  FIX NOW, before reporting: read the model\'s per-million-token input/output price from the official pricing page',
    '  (https://platform.claude.com/docs/en/about-claude/pricing), then call',
    '  lens_pricing {action:"set", model:"<id>", input_usd_per_mtok:<n>, output_usd_per_mtok:<n>, cache_read_usd_per_mtok:<n if not 10% of input>, source_url:"<page>"} and re-run this query.',
    '  If the price cannot be found, report the unpriced requests and tokens explicitly — never present the partial $ as the total.',
  ].join('\n');
}

/** One-line form for lens_status, whose render has a tight token budget. */
export function gapLine(gaps) {
  if (!gaps || gaps.length === 0) return null;
  return `⚠ pricing gap: ${gaps.map((g) => g.model).join(', ')} ha${gaps.length === 1 ? 's' : 've'} no rate — $ totals exclude them; fix: lens_pricing`;
}
