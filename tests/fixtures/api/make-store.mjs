// Builds the committed fixture store for group D tests. Deterministic,
// idempotent; every event shape mirrors real corpus lines (verified against
// real corpus session files, read-only; identifiers redacted). Hand-computed
// expected totals live in EXPECT below — tests assert against these
// literals, never against re-derived figures.
//
// Stub pricing units (1/20 cent per Mtok): fable-5 in=20000 out=100000
// (w5m=25000 w1h=40000 read=2000); haiku-4-5 in=2000 out=10000;
// web search = 2e7 tcu/request. claude-3-opus-20240229 has no rate (R7).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STORE = path.join(HERE, 'store');

export const SLUG = 'C--test-proj-a';
export const S1 = '11111111-1111-4111-8111-111111111111';
export const S2 = '22222222-2222-4222-8222-222222222222';
export const A1 = 'a1234567890abcdef';
export const A2 = 'a2222222222222222';
export const RUN = 'wf_11223344-abc';

const J = JSON.stringify;
const ts = (s) => `2026-08-01T${s}.000Z`;

function asst({ sid, uuid, at, msgId, model, content, stop, usage, sidechain = false }) {
  return J({
    parentUuid: null, isSidechain: sidechain, type: 'assistant', uuid, timestamp: at, sessionId: sid,
    message: { id: msgId, model, type: 'message', role: 'assistant', content, stop_reason: stop, usage },
  });
}
const el = (input, output, read, c5, c1, extra = {}) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read,
  cache_creation_input_tokens: c5 + c1,
  cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 },
  type: 'message', ...extra,
});
const usage = (input, output, read, c5, c1, iters, extra = {}) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: read, cache_creation_input_tokens: c5 + c1,
  cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  speed: 'standard', service_tier: 'standard',
  iterations: iters, ...extra,
});

// -------------------- shared row builders for the fixes-round suites -------
// The fixes-round test files build their own throwaway stores but had all
// re-declared the same three JSONL row shapes per file. They live here now so
// the bytes stay identical everywhere; the module-local builders above are
// the richer shapes THIS fixture store needs and are untouched.
//
// usageStd(input, output): the no-cache, single-iteration usage block the
// round files call `usage` (import with `usageStd as usage`).
export const usageStd = (input, output) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  speed: 'standard', service_tier: 'standard',
  iterations: [{
    type: 'message', input_tokens: input, output_tokens: output,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  }],
});

// makeUser(cwd): each round file stamps its own cwd; the body is the union of
// the per-file copies (sidechain/agentId were the round-3/4 extras — with the
// defaults the row serializes to the exact bytes the plainer copies wrote,
// key order included).
export const makeUser = (cwd) => ({ sid, uuid, at, text, sidechain = false, agentId = null }) => J({
  parentUuid: null, isSidechain: sidechain, type: 'user', uuid, timestamp: at, sessionId: sid,
  origin: sidechain ? undefined : { kind: 'human' }, cwd,
  message: { role: 'user', content: text }, ...(agentId ? { agentId } : {}),
});

// asstStd: the fable-5 end_turn assistant row (import with `asstStd as
// asst`). sidechain/agentId were the round-11 extras; input/output default to
// the 100/50 every copy hard-coded, so unchanged call sites serialize to the
// same bytes as before.
export const asstStd = ({ sid, uuid, at, msgId, text, sidechain = false, agentId = null, input = 100, output = 50 }) => J({
  parentUuid: null, isSidechain: sidechain, type: 'assistant', uuid, timestamp: at, sessionId: sid,
  ...(agentId ? { agentId } : {}),
  message: {
    id: msgId, model: 'claude-fable-5', type: 'message', role: 'assistant',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usageStd(input, output),
  },
});

export async function makeStore() {
  // Idempotent + atomic: node --test runs test files in parallel and several
  // of them call makeStore() while others are mid-scan. Unchanged files are
  // left untouched; changed ones are written to a tmp name and renamed in.
  const w = async (rel, text) => {
    const abs = path.join(STORE, ...rel.split('/'));
    try {
      const existing = await fsp.readFile(abs, 'utf8');
      if (existing === text) return;
    } catch { /* absent — write it */ }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    try { await fsp.rename(tmp, abs); }
    catch { try { await fsp.unlink(tmp); } catch { /* raced */ } }
  };

  // ---- S1 main: msg_AAA (R1 two lines, keep last), synthetic (R4),
  // msg_CCC (R6 empty iterations), a torn line, msg_DDD (R7 unpriced).
  const s1 = [
    J({ type: 'custom-title', customTitle: 'Fixture one', sessionId: S1 }), // untimestamped (R2 ii skips it)
    J({
      parentUuid: null, isSidechain: false, type: 'user', uuid: 'u-s1-1', timestamp: ts('10:00:00'),
      sessionId: S1, cwd: 'C:\\test\\proj-a', origin: { kind: 'human' },
      message: { role: 'user', content: 'NEEDLE_ALPHA please build the thing' },
    }),
    asst({
      sid: S1, uuid: 'u-s1-2', at: ts('10:00:05'), msgId: 'msg_AAA', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'working on it' }], stop: null,
      usage: usage(100, 5, 2000, 0, 1000, undefined), // streaming partial: no iterations key
    }),
    asst({
      sid: S1, uuid: 'u-s1-3', at: ts('10:00:10'), msgId: 'msg_AAA', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'the NEEDLE_ALPHA result is ready' }], stop: 'end_turn',
      usage: usage(100, 50, 2000, 0, 1000, [el(100, 50, 2000, 0, 1000)]),
    }),
    asst({ // <synthetic> — usage.iterations === null is the exact discriminator (R4)
      sid: S1, uuid: 'u-s1-4', at: ts('10:01:00'), msgId: 'e3b0c442-98fc-4111-8111-aaaaaaaaaaaa',
      model: '<synthetic>', content: [{ type: 'text', text: 'API error: overloaded' }], stop: 'stop_sequence',
      usage: {
        input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        iterations: null, speed: null, service_tier: null,
      },
    }),
    asst({ // never-finalized: empty iterations ARRAY with stop_reason end_turn (the r6b empty-iterations shape)
      sid: S1, uuid: 'u-s1-5', at: ts('10:02:00'), msgId: 'msg_CCC', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'stub output' }], stop: 'end_turn',
      usage: {
        input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard', iterations: [], // NO speed key -> ABSENT|standard in the pair census
      },
    }),
    '{"type":"assistant","broken":tr', // torn line (fails JSON.parse; counted, contributes zero)
    asst({ // unpriced model (R7): claude-3-opus has no rate row
      sid: S1, uuid: 'u-s1-7', at: ts('10:03:00'), msgId: 'msg_DDD', model: 'claude-3-opus-20240229',
      content: [{ type: 'text', text: 'legacy model output' }], stop: 'end_turn',
      usage: usage(1000, 2000, 0, 0, 0, [el(1000, 2000, 0, 0, 0)]),
    }),
  ];
  await w(`${SLUG}/${S1}.jsonl`, s1.join('\n') + '\n');

  // ---- S2 fork of S1: first timestamped record 11:59 (own), then copied
  // events with sessionId REWRITTEN to S2 (both copies match rule (i), so
  // rule (ii) decides: S1's 10:00:00 < S2's 11:59:00 -> S1 canonical).
  const s2 = [
    J({ type: 'queue-operation', operation: 'enqueue', timestamp: ts('11:59:00'), sessionId: S2, content: 'resume this' }),
    J({
      parentUuid: null, isSidechain: false, type: 'user', uuid: 'u-s1-1', timestamp: ts('10:00:00'),
      sessionId: S2, origin: { kind: 'human' },
      message: { role: 'user', content: 'NEEDLE_ALPHA please build the thing' },
    }),
    asst({ // copied msg_AAA (R2 non-canonical here)
      sid: S2, uuid: 'u-s1-3', at: ts('10:00:10'), msgId: 'msg_AAA', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'the NEEDLE_ALPHA result is ready' }], stop: 'end_turn',
      usage: usage(100, 50, 2000, 0, 1000, [el(100, 50, 2000, 0, 1000)]),
    }),
    J({
      parentUuid: 'u-s1-3', isSidechain: false, type: 'user', uuid: 'u-s2-2', timestamp: ts('12:00:00'),
      sessionId: S2, origin: { kind: 'human' },
      message: { role: 'user', content: 'and now the second half' },
    }),
    asst({ // msg_EEE with one web search on the kept line (R8: 2e7 tcu each)
      sid: S2, uuid: 'u-s2-3', at: ts('12:00:30'), msgId: 'msg_EEE', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'searched and found NEEDLE_BETA' }], stop: 'end_turn',
      usage: {
        ...usage(100, 100, 0, 0, 0, [el(100, 100, 0, 0, 0)]),
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
      },
    }),
    asst({ // msg_HHH: flat-only cache_creation (no 5m/1h split) -> ttlAssumed (R5)
      sid: S2, uuid: 'u-s2-4', at: ts('12:01:00'), msgId: 'msg_HHH', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'foreign-shaped cache line' }], stop: 'end_turn',
      usage: {
        input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 100,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        speed: 'standard', service_tier: 'standard',
        iterations: [{ input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, type: 'message' }],
      },
    }),
    asst({ // msg_III: R3 two-element split; el0 carries its own model (fallback shape),
      // webSearch (3 requests) attaches to the FINAL element's row only
      sid: S2, uuid: 'u-s2-5', at: ts('12:02:00'), msgId: 'msg_III', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'split response' }], stop: 'end_turn',
      usage: {
        input_tokens: 11, output_tokens: 15, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 },
        speed: 'standard', service_tier: 'standard',
        iterations: [
          el(5, 7, 0, 0, 0, { model: 'claude-haiku-4-5-20251001' }),
          el(6, 8, 0, 0, 0),
        ],
      },
    }),
  ];
  await w(`${SLUG}/${S2}.jsonl`, s2.join('\n') + '\n');

  // ---- S1 agents (agent events are isSidechain: true, like the corpus)
  await w(`${SLUG}/${S1}/subagents/agent-${A1}.jsonl`, [
    J({
      parentUuid: null, isSidechain: true, type: 'user', uuid: 'u-a1-1', timestamp: ts('10:00:20'),
      sessionId: S1, agentId: A1, message: { role: 'user', content: 'agent fixture prompt NEEDLE_AGENT' },
    }),
    asst({
      sid: S1, uuid: 'u-a1-2', at: ts('10:00:30'), msgId: 'msg_FFF', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'agent answer' }], stop: 'end_turn', sidechain: true,
      usage: usage(10, 20, 500, 100, 0, [el(10, 20, 500, 100, 0)]),
    }),
  ].join('\n') + '\n');
  await w(`${SLUG}/${S1}/subagents/agent-${A1}.meta.json`,
    J({ agentType: 'claude', spawnDepth: 1, model: 'fable', description: 'fixture agent', toolUseId: 'toolu_fixture_1' }));

  await w(`${SLUG}/${S1}/subagents/workflows/${RUN}/agent-${A2}.jsonl`, [
    asst({
      sid: S1, uuid: 'u-a2-1', at: ts('10:05:00'), msgId: 'msg_GGG', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'workflow agent answer' }], stop: 'end_turn', sidechain: true,
      usage: usage(10, 10, 0, 0, 0, [el(10, 10, 0, 0, 0)]),
    }),
  ].join('\n') + '\n');
  await w(`${SLUG}/${S1}/subagents/workflows/${RUN}/agent-${A2}.meta.json`,
    J({ agentType: 'claude', spawnDepth: 1, model: 'fable' }));
  await w(`${SLUG}/${S1}/subagents/workflows/${RUN}/journal.jsonl`,
    J({ type: 'started', key: 'v2:' + 'ab'.repeat(32), agentId: A2 }) + '\n');
  await w(`${SLUG}/${S1}/workflows/scripts/fixture-${RUN}.js`, '// fixture workflow script\n');

  // ---- project memory
  await w(`${SLUG}/memory/notes.md`,
    `---\nmetadata:\n  originSessionId: ${S1}\n---\nfixture memory NEEDLE_MEM\n`);

  return STORE;
}

// -------------------- hand-computed Path B expectations --------------------
// S1 (canonical: AAA per R2 ii; CCC billed as recorded; DDD unpriced; FFF, GGG agents)
//   AAA: 100*20000 + 50*100000 + 1000*40000 + 2000*2000          = 51,000,000
//   CCC: 10*20000 + 3*100000                                     =    500,000
//   FFF: 10*20000 + 20*100000 + 100*25000 + 500*2000             =  5,700,000
//   GGG: 10*20000 + 10*100000                                    =  1,200,000
//   S1 total                                                     = 58,400,000
//   requests 5 (AAA, CCC, DDD, FFF, GGG); DDD -> unpriced['opus-3']
// S2 (AAA copy inherited; EEE + 1 webSearch; HHH flat->5m; III split 2 rows)
//   EEE: 100*20000 + 100*100000 + 1*2e7                          = 32,000,000
//   HHH: 10*20000 + 10*100000 + 100*25000                        =  3,700,000
//   III el0 (haiku-4-5): 5*2000 + 7*10000                        =     80,000
//   III el1 (fable-5):   6*20000 + 8*100000 + 3*2e7              = 60,920,000
//   S2 total                                                     = 96,700,000
//   requests 4 (EEE, HHH, III x2)
// Grand total tcu = 155,100,000 ; grand requests = 9
export const EXPECT = {
  s1Key: `${SLUG}/${S1}`,
  s2Key: `${SLUG}/${S2}`,
  s1Tcu: 58_400_000,
  s2Tcu: 96_700_000,
  totalTcu: 155_100_000,
  s1Requests: 5,
  s2Requests: 4,
  totalRequests: 9,
  tokens: { // priced canonical rows only (R7 keeps unpriced parallel)
    input: 130 + 121,        // S1: 100+10+10+10 ; S2: 100+10+5+6
    output: 83 + 125,        // S1: 50+3+20+10   ; S2: 100+10+7+8
    cache5m: 100, cache1h: 1000, cacheFlat: 100, cacheRead: 2500,
  },
  unpricedModel: 'claude-3-opus-20240229', // RAW string key (ACC-17: same rule as the ledger's unpriced channel)
  unpricedTokens: { input: 1000, output: 2000 },
  files: 9,
  mains: 2, agents: 2, journals: 1,
  torn: 1, synthetic: 1, neverFinalized: 1, ttlAssumed: 1,
  duplicateGroups: 1, tieBreaks: 0, ambiguous: 0,
  pairCensus: { 'standard|standard': 8, 'ABSENT|standard': 1, 'null|null': 1 },
  r3SplitGroups: 1,
  webSearchTcu: 8e7, // 1 on EEE + 3 on III final row = 4 requests * 2e7
};
