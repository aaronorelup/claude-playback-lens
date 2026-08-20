// tests/stubs/store — stand-in for server/ledger.mjs (group A).

export function buildSessionLedger(assistantLines) {
  return (assistantLines || []).map((l, i) => ({
    idx: i,
    msgId: l && l.id ? l.id : null,
    synthetic: false,
    tokens: { input: 1, output: 1, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 },
  }));
}

export function resolveCanonical() {
  return new Map();
}

export function aggregate() {
  return {};
}

export function addCostAgg(a) {
  return a;
}
