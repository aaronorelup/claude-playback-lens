// tests/web-format.test.mjs — the house rules, as assertions.
// Pattern for every web-*.test.mjs: pure logic only, no DOM, no server.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNKNOWN, isKnown, formatInt, formatTokens, formatUsd, formatUsdLocal, formatRate,
  formatDuration, formatBytes, formatPercent, formatOf, pluralize, truncate,
  formatLocalDate, formatClock, formatLocalTime, formatMonth, formatUtc, tzLabel,
  sumOrUnknown, tokenCategories, tokensTotal, addTokens, setPricingModule,
} from '../web/js/format.mjs';

test('house rule 3: unknown is — and a real zero is 0, never the same glyph', () => {
  assert.equal(formatUsd(null), UNKNOWN);
  assert.equal(formatUsd(undefined), UNKNOWN);
  assert.equal(formatUsd(0), '0');
  assert.notEqual(formatUsd(0), formatUsd(null));

  assert.equal(formatInt(null), UNKNOWN);
  assert.equal(formatInt(0), '0');
  assert.equal(formatTokens(null), UNKNOWN);
  assert.equal(formatTokens(0), '0');
  assert.equal(formatDuration(null), UNKNOWN);
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatBytes(null), UNKNOWN);
  assert.equal(formatBytes(0), '0 B');
});

test('money: SPEC §6 display rule (4dp, exact zero, sub-threshold)', () => {
  assert.equal(formatUsd(2e9), '$1.0000');                 // TCU_PER_USD = 2e9
  assert.equal(formatUsd(2e9 * 1234.5), '$1234.5000');     // no separators — matches shared/pricing.mjs byte for byte
  assert.equal(formatUsd(2e5), '$0.0001');                 // exactly the threshold
  assert.equal(formatUsd(1e5), '<$0.0001');                // nonzero, below it
  assert.equal(formatUsd(1), '<$0.0001');
  assert.equal(formatUsd(0), '0');
  assert.equal(formatUsd(-2e9), '-$1.0000');
});

test('the local money fallback is byte-identical to shared/pricing.mjs', async () => {
  const pricing = await import('../shared/pricing.mjs');
  const cases = [0, 1, 99999, 1e5, 2e5, 2e9, 2e9 * 1234.5, 3, 123456789, -2e9, -1];
  for (const tcu of cases) {
    assert.equal(formatUsdLocal(tcu, pricing.TCU_PER_USD), pricing.formatUsd(tcu),
      `formatUsd disagreement at tcu=${tcu} — money must render identically before and after the rate table loads`);
  }
});

test('money delegates to shared/pricing.mjs once it is loaded', () => {
  const calls = [];
  setPricingModule({ TCU_PER_USD: 2e9, formatUsd: (tcu) => { calls.push(tcu); return 'FROM-PRICING'; } });
  assert.equal(formatUsd(12345), 'FROM-PRICING');
  assert.deepEqual(calls, [12345]);
  // null is still handled locally — the pricing module never sees an unknown
  assert.equal(formatUsd(null), UNKNOWN);
  setPricingModule(null);
  assert.equal(formatUsd(2e9), '$1.0000');
});

test('formatUsdLocal honours an alternative tcu scale', () => {
  assert.equal(formatUsdLocal(1000, 1000), '$1.0000');
});

test('rate units are 1/20 cent per Mtok (haiku-3 = 500 units = $0.25/M)', () => {
  assert.equal(formatRate(500), '$0.25/M');
  assert.equal(formatRate(10000), '$5.00/M');
  assert.equal(formatRate(100000), '$50.00/M');
  assert.equal(formatRate(null), UNKNOWN);
});

test('durations read like DESIGN §2 ("no events for 2h 14m")', () => {
  assert.equal(formatDuration(2 * 3600000 + 14 * 60000), '2h 14m');
  assert.equal(formatDuration(3600000), '1h');
  assert.equal(formatDuration(90000), '1m 30s');
  assert.equal(formatDuration(3400), '3.4s');
  assert.equal(formatDuration(812), '812ms');
  assert.equal(formatDuration(2 * 86400000 + 3 * 3600000), '2d 3h');
});

test('bytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(38 * 1024 * 1024), '38 MB');
});

test('denominators: N of M, percents, plurals', () => {
  assert.equal(formatOf(61, 85), '61 of 85');
  assert.equal(formatOf(61, 85, { unit: 'sessions' }), '61 of 85 sessions');
  assert.equal(formatOf(null, 85), UNKNOWN);
  assert.equal(formatPercent(936, 1000), '93.6%');
  assert.equal(formatPercent(1, 0), UNKNOWN);
  assert.equal(pluralize(1, 'session'), '1 session');
  assert.equal(pluralize(0, 'session'), '0 sessions');
  assert.equal(truncate('abcdef', 4), 'abc…');
});

test('local time formatting is local, and the recorded UTC stays available', () => {
  const ms = Date.UTC(2026, 7, 17, 12, 0, 0);
  assert.match(formatLocalDate(ms), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(formatClock(ms), /^\d{2}:\d{2}:\d{2}$/);
  assert.match(formatLocalTime(ms), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(formatMonth(ms), /^[A-Z][a-z]{2} 2026$/);
  assert.equal(formatUtc(ms), '2026-08-17T12:00:00.000Z');
  assert.match(tzLabel(ms), /^\(UTC[+−]\d+(:\d{2})?\)$/);
  assert.equal(formatLocalTime(null), UNKNOWN);
});

test('an unknown poisons a sum — it is never silently treated as zero', () => {
  assert.equal(sumOrUnknown(1, 2, 3), 6);
  assert.equal(sumOrUnknown(1, null, 3), null);
  assert.equal(sumOrUnknown(0, 0), 0);
});

test('the four token categories never collapse', () => {
  const tokens = { input: 10, output: 20, cache5m: 3, cache1h: 4, cacheFlat: 0, cacheRead: 100 };
  const cats = tokenCategories(tokens);
  assert.equal(cats.input, 10);
  assert.equal(cats.output, 20);
  assert.equal(cats.cacheWrite, 7);      // 5m + 1h + flat
  assert.equal(cats.cache5m, 3);
  assert.equal(cats.cache1h, 4);
  assert.equal(cats.cacheRead, 100);
  assert.equal(tokensTotal(tokens), 137);

  const missing = tokenCategories({ input: 10, output: 20, cache5m: null, cache1h: 4, cacheRead: 1 });
  assert.equal(missing.cacheWrite, null, 'a missing cache figure is unknown, not zero');
});

test('addTokens keeps every category separate and propagates unknowns', () => {
  const a = { input: 1, output: 2, cache5m: 3, cache1h: 4, cacheFlat: 5, cacheRead: 6 };
  const b = { input: 1, output: 1, cache5m: 1, cache1h: 1, cacheFlat: 1, cacheRead: 1 };
  assert.deepEqual(addTokens(a, b), { input: 2, output: 3, cache5m: 4, cache1h: 5, cacheFlat: 6, cacheRead: 7 });
  assert.equal(addTokens(a, { input: null }).input, null);
});

test('isKnown treats NaN as unknown', () => {
  assert.equal(isKnown(NaN), false);
  assert.equal(isKnown(0), true);
  assert.equal(isKnown(''), true);
});
