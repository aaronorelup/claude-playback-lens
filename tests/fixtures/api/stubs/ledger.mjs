// Test stub for server/ledger.mjs (group A) — documented signatures only.
// aggregate/addCostAgg/resolveCanonical shaped per BUILD-CONTRACTS.

function zeroTokens() {
  return { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };
}

export function buildSessionLedger() {
  throw new Error('stub: not used by group D tests');
}

// R2 (i, ii, iii) over Map<sessionId, msgIds[]> + Map<sessionId, {firstTsMs, rel}>
export function resolveCanonical(sessionsMsgIds, tsRel) {
  const bySession = new Map(); // msgId -> [sessionId]
  for (const [sid, ids] of sessionsMsgIds) {
    for (const id of ids ?? []) {
      let l = bySession.get(id);
      if (!l) bySession.set(id, l = []);
      l.push(sid);
    }
  }
  const map = new Map();
  const ambiguous = [];
  for (const [msgId, sids] of bySession) {
    if (sids.length < 2) continue;
    const sorted = [...sids].sort((a, b) => {
      const ta = tsRel.get(a)?.firstTsMs ?? Infinity;
      const tb = tsRel.get(b)?.firstTsMs ?? Infinity;
      if (ta !== tb) return ta - tb;
      const ra = tsRel.get(a)?.rel ?? a, rb = tsRel.get(b)?.rel ?? b;
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    map.set(msgId, sorted[0]);
  }
  map.ambiguous = ambiguous;
  return map;
}

export function aggregate(rows, { canonicalOf, sessionId, priceRow }) {
  const agg = {
    requests: 0,
    tokens: zeroTokens(),
    usd: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 },
    thinking: { tokens: 0, recordedOn: 0, notRecordedOn: 0 },
    unpriced: {},
    inherited: {},
    embeddedSidechain: { requests: 0, tokens: zeroTokens() },
    neverFinalized: 0, synthetic: 0, ttlAssumed: 0,
    tierAssumed: 0, premiumUnknown: 0,
    byModel: {},
  };
  for (const row of rows) {
    if (row.synthetic) { agg.synthetic += 1; continue; }
    if (row.embeddedSidechain === true) { // §3 foreign rows — disclosed channel (before the R2 gate)
      agg.embeddedSidechain.requests += 1;
      agg.embeddedSidechain.tokens.input += row.input;
      agg.embeddedSidechain.tokens.output += row.output;
      continue;
    }
    const own = row.sessionId ?? sessionId;
    const canon = canonicalOf ? canonicalOf.get(row.msgId) : undefined;
    const inherited = row.billedElsewhere != null || (canon !== undefined && own != null && canon !== own);
    if (inherited) {
      const key = row.billedElsewhere?.sessionId ?? canon ?? '(other)';
      const t = agg.inherited[key] ?? (agg.inherited[key] = { requests: 0, tokens: zeroTokens() });
      t.requests += 1;
      t.tokens.input += row.input; t.tokens.output += row.output;
      continue;
    }
    agg.requests += 1;
    if (!row.finalized) agg.neverFinalized += 1;
    if (row.ttl === 'unrecorded') agg.ttlAssumed += 1;
    if (row.thinkingTokens != null) { agg.thinking.tokens += row.thinkingTokens; agg.thinking.recordedOn += 1; }
    else agg.thinking.notRecordedOn += 1;
    const p = priceRow(row);
    if (p && p.unpriced !== true && p.usd) {
      agg.tokens.input += row.input; agg.tokens.output += row.output;
      agg.tokens.cache5m += row.cache5m; agg.tokens.cache1h += row.cache1h;
      agg.tokens.cacheFlat += row.cacheFlat; agg.tokens.cacheRead += row.cacheRead;
      agg.usd.input += p.usd.input; agg.usd.output += p.usd.output;
      agg.usd.cacheWrite += p.usd.cacheWrite; agg.usd.cacheRead += p.usd.cacheRead;
      agg.usd.webSearch += p.usd.webSearch; agg.usd.total += p.usd.total;
    } else {
      const key = String(row.model ?? '(none)');
      const t = agg.unpriced[key] ?? (agg.unpriced[key] = { requests: 0, tokens: zeroTokens() });
      t.requests += 1;
      t.tokens.input += row.input; t.tokens.output += row.output;
    }
  }
  return agg;
}

export function addCostAgg(a, b) {
  const out = JSON.parse(JSON.stringify(a));
  out.requests += b.requests;
  for (const k of Object.keys(out.tokens)) out.tokens[k] += b.tokens[k];
  for (const k of Object.keys(out.usd)) out.usd[k] += b.usd[k];
  out.neverFinalized += b.neverFinalized; out.synthetic += b.synthetic;
  out.ttlAssumed += b.ttlAssumed;
  return out;
}
