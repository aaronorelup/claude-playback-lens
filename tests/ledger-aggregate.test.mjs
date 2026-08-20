// tests/ledger-aggregate.test.mjs — aggregate() produces the full CostAgg of
// SPEC §9 (integer tcu; disclosure channels and counters) and addCostAgg() is
// exact component-wise addition so parent = Σ children by construction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionLedger, aggregate, addCostAgg, emptyCostAgg, emptyTokens } from '../server/ledger.mjs';
import { priceRow, TCU_PER_USD } from '../shared/pricing.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const manifest = JSON.parse(readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));

function loadCase(name) {
  const c = manifest.cases[name];
  assert.ok(c, `fixture case ${name} missing — run: node tests/extract-fixtures.mjs`);
  const parts = readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8').split('\n');
  return parts.slice(0, -1).map((t, i) => ({ file: c.sourceRel, line: c.lines[i], event: JSON.parse(t) }));
}

const AT = Date.parse('2026-08-01T00:00:00.000Z');

// a minimal well-formed billed row for constructed cases
function mkRow(over = {}) {
  return {
    msgId: 'msg_constructed',
    model: 'claude-opus-5',
    input: 0,
    output: 0,
    cacheRead: 0,
    cache5m: 0,
    cache1h: 0,
    cacheFlat: 0,
    thinkingTokens: null,
    webSearch: 0,
    webFetch: 0,
    speed: 'standard',
    serviceTier: 'standard',
    stopReason: 'end_turn',
    at: AT,
    file: 'x.jsonl',
    line: 1,
    ttl: 'recorded',
    finalized: true,
    synthetic: false,
    billedElsewhere: null,
    iterIndex: null,
    ...over,
  };
}

test('CostAgg shape — every SPEC §9 field present, zeros are real zeros', () => {
  const agg = emptyCostAgg();
  assert.deepEqual(Object.keys(agg).sort(), [
    'byModel',
    'embeddedSidechain',
    'inherited',
    'neverFinalized',
    'neverFinalizedOutput', // R6 recorded stub mass (SPEC §9, integration 2026-08-17)
    'premiumUnknown',
    'requests',
    'synthetic',
    'thinking',
    'tierAssumed',
    'tokens',
    'ttlAssumed',
    'ttlDeltaTcu', // R5 exact 1h-delta mass (SPEC §9, integration 2026-08-17)
    'unpriced',
    'usd',
    'webFetchRequests', // R8 metric (ACC-18): Σ row.webFetch over billed rows
    'webSearchRequests', // R8 metric (ACC-18): Σ row.webSearch over billed rows
  ]);
  assert.deepEqual(agg.tokens, { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 });
  assert.deepEqual(agg.usd, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 });
  assert.deepEqual(agg.thinking, { tokens: 0, recordedOn: 0, notRecordedOn: 0 });
  assert.deepEqual(agg.embeddedSidechain, { requests: 0, tokens: emptyTokens() });
});

test('aggregate — real fixture rows: tokens, integer tcu usd, byModel decomposition', () => {
  const rows = buildSessionLedger([...loadCase('r1-agent-multiline'), ...loadCase('r3-fallback-00000003')]);
  assert.equal(rows.length, 3); // 1 + 2 (split)
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.requests, 3);
  // tokens sum exactly over rows
  for (const k of Object.keys(agg.tokens)) {
    assert.equal(
      agg.tokens[k],
      rows.reduce((s, r) => s + r[{ input: 'input', output: 'output', cache5m: 'cache5m', cache1h: 'cache1h', cacheFlat: 'cacheFlat', cacheRead: 'cacheRead' }[k]], 0),
      k,
    );
  }
  // usd components are integers and total is their exact sum
  for (const v of Object.values(agg.usd)) assert.ok(Number.isSafeInteger(v), 'integer tcu at source');
  assert.equal(agg.usd.total, agg.usd.input + agg.usd.output + agg.usd.cacheWrite + agg.usd.cacheRead + agg.usd.webSearch);
  // byModel decomposes billed rows; requests sum to the header
  assert.equal(Object.values(agg.byModel).reduce((s, m) => s + m.requests, 0), 3);
  assert.equal(Object.values(agg.byModel).reduce((s, m) => s + (m.usd.total ?? 0), 0), agg.usd.total);
  assert.ok(agg.byModel['claude-fable-5'], 'the refused fallback call bills under its OWN model');
  // usd cross-check against pricing on the fallback group alone
  // (fable-5 iteration: in 2, out 972, cr 328023, 1h 510 — $10/$50 sticker)
  const fallbackOnly = aggregate(buildSessionLedger(loadCase('r3-fallback-00000003')), { priceRow });
  assert.equal(fallbackOnly.byModel['claude-fable-5'].usd.total, 2 * 20000 + 972 * 100000 + 510 * 40000 + 328023 * 2000);
  assert.equal(fallbackOnly.byModel['claude-opus-5'].usd.total, 2 * 10000 + 965 * 50000 + 274832 * 1000);
});

test('aggregate — thinking is a covered fraction, never a bare scalar', () => {
  const rows = [
    mkRow({ msgId: 'm1', thinkingTokens: 100 }),
    mkRow({ msgId: 'm2', thinkingTokens: 0 }), // recorded zero IS recorded
    mkRow({ msgId: 'm3', thinkingTokens: null }), // pre-2.1.229: not recorded, never 0
  ];
  const agg = aggregate(rows, { priceRow });
  assert.deepEqual(agg.thinking, { tokens: 100, recordedOn: 2, notRecordedOn: 1 });
});

test('aggregate — R7 unpriced channel: tokens routed in parallel, usd untouched, byModel total null', () => {
  const rows = [
    mkRow({ msgId: 'm1', model: 'claude-3-opus-20240229', input: 10, output: 20, cacheRead: 30 }),
    mkRow({ msgId: 'm2', model: 'claude-opus-5', input: 5, output: 5 }),
  ];
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.requests, 2, 'unpriced rows are still billed rows');
  assert.equal(agg.tokens.input, 15, 'unpriced tokens stay in the header tokens (the channel discloses the subset)');
  assert.ok(agg.unpriced['claude-3-opus-20240229']);
  assert.equal(agg.unpriced['claude-3-opus-20240229'].requests, 1);
  assert.equal(agg.unpriced['claude-3-opus-20240229'].tokens.input, 10);
  assert.equal(agg.usd.total, 5 * 10000 + 5 * 50000, 'usd covers ONLY the priced rows — a missing rate is never $0');
  assert.equal(agg.byModel['claude-3-opus-20240229'].usd.total, null, 'null, never 0, for an all-unpriced model');
  assert.equal(agg.byModel['claude-opus-5'].usd.total, 5 * 10000 + 5 * 50000);
});

test('aggregate — R5 ttlAssumed counts rows actually billed under the 5-minute assumption', () => {
  // constructed foreign-transcript line: only the flat cache counter, no 5m/1h split
  const foreign = {
    type: 'assistant',
    uuid: 'u-foreign',
    timestamp: '2026-08-01T00:00:00.000Z',
    message: {
      id: 'msg_foreignttl',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
    },
  };
  const rows = buildSessionLedger([{ file: 'foreign.jsonl', line: 1, event: foreign }]);
  assert.equal(rows[0].ttl, 'unrecorded');
  assert.equal(rows[0].cacheFlat, 100);
  assert.equal(rows[0].cache5m, 0);
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.ttlAssumed, 1);
  assert.equal(agg.usd.cacheWrite, 100 * 12500, 'flat billed at the 5-minute rate');
  // a row with the split recorded does not count
  const agg2 = aggregate([mkRow({ cache5m: 100 })], { priceRow });
  assert.equal(agg2.ttlAssumed, 0);
});

test('aggregate — premiumUnknown: >200K input-side on a model outside the verified 1M set', () => {
  const rows = [
    // haiku-3-5 is priced but NOT in the verified long-context set
    mkRow({ msgId: 'm1', model: 'claude-3-5-haiku-20241022', cacheRead: 250000 }),
    // fable-5 IS verified: 1M window at standard rates, no premium applies
    mkRow({ msgId: 'm2', model: 'claude-fable-5', cacheRead: 800000 }),
    // haiku-3-5 under the threshold: not counted
    mkRow({ msgId: 'm3', model: 'claude-3-5-haiku-20241022', cacheRead: 200000 }),
  ];
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.premiumUnknown, 1);
  assert.ok(agg.usd.total > 0, 'premiumUnknown rows are priced at standard rates (distinct from R7)');
});

test('aggregate — tierAssumed is structurally 0: unknown tiers route to unpriced, never to a standard-rate fallback', () => {
  const rows = [mkRow({ model: 'claude-fable-5', speed: 'fast', input: 10 })];
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.tierAssumed, 0);
  assert.ok(agg.unpriced['claude-fable-5'], 'the non-standard pair is DISCLOSED as unpriced (chip names the tier)');
});

test('aggregate — R9 fast tier prices at the documented 2x rate', () => {
  const rows = [mkRow({ model: 'claude-opus-5', speed: 'fast', input: 1000000 })];
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.usd.total, 1000000 * 20000, '$10/Mtok input at speed=fast');
  assert.equal(agg.usd.total / TCU_PER_USD, 10);
  assert.deepEqual(agg.unpriced, {});
});

test('aggregate — R8 webSearch bills exactly 1 cent per request; webFetch is free', () => {
  const rows = [mkRow({ webSearch: 3, webFetch: 9 })];
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.usd.webSearch, 3 * 2e7);
  assert.equal(agg.usd.webSearch / TCU_PER_USD, 0.03);
  assert.equal(agg.usd.total, agg.usd.webSearch);
});

test('aggregate — §3 embedded sidechains: disclosed channel so session = Σ turns + channels', () => {
  const ev = {
    type: 'assistant',
    isSidechain: true,
    uuid: 'u-sc',
    timestamp: '2026-08-01T00:00:00.000Z',
    message: {
      id: 'msg_sidechain1',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 7,
        output_tokens: 11,
        cache_read_input_tokens: 13,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  };
  const rows = buildSessionLedger([{ file: 'main.jsonl', line: 3, event: ev, tier: 'main' }]);
  assert.equal(rows[0].embeddedSidechain, true);
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.requests, 0, 'excluded from turn billing');
  assert.equal(agg.usd.total, 0);
  assert.deepEqual(agg.embeddedSidechain, {
    requests: 1,
    tokens: { input: 7, output: 11, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 13 },
  });
  // the same event NOT flagged as main-tier does not route to the channel
  const rows2 = buildSessionLedger([{ file: 'agent.jsonl', line: 3, event: ev }]);
  assert.equal(rows2[0].embeddedSidechain, undefined);
});

test('addCostAgg — exact component-wise addition; parent = Σ children by construction', () => {
  const rowsA = [
    mkRow({ msgId: 'a1', input: 3, output: 5, cache5m: 7, thinkingTokens: 20, webSearch: 1 }),
    mkRow({ msgId: 'a2', model: 'claude-3-opus-20240229', input: 100 }),
    mkRow({ msgId: 'a3', synthetic: true, model: '<synthetic>' }),
  ];
  const rowsB = [
    mkRow({ msgId: 'b1', model: 'claude-sonnet-5', input: 11, output: 13, cache1h: 17, cacheRead: 19 }),
    mkRow({ msgId: 'b2', model: 'claude-3-opus-20240229', output: 50 }),
    mkRow({ msgId: 'b3', finalized: false, stopReason: null, speed: null }),
  ];
  const a = aggregate(rowsA, { priceRow });
  const b = aggregate(rowsB, { priceRow });
  const sum = addCostAgg(a, b);
  const direct = aggregate([...rowsA, ...rowsB], { priceRow });
  assert.deepEqual(sum, direct, 'addCostAgg(a, b) === aggregate(a-rows ++ b-rows) on every component');
  // purity: inputs untouched
  assert.equal(a.requests, 2);
  assert.equal(b.requests, 3);
  // spot checks
  assert.equal(sum.requests, 5);
  assert.equal(sum.synthetic, 1);
  assert.equal(sum.neverFinalized, 1);
  assert.equal(sum.unpriced['claude-3-opus-20240229'].requests, 2);
  assert.equal(sum.unpriced['claude-3-opus-20240229'].tokens.input, 100);
  assert.equal(sum.unpriced['claude-3-opus-20240229'].tokens.output, 50);
  assert.equal(sum.byModel['claude-3-opus-20240229'].usd.total, null, 'null + null stays null — never fabricates $0');
  assert.equal(sum.thinking.tokens, 20);
  assert.equal(sum.thinking.recordedOn, 1);
  assert.equal(sum.thinking.notRecordedOn, 4);
  assert.equal(sum.usd.webSearch, 2e7);
});

test('addCostAgg — identity: adding an empty CostAgg changes nothing', () => {
  const rows = buildSessionLedger(loadCase('r3-fallback-00000004'));
  const agg = aggregate(rows, { priceRow });
  assert.deepEqual(addCostAgg(agg, emptyCostAgg()), agg);
  assert.deepEqual(addCostAgg(emptyCostAgg(), agg), agg);
});

test('aggregate — full-session composition over every fixture group at once', () => {
  const all = [
    ...loadCase('r1-agent-multiline'),
    ...loadCase('r3-fallback-00000003'),
    ...loadCase('r3-fallback-00000004'),
    ...loadCase('r4-synthetic'),
    ...loadCase('r6a-never-finalized'),
    ...loadCase('r6b-empty-iterations'),
  ];
  const rows = buildSessionLedger(all);
  // groups: r1 (1) + fallback (2) + fallback (2) + synthetic (1) + nf (1) + empty-iter (1) = 8 rows
  assert.equal(rows.length, 8);
  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.requests, 7, 'synthetic excluded from requests');
  assert.equal(agg.synthetic, 1);
  assert.equal(agg.neverFinalized, 2, 'the stop-null agent group AND the empty-iterations group');
  assert.equal(agg.ttlAssumed, 0);
  assert.equal(agg.tierAssumed, 0);
  assert.deepEqual(agg.unpriced, {}, 'every real model in these fixtures is priced');
  // header requests decompose exactly across byModel
  assert.equal(Object.values(agg.byModel).reduce((s, m) => s + m.requests, 0), 7);
  assert.equal(Object.values(agg.byModel).reduce((s, m) => s + (m.usd.total ?? 0), 0), agg.usd.total);
});
