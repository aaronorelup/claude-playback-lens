// tests/web-chips.test.mjs — DESIGN §1 disclosure chips: exactly one per
// CostAgg counter, every one citing its R-number, none when zero.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChips, KNOWN_COUNTERS } from '../web/js/components/chips.mjs';
import { setPricingModule } from '../web/js/format.mjs';

setPricingModule(null);

const zeroTokens = { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };

const clean = {
  requests: 1000,
  tokens: zeroTokens,
  usd: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 },
  unpriced: {}, inherited: {}, embeddedSidechain: { requests: 0, tokens: zeroTokens },
  neverFinalized: 0, synthetic: 0, ttlAssumed: 0, tierAssumed: 0, premiumUnknown: 0,
  byModel: {},
};

test('a clean scope discloses nothing — silence means zero, not unknown', () => {
  assert.deepEqual(buildChips(clean), []);
  assert.deepEqual(buildChips(null), []);
  assert.deepEqual(buildChips(undefined), []);
});

test('R2 inherited: one chip per canonical session, with the excluded mass', () => {
  const agg = Object.assign({}, clean, {
    inherited: { '0000000b1234': { requests: 250, tokens: Object.assign({}, zeroTokens, { input: 400, output: 600 }) } },
  });
  const chips = buildChips(agg);
  assert.equal(chips.length, 1);
  assert.match(chips[0].text, /^↷ 250 events inherited from 0000000b — billed there; 1,000 tokens excluded here · R2$/);
  assert.equal(chips[0].rule, 'R2');
});

test('R2 pending: while the index builds, the channel says so and shows no figure', () => {
  const chips = buildChips(Object.assign({}, clean, { inheritedPending: true }));
  assert.equal(chips.length, 1);
  assert.match(chips[0].text, /not yet resolved/);
  assert.match(chips[0].text, /· R2$/);
});

test('R4 synthetic wording is exact', () => {
  const chips = buildChips(Object.assign({}, clean, { synthetic: 28 }));
  assert.equal(chips[0].text, 'synthetic 28 — API-error events, zero usage, excluded from billing · R4');
});

test('R5 ttlAssumed prints the 1h delta when the server gives it, — when it does not', () => {
  const agg = Object.assign({}, clean, { ttlAssumed: 12 });
  assert.equal(buildChips(agg)[0].text, 'ttl assumed on 12 rows (±— if 1h) · R5');
  assert.match(buildChips(agg)[0].title, /not estimated here/);

  const withDelta = buildChips(agg, { masses: { ttlDeltaTcu: 2e9 } });
  assert.equal(withDelta[0].text, 'ttl assumed on 12 rows (±$1.0000 if 1h) · R5');
});

test('R6 never-finalized states the recorded stub mass and refuses to estimate', () => {
  const agg = Object.assign({}, clean, { neverFinalized: 1584, requests: 29741 });
  const noMass = buildChips(agg)[0];
  assert.match(noMass.text, /^≈ 1,584 of 29,741 responses stopped mid-stream/);
  assert.match(noMass.text, /output recorded on them is a stub, not a final count/);
  assert.match(noMass.text, /\(— output tokens recorded; the shortfall is not measurable and never estimated\) · R6$/);

  const withMass = buildChips(agg, { masses: { neverFinalizedOutput: 11747 } })[0];
  assert.match(withMass.text, /\(11,747 output tokens recorded;/);
});

test('R7 unpriced: one chip per model, tokens counted, never $0', () => {
  const agg = Object.assign({}, clean, {
    unpriced: {
      'claude-3-opus-20240229': { requests: 4, tokens: Object.assign({}, zeroTokens, { input: 100, output: 50 }) },
      'claude-3-5-sonnet-20241022': { requests: 1, tokens: Object.assign({}, zeroTokens, { input: 7 }) },
    },
  });
  const chips = buildChips(agg);
  assert.equal(chips.length, 2);
  assert.equal(chips[0].text, '+⚠ 4 requests on a model with no rate — 150 tokens not priced · R7');
  assert.match(chips[0].title, /claude-3-opus-20240229/);
  assert.equal(chips[0].tone, 'error');
});

test('R9 tier, long-context premium and embedded sidechain wording', () => {
  assert.equal(buildChips(Object.assign({}, clean, { tierAssumed: 3 }))[0].text, 'tier assumed on 3 rows · R9');
  assert.equal(buildChips(Object.assign({}, clean, { premiumUnknown: 7 }))[0].text,
    '>200K on an unverified-tier model: 7 rows · SPEC §5 premiumUnknown');
  assert.equal(buildChips(Object.assign({}, clean, { embeddedSidechain: { requests: 5, tokens: zeroTokens } }))[0].text,
    'embedded sidechain: 5 foreign rows · SPEC §3');
});

test('every chip cites a rule and every counter this app knows has one', () => {
  const agg = Object.assign({}, clean, {
    inherited: { s1: { requests: 1, tokens: zeroTokens } },
    unpriced: { m: { requests: 1, tokens: zeroTokens } },
    synthetic: 1, ttlAssumed: 1, neverFinalized: 1, tierAssumed: 1, premiumUnknown: 1,
    embeddedSidechain: { requests: 1, tokens: zeroTokens },
  });
  const chips = buildChips(agg);
  // 8 nonzero counters in this fixture → 8 chips. (KNOWN_COUNTERS also lists
  // the Lite-agg summed counters, which this full-shape fixture does not carry.)
  assert.equal(chips.length, 8, 'exactly one chip per nonzero counter');
  for (const c of chips) {
    assert.ok(c.rule, `chip ${c.key} does not cite a rule`);
    assert.match(c.text, /· (R\d|SPEC §\d)/, `chip ${c.key} does not print its rule`);
    assert.ok(['note', 'warn', 'error'].includes(c.tone));
  }
});

test('drift rule: a CostAgg counter with no chip still surfaces, loudly', () => {
  const chips = buildChips(Object.assign({}, clean, { quantumAssumed: 4 }));
  assert.equal(chips.length, 1);
  assert.match(chips[0].text, /this counter has no chip yet · SPEC §9 drift rule/);
  assert.equal(chips[0].tone, 'error');
});

test('links are optional; a chip without a builder renders unlinked', () => {
  const agg = Object.assign({}, clean, { inherited: { sid1: { requests: 2, tokens: zeroTokens } } });
  assert.equal(buildChips(agg)[0].href, null);
  assert.equal(buildChips(agg, { links: { session: (s) => `#/s/${s}` } })[0].href, '#/s/sid1');
});
