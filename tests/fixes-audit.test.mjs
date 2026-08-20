// Round-1 fix regressions — audit Path B + invariants (ACC-4, ACC-5, ACC-10,
// ACC-14, ACC-15 audit half, ACC-16, ACC-17, ACC-27; per-session A/B rows and
// the two file censuses on `done`).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from '../server/audit.mjs';
import * as pricing from './fixtures/api/stubs/pricing.mjs';
import { makeStore, STORE, EXPECT, SLUG, S1, S2 } from './fixtures/api/make-store.mjs';

before(async () => { await makeStore(); });

function collect() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }) };
}
const inv = (events, name) => events.find((e) => e.event === 'invariant' && e.data.name === name)?.data;
const doneOf = (events) => events.find((e) => e.event === 'done')?.data;

test('ACC-4 — the five SPEC §10 headline invariants are REAL when Path A supplies expectations', async () => {
  const { events, emit } = collect();
  const pathA = {
    fileCensus: { files: EXPECT.files, bytes: null }, // bytes filled below from Path B's own census
    agentCount: EXPECT.agents,
    turnAgentSum: EXPECT.agents,
    sessionSum: { pass: true, failures: [] },
    sessions: {},
    totals: { requests: EXPECT.totalRequests, usdTotal: EXPECT.totalTcu },
    expectations: {
      neverFinalized: EXPECT.neverFinalized,
      synthetic: EXPECT.synthetic,
      pairCensus: Object.fromEntries(Object.entries(EXPECT.pairCensus).sort()),
    },
  };
  const sum = await runAudit({ projectsDir: STORE, scope: { kind: 'store' }, pricing, pathA, emit });
  pathA.fileCensus.bytes = sum.fileCensus.bytes;

  const pc = inv(events, 'pair-census');
  assert.equal(pc.pass, true, 'pair census is COMPARED, not hard-coded true');
  assert.deepEqual(pc.expected, pathA.expectations.pairCensus);
  const nf = inv(events, 'never-finalized');
  assert.equal(nf.pass, true);
  assert.equal(nf.expected, EXPECT.neverFinalized, 'non-null expected side');
  const sc = inv(events, 'synthetic-census');
  assert.equal(sc.pass, true);
  assert.equal(sc.expected, EXPECT.synthetic);
  const aa = inv(events, 'agents-attribution');
  assert.ok(aa, 'agents-attribution is EMITTED');
  assert.equal(aa.pass, true);
  const ss = inv(events, 'session-sum-channels');
  assert.ok(ss, 'session-sum-channels is EMITTED');
  assert.equal(ss.pass, true);
});

test('ACC-4 — a doctored pair census FAILS the invariant; a failed sessionSum fails its row', async () => {
  const { events, emit } = collect();
  await runAudit({
    projectsDir: STORE, scope: { kind: 'store' }, pricing, emit,
    pathA: {
      sessions: {}, totals: { requests: 0, usdTotal: 0 },
      turnAgentSum: 999,
      sessionSum: { pass: false, failures: [`${SLUG}/${S1}`] },
      expectations: { neverFinalized: 0, synthetic: 0, pairCensus: { 'doctored|census': 1 } },
    },
  });
  assert.equal(inv(events, 'pair-census').pass, false);
  assert.equal(inv(events, 'never-finalized').pass, false, 'wrong expectation fails loudly');
  assert.equal(inv(events, 'agents-attribution').pass, false);
  assert.equal(inv(events, 'session-sum-channels').pass, false);
});

test('per-session A/B rows are emitted as `session:<key>` invariants; done carries both censuses', async () => {
  const { events, emit } = collect();
  const first = await runAudit({ projectsDir: STORE, scope: { kind: 'store' }, pricing, emit });
  const pathA = {
    fileCensus: first.fileCensus,
    sessions: {
      [`${SLUG}/${S1}`]: { requests: EXPECT.s1Requests, usdTotal: EXPECT.s1Tcu },
      [`${SLUG}/${S2}`]: { requests: EXPECT.s2Requests, usdTotal: EXPECT.s2Tcu },
    },
    totals: { requests: EXPECT.totalRequests, usdTotal: EXPECT.totalTcu },
  };
  const { events: ev2, emit: emit2 } = collect();
  await runAudit({ projectsDir: STORE, scope: { kind: 'store' }, pricing, pathA, emit: emit2 });
  const s1row = inv(ev2, `session:${SLUG}/${S1}`);
  const s2row = inv(ev2, `session:${SLUG}/${S2}`);
  assert.ok(s1row && s2row, 'one invariant row per session');
  assert.equal(s1row.pass, true);
  assert.equal(s1row.expected.usdTotal, EXPECT.s1Tcu);
  assert.equal(s2row.actual.requests, EXPECT.s2Requests);
  const done = doneOf(ev2);
  assert.deepEqual(done.pathB, first.fileCensus, 'Path B census on done');
  assert.deepEqual(done.pathA, pathA.fileCensus, 'Path A census on done');
});

test('ACC-16 — a first-timestamp TIE fails the r2-census invariant (tieBreaks census is asserted)', async () => {
  // two mains sharing a msgId with IDENTICAL first timestamps and rewritten
  // sessionIds (clause i non-discriminating) -> clause (iii) tie-break
  const root = path.join(os.tmpdir(), `lens-fix-tie-${process.pid.toString(36)}`);
  const slug = 'C--tie';
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line = (sid) => JSON.stringify({
    type: 'assistant', uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z', sessionId: sid,
    message: { id: 'msg_tie', model: 'claude-fable-5', stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, iterations: [{ input_tokens: 1, output_tokens: 1 }] } },
  }) + '\n';
  await fsp.writeFile(path.join(root, slug, `${idA}.jsonl`), line(idA));
  await fsp.writeFile(path.join(root, slug, `${idB}.jsonl`), line(idA)); // rewritten? keep BOTH claiming idA -> clause (i) picks... make both match their own file? no:
  // both files record sessionId=idA: file A matches (i), file B does not -> (i) resolves.
  // To force the tie, make BOTH match their own filename ids:
  await fsp.writeFile(path.join(root, slug, `${idB}.jsonl`), line(idB));
  const { events, emit } = collect();
  await runAudit({ projectsDir: root, scope: { kind: 'store' }, pricing, emit });
  const r2 = inv(events, 'r2-census');
  assert.equal(r2.actual.tieBreaks, 1, 'the tie is censused');
  assert.equal(r2.pass, false, 'tieBreaks !== 0 FAILS the invariant');
  await fsp.rm(root, { recursive: true, force: true });
});

test('ACC-10 — a >200K mythos-5 row counts premiumUnknown in Path B (verified set from pricing)', async () => {
  const root = path.join(os.tmpdir(), `lens-fix-myth-${process.pid.toString(36)}`);
  const slug = 'C--myth';
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const line = JSON.stringify({
    type: 'assistant', uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z', sessionId: id,
    message: { id: 'msg_big', model: 'claude-mythos-5', stop_reason: 'end_turn',
      usage: { input_tokens: 250000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, iterations: [{ input_tokens: 250000, output_tokens: 1 }] } },
  }) + '\n';
  await fsp.writeFile(path.join(root, slug, `${id}.jsonl`), line);
  const { events, emit } = collect();
  const realPricing = await import('../shared/pricing.mjs');
  const sum = await runAudit({ projectsDir: root, scope: { kind: 'store' }, pricing: realPricing, emit });
  assert.equal(sum.counts.over200k, 1);
  assert.equal(sum.counts.premiumUnknown, 1, 'mythos-5 is OUTSIDE the verified long-context set (SPEC §5)');
  assert.equal(inv(events, 'over-200k').pass, false, 'the disclosure fails loudly, matching Path A');
  await fsp.rm(root, { recursive: true, force: true });
});

test('ACC-14/ACC-15/ACC-27 — id-less lines key per line; fractional usage censused; uppercase UUID classifies', async () => {
  const root = path.join(os.tmpdir(), `lens-fix-misc-${process.pid.toString(36)}`);
  const slug = 'C--misc';
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const idUpper = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD'; // uppercase on disk
  const noIdLine = (out) => JSON.stringify({
    type: 'assistant', timestamp: '2026-08-01T10:00:00.000Z', sessionId: idUpper.toLowerCase(),
    message: { model: 'claude-fable-5', stop_reason: 'end_turn',
      usage: { input_tokens: 1.5, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, iterations: [{ input_tokens: 1.5, output_tokens: out }] } },
  }) + '\n';
  await fsp.writeFile(path.join(root, slug, `${idUpper}.jsonl`), noIdLine(1) + noIdLine(2));
  const { events, emit } = collect();
  const sum = await runAudit({ projectsDir: root, scope: { kind: 'store' }, pricing, emit });
  // ACC-27: the uppercase main classifies as a session (case-insensitive predicate, id lowercased)
  assert.equal(sum.counts.mains, 1);
  const key = Object.keys(sum.sessions)[0];
  assert.ok(key.endsWith(idUpper.toLowerCase()), 'session id normalised to lowercase');
  // ACC-14: two id-less+uuid-less lines are TWO groups, not one collapsed slot
  assert.equal(sum.totals.requests, 2);
  // ACC-15: fractional input billed 0 and censused (2 kept lines x 1 violation each)
  assert.equal(sum.totals.tokens.input, 0);
  const ui = inv(events, 'usage-integers');
  assert.equal(ui.pass, false);
  assert.equal(ui.actual, 2);
  await fsp.rm(root, { recursive: true, force: true });
});
