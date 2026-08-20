// shared/pricing.mjs — single source of truth for rates (SPEC §6, rules R5/R7/R8/R9/R10).
//
// Runs unmodified in BOTH Node (>=18, ESM) and the browser: no `node:` imports,
// pure data + functions. Money is exact integer arithmetic:
//
//   rate unit = 1/20 cent per Mtok  (scale 20 = lcm of the x0.1 and x5/4
//   multipliers' denominators), so $1 per Mtok = 2,000 rate units.
//   cost accumulates as integer tcu = rateUnits x tokens;  USD = tcu / 2e9;
//   one web-search request adds exactly 2e7 tcu (= 1 cent, R8).
//
// Sticker rates: https://platform.claude.com/docs/en/about-claude/pricing
// (retrieved 2026-08-17), cross-checked against the Anthropic model reference
// (sonnet-5 $2/$10 is an intro price through 2026-08-31; $3/$15 after).
// Not editable in the UI — editing is a code change, versioned below.

export const PRICING_VERSION = '2026-08-17';
export const TCU_PER_USD = 2e9;
export const WEB_SEARCH_TCU = 2e7; // $10 / 1,000 requests = exactly 1 cent/request (R8); web_fetch is free

// Interval lists (R10). Units are integers: inputU/outputU in rate units
// (1/20 cent per Mtok; $1/Mtok = 2000 units). `from`/`to` are inclusive
// 'YYYY-MM-DD' UTC dates or null (open-ended). The earliest interval of every
// model is open-ended backwards so history never falls into a hole; the latest
// is open-ended forwards. Key = modelKey, or `${modelKey}@fast` for R9 tier rows.
export const RATES = {
  // $10 / $50
  'fable-5':  [{ from: null, to: null, inputU: 20000, outputU: 100000 }],
  'mythos-5': [{ from: null, to: null, inputU: 20000, outputU: 100000 }],
  // $5 / $25
  'opus-5':   [{ from: null, to: null, inputU: 10000, outputU: 50000 }],
  'opus-4-8': [{ from: null, to: null, inputU: 10000, outputU: 50000 }],
  'opus-4-7': [{ from: null, to: null, inputU: 10000, outputU: 50000 }],
  'opus-4-6': [{ from: null, to: null, inputU: 10000, outputU: 50000 }],
  'opus-4-5': [{ from: null, to: null, inputU: 10000, outputU: 50000 }],
  // R9 research-preview fast tier, documented: $10 / $50
  'opus-5@fast':   [{ from: null, to: null, inputU: 20000, outputU: 100000 }],
  'opus-4-8@fast': [{ from: null, to: null, inputU: 20000, outputU: 100000 }],
  // legacy $15 / $75
  'opus-4-1': [{ from: null, to: null, inputU: 30000, outputU: 150000 }],
  'opus-4':   [{ from: null, to: null, inputU: 30000, outputU: 150000 }],
  // sonnet-5: $2/$10 intro interval (open-ended backwards) through 2026-08-31,
  // then $3/$15 from 2026-09-01 (open-ended forwards).
  'sonnet-5': [
    { from: null, to: '2026-08-31', inputU: 4000, outputU: 20000 },
    { from: '2026-09-01', to: null, inputU: 6000, outputU: 30000 },
  ],
  // $3 / $15
  'sonnet-4-6': [{ from: null, to: null, inputU: 6000, outputU: 30000 }],
  'sonnet-4-5': [{ from: null, to: null, inputU: 6000, outputU: 30000 }],
  'sonnet-4':   [{ from: null, to: null, inputU: 6000, outputU: 30000 }],
  'sonnet-3-7': [{ from: null, to: null, inputU: 6000, outputU: 30000 }],
  // $1 / $5
  'haiku-4-5': [{ from: null, to: null, inputU: 2000, outputU: 10000 }],
  // legacy $0.80 / $4
  'haiku-3-5': [{ from: null, to: null, inputU: 1600, outputU: 8000 }],
  // legacy $0.25 / $1.25  (inputU 500 -> read 50, 5m 625, 1h 1000 — SPEC §6 worked example)
  'haiku-3':   [{ from: null, to: null, inputU: 500, outputU: 2500 }],
  // Deliberately partial legacy 3.x coverage (R7): claude-3-opus-* (opus-3) and
  // claude-3-5-sonnet-* (sonnet-3-5) have NO rows and fall to the unpriced channel.
};

// SPEC §5 "Long context": models VERIFIED to have published pricing covering the
// full 1M-token window at standard rates — no long-context premium applies to them.
// A billed row on any model OUTSIDE this set whose measured input-side total
// exceeds 200,000 tokens is priced at standard rates and counted premiumUnknown.
export const LONG_CONTEXT_COVERED = ['fable-5', 'opus-5', 'sonnet-5', 'opus-4-8'];

// modelKey(raw) — SPEC §6 normalisation:
// strip `claude-` prefix, `[1m]` suffix, `-YYYYMMDD` date suffix; then reorder
// genuine 3.x ids, which name version before family (3-5-haiku -> haiku-3-5,
// 3-haiku -> haiku-3, 3-7-sonnet -> sonnet-3-7). Anchored on the leading `3`,
// so it cannot touch 4.x+ keys. The raw string is preserved on every billed row;
// this key is only the rate-table lookup.
export function modelKey(raw) {
  if (typeof raw !== 'string' || raw === '') return raw == null ? null : raw;
  let k = raw;
  if (k.startsWith('claude-')) k = k.slice('claude-'.length);
  if (k.endsWith('[1m]')) k = k.slice(0, -'[1m]'.length);
  k = k.replace(/-\d{8}$/, '');
  const m = /^3(?:-(\d))?-(haiku|sonnet|opus)$/.exec(k);
  if (m) k = m[1] ? `${m[2]}-3-${m[1]}` : `${m[2]}-3`;
  return k;
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function intervalFor(list, atMs) {
  if (atMs == null || !Number.isFinite(atMs)) {
    // Unknown timestamp (house rule: never guess): resolvable only when the
    // model has a single all-time interval, otherwise no rate (caller -> R7).
    return list.length === 1 && list[0].from === null && list[0].to === null ? list[0] : null;
  }
  const d = utcDay(atMs);
  for (const iv of list) {
    if ((iv.from === null || d >= iv.from) && (iv.to === null || d <= iv.to)) return iv;
  }
  return null;
}

// resolveRate — R9 + R10. `speed`/`serviceTier` are the RAW row values
// (string|null; null covers both recorded-null and absent-as-key — R9: both
// resolve to 'standard'). Returns null when no rate is shipped for the resolved
// (key, speed, serviceTier, at); the caller routes null to R7's unpriced channel
// (never $0, never a silent standard-rate fallback — which is why tierAssumed
// is structurally 0 in this implementation).
export function resolveRate({ key, speed, serviceTier, atMs }) {
  const s = speed == null ? 'standard' : speed;
  const t = serviceTier == null ? 'standard' : serviceTier;
  let lookupKey;
  let tier;
  if (s === 'standard' && t === 'standard') {
    lookupKey = key;
    tier = 'standard';
  } else if (t === 'standard') {
    lookupKey = `${key}@${s}`; // shipped tier rows: opus-5@fast, opus-4-8@fast only
    tier = s;
  } else {
    return null; // non-standard service_tier (e.g. batch): no shipped rate (SPEC R9: do NOT pre-ship)
  }
  const list = RATES[lookupKey];
  if (!list) return null;
  const iv = intervalFor(list, atMs);
  if (!iv) return null;
  return {
    inputU: iv.inputU,
    outputU: iv.outputU,
    w5mU: (iv.inputU * 5) / 4, // R5: 5-minute cache write = 1.25 x input
    w1hU: iv.inputU * 2,       // R5: 1-hour cache write   = 2    x input
    readU: iv.inputU / 10,     // R5: cache read            = 0.1  x input
    interval: { from: iv.from, to: iv.to },
    tier,
  };
}

// priceRow — billed row (SPEC §5 shape) -> integer-tcu usd components, or
// { unpriced: true } (R7). cacheFlat (TTL-unrecorded foreign transcripts) is
// billed at the 5-minute rate (R5); the ledger counts those rows in ttlAssumed.
// webFetch is free (R8) and does not appear in usd.
export function priceRow(row) {
  const rate = resolveRate({
    key: modelKey(row.model),
    speed: row.speed,
    serviceTier: row.serviceTier,
    atMs: row.at,
  });
  if (!rate) return { unpriced: true };
  const input = row.input * rate.inputU;
  const output = row.output * rate.outputU;
  const cacheWrite = row.cache5m * rate.w5mU + row.cache1h * rate.w1hU + row.cacheFlat * rate.w5mU;
  const cacheRead = row.cacheRead * rate.readU;
  const webSearch = (row.webSearch ?? 0) * WEB_SEARCH_TCU;
  return {
    usd: {
      input,
      output,
      cacheWrite,
      cacheRead,
      webSearch,
      total: input + output + cacheWrite + cacheRead + webSearch,
    },
    unpriced: false,
    interval: rate.interval, // for the cost panel's "in effect from..to" print (R10)
    tier: rate.tier,
  };
}

// formatUsd — SPEC §6 display rule (house rule 3 applied to money):
// exact zero renders '0' (a real zero, e.g. a 100%-inherited session);
// any nonzero value below $0.0001 renders '<$0.0001';
// four decimals otherwise. `—` for unknown is the CALLER's job (a missing rate
// never reaches this function as 0). All arithmetic here is integer.
export function formatUsd(tcu) {
  if (tcu === 0) return '0';
  const neg = tcu < 0;
  const abs = neg ? -tcu : tcu;
  const TCU_PER_E4 = 200000; // 2e9 / 1e4: tcu per $0.0001, exact
  // sub-threshold: a small positive is `<$0.0001`; a small NEGATIVE exceeds
  // −$0.0001, so the mathematically correct bound is `>-$0.0001` (never the
  // glyph soup `-<$0.0001`). web/js/format.mjs keeps a byte-identical copy.
  if (abs < TCU_PER_E4) return neg ? '>-$0.0001' : '<$0.0001';
  const e4 = Math.round(abs / TCU_PER_E4); // rounding happens only at display
  const whole = Math.floor(e4 / 10000);
  const frac = String(e4 % 10000).padStart(4, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

// assertRateTable — module-load proof (SPEC §6): every effective rate
// (base x1, x1.25, x2, x0.1) across ALL intervals including legacy rows is an
// integer in rate units, and every model's interval list tiles time with no
// hole or overlap. A future rate that breaks this fails loudly at import,
// not silently at runtime.
export function assertRateTable() {
  const DAY_MS = 86400000;
  for (const [key, list] of Object.entries(RATES)) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`pricing: ${key} has no intervals`);
    }
    for (let i = 0; i < list.length; i++) {
      const iv = list[i];
      const effective = {
        'input x1': iv.inputU,
        'input x1.25 (5m write)': (iv.inputU * 5) / 4,
        'input x2 (1h write)': iv.inputU * 2,
        'input x0.1 (read)': iv.inputU / 10,
        'output x1': iv.outputU,
      };
      for (const [name, v] of Object.entries(effective)) {
        if (!Number.isSafeInteger(v) || v <= 0) {
          throw new Error(`pricing: non-integral effective rate — ${key}[${i}] ${name} = ${v}`);
        }
      }
      if (i === 0 && iv.from !== null) {
        throw new Error(`pricing: ${key} earliest interval must be open-ended backwards (effectiveFrom null)`);
      }
      if (i === list.length - 1 && iv.to !== null) {
        throw new Error(`pricing: ${key} latest interval must be open-ended forwards (effectiveTo null)`);
      }
      if (i > 0) {
        const prev = list[i - 1];
        if (prev.to === null) throw new Error(`pricing: ${key}[${i - 1}] open-ended interval is not last`);
        if (iv.from === null) throw new Error(`pricing: ${key}[${i}] open-ended-backwards interval is not first`);
        const dayAfterPrev = new Date(Date.parse(`${prev.to}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
        if (iv.from !== dayAfterPrev) {
          throw new Error(`pricing: ${key} interval hole/overlap between ${prev.to} and ${iv.from}`);
        }
      }
    }
  }
  return true;
}

assertRateTable(); // runs at module load, in Node and in the browser alike
