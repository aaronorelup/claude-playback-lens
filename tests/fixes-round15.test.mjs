// tests/fixes-round15.test.mjs — named regressions for the round-15 fix pass.
//
//   R15-F1 (server/index-store.mjs — createIndexWriter().schedule())
//       schedule() computed its setTimeout delay as
//         Math.max(0, lastWriteAt + minIntervalMs - Date.now())
//       — WALL clock on both sides. setTimeout then counts that delay down
//       against libuv's own monotonic loop clock, and the delay is FIXED at
//       creation. So if the wall clock stepped BACKWARD between one write and
//       the next update (an NTP or manual step correction, or an RTC fix on
//       resume from sleep — DST and timezone changes do NOT move Date.now(),
//       which is UTC epoch ms and invariant under both), the computed delay
//       ballooned to the size of the jump instead of the configured floor.
//       Worse, restoring the clock afterwards did not rescue the armed timer:
//       schedule() early-returns on `if (closed || timer)`, so nothing ever
//       re-armed and the pending write stalled for the whole size of the skew.
//
//       Blast radius is the cache alone — SPEC §9 classifies a cache write
//       failure as `affects: 'nothing'` (keep serving from memory), and the
//       default worker path re-converges anyway because every schedule()-arming
//       call in indexer.worker.mjs sits inside build(), which ends in
//       writer.flush(). The unmitigated path is the no-worker fallback
//       (lens.mjs:606), which never flushes. Either way the arithmetic has no
//       legitimate dependence on wall time, so the fix measures the interval on
//       process.hrtime.bigint() and keeps stats.lastWriteAt wall-clock for
//       display.
//
// Date.now is faked ONLY inside this test process and only for the length of
// each case; elapsed time is always measured on the REAL clock, so a stalled
// write cannot pass by accident. The module under test is imported unmodified.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createIndexWriter, loadIndex } from '../server/index-store.mjs';

let TMP;
let n = 0;

const REAL_NOW = Date.now.bind(Date);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Offset in ms ADDED to the real wall clock. Negative = a backward jump. */
let fakeOffset = 0;

before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r15-'));
  Date.now = () => REAL_NOW() + fakeOffset;
});
after(async () => {
  Date.now = REAL_NOW;
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const freshDir = async () => {
  const d = path.join(TMP, `d${n++}`);
  await fsp.mkdir(d, { recursive: true });
  return d;
};

/** Poll the writer's own stats on the REAL clock until it has done `want` writes. */
async function waitForWrites(w, want, budgetMs) {
  const t0 = REAL_NOW();
  while (REAL_NOW() - t0 < budgetMs) {
    if (w.stats.writes >= want) return REAL_NOW() - t0;
    await sleep(20);
  }
  return null;
}

describe('R15-F1 — a backward wall-clock jump must not stall the debounced writer', () => {
  test('a 1h backward step does not hold the next write hostage', async () => {
    const dir = await freshDir();
    const w = createIndexWriter(dir, { minIntervalMs: 200 });
    try {
      w.update({ id: 'p1', fingerprint: 'f' });
      const first = await w.flush();
      assert.equal(first.ok, true);
      assert.equal(w.stats.writes, 1);

      // The wall clock steps back an hour right as the next update arrives.
      // Pre-fix the armed delay became ~3_600_000ms; the floor is 200ms.
      fakeOffset = -60 * 60 * 1000;
      w.update({ id: 'p2', fingerprint: 'f' });
      assert.equal(w.stats.pending, true, 'the update is queued, not yet written');

      const elapsed = await waitForWrites(w, 2, 4000);
      assert.notEqual(elapsed, null, 'the second write must land despite the backward jump');
      assert.ok(
        elapsed < 2000,
        `it lands on the configured floor, not on the size of the jump (took ${elapsed}ms)`,
      );
      assert.equal(w.stats.pending, false);
    } finally {
      fakeOffset = 0;
      await w.close();
    }

    const idx = await loadIndex(dir);
    assert.deepEqual(Array.from(idx.cards.keys()).sort(), ['p1', 'p2']);
  });

  test('a jump that corrects itself mid-window still lands on the floor', async () => {
    const dir = await freshDir();
    const w = createIndexWriter(dir, { minIntervalMs: 200 });
    try {
      w.update({ id: 'c1', fingerprint: 'f' });
      assert.equal((await w.flush()).ok, true);

      fakeOffset = -60 * 60 * 1000;
      w.update({ id: 'c2', fingerprint: 'f' });
      await sleep(30);
      fakeOffset = 0; // the clock finishes correcting; the armed timer is not re-armed

      const elapsed = await waitForWrites(w, 2, 4000);
      assert.notEqual(elapsed, null, 'the write lands regardless of when the clock settles');
      assert.ok(elapsed < 2000, `on the floor, not on the skew (took ${elapsed}ms)`);
    } finally {
      fakeOffset = 0;
      await w.close();
    }

    const idx = await loadIndex(dir);
    assert.deepEqual(Array.from(idx.cards.keys()).sort(), ['c1', 'c2']);
  });

  test('a forward wall-clock jump does not shorten the debounce floor either', async () => {
    const dir = await freshDir();
    const w = createIndexWriter(dir, { minIntervalMs: 400 });
    try {
      w.update({ id: 'g1', fingerprint: 'f' });
      assert.equal((await w.flush()).ok, true);
      assert.equal(w.stats.writes, 1);

      fakeOffset = 60 * 60 * 1000; // an hour forward
      w.update({ id: 'g2', fingerprint: 'f' });
      await sleep(120);
      assert.equal(w.stats.writes, 1, 'still held by the floor — the floor is real time');

      const elapsed = await waitForWrites(w, 2, 4000);
      assert.notEqual(elapsed, null);
      assert.ok(elapsed < 2000, `and lands once the real floor passes (took ${elapsed}ms)`);
    } finally {
      fakeOffset = 0;
      await w.close();
    }
  });

  test('stats.lastWriteAt is still a wall-clock epoch, not a monotonic reading', async () => {
    const dir = await freshDir();
    const w = createIndexWriter(dir, { minIntervalMs: 5 });
    try {
      assert.equal(w.stats.lastWriteAt, null, 'null before the first write');
      w.update({ id: 'w1', fingerprint: 'f' });
      await w.flush();
      const at = w.stats.lastWriteAt;
      assert.equal(typeof at, 'number');
      assert.ok(
        Math.abs(at - REAL_NOW()) < 60_000,
        'the exposed field still means "when, on the wall clock"',
      );
    } finally {
      await w.close();
    }
  });
});
