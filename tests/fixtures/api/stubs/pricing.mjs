// Test stub for shared/pricing.mjs (group A) — documented signatures only.
// Group D codes against BUILD-CONTRACTS; this stub exists so group D tests
// run before group A lands. Rate units: 1/20 cent per Mtok (SPEC §6), so
// unitsPerMtok = USD_per_Mtok * 2000 and tcu = units * tokens; USD = tcu/2e9.

export const PRICING_VERSION = 'test-2026-08-17';
export const TCU_PER_USD = 2e9;

// $10/$50 fable-5; $1/$5 haiku-4-5
export const RATES = {
  'fable-5': [{ from: null, to: null, inputU: 20000, outputU: 100000 }],
  'haiku-4-5': [{ from: null, to: null, inputU: 2000, outputU: 10000 }],
};

export function modelKey(raw) {
  let k = String(raw ?? '');
  if (k.startsWith('claude-')) k = k.slice('claude-'.length);
  k = k.replace(/\[1m\]$/, '');
  k = k.replace(/-\d{8}$/, '');
  const m = /^3(?:-(\d))?-(haiku|sonnet|opus)$/.exec(k);
  if (m) k = m[1] ? `${m[2]}-3-${m[1]}` : `${m[2]}-3`;
  return k;
}

export function resolveRate({ key, speed, serviceTier, atMs }) {
  void atMs;
  const sp = speed == null ? 'standard' : String(speed);
  const st = serviceTier == null ? 'standard' : String(serviceTier);
  if (sp !== 'standard' || st !== 'standard') return null; // stub: no tier rows
  const list = RATES[key];
  if (!list || !list.length) return null;
  const r = list[0];
  return {
    inputU: r.inputU, outputU: r.outputU,
    w5mU: (r.inputU * 5) / 4, w1hU: r.inputU * 2, readU: r.inputU / 10,
    interval: { from: r.from, to: r.to }, tier: 'standard',
  };
}

const WEB_SEARCH_TCU = 2e7; // $0.01/request exactly

export function priceRow(row) {
  const rate = resolveRate({
    key: modelKey(row.model), speed: row.speed, serviceTier: row.serviceTier, atMs: row.at,
  });
  if (!rate) return { unpriced: true };
  const usd = {
    input: row.input * rate.inputU,
    output: row.output * rate.outputU,
    cacheWrite: row.cache5m * rate.w5mU + row.cache1h * rate.w1hU + row.cacheFlat * rate.w5mU,
    cacheRead: row.cacheRead * rate.readU,
    webSearch: (row.webSearch | 0) * WEB_SEARCH_TCU,
  };
  usd.total = usd.input + usd.output + usd.cacheWrite + usd.cacheRead + usd.webSearch;
  return { usd, unpriced: false };
}

export function formatUsd(tcu) {
  if (tcu === 0) return '0';
  const usd = tcu / TCU_PER_USD;
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(4)}`;
}

export function assertRateTable() { /* stub: all rates integral by construction */ }
