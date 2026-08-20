// server/ledger.mjs — the request ledger: assistant lines -> billed rows
// (SPEC §5: R1 keep-last, R3 iterations split, R4 synthetic, R6 finalized,
// R9 raw speed/serviceTier capture), R2 canonical resolution at index level,
// and CostAgg aggregation (SPEC §9).
//
// The ledger stores TOKENS ONLY, never dollars — cost is computed at read time
// via the injected priceRow (shared/pricing.mjs), so pricing edits never
// invalidate the cache. All accumulation is integer arithmetic.
//
// House rules: no inference — recorded fields + arithmetic on them only;
// an unknown is null, never 0; a real zero is 0.

import { modelKey, LONG_CONTEXT_COVERED } from '../shared/pricing.mjs';

const LONG_CONTEXT_SET = new Set(LONG_CONTEXT_COVERED);

// Token counters must be integers ("money is exact integer arithmetic",
// SPEC §6). A PRESENT non-integer value (fractional, string, NaN) bills 0 and
// is COUNTED as a violation so the divergence is disclosed (usage-reconcile),
// never silently coerced — mirrored by the audit's usage-integers census.
const intGate = (v, viol) => {
  if (v === undefined || v === null) return 0; // absent — a normal recorded shape
  if (Number.isInteger(v)) return v;
  if (viol) viol.count += 1;
  return 0;
};

// ---------------------------------------------------------------------------
// buildSessionLedger(assistantLines) -> BilledRow[]   (SPEC §5 shape)
//
// Input: the parse layer's assistant events for ONE session (main + agent
// files), in file order per file. Two element shapes are accepted:
//   { file, line, event }            — wrapper with the 1-based locator (preferred)
//   <raw parsed assistant event>     — optional `file`/`line` properties read off
//                                      the object itself; absent -> null locator
// An optional wrapper flag `embeddedSidechain: true` (or `tier:'main'` on the
// wrapper combined with `isSidechain:true` on the event) marks §3 foreign rows;
// aggregate() routes them to the disclosed embeddedSidechain channel.
// NO R2 here — canonicality is an index-level decision (resolveCanonical),
// derived at read time and never persisted; every row leaves here with
// billedElsewhere: null.
// ---------------------------------------------------------------------------
export function buildSessionLedger(assistantLines) {
  // R1 — group assistant lines by message.id (fallback uuid) PER FILE and keep
  // the LAST line in file order. Verified corpus-wide: last === max-output on
  // every multi-line group; all input-side counters and model are byte-identical
  // across a group's lines; only output/thinking/stop_reason progress.
  const groups = new Map(); // `${file}\u001f${msgId}` -> kept entry (last wins)
  for (const el of assistantLines ?? []) {
    if (!el || typeof el !== 'object') continue;
    const ev = el.event && typeof el.event === 'object' ? el.event : el;
    if (!ev || ev.type !== 'assistant' || !ev.message || typeof ev.message !== 'object') continue;
    // An assistant line WITHOUT a usage object is not an API response record —
    // the LEDGER skips it (it remains a parse-layer row/event), matching Path
    // B's grouping predicate exactly. Billing a zero-token phantom request
    // from a non-response would be inference (house rule 1). 0 lines here.
    if (!ev.message.usage || typeof ev.message.usage !== 'object') continue;
    const file = typeof el.file === 'string' ? el.file : null;
    const line = typeof el.line === 'number' ? el.line : null;
    const sidechain = el.embeddedSidechain === true || (el.tier === 'main' && ev.isSidechain === true);
    const msgId = ev.message.id ?? ev.uuid ?? `\u001fline-${line}`;
    groups.set(`${file}\u001f${msgId}`, { file, line, event: ev, msgId, sidechain });
  }
  const rows = [];
  const viol = { count: 0 };
  for (const kept of groups.values()) rows.push(...rowsFromKeptLine(kept, viol));
  // Disclosed via an in-process, NON-enumerable property on the returned array
  // (never persisted or serialized): callers raise a usage-reconcile Problem
  // when nonzero.
  Object.defineProperty(rows, 'usageIntViolations', { value: viol.count, enumerable: false });
  return rows;
}

function rowsFromKeptLine({ file, line, event, msgId, sidechain }, viol) {
  const msg = event.message;
  const usage = msg.usage && typeof msg.usage === 'object' ? msg.usage : {};
  const int0 = (v) => intGate(v, viol);
  const iters = usage.iterations;
  const synthetic = iters === null; // R4 — exact discriminator (28/28; usage all-zero)
  // R6 — the single finalization predicate, used everywhere. A non-null
  // stop_reason is NOT sufficient (one measured message carries end_turn
  // with an EMPTY iterations array and a stub output of 3).
  const finalized = Array.isArray(iters) && iters.length > 0;
  const parsedAt = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
  const at = Number.isFinite(parsedAt) ? parsedAt : null;
  // R9 — RAW price discriminators. null covers both recorded-null and
  // absent-as-key (billed-row shape: string|null); resolution to 'standard'
  // happens in the rate lookup, never here. The separate *Absent flags keep
  // the recorded ABSENT-vs-null distinction so Path A can reproduce the
  // audit's (speed, service_tier) pair census (SPEC §10) without reparse.
  const speed = usage.speed ?? null;
  const serviceTier = usage.service_tier ?? null;
  const speedAbsent = !Object.prototype.hasOwnProperty.call(usage, 'speed');
  const serviceTierAbsent = !Object.prototype.hasOwnProperty.call(usage, 'service_tier');
  const stopReason = msg.stop_reason ?? null;
  const thinkingTokens =
    usage.output_tokens_details && typeof usage.output_tokens_details.thinking_tokens === 'number'
      ? usage.output_tokens_details.thinking_tokens
      : null; // null = not recorded (harness < 2.1.229) — never 0
  const webSearch = int0(usage.server_tool_use?.web_search_requests);
  const webFetch = int0(usage.server_tool_use?.web_fetch_requests);
  const cc = usage.cache_creation;
  const ttlRecorded =
    !!cc &&
    typeof cc === 'object' &&
    typeof cc.ephemeral_5m_input_tokens === 'number' &&
    typeof cc.ephemeral_1h_input_tokens === 'number';
  // R5 — the 5m/1h split is recorded on 100% of lines in this corpus; a foreign
  // transcript carrying only the flat counter bills it as cacheFlat at the
  // 5-minute rate and is counted in ttlAssumed by aggregate().
  const ttl = ttlRecorded ? 'recorded' : 'unrecorded';

  const base = {
    msgId,
    at,
    file,
    line, // locator of the KEPT line, 1-based as an editor shows it
    stopReason,
    speed,
    serviceTier,
    speedAbsent,
    serviceTierAbsent,
    ttl,
    finalized,
    synthetic,
    billedElsewhere: null, // R2 is resolved at index level, at read time
  };
  if (sidechain) base.embeddedSidechain = true;

  if (finalized) {
    // R3 — iterations override: one billed row per element. Field provenance
    // (SPEC §5): token counters + model come FROM THE ELEMENT
    // (element.model ?? message.model — fallback messages carry a refused first
    // call on another model that exists nowhere else); msgId/at/file/line/
    // stopReason/ttl/speed/serviceTier are line properties copied to every row.
    // When length > 1, the line-level scalars (thinkingTokens, webSearch,
    // webFetch) attach to the FINAL element's row — the call the recorded
    // top-level usage reports — with webSearch/webFetch 0 (a real zero) and
    // thinkingTokens null (not recorded per iteration) on the other rows.
    // This override repairs the 5m+1h === flat identity corpus-wide.
    const n = iters.length;
    return iters.map((elm, i) => {
      const eCc = elm.cache_creation;
      const eSplit =
        !!eCc &&
        typeof eCc === 'object' &&
        typeof eCc.ephemeral_5m_input_tokens === 'number' &&
        typeof eCc.ephemeral_1h_input_tokens === 'number';
      const isFinal = i === n - 1;
      return {
        ...base,
        model: elm.model ?? msg.model,
        input: int0(elm.input_tokens),
        output: int0(elm.output_tokens),
        cacheRead: int0(elm.cache_read_input_tokens),
        cache5m: eSplit ? int0(eCc.ephemeral_5m_input_tokens) : 0,
        cache1h: eSplit ? int0(eCc.ephemeral_1h_input_tokens) : 0,
        cacheFlat: eSplit ? 0 : int0(elm.cache_creation_input_tokens),
        thinkingTokens: n > 1 && !isFinal ? null : thinkingTokens,
        webSearch: n > 1 && !isFinal ? 0 : webSearch,
        webFetch: n > 1 && !isFinal ? 0 : webFetch,
        iterIndex: n > 1 ? i : null, // which iterations element, when split
      };
    });
  }

  // iterations absent (streaming-only groups), empty array (R6 never-finalized
  // with a recorded stop_reason), or null (R4 synthetic, all-zero usage):
  // bill from the top-level usage fields — the recorded numbers, never estimates.
  return [
    {
      ...base,
      model: msg.model,
      input: int0(usage.input_tokens),
      output: int0(usage.output_tokens),
      cacheRead: int0(usage.cache_read_input_tokens),
      cache5m: ttlRecorded ? int0(cc.ephemeral_5m_input_tokens) : 0,
      cache1h: ttlRecorded ? int0(cc.ephemeral_1h_input_tokens) : 0,
      cacheFlat: ttlRecorded ? 0 : int0(usage.cache_creation_input_tokens),
      thinkingTokens,
      webSearch,
      webFetch,
      iterIndex: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// resolveCanonical — R2 at index level.
//
// A message.id duplicated across main files (forks/resumes copy prefix events)
// is billed once, in its canonical file:
//   (i)   the copy whose main filename equals the copy's own recorded sessionId,
//         when only one does (1 of the 7 measured pairs keeps the original
//         sessionId on its copies — and that pair TIES on clause (ii), so (i)
//         is load-bearing);
//   (ii)  else the copy in the file whose FIRST record IN FILE ORDER that
//         CARRIES a timestamp is earliest — the four untimestamped metadata
//         types (last-prompt, ai-title, custom-title, mode) are skipped, never
//         treated as 0 or NaN. Deliberately NOT the file-minimum timestamp
//         (in a resumed file the minimum is an inherited timestamp and ties);
//   (iii) on an exact tie, the lexicographically smallest relative file path —
//         a deterministic backstop, counted in the R2 ambiguity census
//         (expected 0 on this corpus).
//
// CONTRACT-DEVIATION: BUILD-CONTRACTS sketches a single parameter carrying two
// maps; implemented as two parameters. sessionMeta entries additionally accept
// an optional `foreignMsgIds` (Set/array of msgIds in that main file whose
// recorded per-event sessionId differs from the filename id) — without this
// evidence clause (i) cannot be evaluated from index data (the mainMsgIds token
// sets cannot see the sessionId recorded ON a copy); when absent, every
// candidate is treated as matching (i) and resolution falls through to (ii).
//
// sessionsMsgIds: Map<sessionId, Set<string>|string[]>  (main-tier message.ids;
//                 gap-2 §5: duplication exists ONLY between main files)
// sessionMeta:    Map<sessionId, { firstTsMs: number|null, rel: string,
//                                  foreignMsgIds?: Set<string>|string[] }>
// Returns Map<msgId, canonicalSessionId> for every msgId present in 2+ sessions
// (ids in exactly one session are canonical where they live and get no entry),
// with two extra properties: .ambiguous — [{ msgId, candidates, chose }] for
// clause-(iii) resolutions (the ambiguity census) — and .stats.byClause.
// ---------------------------------------------------------------------------
export function resolveCanonical(sessionsMsgIds, sessionMeta) {
  const msgEntries = entriesOf(sessionsMsgIds);
  const meta = new Map(entriesOf(sessionMeta ?? new Map()));
  const foreignSets = new Map(); // sessionId -> Set<msgId> (normalised)
  for (const [sid, m] of meta) {
    if (m && m.foreignMsgIds) foreignSets.set(sid, toSet(m.foreignMsgIds));
  }

  const byMsg = new Map(); // msgId -> [sessionId, ...]
  for (const [sid, ids] of msgEntries) {
    for (const id of iterOf(ids)) {
      let arr = byMsg.get(id);
      if (!arr) byMsg.set(id, (arr = []));
      if (!arr.includes(sid)) arr.push(sid);
    }
  }

  const out = new Map();
  const ambiguous = [];
  const stats = { duplicated: 0, byClause: { i: 0, ii: 0, iii: 0 } };

  for (const [msgId, sids] of byMsg) {
    if (sids.length < 2) continue;
    stats.duplicated++;

    // clause (i)
    const matchesI = sids.filter((sid) => {
      const foreign = foreignSets.get(sid);
      return !(foreign && foreign.has(msgId)); // copy's recorded sessionId == filename id
    });
    if (matchesI.length === 1) {
      out.set(msgId, matchesI[0]);
      stats.byClause.i++;
      continue;
    }

    // clause (ii) — over ALL candidates (SPEC: "when only one does; else ...")
    let best = [];
    let bestTs = Infinity;
    for (const sid of sids) {
      const m = meta.get(sid);
      const ts = m && Number.isFinite(m.firstTsMs) ? m.firstTsMs : Infinity; // no timestamped record -> never wins
      if (ts < bestTs) {
        bestTs = ts;
        best = [sid];
      } else if (ts === bestTs) {
        best.push(sid);
      }
    }
    if (best.length === 1) {
      out.set(msgId, best[0]);
      stats.byClause.ii++;
      continue;
    }

    // clause (iii) — deterministic backstop; counted as the ambiguity census
    const ranked = best
      .map((sid) => ({ sid, rel: meta.get(sid)?.rel ?? sid }))
      .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    out.set(msgId, ranked[0].sid);
    stats.byClause.iii++;
    ambiguous.push({ msgId, candidates: best.slice(), chose: ranked[0].sid });
  }

  out.ambiguous = ambiguous;
  out.stats = stats;
  return out;
}

function entriesOf(x) {
  if (!x) return [];
  if (x instanceof Map) return [...x.entries()];
  if (typeof x.entries === 'function' && !Array.isArray(x)) return [...x.entries()];
  return Object.entries(x);
}

function iterOf(x) {
  if (!x) return [];
  if (x instanceof Set || Array.isArray(x)) return x;
  if (typeof x[Symbol.iterator] === 'function' && typeof x !== 'string') return x;
  return [];
}

function toSet(x) {
  return x instanceof Set ? x : new Set(iterOf(x));
}

// ---------------------------------------------------------------------------
// CostAgg (SPEC §9) — integer tcu at source; adds component-wise so
// parent = Σ children by construction.
// ---------------------------------------------------------------------------
export function emptyTokens() {
  return { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };
}

export function emptyCostAgg() {
  return {
    requests: 0, // billed rows with synthetic === false (SPEC §5)
    tokens: emptyTokens(),
    usd: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 }, // integer tcu
    thinking: { tokens: 0, recordedOn: 0, notRecordedOn: 0 }, // covered fraction, never a bare scalar
    unpriced: {}, // R7: { [raw model]: { requests, tokens } } — never $0, never blended
    inherited: {}, // R2: { [canonicalSessionId]: { requests, tokens } } — copies billed elsewhere
    embeddedSidechain: { requests: 0, tokens: emptyTokens() }, // §3 foreign rows (0 in this corpus)
    neverFinalized: 0, // R6
    synthetic: 0, // R4
    ttlAssumed: 0, // R5
    tierAssumed: 0, // R9 — structurally 0 here: unknown tiers route to unpriced, never to a standard-rate fallback
    premiumUnknown: 0, // long-context census (rate exists and is applied; only the tier is unknown)
    neverFinalizedOutput: 0, // R6: recorded stub output-token mass on never-finalized billed rows (recorded, not an estimate)
    ttlDeltaTcu: 0, // R5: exact integer-tcu delta if 1h had applied to the ttlAssumed rows (priced rows only)
    webSearchRequests: 0, // R8 metric (like `requests`, not a disclosure counter): Σ row.webSearch over billed rows
    webFetchRequests: 0, // R8 metric: Σ row.webFetch over billed rows (webFetch is free — count only)
    byModel: {}, // { [raw model]: CostAggLite }
  };
}

const inputSide = (r) => r.input + r.cache5m + r.cache1h + r.cacheFlat + r.cacheRead;

function addRowTokens(t, r) {
  t.input += r.input;
  t.output += r.output;
  t.cache5m += r.cache5m;
  t.cache1h += r.cache1h;
  t.cacheFlat += r.cacheFlat;
  t.cacheRead += r.cacheRead;
}

function addChannel(channel, key, row) {
  let e = channel[key];
  if (!e) e = channel[key] = { requests: 0, tokens: emptyTokens() };
  e.requests++;
  addRowTokens(e.tokens, row);
}

function addLite(byModel, key, row, pricedTcuOrNull) {
  let e = byModel[key];
  if (!e) e = byModel[key] = { requests: 0, tokens: emptyTokens(), usd: { total: null } };
  e.requests++;
  addRowTokens(e.tokens, row);
  if (pricedTcuOrNull !== null) e.usd.total = (e.usd.total ?? 0) + pricedTcuOrNull;
  // a model with only unpriced rows keeps usd.total null — a missing rate is never $0
}

// aggregate(rows, { canonicalOf, sessionId, priceRow }) -> CostAgg
//
// canonicalOf — the Map from resolveCanonical() over the WHOLE loaded index;
//   a row whose msgId resolves to a different sessionId is an R2 non-canonical
//   copy: it is routed to the inherited channel (and annotated
//   billedElsewhere: { sessionId }) instead of the billed totals. The decision
//   is derived here at read time, never persisted (SPEC R2). Omitting
//   canonicalOf treats every row as canonical (single-session/test use; the
//   API layer must not serve R2-resolved figures from an incomplete index).
// priceRow — shared/pricing.mjs priceRow (injected; keeps the ledger free of a
//   direct pricing dependency for cost computation and testable in isolation).
export function aggregate(rows, { canonicalOf, sessionId, priceRow } = {}) {
  const agg = emptyCostAgg();
  for (const row of rows ?? []) {
    // R4 — synthetic bills nothing, excluded from requests and per-model groups;
    // it appears only in the synthetic counter (and renders as an event).
    if (row.synthetic) {
      agg.synthetic++;
      continue;
    }

    // §3 — embedded sidechains BEFORE the R2 gate (same routing order as the
    // audit's Path B: the row is classified foreign before billing rules
    // apply). Disclosed channel, so session = Σ turns + channels.
    if (row.embeddedSidechain === true) {
      agg.embeddedSidechain.requests++;
      addRowTokens(agg.embeddedSidechain.tokens, row);
      continue;
    }

    // R2 — derived at read time, PURE (no row writes: rows may be shared
    // cached arrays; the API layer derives billedElsewhere annotations from
    // the same canonicalOf, never from a mutation left here). Only MAIN-TIER
    // rows are contestable — SPEC R2 scopes duplication to main files (0
    // duplicates among the non-main files); a null/unknown file stays
    // contestable, matching buildLedgerLite's dupRows over-approximation.
    const contestable = !/(^|\/)subagents\//.test(String(row.file ?? ''));
    const canon = contestable && canonicalOf ? canonicalOf.get(row.msgId) : undefined;
    if (canon !== undefined && sessionId !== undefined && canon !== sessionId) {
      addChannel(agg.inherited, canon, row);
      continue;
    }

    agg.requests++;
    addRowTokens(agg.tokens, row);
    agg.webSearchRequests += row.webSearch || 0;
    agg.webFetchRequests += row.webFetch || 0;

    if (row.thinkingTokens == null) {
      agg.thinking.notRecordedOn++; // not recorded — never counted as 0
    } else {
      agg.thinking.tokens += row.thinkingTokens;
      agg.thinking.recordedOn++;
    }

    if (!row.finalized) {
      agg.neverFinalized++; // R6 (synthetic already excluded above)
      agg.neverFinalizedOutput += row.output; // the RECORDED stub mass, never an estimate
    }
    // R5 — ttlAssumed counts every billed row with cacheFlat > 0, regardless
    // of the line-level ttl tag: an R3 element without its own 5m/1h split
    // falls back to its flat counter and is billed at the 5-minute assumption
    // even when the line-level usage carried a split (hybrid rows). The
    // disclosure follows the billed mass, not the tag.
    const ttlAssumedRow = row.cacheFlat > 0;
    if (ttlAssumedRow) agg.ttlAssumed++;
    if (inputSide(row) > 200000 && !LONG_CONTEXT_SET.has(modelKey(row.model))) {
      agg.premiumUnknown++; // long-context: priced at standard rates, tier unknown — disclosed
    }

    const raw = typeof row.model === 'string' ? row.model : '(unrecorded)';
    const p = priceRow ? priceRow(row) : { unpriced: true };
    if (p.unpriced) {
      addChannel(agg.unpriced, raw, row); // R7
      addLite(agg.byModel, raw, row, null);
    } else {
      agg.usd.input += p.usd.input;
      agg.usd.output += p.usd.output;
      agg.usd.cacheWrite += p.usd.cacheWrite;
      agg.usd.cacheRead += p.usd.cacheRead;
      agg.usd.webSearch += p.usd.webSearch;
      agg.usd.total += p.usd.total;
      addLite(agg.byModel, raw, row, p.usd.total);
      if (ttlAssumedRow) {
        // R5's promised disclosure: the EXACT tcu delta if the 1-hour rate had
        // applied to the flat mass billed at 5m. Pure recorded arithmetic:
        // delta = cacheFlat x (w1hU - w5mU), computed through priceRow so the
        // resolved interval is identical. Unpriced rows carry no dollar either
        // way and add nothing (they live in the unpriced channel).
        const p1h = priceRow({ ...row, cacheFlat: 0, cache1h: row.cache1h + row.cacheFlat });
        if (!p1h.unpriced) agg.ttlDeltaTcu += p1h.usd.cacheWrite - p.usd.cacheWrite;
      }
    }
  }
  return agg;
}

// addCostAgg(a, b) — exact component-wise addition (pure; neither input is
// mutated). parent = Σ children by construction.
//
// ONE documented exception: `inheritedPending` is a disclosure FLAG, not a
// summed quantity — it OR's through, so a parent scope still discloses an
// unresolved R2 duplicate group underneath it instead of silently dropping
// the warning at the first fold. emptyCostAgg() carries no such field, and no
// money invariant is touched: nothing is added.
export function addCostAgg(a, b) {
  const out = emptyCostAgg();
  out.requests = a.requests + b.requests;
  for (const k of Object.keys(out.tokens)) out.tokens[k] = a.tokens[k] + b.tokens[k];
  for (const k of Object.keys(out.usd)) out.usd[k] = a.usd[k] + b.usd[k];
  out.thinking.tokens = a.thinking.tokens + b.thinking.tokens;
  out.thinking.recordedOn = a.thinking.recordedOn + b.thinking.recordedOn;
  out.thinking.notRecordedOn = a.thinking.notRecordedOn + b.thinking.notRecordedOn;
  mergeChannels(out.unpriced, a.unpriced, b.unpriced);
  mergeChannels(out.inherited, a.inherited, b.inherited);
  out.embeddedSidechain.requests = a.embeddedSidechain.requests + b.embeddedSidechain.requests;
  for (const k of Object.keys(out.embeddedSidechain.tokens)) {
    out.embeddedSidechain.tokens[k] = a.embeddedSidechain.tokens[k] + b.embeddedSidechain.tokens[k];
  }
  out.neverFinalized = a.neverFinalized + b.neverFinalized;
  out.synthetic = a.synthetic + b.synthetic;
  out.ttlAssumed = a.ttlAssumed + b.ttlAssumed;
  out.tierAssumed = a.tierAssumed + b.tierAssumed;
  out.premiumUnknown = a.premiumUnknown + b.premiumUnknown;
  out.neverFinalizedOutput = (a.neverFinalizedOutput ?? 0) + (b.neverFinalizedOutput ?? 0);
  out.ttlDeltaTcu = (a.ttlDeltaTcu ?? 0) + (b.ttlDeltaTcu ?? 0);
  out.webSearchRequests = (a.webSearchRequests ?? 0) + (b.webSearchRequests ?? 0);
  out.webFetchRequests = (a.webFetchRequests ?? 0) + (b.webFetchRequests ?? 0);
  for (const src of [a.byModel, b.byModel]) {
    for (const [key, lite] of Object.entries(src)) {
      let e = out.byModel[key];
      if (!e) e = out.byModel[key] = { requests: 0, tokens: emptyTokens(), usd: { total: null } };
      e.requests += lite.requests;
      for (const k of Object.keys(e.tokens)) e.tokens[k] += lite.tokens[k];
      if (lite.usd.total !== null) e.usd.total = (e.usd.total ?? 0) + lite.usd.total;
    }
  }
  if (a.inheritedPending || b.inheritedPending) out.inheritedPending = true; // disclosure flag: OR'd, never summed
  return out;
}

function mergeChannels(out, ...sources) {
  for (const src of sources) {
    for (const [key, e] of Object.entries(src)) {
      let o = out[key];
      if (!o) o = out[key] = { requests: 0, tokens: emptyTokens() };
      o.requests += e.requests;
      for (const k of Object.keys(o.tokens)) o.tokens[k] += e.tokens[k];
    }
  }
}

// ---------------------------------------------------------------------------
// aggregateLite — CostAgg from a cached SessionCard.ledgerLite (SPEC §9),
// without reparsing the session. Exactly equal to aggregate(rows, ...) over the
// same session's full ledger rows (pinned by tests/index-lite.test.mjs):
//
//   * dupRows (every MAIN-TIER row, kept individually — see summary.mjs
//     buildLedgerLite for why that is the only rule that stays correct under
//     future forks) go through aggregate() itself, so R2 resolution, the
//     inherited channel and every per-row disclosure are the same code path.
//   * buckets (agent-tier rows, tallied by (rawModel, speedRaw, serviceTierRaw,
//     utcDate, localDate, finalized, synthetic, ttl)) fold in linearly: tcu is
//     rateUnits x tokens summed per component, so pricing a bucket's summed
//     tokens at its (single, utcDate-resolved) rate equals the per-row sum
//     EXACTLY in integer tcu. A bucket's representative `at` is noon UTC of its
//     utcDate — the rate lookup keys on the UTC day (R10), so every row in the
//     bucket resolves the identical interval.
//
// Buckets never consult canonicalOf — R2 detection is duplicate message.ids
// ACROSS MAIN FILES (SPEC §5; 0 duplicates among the non-main files), so
// agent-tier rows are never contested. aggregate() now gates its R2 routing
// on the same rule (rows under subagents/ are never routed to inherited), so
// the two paths coincide STRUCTURALLY, not just empirically, even if an
// agent-file msgId ever collides with a duplicated main msgId.
// ---------------------------------------------------------------------------
export function bucketAtMs(utcDate) {
  // Any instant inside the bucket's UTC day resolves the same R10 interval.
  return typeof utcDate === 'string' ? Date.parse(`${utcDate}T12:00:00Z`) : null;
}

export function aggregateLite(ledgerLite, { canonicalOf, sessionId, priceRow } = {}) {
  const lite = ledgerLite && typeof ledgerLite === 'object' ? ledgerLite : {};
  // fresh copies: aggregate() annotates billedElsewhere and these rows live in
  // the persisted card — never mutate the cache from a read path.
  const dup = (lite.dupRows ?? []).map((r) => ({ ...r, billedElsewhere: null }));
  const agg = aggregate(dup, { canonicalOf, sessionId, priceRow });

  for (const b of lite.buckets ?? []) {
    if (!b || typeof b !== 'object') continue;
    if (b.synthetic) { agg.synthetic += b.requests; continue; } // R4 — bills nothing
    agg.requests += b.requests;
    agg.webSearchRequests += b.webSearch ?? 0;
    agg.webFetchRequests += b.webFetch ?? 0;
    for (const k of Object.keys(agg.tokens)) agg.tokens[k] += b.tokens?.[k] ?? 0;
    agg.thinking.tokens += b.thinking?.tokens ?? 0;
    agg.thinking.recordedOn += b.thinking?.recordedOn ?? 0;
    agg.thinking.notRecordedOn += b.thinking?.notRecordedOn ?? 0;
    if (!b.finalized) {
      agg.neverFinalized += b.requests;
      agg.neverFinalizedOutput += b.neverFinalizedOutput ?? 0;
    }
    const ttlAssumed = b.ttlAssumed ?? 0;
    agg.ttlAssumed += ttlAssumed;
    // premiumUnknown resolves at READ time from the pure recorded over-200K
    // count, so a pricing edit to LONG_CONTEXT_COVERED never invalidates the cache.
    if ((b.over200k ?? 0) > 0 && !LONG_CONTEXT_SET.has(modelKey(b.model))) {
      agg.premiumUnknown += b.over200k;
    }

    const raw = typeof b.model === 'string' ? b.model : '(unrecorded)';
    const pseudo = {
      model: b.model,
      speed: b.speed ?? null,
      serviceTier: b.serviceTier ?? null,
      at: bucketAtMs(b.utcDate),
      input: b.tokens?.input ?? 0,
      output: b.tokens?.output ?? 0,
      cacheRead: b.tokens?.cacheRead ?? 0,
      cache5m: b.tokens?.cache5m ?? 0,
      cache1h: b.tokens?.cache1h ?? 0,
      cacheFlat: b.tokens?.cacheFlat ?? 0,
      webSearch: b.webSearch ?? 0,
      webFetch: b.webFetch ?? 0,
    };
    const p = priceRow ? priceRow(pseudo) : { unpriced: true };
    if (p.unpriced) {
      let e = agg.unpriced[raw];
      if (!e) e = agg.unpriced[raw] = { requests: 0, tokens: emptyTokens() };
      e.requests += b.requests;
      for (const k of Object.keys(e.tokens)) e.tokens[k] += b.tokens?.[k] ?? 0;
      let m = agg.byModel[raw];
      if (!m) m = agg.byModel[raw] = { requests: 0, tokens: emptyTokens(), usd: { total: null } };
      m.requests += b.requests;
      for (const k of Object.keys(m.tokens)) m.tokens[k] += b.tokens?.[k] ?? 0;
    } else {
      agg.usd.input += p.usd.input;
      agg.usd.output += p.usd.output;
      agg.usd.cacheWrite += p.usd.cacheWrite;
      agg.usd.cacheRead += p.usd.cacheRead;
      agg.usd.webSearch += p.usd.webSearch;
      agg.usd.total += p.usd.total;
      let m = agg.byModel[raw];
      if (!m) m = agg.byModel[raw] = { requests: 0, tokens: emptyTokens(), usd: { total: null } };
      m.requests += b.requests;
      for (const k of Object.keys(m.tokens)) m.tokens[k] += b.tokens?.[k] ?? 0;
      m.usd.total = (m.usd.total ?? 0) + p.usd.total;
      if (ttlAssumed > 0 && (b.tokens?.cacheFlat ?? 0) > 0) {
        // linear in cacheFlat, so the bucket-level delta equals Σ per-row deltas
        const p1h = priceRow({ ...pseudo, cacheFlat: 0, cache1h: pseudo.cache1h + pseudo.cacheFlat });
        if (!p1h.unpriced) agg.ttlDeltaTcu += p1h.usd.cacheWrite - p.usd.cacheWrite;
      }
    }
  }
  return agg;
}
