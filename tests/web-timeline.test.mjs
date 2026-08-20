// tests/web-timeline.test.mjs — DESIGN §2 geometry: linear, capped, exact.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MARK_CAP, computeBounds, makeScale, binMarks, emptyStretches, axisTicks,
  isInverted, markKind, projectPalette, PALETTE_SIZE,
} from '../web/js/components/timeline.mjs';

const T = Date.UTC(2026, 7, 17, 8, 0, 0);

test('bounds come from recorded timestamps only', () => {
  const marks = [{ at: T }, { at: T + 1000, end: T + 5000 }];
  assert.deepEqual(computeBounds(marks), { from: T, to: T + 5000 });
  assert.equal(computeBounds([]), null, 'nothing recorded means no axis, not a made-up one');
  assert.equal(computeBounds([{ at: null }]), null);

  const forced = computeBounds(marks, { from: 0, to: 10 });
  assert.deepEqual(forced, { from: 0, to: 10 }, 'an explicit axis wins');

  const single = computeBounds([{ at: T }]);
  assert.equal(single.degenerate, true, 'a single instant is padded, and says so');
});

test('the scale is LINEAR — no gap compression, ever', () => {
  const x = makeScale(0, 1000, 100);
  assert.equal(x(0), 0);
  assert.equal(x(500), 50);
  assert.equal(x(1000), 100);
  assert.equal(x.invert(50), 500);
  // linearity: equal time deltas map to equal pixel deltas anywhere on the axis
  assert.equal(x(300) - x(200), x(900) - x(800));
});

test('pixel-column binning enforces the ≤2,500-mark budget with EXACT counts', () => {
  const under = Array.from({ length: MARK_CAP }, (_, i) => ({ lane: 'a', at: T + i }));
  assert.equal(binMarks(under, { from: T, to: T + MARK_CAP, width: 800 }).binned, false);

  const over = Array.from({ length: MARK_CAP + 1 }, (_, i) => ({ lane: 'a', at: T + i }));
  const res = binMarks(over, { from: T, to: T + MARK_CAP + 1, width: 800 });
  assert.equal(res.binned, true);
  assert.ok(res.bins.length <= MARK_CAP);
  const counted = res.bins.reduce((s, b) => s + b.count, 0);
  assert.equal(counted, over.length, 'binning loses nothing — every mark is counted exactly once');
  for (const b of res.bins) assert.ok(b.from <= b.to);
});

test('binning widens columns until the cap is met even on a huge canvas', () => {
  const n = 20000;
  const marks = Array.from({ length: n }, (_, i) => ({ lane: `lane${i % 40}`, at: T + i * 10 }));
  const res = binMarks(marks, { from: T, to: T + n * 10, width: 4000, cap: 500 });
  assert.equal(res.binned, true);
  assert.ok(res.bins.length <= 500, `expected ≤500 bins, got ${res.bins.length}`);
  assert.equal(res.bins.reduce((s, b) => s + b.count, 0), n);
  assert.ok(res.colWidth >= 1);
});

test('bins are per lane — two lanes never merge into one block', () => {
  const marks = [];
  for (let i = 0; i < 30; i++) { marks.push({ lane: 'a', at: T + i }); marks.push({ lane: 'b', at: T + i }); }
  const res = binMarks(marks, { from: T, to: T + 30, width: 10, cap: 10 });
  const lanes = new Set(res.bins.map((b) => b.lane));
  assert.deepEqual([...lanes].sort(), ['a', 'b']);
});

test('in-view empty stretches ≥20% of the width are reported for labelling', () => {
  const from = 0, to = 1000;
  const marks = [{ at: 0 }, { at: 950 }];
  const gaps = emptyStretches(marks, { from, to });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, 0);
  assert.equal(gaps[0].to, 950);
  assert.equal(gaps[0].ms, 950);

  // a dense axis reports nothing
  const dense = Array.from({ length: 20 }, (_, i) => ({ at: i * 50 }));
  assert.deepEqual(emptyStretches(dense, { from, to }), []);
});

test('a trailing empty stretch is reported too', () => {
  const gaps = emptyStretches([{ at: 0, end: 100 }], { from: 0, to: 1000 });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, 100);
  assert.equal(gaps[0].to, 1000);
});

test('axis ticks are produced on a local-time grid and stay bounded', () => {
  const ticks = axisTicks(T, T + 6 * 3600000, 900);
  assert.ok(ticks.length > 0 && ticks.length < 200);
  for (const t of ticks) {
    assert.ok(t.at >= T && t.at <= T + 6 * 3600000);
    assert.equal(typeof t.label, 'string');
  }
  const dayTicks = axisTicks(T, T + 30 * 86400000, 900);
  assert.ok(dayTicks.some((t) => t.major), 'a month-wide axis marks day boundaries');
});

test('end < start is a recorded contradiction: ⚠ tick, never a repaired span', () => {
  const bad = { at: T + 1000, end: T };
  assert.equal(isInverted(bad), true);
  assert.equal(markKind(bad), 'inverted');
  assert.equal(markKind({ at: T, end: T + 1 }), 'span');
  assert.equal(markKind({ at: T }), 'tick');
  assert.equal(markKind({ at: T, end: T }), 'tick', 'zero width is a tick — no invented width');
});

test('project palette: 12 stable hues then grey overflow', () => {
  const slugs = Array.from({ length: 15 }, (_, i) => `p${i}`);
  const map = projectPalette(slugs);
  assert.equal(map.get('p0'), 'var(--lens-p1)');
  assert.equal(map.get('p11'), `var(--lens-p${PALETTE_SIZE})`);
  assert.equal(map.get('p12'), 'var(--lens-p-overflow)');
  assert.equal(map.get('p14'), 'var(--lens-p-overflow)');
});
