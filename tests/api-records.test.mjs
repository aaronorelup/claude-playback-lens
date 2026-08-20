// /api/records: scope narrowing, paging (default 300, cap 5000),
// server-computed rowsSumToHeader in integer tcu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildCtx, startServer, getJson, SLUG, S1, S2, A1 } from './fixtures/api/helpers.mjs';

let ctx, srv;
before(async () => { ctx = await buildCtx(); srv = await startServer(ctx); });
after(async () => { await srv.close(); });

test('store scope: all rows, rowsSumToHeader true, inherited copy excluded from sums', async () => {
  const r = await getJson(`${srv.url}/api/records?scope=store`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 11); // 6 S1 rows + 5 S2 rows (incl. synthetic + inherited copy)
  assert.equal(r.body.scope, 'store');
  assert.equal(r.body.rowsSumToHeader, true);
  // the S2 copy of msg_AAA is marked billedElsewhere via index-level R2
  const copy = r.body.rows.find((x) => x.msgId === 'msg_AAA' && x.sessionId === S2);
  assert.ok(copy, 'S2 copy present as a display row');
  assert.deepEqual(copy.billedElsewhere, { sessionId: S1 });
  const canonical = r.body.rows.find((x) => x.msgId === 'msg_AAA' && x.sessionId === S1);
  assert.equal(canonical.billedElsewhere, null);
});

test('session / turn / agent scopes narrow correctly', async () => {
  let r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S1}`);
  assert.equal(r.body.total, 6);
  r = await getJson(`${srv.url}/api/records?scope=turn:${SLUG}/${S1}/1`);
  assert.equal(r.body.total, 6); // 4 main rows in lineRange + FFF + GGG via agentIds
  r = await getJson(`${srv.url}/api/records?scope=turn:${SLUG}/${S1}/99`);
  assert.equal(r.status, 404);
  r = await getJson(`${srv.url}/api/records?scope=agent:${SLUG}/${S1}/${A1}`);
  assert.equal(r.body.total, 1);
  assert.equal(r.body.rows[0].msgId, 'msg_FFF');
  r = await getJson(`${srv.url}/api/records?scope=agent:${SLUG}/${S1}/main`);
  assert.equal(r.body.total, 4); // AAA, synthetic, CCC, DDD
});

test('paging: default 300, hard cap 5000, from offsets', async () => {
  // swell S2 to 700 hand-made rows
  const bigRows = Array.from({ length: 700 }, (_, i) => ({
    msgId: `msg_big_${i}`, model: 'claude-fable-5', input: 1, output: 1,
    cacheRead: 0, cache5m: 0, cache1h: 0, cacheFlat: 0,
    thinkingTokens: null, webSearch: 0, webFetch: 0,
    speed: 'standard', serviceTier: 'standard', stopReason: 'end_turn',
    at: Date.parse('2026-08-01T12:00:00Z') + i * 1000,
    file: `${S2}.jsonl`, line: i + 1, ttl: 'recorded',
    finalized: true, synthetic: false, billedElsewhere: null, iterIndex: 0,
  }));
  ctx._internals.rowsBySession.set(`${SLUG}/${S2}`, bigRows);
  ctx._internals.bumpVersion();
  try {
    let r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S2}`);
    assert.equal(r.body.total, 700);
    assert.equal(r.body.count, 300); // default page size
    assert.equal(r.body.rows.length, 300);
    assert.equal(r.body.rowsSumToHeader, true);
    r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S2}&from=650`);
    assert.equal(r.body.count, 50);
    assert.equal(r.body.rows[0].msgId, 'msg_big_650');
    r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S2}&count=9999`);
    assert.equal(r.body.rows.length, 700); // clamped cap 5000 covers all 700
    r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S2}&count=0`);
    assert.equal(r.status, 400); // count below minimum rejects
  } finally {
    const { fixtureRows } = await import('./fixtures/api/helpers.mjs');
    ctx._internals.rowsBySession.set(`${SLUG}/${S2}`, fixtureRows().s2);
    ctx._internals.bumpVersion();
  }
});

test('records echo integer-tcu arithmetic that a client can reprice', async () => {
  const r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S1}`);
  const { pricing } = await import('./fixtures/api/helpers.mjs');
  let sum = 0;
  for (const row of r.body.rows) {
    if (row.synthetic || row.billedElsewhere) continue;
    const p = pricing.priceRow(row);
    if (p.unpriced !== true) sum += p.usd.total;
  }
  // hand-computed S1 total (see make-store.mjs): 58,400,000 tcu
  assert.equal(sum, 58_400_000);
});
