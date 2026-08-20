// tests/store-lru.test.mjs — parsed-session LRU (SPEC §9).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLru, defaultSizeOf } from '../server/lru.mjs';

const one = () => 1;

describe('createLru', () => {
  test('the key carries the fingerprint, so a changed session misses naturally', () => {
    const lru = createLru({ sizeOf: one });
    const k1 = lru.key('proj-a', 'sess-1', 'fp-old');
    const k2 = lru.key('proj-a', 'sess-1', 'fp-new');
    assert.equal(k1, 'proj-a/sess-1@fp-old');
    assert.notEqual(k1, k2);

    lru.set(k1, { parsed: 'old' });
    assert.equal(lru.get(k2), undefined, 'a re-fingerprinted session is simply a miss');
    assert.deepEqual(lru.get(k1), { parsed: 'old' });

    // No invalidate() call anywhere: the stale entry just ages out.
    lru.set(k2, { parsed: 'new' });
    assert.equal(lru.size, 2);
  });

  test('evicts least-recently-used when the entry budget binds', () => {
    const lru = createLru({ maxEntries: 3, maxBytes: 1e9, sizeOf: one });
    for (const k of ['a', 'b', 'c']) lru.set(k, k);
    lru.get('a'); // a becomes most recent → b is now the oldest
    lru.set('d', 'd');

    assert.equal(lru.size, 3);
    assert.deepEqual(lru.keys(), ['c', 'a', 'd'], 'b evicted, order is LRU→MRU');
    assert.equal(lru.get('b'), undefined);
    assert.equal(lru.stats.evictedByEntries, 1);
    assert.equal(lru.stats.evictedByBytes, 0);
  });

  test('evicts when the byte budget binds even though the entry count is fine', () => {
    const lru = createLru({ maxEntries: 100, maxBytes: 300, sizeOf: (v) => v.n });
    lru.set('a', { n: 100 });
    lru.set('b', { n: 100 });
    lru.set('c', { n: 100 });
    assert.equal(lru.size, 3);
    assert.equal(lru.bytes, 300);

    lru.set('d', { n: 100 });
    assert.deepEqual(lru.keys(), ['b', 'c', 'd']);
    assert.equal(lru.bytes, 300);
    assert.equal(lru.stats.evictedByBytes, 1);
    assert.equal(lru.stats.evictedByEntries, 0);
  });

  test('both limits can bind in the same set()', () => {
    const lru = createLru({ maxEntries: 3, maxBytes: 120, sizeOf: (v) => v.n });
    lru.set('a', { n: 50 });
    lru.set('b', { n: 50 });
    lru.set('c', { n: 50 }); // entries ok (3), bytes 150 > 120 → a goes
    assert.deepEqual(lru.keys(), ['b', 'c']);
    lru.set('d', { n: 10 });
    lru.set('e', { n: 10 }); // entries 4 > 3 → b goes
    assert.deepEqual(lru.keys(), ['c', 'd', 'e']);
    assert.equal(lru.bytes, 70);
  });

  test('re-setting a key replaces its byte charge rather than double-counting', () => {
    const lru = createLru({ maxEntries: 8, maxBytes: 1e9, sizeOf: (v) => v.n });
    lru.set('a', { n: 100 });
    lru.set('a', { n: 10 });
    assert.equal(lru.size, 1);
    assert.equal(lru.bytes, 10);
  });

  test('the default budget is 8 entries / 96 MB', () => {
    const lru = createLru();
    assert.deepEqual(lru.limits, { maxEntries: 8, maxBytes: 96e6 });
  });

  test('an oversized single entry is kept rather than evicting itself', () => {
    const lru = createLru({ maxEntries: 8, maxBytes: 100, sizeOf: (v) => v.n });
    lru.set('huge', { n: 5000 });
    assert.deepEqual(lru.get('huge'), { n: 5000 }, 'set() then get() must not return undefined');
    assert.equal(lru.size, 1);
  });

  test('onEvict reports the binding limit', () => {
    const seen = [];
    const lru = createLru({ maxEntries: 1, maxBytes: 1e9, sizeOf: one, onEvict: (k, v, r) => seen.push([k, r]) });
    lru.set('a', 1);
    lru.set('b', 2);
    assert.deepEqual(seen, [['a', 'entries']]);
  });

  test('delete and clear keep the byte total honest', () => {
    const lru = createLru({ sizeOf: (v) => v.n });
    lru.set('a', { n: 40 });
    lru.set('b', { n: 60 });
    assert.equal(lru.delete('a'), true);
    assert.equal(lru.delete('a'), false);
    assert.equal(lru.bytes, 60);
    lru.clear();
    assert.equal(lru.bytes, 0);
    assert.equal(lru.size, 0);
  });

  test('peek does not change recency', () => {
    const lru = createLru({ maxEntries: 2, sizeOf: one });
    lru.set('a', 1);
    lru.set('b', 2);
    lru.peek('a');
    lru.set('c', 3);
    assert.equal(lru.has('a'), false, 'peek left a as the oldest');
  });
});

describe('defaultSizeOf (SPEC §9 proxy)', () => {
  test('Σ(head.length)×2 + rows×120 + offsetTableBytes', () => {
    const session = {
      main: { rows: [{ head: 'abcde' }, { head: 'xy' }] }, // 7 chars
      agents: [{ rows: [{ head: 'zzz' }] }], // 3 chars
      offsetTableBytes: 14000,
    };
    // heads 10 → 20 ; rows 3 → 360 ; + 14000
    assert.equal(defaultSizeOf(session), 20 + 360 + 14000);
  });

  test('counts retained typed-array offset tables', () => {
    const session = {
      rows: [{ head: '' }],
      offsetTables: new Map([['main.jsonl', { offsets: new BigUint64Array(100) }]]),
    };
    assert.equal(defaultSizeOf(session), 120 + 800);
  });

  test('an explicit sizeBytes wins, and nothing ever measures as free', () => {
    assert.equal(defaultSizeOf({ sizeBytes: 4242 }), 4242);
    assert.equal(defaultSizeOf({}), 1);
    assert.equal(defaultSizeOf(null), 1);
  });
});
