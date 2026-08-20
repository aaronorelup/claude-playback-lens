// tests/web-costfigure.test.mjs — DESIGN §6: the panel reprices ONLY the rows
// it actually fetched, and says exactly what that proves.

import test from 'node:test';
import assert from 'node:assert/strict';

import { repriceCheck, formatInterval, COMPONENTS, PAGE_SIZE, HARD_CAP } from '../web/js/components/costfigure.mjs';

const priceRow = (row) => (row.model === 'no-rate'
  ? { unpriced: true }
  : { unpriced: false, usd: { input: row.input, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: row.input } });

test('paging limits are the SPEC §9 ones', () => {
  assert.equal(PAGE_SIZE, 300);
  assert.equal(HARD_CAP, 5000);
  assert.deepEqual(COMPONENTS.map((c) => c.key), ['input', 'output', 'cacheWrite', 'cacheRead', 'webSearch']);
});

test('when the page IS the whole scope, the reprice must equal the scope total', () => {
  const rows = [{ model: 'a', input: 10 }, { model: 'a', input: 15 }];
  const agg = { usd: { total: 25 } };
  const ok = repriceCheck({ rows, total: 2, agg, priceRow });
  assert.equal(ok.basis, 'scope');
  assert.equal(ok.ok, true);
  assert.equal(ok.pageTcu, 25);

  const bad = repriceCheck({ rows, total: 2, agg: { usd: { total: 26 } }, priceRow });
  assert.equal(bad.ok, false);
  assert.equal(bad.delta, -1);
});

test('a PARTIAL page asserts nothing about the header — it shows its own subtotal', () => {
  const rows = [{ model: 'a', input: 10 }];
  const res = repriceCheck({ rows, total: 29741, agg: { usd: { total: 999 } }, priceRow });
  assert.equal(res.basis, 'page');
  assert.equal(res.ok, null, 'no ✓ and no ✗ is claimed for a slice of the scope');
  assert.equal(res.pageTcu, 10);
  assert.equal(res.referenceTcu, null);
});

test('when the rows carry their own usd, the check is row by row', () => {
  const rows = [
    { model: 'a', input: 10, usd: { total: 10 } },
    { model: 'a', input: 5, usd: { total: 5 } },
  ];
  const res = repriceCheck({ rows, total: 1000, agg: { usd: { total: 12345 } }, priceRow });
  assert.equal(res.basis, 'rows');
  assert.equal(res.ok, true);
});

test('unpriced rows are counted, not silently priced at zero (R7)', () => {
  const rows = [{ model: 'a', input: 10 }, { model: 'no-rate', input: 999 }];
  const res = repriceCheck({ rows, total: 2, agg: { usd: { total: 10 } }, priceRow });
  assert.equal(res.unpriced, 1);
  assert.equal(res.pageTcu, 10, 'the unpriced row contributes nothing to the priced sum');
  assert.equal(res.ok, true);
});

test('with no pricing module every row is unpriced and nothing is invented', () => {
  const rows = [{ model: 'a', input: 10 }];
  const res = repriceCheck({ rows, total: 1, agg: { usd: { total: 10 } }, priceRow: null });
  assert.equal(res.unpriced, 1);
  assert.equal(res.pageTcu, 0);
  assert.equal(res.ok, false, 'a missing rate table fails the check loudly rather than quietly agreeing');
});

test('the R10 interval prints from whichever key shape the rate carries', () => {
  assert.equal(formatInterval({ from: '2026-06-01', to: '2026-08-31' }), 'in effect 2026-06-01..2026-08-31');
  assert.equal(formatInterval({ effectiveFrom: null, effectiveTo: '2026-08-31' }), 'in effect …..2026-08-31');
  assert.equal(formatInterval(null), null);
});
