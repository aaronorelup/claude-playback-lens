// tests/pricing-core.test.mjs — shared/pricing.mjs: R5 R7 R8 R9 R10,
// modelKey (incl. the 3.x reorder), rate-table integrality, formatUsd.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICING_VERSION,
  TCU_PER_USD,
  WEB_SEARCH_TCU,
  RATES,
  LONG_CONTEXT_COVERED,
  modelKey,
  resolveRate,
  priceRow,
  formatUsd,
  assertRateTable,
} from '../shared/pricing.mjs';

const AT = Date.parse('2026-08-01T00:00:00.000Z'); // inside the corpus window

test('module constants (SPEC §6)', () => {
  assert.equal(PRICING_VERSION, '2026-08-17');
  assert.equal(TCU_PER_USD, 2e9);
  assert.equal(WEB_SEARCH_TCU, 2e7); // exactly 1 cent per request (R8)
});

test('assertRateTable passes and every effective rate is integral (SPEC §6 money rule)', () => {
  assert.equal(assertRateTable(), true);
  for (const [key, list] of Object.entries(RATES)) {
    for (const iv of list) {
      for (const [name, v] of [
        [`${key} input x1`, iv.inputU],
        [`${key} input x1.25`, (iv.inputU * 5) / 4],
        [`${key} input x2`, iv.inputU * 2],
        [`${key} input x0.1`, iv.inputU / 10],
        [`${key} output`, iv.outputU],
      ]) {
        assert.ok(Number.isSafeInteger(v) && v > 0, `${name} = ${v} must be a positive safe integer`);
      }
    }
  }
});

test('modelKey — the five SPEC §6 unit cases', () => {
  assert.equal(modelKey('claude-3-5-haiku-20241022'), 'haiku-3-5');
  assert.equal(modelKey('claude-3-haiku-20240307'), 'haiku-3');
  assert.equal(modelKey('claude-3-7-sonnet-20250219'), 'sonnet-3-7');
  // the two that MUST fall through to R7 unpriced (deliberately partial 3.x coverage)
  assert.equal(modelKey('claude-3-opus-20240229'), 'opus-3');
  assert.equal(modelKey('claude-3-5-sonnet-20241022'), 'sonnet-3-5');
  assert.equal(RATES['opus-3'], undefined);
  assert.equal(RATES['sonnet-3-5'], undefined);
});

test('modelKey — prefix, [1m] suffix, date suffix, corpus ids, non-strings', () => {
  assert.equal(modelKey('claude-fable-5'), 'fable-5');
  assert.equal(modelKey('claude-opus-5'), 'opus-5');
  assert.equal(modelKey('claude-opus-5[1m]'), 'opus-5'); // recorded in resolvedModel/workflowProgress (R10)
  assert.equal(modelKey('claude-sonnet-5[1m]'), 'sonnet-5');
  assert.equal(modelKey('claude-haiku-4-5-20251001'), 'haiku-4-5'); // the only dated id in the corpus
  assert.equal(modelKey('claude-opus-4-8'), 'opus-4-8');
  assert.equal(modelKey('<synthetic>'), '<synthetic>'); // untouched; no rate row -> R7
  assert.equal(modelKey('mythos-5'), 'mythos-5'); // bare alias without claude- prefix
  // anchored on the leading 3 — cannot touch 4.x+ keys
  assert.equal(modelKey('claude-sonnet-4-5'), 'sonnet-4-5');
  assert.equal(modelKey(null), null);
  assert.equal(modelKey(undefined), null);
});

test('resolveRate — standard resolution (R9: absent/null speed and tier resolve to standard)', () => {
  for (const speedTier of [
    { speed: null, serviceTier: null },
    { speed: undefined, serviceTier: undefined },
    { speed: 'standard', serviceTier: 'standard' },
    { speed: null, serviceTier: 'standard' }, // the ABSENT|standard census pair (never-finalized lines)
  ]) {
    const r = resolveRate({ key: 'opus-5', ...speedTier, atMs: AT });
    assert.ok(r, `opus-5 must resolve for ${JSON.stringify(speedTier)}`);
    assert.equal(r.inputU, 10000); // $5/Mtok
    assert.equal(r.outputU, 50000); // $25/Mtok
    assert.equal(r.tier, 'standard');
  }
});

test('resolveRate — R5 multipliers, SPEC worked example haiku-3 (500 / 625 / 1000 / 50)', () => {
  const r = resolveRate({ key: 'haiku-3', speed: null, serviceTier: null, atMs: AT });
  assert.equal(r.inputU, 500);
  assert.equal(r.w5mU, 625); // 1.25x
  assert.equal(r.w1hU, 1000); // 2x
  assert.equal(r.readU, 50); // 0.1x
  assert.equal(r.outputU, 2500);
  const h35 = resolveRate({ key: 'haiku-3-5', speed: null, serviceTier: null, atMs: AT });
  assert.deepEqual([h35.inputU, h35.w5mU, h35.w1hU, h35.readU], [1600, 2000, 3200, 160]);
});

test('resolveRate — R9 fast tier: only the documented opus-5 / opus-4-8 pair, at $10/$50', () => {
  for (const key of ['opus-5', 'opus-4-8']) {
    const r = resolveRate({ key, speed: 'fast', serviceTier: null, atMs: AT });
    assert.ok(r, `${key}@fast must resolve`);
    assert.equal(r.inputU, 20000);
    assert.equal(r.outputU, 100000);
    assert.equal(r.tier, 'fast');
  }
  // any other resolved non-standard pair routes to R7 (null), never a silent standard fallback
  assert.equal(resolveRate({ key: 'fable-5', speed: 'fast', serviceTier: null, atMs: AT }), null);
  assert.equal(resolveRate({ key: 'sonnet-5', speed: 'fast', serviceTier: null, atMs: AT }), null);
  assert.equal(resolveRate({ key: 'opus-5', speed: 'turbo', serviceTier: null, atMs: AT }), null);
  // no batch rate is pre-shipped (SPEC R9: unobserved, unverifiable in transcripts)
  assert.equal(resolveRate({ key: 'opus-5', speed: null, serviceTier: 'batch', atMs: AT }), null);
});

test('resolveRate — R10 intervals: sonnet-5 intro window boundary', () => {
  const intro = resolveRate({ key: 'sonnet-5', speed: null, serviceTier: null, atMs: Date.parse('2026-08-31T23:59:59.999Z') });
  assert.equal(intro.inputU, 4000); // $2 intro
  assert.equal(intro.outputU, 20000); // $10 intro
  assert.deepEqual(intro.interval, { from: null, to: '2026-08-31' });
  const post = resolveRate({ key: 'sonnet-5', speed: null, serviceTier: null, atMs: Date.parse('2026-09-01T00:00:00.000Z') });
  assert.equal(post.inputU, 6000); // $3
  assert.equal(post.outputU, 30000); // $15
  assert.deepEqual(post.interval, { from: '2026-09-01', to: null });
  // earliest interval is open-ended backwards: history never falls into a hole
  const ancient = resolveRate({ key: 'sonnet-5', speed: null, serviceTier: null, atMs: Date.parse('2020-01-01T00:00:00Z') });
  assert.equal(ancient.inputU, 4000);
  const future = resolveRate({ key: 'sonnet-5', speed: null, serviceTier: null, atMs: Date.parse('2030-01-01T00:00:00Z') });
  assert.equal(future.inputU, 6000);
});

test('resolveRate — unknown `at` resolves only against a single all-time interval (never guesses)', () => {
  assert.ok(resolveRate({ key: 'opus-5', speed: null, serviceTier: null, atMs: null })); // one open interval
  assert.equal(resolveRate({ key: 'sonnet-5', speed: null, serviceTier: null, atMs: null }), null); // two intervals: ambiguous
});

test('R10 — every model interval list tiles all of time (no hole for any at)', () => {
  for (const [key, list] of Object.entries(RATES)) {
    assert.equal(list[0].from, null, `${key} earliest open-ended backwards`);
    assert.equal(list[list.length - 1].to, null, `${key} latest open-ended forwards`);
    for (let i = 1; i < list.length; i++) {
      const dayAfter = new Date(Date.parse(`${list[i - 1].to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      assert.equal(list[i].from, dayAfter, `${key} contiguous at interval ${i}`);
    }
  }
});

test('priceRow — exact integer tcu arithmetic (haiku-3 exercise, R5+R8)', () => {
  const p = priceRow({
    model: 'claude-3-haiku-20240307', // -> haiku-3 (modelKey reorder in the pricing path)
    speed: null,
    serviceTier: null,
    at: AT,
    input: 1000,
    output: 2000,
    cache5m: 100,
    cache1h: 10,
    cacheFlat: 0,
    cacheRead: 100000,
    webSearch: 2,
    webFetch: 7, // free (R8) — must not appear in usd
  });
  assert.equal(p.unpriced, false);
  assert.equal(p.usd.input, 1000 * 500);
  assert.equal(p.usd.output, 2000 * 2500);
  assert.equal(p.usd.cacheWrite, 100 * 625 + 10 * 1000);
  assert.equal(p.usd.cacheRead, 100000 * 50);
  assert.equal(p.usd.webSearch, 2 * 2e7);
  assert.equal(p.usd.total, 500000 + 5000000 + 72500 + 5000000 + 40000000);
  assert.equal(p.tier, 'standard');
});

test('priceRow — R5 cacheFlat (TTL unrecorded) bills at the 5-minute rate', () => {
  const p = priceRow({
    model: 'claude-opus-5',
    speed: null,
    serviceTier: null,
    at: AT,
    input: 0,
    output: 0,
    cache5m: 0,
    cache1h: 0,
    cacheFlat: 100,
    cacheRead: 0,
    webSearch: 0,
    webFetch: 0,
  });
  assert.equal(p.usd.cacheWrite, 100 * 12500); // opus-5 w5m = 10000 * 1.25
  assert.equal(p.usd.total, 100 * 12500);
});

test('priceRow — R7: unpriced models return { unpriced: true }, never $0', () => {
  for (const model of ['claude-3-opus-20240229', 'claude-3-5-sonnet-20241022', '<synthetic>', 'some-future-model']) {
    const p = priceRow({ model, speed: null, serviceTier: null, at: AT, input: 1, output: 1, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0, webSearch: 0, webFetch: 0 });
    assert.deepEqual(p, { unpriced: true }, model);
  }
  // a priced model on an unknown tier is also unpriced (R9 -> R7), not standard-priced
  const p = priceRow({ model: 'claude-fable-5', speed: 'fast', serviceTier: null, at: AT, input: 1, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0, webSearch: 0, webFetch: 0 });
  assert.deepEqual(p, { unpriced: true });
});

test('R8 — one web-search request costs exactly 1 cent', () => {
  assert.equal(WEB_SEARCH_TCU / TCU_PER_USD, 0.01);
  assert.equal(formatUsd(WEB_SEARCH_TCU), '$0.0100');
});

test('formatUsd — SPEC §6 display rule (0 / <$0.0001 / four decimals)', () => {
  assert.equal(formatUsd(0), '0'); // a real zero renders 0, never $0.0000
  assert.equal(formatUsd(1), '<$0.0001');
  assert.equal(formatUsd(199999), '<$0.0001');
  assert.equal(formatUsd(200000), '$0.0001'); // exactly the display threshold
  assert.equal(formatUsd(250000), '$0.0001'); // display rounding only
  assert.equal(formatUsd(300000), '$0.0002');
  assert.equal(formatUsd(2e9), '$1.0000');
  assert.equal(formatUsd(2e9 * 1234.56), '$1234.5600');
  assert.equal(formatUsd(50572500), '$0.0253');
});

test('LONG_CONTEXT_COVERED — exactly the SPEC §5 verified 1M-window set', () => {
  assert.deepEqual([...LONG_CONTEXT_COVERED].sort(), ['fable-5', 'opus-4-8', 'opus-5', 'sonnet-5']);
});
