// Round-1 fix regressions — ledger/summary routing (ACC-7, ACC-8, ACC-13,
// ACC-15, ACC-18, ACC-23, ACC-28, ACC-32) + the ledger key-separator hygiene
// (addendum e: no raw control bytes in source).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSessionLedger, aggregate, aggregateLite, addCostAgg, emptyCostAgg,
} from '../server/ledger.mjs';
import { buildLedgerLite, summarise } from '../server/summary.mjs';
import { priceRow } from '../shared/pricing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AT = Date.parse('2026-08-01T00:00:00.000Z');

const mkLine = (id, file, usage, extra = {}) => ({
  file, line: extra.line ?? 1,
  event: {
    type: 'assistant', timestamp: '2026-08-01T00:00:00.000Z', uuid: extra.uuid ?? null,
    isSidechain: extra.isSidechain === true,
    message: { id, model: extra.model ?? 'claude-opus-5', stop_reason: 'end_turn', usage },
  },
  ...(extra.tier ? { tier: extra.tier } : {}),
});
const usage1 = (over = {}) => ({
  input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  iterations: [{ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }],
  ...over,
});

test('addendum e — ledger.mjs source carries no raw control bytes (unit-separator is an escape)', () => {
  const src = readFileSync(path.join(HERE, '..', 'server', 'ledger.mjs'), 'utf8');
  let ctl = 0;
  for (const ch of src) {
    const c = ch.charCodeAt(0);
    if (c < 32 && c !== 10 && c !== 13 && c !== 9) ctl += 1;
  }
  assert.equal(ctl, 0, 'no raw NUL/US bytes in the source');
  assert.ok(src.includes('\\u001f'), 'the separator is the 6-char source escape');
});

test('ACC-7 — an agent-file msgId colliding with a duplicated main msgId is NEVER routed to inherited; full === lite', () => {
  // canonicalOf claims msg_X belongs to another session; the agent-tier row
  // must still bill here (R2 duplication is a MAIN-file phenomenon).
  const lines = [mkLine('msg_X', 'x/subagents/agent-a0000000000000001.jsonl', usage1())];
  const rows = buildSessionLedger(lines);
  const canonicalOf = new Map([['msg_X', 'OTHER-SESSION']]);
  const agg = aggregate(rows.map((r) => ({ ...r })), { canonicalOf, sessionId: 'ME', priceRow });
  assert.equal(agg.requests, 1, 'agent-tier row billed');
  assert.deepEqual(agg.inherited, {}, 'never contested');
  const lite = buildLedgerLite(rows, 'x/main.jsonl');
  const fromLite = aggregateLite(lite, { canonicalOf, sessionId: 'ME', priceRow });
  assert.deepEqual(fromLite, agg, 'lite path routes identically');
});

test('ACC-8 — hybrid R3 row (line-level split, flat-only element) counts ttlAssumed + exact 1h delta; full === lite', () => {
  const lines = [mkLine('msg_hybrid', 'x/subagents/agent-a0000000000000002.jsonl', usage1({
    cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 },
    iterations: [{ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 777 }],
  }))];
  const rows = buildSessionLedger(lines);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ttl, 'recorded', 'the ROW TAG follows the line-level usage (SPEC R3)');
  assert.equal(rows[0].cacheFlat, 777, 'the element billed its flat counter');
  const agg = aggregate(rows.map((r) => ({ ...r })), { priceRow });
  assert.equal(agg.ttlAssumed, 1, 'R5 disclosure follows the billed cacheFlat mass, not the tag');
  // opus-5: w5m 12500, w1h 20000 -> delta 7500/token
  assert.equal(agg.ttlDeltaTcu, 777 * 7500);
  const lite = buildLedgerLite(rows, 'x/main.jsonl');
  const fromLite = aggregateLite(lite, { priceRow });
  assert.deepEqual(fromLite, agg);
});

test('ACC-13 — an assistant line WITHOUT a usage object produces no billed row (matches Path B)', () => {
  const rows = buildSessionLedger([
    { file: 'a.jsonl', line: 1, event: { type: 'assistant', message: { id: 'msg_nousage', model: 'claude-opus-5' } } },
    mkLine('msg_ok', 'a.jsonl', usage1(), { line: 2 }),
  ]);
  assert.equal(rows.length, 1, 'only the real API response is a ledger row');
  assert.equal(rows[0].msgId, 'msg_ok');
});

test('ACC-15 — a present non-integer token counter bills 0 and is COUNTED, never silently coerced', () => {
  const rows = buildSessionLedger([mkLine('msg_frac', 'a.jsonl', usage1({
    iterations: [{ input_tokens: 1.5, output_tokens: 2, cache_read_input_tokens: 0 }],
  }))]);
  assert.equal(rows[0].input, 0, 'fractional bills 0');
  assert.equal(rows[0].output, 2);
  assert.equal(rows.usageIntViolations, 1, 'one violation disclosed');
  // clean input reports zero violations
  const clean = buildSessionLedger([mkLine('msg_ok', 'a.jsonl', usage1())]);
  assert.equal(clean.usageIntViolations, 0);
  // a large (>=2^31) integer passes through unwrapped
  const big = buildSessionLedger([mkLine('msg_big', 'a.jsonl', usage1({
    iterations: [{ input_tokens: 2 ** 31 + 5, output_tokens: 0 }],
  }))]);
  assert.equal(big[0].input, 2 ** 31 + 5);
  assert.equal(big.usageIntViolations, 0);
});

test('ACC-18 — CostAgg carries webSearchRequests/webFetchRequests; aggregate === addCostAgg === aggregateLite', () => {
  const lines = [
    mkLine('msg_ws', 'x/subagents/agent-a0000000000000003.jsonl', usage1({
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
    })),
    mkLine('msg_plain', 'x/main.jsonl', usage1()),
  ];
  const rows = buildSessionLedger(lines);
  const agg = aggregate(rows.map((r) => ({ ...r })), { priceRow });
  assert.equal(agg.webSearchRequests, 3);
  assert.equal(agg.webFetchRequests, 2);
  const sum = addCostAgg(agg, emptyCostAgg());
  assert.deepEqual(sum, agg, 'identity holds with the new metrics');
  const lite = buildLedgerLite(rows, 'x/main.jsonl');
  const fromLite = aggregateLite(lite, { priceRow });
  assert.deepEqual(fromLite, agg, 'bucketed path counts the same requests');
});

test('ACC-32 — a row that is BOTH sidechain and R2-duplicated routes to embeddedSidechain (Path B order)', () => {
  const lines = [mkLine('msg_both', 'x/main.jsonl', usage1(), { isSidechain: true, tier: 'main' })];
  const rows = buildSessionLedger(lines);
  assert.equal(rows[0].embeddedSidechain, true);
  const canonicalOf = new Map([['msg_both', 'OTHER']]);
  const agg = aggregate(rows.map((r) => ({ ...r })), { canonicalOf, sessionId: 'ME', priceRow });
  assert.equal(agg.embeddedSidechain.requests, 1, 'sidechain classification precedes the R2 gate');
  assert.deepEqual(agg.inherited, {}, 'not double-routed');
  assert.equal(agg.requests, 0);
});

test('ACC-4 — billed rows record the ABSENT-vs-null distinction for speed/service_tier (pair census)', () => {
  const absent = buildSessionLedger([mkLine('msg_a', 'a.jsonl', usage1())]);
  assert.equal(absent[0].speedAbsent, true, 'no speed key recorded');
  assert.equal(absent[0].serviceTierAbsent, true);
  const explicit = buildSessionLedger([mkLine('msg_b', 'a.jsonl', usage1({ speed: null, service_tier: 'standard' }))]);
  assert.equal(explicit[0].speedAbsent, false, 'recorded null is PRESENT');
  assert.equal(explicit[0].speed, null);
  assert.equal(explicit[0].serviceTierAbsent, false);
});

test('ACC-28 — cached turn/agent usage excludes synthetic rows; model-less usage keys (unrecorded)', () => {
  const mainRel = 'p/s.jsonl';
  const model = {
    id: 's', slug: 'p', fragmentDirs: [], bytes: 0, files: 1, lines: 3,
    main: {
      rel: mainRel,
      rows: [{ line: 1, bi: null, kind: 'prompt', at: AT, head: 'hi', extra: {} }],
      turns: [
        { idx: 0, preamble: true, openerLine: null, at: null, endAt: null, rowRange: null },
        { idx: 1, preamble: false, openerLine: 1, at: AT, endAt: AT, rowRange: [0, 0] },
      ],
      meta: {
        aiTitle: { value: null, count: 0 }, customTitle: { value: null, count: 0 },
        lastPrompt: { value: null, leafUuid: null, leafLine: null, count: 0 },
        mode: { value: null, count: 0 }, prLinks: { items: [], count: 0 }, frameLinks: { items: [], count: 0 },
        queueOps: { enqueue: 0, dequeue: 0, remove: 0, other: 0 },
        cwds: [], versions: [], gitBranch: null, gitBranchCount: 0, entrypoint: null, bom: false,
        cwd: null, version: null, firstAt: AT, lastAt: AT, r2FirstTsMs: AT,
        foreignMsgIds: [], msgIds: ['msg_real'], embeddedSidechainRows: 0, models: [],
      },
    },
    agents: [], workflows: [], journalOnly: [],
    inventory: {
      perType: {}, attachmentKinds: {}, images: [], spills: [], spillFiles: [], filesLedger: [],
      filesLedgerDenominators: { mainToolCallsWithPath: 0, agentToolCallsWithPath: 0, agentResultsNoSidecar: 0 },
      sessionIdsSeen: [], counts: { events: 3, lines: 3, toolCalls: 0, textChars: 0, thinkingChars: 0, images: 0, imageBlocks: 0, agents: 0, workflows: 0, tornLines: 0 },
      problems: [],
    },
    assistantLines: [], live: false,
  };
  // a FUTURE synthetic row carrying nonzero tokens (R4 exposure today is all-zero)
  const rows = [
    { msgId: 'msg_real', model: 'claude-opus-5', at: AT, file: mainRel, line: 1, input: 10, output: 5, cacheRead: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, thinkingTokens: null, webSearch: 0, webFetch: 0, speed: null, serviceTier: null, stopReason: 'end_turn', ttl: 'recorded', finalized: true, synthetic: false, billedElsewhere: null, iterIndex: null },
    { msgId: 'uuid-syn', model: null, at: AT, file: mainRel, line: 1, input: 7, output: 3, cacheRead: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, thinkingTokens: null, webSearch: 0, webFetch: 0, speed: null, serviceTier: null, stopReason: null, ttl: 'recorded', finalized: false, synthetic: true, billedElsewhere: null, iterIndex: null },
  ];
  const { detail } = summarise(model, rows, 'fp');
  assert.equal(detail.turns[1].usage.input, 10, 'synthetic tokens are NOT in cached turn usage');
  assert.equal(detail.turns[1].usage.output, 5);
  assert.ok(!('undefined' in detail.usageByModel), 'no JS-artifact "undefined" key');
  assert.ok(!('null' in detail.usageByModel));
  assert.deepEqual(Object.keys(detail.usageByModel), ['claude-opus-5'], 'synthetic rows never enter usageByModel');
});
