// tests/index-lite.test.mjs — integration seams (2026-08-17):
//   1. SPEC §9 ledgerLite: aggregateLite(buildLedgerLite(rows)) is EXACTLY
//      aggregate(rows) on real-corpus fixture rows, including a fork pair
//      resolved through resolveCanonical (R2 at read time from cached tallies).
//   2. CostAgg's new recorded masses: neverFinalizedOutput (R6 stub mass) and
//      ttlDeltaTcu (R5's promised exact 1h delta) — pure recorded arithmetic.
//   3. addCostAgg carries both masses component-wise.
//   4. summarise() puts ledgerLite + R2 evidence + turnBars + the SessionDetail
//      additions (turns[].kinds, markers, images, filesLedger) on its payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSessionLedger, aggregate, aggregateLite, addCostAgg, resolveCanonical, emptyCostAgg,
} from '../server/ledger.mjs';
import { buildLedgerLite, summarise } from '../server/summary.mjs';
import { priceRow } from '../shared/pricing.mjs';
import { scanStore, groupSessions, fingerprint } from '../server/scan.mjs';
import { parseSession } from '../server/parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const manifest = JSON.parse(readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));

function loadCase(name, fileOverride) {
  const c = manifest.cases[name];
  assert.ok(c, `fixture case ${name} missing — run: node tests/extract-fixtures.mjs`);
  const texts = readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8').split('\n').slice(0, -1);
  return texts.map((t, i) => ({ file: fileOverride ?? c.sourceRel, line: c.lines[i], event: JSON.parse(t) }));
}

const sidOfRel = (rel) => path.basename(rel, '.jsonl');

// two fork-pair sessions, production-shaped: each session's rows come from its
// OWN main file plus (for A) agent-tier transcripts and a synthetic line.
function buildSessions() {
  const aMain = loadCase('r2a-proja-00000001');
  const cMain = loadCase('r2a-proja-00000002');
  const relA = aMain[0].file;
  const relC = cMain[0].file;
  const sidA = sidOfRel(relA);
  const sidC = sidOfRel(relC);
  const linesA = [
    ...aMain,
    ...loadCase('r4-synthetic', relA), // synthetic lines live in main files
    ...loadCase('r1-agent-multiline'), // agent tier (subagents/... sourceRel)
    ...loadCase('r6a-never-finalized'), // agent tier, R6 stubs
  ];
  const rowsA = buildSessionLedger(linesA);
  const rowsC = buildSessionLedger(cMain);

  const mainMsgIds = new Map([
    [sidA, rowsA.filter((r) => r.file === relA).map((r) => r.msgId)],
    [sidC, rowsC.filter((r) => r.file === relC).map((r) => r.msgId)],
  ]);
  const meta = new Map();
  for (const [sid, rel, lines] of [[sidA, relA, aMain], [sidC, relC, cMain]]) {
    let firstTsMs = null;
    const foreign = new Set();
    for (const l of lines) {
      const t = typeof l.event.timestamp === 'string' ? Date.parse(l.event.timestamp) : NaN;
      if (firstTsMs === null && Number.isFinite(t)) firstTsMs = t;
      if (l.event.type === 'assistant' && l.event.message?.id
        && typeof l.event.sessionId === 'string' && l.event.sessionId !== sid) {
        foreign.add(l.event.message.id);
      }
    }
    meta.set(sid, { firstTsMs, rel, foreignMsgIds: foreign });
  }
  const canonicalOf = resolveCanonical(mainMsgIds, meta);
  return { sidA, sidC, relA, relC, rowsA, rowsC, canonicalOf };
}

test('ledgerLite: aggregateLite === aggregate on real fixture rows, fork pair included', () => {
  const { sidA, sidC, relA, relC, rowsA, rowsC, canonicalOf } = buildSessions();
  assert.ok(canonicalOf.size >= 1, 'the proj-a pair is a real duplicate group');

  for (const [sid, rel, rows] of [[sidA, relA, rowsA], [sidC, relC, rowsC]]) {
    const lite = buildLedgerLite(rows, rel);
    const fromLite = aggregateLite(lite, { canonicalOf, sessionId: sid, priceRow });
    const fromRows = aggregate(rows.map((r) => ({ ...r })), { canonicalOf, sessionId: sid, priceRow });
    assert.deepEqual(fromLite, fromRows, `session ${sid}: lite and full aggregation must be identical`);
  }
});

test('ledgerLite: main-tier rows are kept individually (dupRows), agent tier is bucketed', () => {
  const { relA, rowsA } = buildSessions();
  const lite = buildLedgerLite(rowsA, relA);
  const mainRows = rowsA.filter((r) => r.file === relA);
  assert.equal(lite.dupRows.length, mainRows.length, 'every main-tier row is individually retained');
  const bucketRequests = lite.buckets.reduce((n, b) => n + b.requests, 0);
  assert.equal(bucketRequests, rowsA.length - mainRows.length, 'agent-tier rows are tallied in buckets');
  for (const b of lite.buckets) {
    assert.ok(typeof b.utcDate === 'string' || b.utcDate === null, 'bucket keeps the rate-resolution date');
    assert.ok(typeof b.localDate === 'string' || b.localDate === null, 'bucket keeps the host-local day (dayBands)');
  }
});

test('R6 mass: aggregate() reports the RECORDED stub output on never-finalized rows', () => {
  const rows = buildSessionLedger(loadCase('r6a-never-finalized'));
  const agg = aggregate(rows, { priceRow });
  assert.ok(agg.neverFinalized > 0, 'fixture is a never-finalized group');
  const recorded = rows.filter((r) => !r.finalized && !r.synthetic).reduce((n, r) => n + r.output, 0);
  assert.equal(agg.neverFinalizedOutput, recorded, 'the mass is the recorded stub sum, nothing estimated');
  assert.ok(recorded > 0);
});

test('R5 mass: ttlDeltaTcu is the exact 1h-vs-5m delta on flat-billed rows', () => {
  // hand row (the corpus records the split on 100% of lines — R5 exposure 0):
  // fable-5 inputU 20000 -> w5m 25000, w1h 40000; 1000 flat tokens.
  const row = {
    msgId: 'msg_ttl', model: 'claude-fable-5', at: Date.parse('2026-08-01T00:00:00Z'),
    file: 'x/subagents/agent-a0000000000000001.jsonl', line: 1,
    input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0, cacheFlat: 1000,
    thinkingTokens: null, webSearch: 0, webFetch: 0,
    speed: null, serviceTier: null, stopReason: 'end_turn',
    ttl: 'unrecorded', finalized: true, synthetic: false, billedElsewhere: null, iterIndex: null,
  };
  const agg = aggregate([{ ...row }], { priceRow });
  assert.equal(agg.ttlAssumed, 1);
  assert.equal(agg.ttlDeltaTcu, 1000 * (40000 - 25000)); // 15,000,000 tcu = $0.0075
  // and identically through the bucketed path
  const lite = buildLedgerLite([{ ...row }], 'x/main.jsonl');
  const liteAgg = aggregateLite(lite, { priceRow });
  assert.equal(liteAgg.ttlAssumed, 1);
  assert.equal(liteAgg.ttlDeltaTcu, agg.ttlDeltaTcu);
  assert.deepEqual(liteAgg, agg);
});

test('addCostAgg carries both masses; identity with emptyCostAgg holds', () => {
  const rows = buildSessionLedger(loadCase('r6a-never-finalized'));
  const agg = aggregate(rows, { priceRow });
  const sum = addCostAgg(agg, agg);
  assert.equal(sum.neverFinalizedOutput, 2 * agg.neverFinalizedOutput);
  assert.equal(sum.ttlDeltaTcu, 2 * agg.ttlDeltaTcu);
  assert.deepEqual(addCostAgg(agg, emptyCostAgg()), agg);
});

test('summarise(): the card carries ledgerLite + R2 evidence + turnBars; the detail its new lists', async () => {
  const STORE = path.join(FIX, 'reader', 'store');
  const SID = '11111111-1111-4111-8111-111111111111';
  const grouped = groupSessions(await scanStore(STORE));
  const s = grouped.sessions.find((x) => x.id === SID);
  const model = await parseSession(s, { projectsDir: STORE });
  const rows = buildSessionLedger(model.assistantLines);
  const files = s.files.map((rel) => ({ rel, size: 1, mtimeMs: 1 })).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const { card, detail } = summarise(model, rows, fingerprint(files));

  // SPEC §9 SessionCard additions
  assert.ok(card.ledgerLite && Array.isArray(card.ledgerLite.buckets) && Array.isArray(card.ledgerLite.dupRows));
  assert.equal(typeof card.r2FirstTsMs, 'number', 'first FILE-ORDERED timestamped record');
  assert.ok(Array.isArray(card.foreignMsgIds));
  assert.equal(card.lostAgents, 0, 'census, expected 0 on the fixture');
  assert.equal(typeof card.lastPromptCount, 'number');
  assert.equal(card.mainRel, model.main.rel);
  assert.equal(card.turnBars.length, card.turnCount, 'one bar per real turn rides the card');
  for (const b of card.turnBars) assert.ok(b.idx >= 1 && (b.at === null || typeof b.at === 'number'));

  // exactness: the cached tallies re-aggregate to the full-rows figure
  const fromLite = aggregateLite(card.ledgerLite, { sessionId: SID, priceRow });
  const fromRows = aggregate(rows.map((r) => ({ ...r })), { sessionId: SID, priceRow });
  assert.deepEqual(fromLite, fromRows);

  // SPEC §9 SessionDetail additions
  assert.ok(Array.isArray(detail.markers));
  assert.ok(Array.isArray(detail.images));
  assert.ok(Array.isArray(detail.filesLedger));
  for (const t of detail.turns) {
    assert.ok(t.kinds && typeof t.kinds === 'object', 'row-kind counts for the composition bar');
    if (!t.preamble) assert.equal(typeof t.openerLine, 'number');
  }
  const kindSum = detail.turns.reduce((n, t) => n + Object.values(t.kinds).reduce((x, v) => x + v, 0), 0);
  assert.equal(kindSum, model.main.rows.length, 'turn kinds partition the main rows exactly');
  for (const im of detail.images) {
    assert.ok(['content', 'tool_result', 'toolUseResult'].includes(im.source));
    assert.ok(im.bytes === null || typeof im.bytes === 'number', 'unknown byte size is null, never 0');
  }
});
