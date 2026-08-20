// tests/web-vtable.test.mjs — DESIGN §4, one table behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_SIZE, isNumeric, isFilterable, cellValue,
  filterRows, sortRows, nextSort, groupRows, sumColumns, pageSlice,
} from '../web/js/components/vtable.mjs';

const columns = [
  { key: 'title', label: 'title', type: 'text' },
  { key: 'slug', label: 'project', type: 'text', groupable: true },
  { key: 'turns', label: 'turns', type: 'num', sum: true },
  { key: 'cost', label: 'cost', type: 'money', sum: true },
];

const rows = [
  { title: 'Alpha run', slug: 'blog', turns: 3, cost: 2e9 },
  { title: 'beta run', slug: 'lens', turns: 10, cost: 4e9 },
  { title: 'Gamma', slug: 'blog', turns: 1, cost: 1e9 },
  { title: 'delta', slug: 'lens', turns: null, cost: 0 },
];

test('numeric vs text columns are classified for alignment, sums and filtering', () => {
  assert.equal(isNumeric(columns[2]), true);
  assert.equal(isNumeric(columns[0]), false);
  assert.equal(isFilterable(columns[0]), true);
  assert.equal(isFilterable(columns[2]), false, 'the filter is on TEXT columns only');
  assert.equal(cellValue(rows[0], columns[0]), 'Alpha run');
  assert.equal(cellValue(rows[0], { key: 'x', value: (r) => r.turns * 2 }), 6);
});

test('substring filter is case-insensitive and touches text columns only', () => {
  assert.equal(filterRows(rows, columns, 'run').length, 2);
  assert.equal(filterRows(rows, columns, 'RUN').length, 2);
  assert.equal(filterRows(rows, columns, 'blog').length, 2);
  assert.equal(filterRows(rows, columns, '10').length, 0, 'a numeric column is not searched');
  assert.equal(filterRows(rows, columns, '').length, rows.length);
});

test('sorting is stable, and unknowns sort last in BOTH directions', () => {
  const asc = sortRows(rows, columns, [{ key: 'turns', dir: 'asc' }]);
  assert.deepEqual(asc.map((r) => r.turns), [1, 3, 10, null]);
  const desc = sortRows(rows, columns, [{ key: 'turns', dir: 'desc' }]);
  assert.deepEqual(desc.map((r) => r.turns), [10, 3, 1, null]);

  // stability: equal keys keep file order
  const tied = [{ k: 1, id: 'a' }, { k: 1, id: 'b' }, { k: 1, id: 'c' }];
  const cols = [{ key: 'k', type: 'num' }];
  assert.deepEqual(sortRows(tied, cols, [{ key: 'k', dir: 'asc' }]).map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(sortRows(tied, cols, [{ key: 'k', dir: 'desc' }]).map((r) => r.id), ['a', 'b', 'c']);
});

test('a secondary key breaks ties in the primary', () => {
  const sorted = sortRows(rows, columns, [{ key: 'slug', dir: 'asc' }, { key: 'turns', dir: 'desc' }]);
  assert.deepEqual(sorted.map((r) => r.title), ['Alpha run', 'Gamma', 'beta run', 'delta']);
});

test('click-sort flips the primary; shift-click appends a secondary', () => {
  let sort = nextSort([], 'turns', false);
  assert.deepEqual(sort, [{ key: 'turns', dir: 'asc' }]);
  sort = nextSort(sort, 'turns', false);
  assert.deepEqual(sort, [{ key: 'turns', dir: 'desc' }]);
  sort = nextSort(sort, 'cost', false);
  assert.deepEqual(sort, [{ key: 'cost', dir: 'asc' }], 'a plain click REPLACES the sort');
  sort = nextSort(sort, 'turns', true);
  assert.deepEqual(sort, [{ key: 'cost', dir: 'asc' }, { key: 'turns', dir: 'asc' }]);
  sort = nextSort(sort, 'turns', true);
  assert.deepEqual(sort, [{ key: 'cost', dir: 'asc' }, { key: 'turns', dir: 'desc' }]);
});

test('group-by keeps the sorted order inside groups and names an unknown key', () => {
  const groups = groupRows(rows, 'slug');
  assert.deepEqual(groups.map((g) => g.key), ['blog', 'lens']);
  assert.deepEqual(groups[0].rows.map((r) => r.title), ['Alpha run', 'Gamma']);

  const withGap = groupRows([{ slug: 'a' }, { slug: null }], 'slug');
  const unknown = withGap.find((g) => g.unknown);
  assert.ok(unknown, 'rows with no recorded value form their own, labelled group');

  assert.equal(groupRows(rows, null).length, 1);
});

test('column sums are exact, and one unknown makes the column sum unknown', () => {
  const sums = sumColumns(rows, columns);
  assert.equal(sums.cost, 7e9);
  assert.equal(sums.turns, null, 'a null turn count poisons the column sum — it is never treated as 0');
  assert.equal(sums.title, undefined, 'only sum:true columns are totalled');

  const complete = rows.filter((r) => r.turns !== null);
  assert.equal(sumColumns(complete, columns).turns, 14);
});

test('paging is 300 rows by default, no infinite scroll', () => {
  assert.equal(PAGE_SIZE, 300);
  const many = Array.from({ length: 750 }, (_, i) => ({ i }));
  const p0 = pageSlice(many, { index: 0 });
  assert.equal(p0.rows.length, 300);
  assert.equal(p0.from, 0);
  assert.equal(p0.total, 750);
  const p2 = pageSlice(many, { index: 2 });
  assert.equal(p2.from, 600);
  assert.equal(p2.rows.length, 150);
});
