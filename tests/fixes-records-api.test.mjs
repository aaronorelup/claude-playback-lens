// Round-1 fix regressions — API layer (ACC-1, ACC-2, ACC-9, ACC-12, addendum
// a/b/c/e1, COR-18 boot pairing is in api-envelope).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildCtx, startServer, getJson, fixtureRows, SLUG, S1, S2, A1 } from './fixtures/api/helpers.mjs';

let ctx, srv;
before(async () => { ctx = await buildCtx(); srv = await startServer(ctx); });
after(async () => { await srv.close(); });

const T = (s) => Date.parse(`2026-08-01T${s}.000Z`);

test('ACC-1 — /api/records rowsSumToHeader is TRUE at store scope and BOTH fork-half session scopes', async () => {
  // the fixture store carries a real duplicated msgId (msg_AAA in S1+S2, canonical S1)
  let r = await getJson(`${srv.url}/api/records?scope=store`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rowsSumToHeader, true, 'store scope: canonical fork copies stay in the header');
  r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S1}`);
  assert.equal(r.body.rowsSumToHeader, true, 'canonical side');
  r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S2}`);
  assert.equal(r.body.rowsSumToHeader, true, 'inherited side');
  const copy = r.body.rows.find((x) => x.msgId === 'msg_AAA');
  assert.deepEqual(copy.billedElsewhere, { sessionId: S1 }, 'derived purely from canonicalOf');
  r = await getJson(`${srv.url}/api/records?scope=turn:${SLUG}/${S1}/1`);
  assert.equal(r.body.rowsSumToHeader, true, 'turn scope inside the forked session');
});

test('ACC-12 — an embeddedSidechain row contributes $0 to rowSum and stays out of dayBands money', async () => {
  const rows = fixtureRows();
  const sidechainRow = {
    ...rows.s2[1], msgId: 'msg_side', line: 9, embeddedSidechain: true, webSearch: 0,
  };
  ctx._internals.rowsBySession.set(`${SLUG}/${S2}`, [...rows.s2, sidechainRow]);
  ctx._internals.bumpVersion();
  try {
    const r = await getJson(`${srv.url}/api/records?scope=session:${SLUG}/${S2}`);
    assert.equal(r.body.rowsSumToHeader, true, 'sidechain excluded identically from header and rowSum');
    const idx = await getJson(`${srv.url}/api/index`);
    const day = idx.body.dayBands.find((b) => b.localDate != null && b.usd > 0);
    assert.ok(day, 'bands still carry the priced rows');
  } finally {
    ctx._internals.rowsBySession.set(`${SLUG}/${S2}`, fixtureRows().s2);
    ctx._internals.bumpVersion();
  }
});

test('addendum e1 — records scope agent:<unknown agentId> is a 404, never a confident 200-empty', async () => {
  const r = await getJson(`${srv.url}/api/records?scope=agent:${SLUG}/${S1}/adeadbeefdeadbee1`);
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'unknown-agent');
  const ok = await getJson(`${srv.url}/api/records?scope=agent:${SLUG}/${S1}/${A1}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.total, 1);
});

test('ACC-9 — dayBands turnCount: same-day bar counts ONCE, midnight-crosser once per touched day', async () => {
  // Build LOCAL-time bars so the expectation is timezone-independent.
  const dayMs = (y, m, d, h) => new Date(y, m - 1, d, h).getTime();
  const bars = [
    { slug: SLUG, id: S1, idx: 1, at: dayMs(2026, 8, 1, 10), endedAt: dayMs(2026, 8, 1, 11) },   // same-day
    { slug: SLUG, id: S1, idx: 2, at: dayMs(2026, 8, 1, 23), endedAt: dayMs(2026, 8, 2, 1) },    // crosses midnight
    { slug: SLUG, id: S2, idx: 1, at: dayMs(2026, 8, 1, 12), endedAt: dayMs(2026, 8, 2, 13) },   // 25h
    { slug: SLUG, id: S2, idx: 2, at: dayMs(2026, 8, 1, 9), endedAt: null },                     // zero-length
  ];
  // rows on both local days so both bands exist
  const rows = fixtureRows();
  const localRow = (msgId, ms, line) => ({ ...rows.s2[1], msgId, at: ms, line, webSearch: 0 });
  ctx._internals.rowsBySession.set(`${SLUG}/${S2}`, [
    localRow('msg_d1', dayMs(2026, 8, 1, 12), 21),
    localRow('msg_d2', dayMs(2026, 8, 2, 12), 22),
  ]);
  const origBars = ctx.index.turnBars;
  ctx.index.turnBars = () => bars;
  ctx._internals.bumpVersion();
  try {
    const idx = await getJson(`${srv.url}/api/index`);
    const byDay = Object.fromEntries(idx.body.dayBands.map((b) => [b.localDate, b.turnCount]));
    // 2026-08-01: same-day(1) + crosser day1(1) + 25h day1(1) + zero-len(1) = 4
    assert.equal(byDay['2026-08-01'], 4, 'no double-count of the final day (was 2x before the fix)');
    // 2026-08-02: crosser day2(1) + 25h day2(1) = 2
    assert.equal(byDay['2026-08-02'], 2);
    // Σ turnCounts = distinct turns (4) + midnight crossings (2)
    const sum = idx.body.dayBands.reduce((n, b) => n + b.turnCount, 0);
    assert.equal(sum, 6);
  } finally {
    ctx.index.turnBars = origBars;
    ctx._internals.rowsBySession.set(`${SLUG}/${S2}`, fixtureRows().s2);
    ctx._internals.bumpVersion();
  }
});

test('addendum b — /api/turn ships the main-thread row index (rows + rowsTotal + turnCount)', async () => {
  const r = await getJson(`${srv.url}/api/turn/${SLUG}/${S1}/1`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rows), 'rows[] present');
  assert.equal(typeof r.body.rowsTotal, 'number');
  assert.equal(r.body.rows.length, r.body.rowsTotal);
  assert.equal(r.body.turnCount, 1);
  assert.ok('rowsSumToHeader' in r.body, 'footnote data at turn scope');
});

test('addendum c — rowsSumToHeader rides /api/session and /api/agent; /api/index carries lostAgents + boot', async () => {
  const s = await getJson(`${srv.url}/api/session/${SLUG}/${S1}`);
  assert.equal(s.body.rowsSumToHeader, true);
  const a = await getJson(`${srv.url}/api/agent/${SLUG}/${S1}/${A1}`);
  assert.equal(a.body.rowsSumToHeader, true);
  const idx = await getJson(`${srv.url}/api/index`);
  assert.ok('rowsSumToHeader' in idx.body, 'index-level verdict present (may be null when underivable)');
  assert.equal(typeof idx.body.lostAgents, 'number', 'a provable census, never `—`');
  assert.equal(typeof idx.body.boot, 'string');
});

test('addendum a — /api/session ships counts, not the images/filesLedger lists; the two endpoints ship them', async () => {
  // give the S1 detail an images + filesLedger payload with STORE-relative rels
  const d = ctx._internals.details.get(`${SLUG}/${S1}`);
  d.images = [
    { file: `${SLUG}/${S1}.jsonl`, line: 4, bi: '0', bytes: 100, source: 'content', mediaType: 'image/png', twin: false },
    { file: `${SLUG}/${S1}/subagents/agent-${A1}.jsonl`, line: 2, bi: 'r', bytes: null, source: 'toolUseResult', mediaType: null, twin: true },
  ];
  d.filesLedger = [{ path: 'C:/x.txt', tier: 'main', reads: 1, writes: 0, edits: 0, searches: 0, sidecar: 0 }];
  d.inventory = { filesLedgerDenominators: { mainToolCallsWithPath: 1, agentToolCallsWithPath: 0, agentResultsNoSidecar: 0 } };
  ctx._internals.bumpVersion();
  try {
    const s = await getJson(`${srv.url}/api/session/${SLUG}/${S1}`);
    assert.ok(!('images' in s.body), 'images list is NOT on the detail payload');
    assert.ok(!('filesLedger' in s.body), 'filesLedger list is NOT on the detail payload');
    assert.equal(s.body.imagesTotal, 2, 'counts stay on the detail');
    assert.equal(s.body.filesLedgerTotal, 1);

    const im = await getJson(`${srv.url}/api/session/${SLUG}/${S1}/images`);
    assert.equal(im.status, 200);
    assert.equal(im.body.total, 2);
    // SESSION-RELATIVE rels — exactly what /api/image's guard accepts
    assert.equal(im.body.images[0].file, `${S1}.jsonl`);
    assert.equal(im.body.images[1].file, `subagents/agent-${A1}.jsonl`);

    const fl = await getJson(`${srv.url}/api/session/${SLUG}/${S1}/files`);
    assert.equal(fl.status, 200);
    assert.equal(fl.body.total, 1);
    assert.equal(fl.body.filesLedger[0].path, 'C:/x.txt');
    assert.equal(fl.body.denominators.mainToolCallsWithPath, 1);
  } finally {
    delete d.images; delete d.filesLedger; delete d.inventory;
    ctx._internals.bumpVersion();
  }
});

test('ACC-2 — while building, a session in an already-detected duplicate group flags inheritedPending', async () => {
  const bctx = await buildCtx({ status: { state: 'building', sessionsDone: 2, sessionsTotal: 3, bytesIndexed: 10, bytesTotal: 100 } });
  const bsrv = await startServer(bctx);
  try {
    const r = await getJson(`${bsrv.url}/api/index`);
    assert.equal(r.body.status.r2, 'pending');
    const s1 = r.body.sessions.find((c) => c.id === S1);
    const s2 = r.body.sessions.find((c) => c.id === S2);
    assert.equal(s1.agg.inheritedPending, true, 'both halves of the visible group are provisional');
    assert.equal(s2.agg.inheritedPending, true);
  } finally { await bsrv.close(); }
});

test('addendum a — /api/index per-card agg is the Lite shape (no byModel/inherited maps); store agg stays full', async () => {
  const r = await getJson(`${srv.url}/api/index`);
  const card = r.body.sessions.find((c) => c.id === S1);
  assert.ok(card.agg, 'card carries an agg');
  assert.ok(!('byModel' in card.agg), 'maps are trimmed from card aggs');
  assert.ok(!('inherited' in card.agg));
  assert.equal(typeof card.agg.requests, 'number');
  assert.ok(card.agg.tokens && typeof card.agg.tokens.input === 'number');
  assert.equal(typeof card.agg.usd.total, 'number');
  assert.equal(typeof card.agg.synthetic, 'number', 'disclosure counters survive');
  assert.equal(typeof card.agg.inheritedRequests, 'number');
  assert.ok('tokens' in r.body.agg && 'usd' in r.body.agg, 'store agg is the full CostAgg');
});
