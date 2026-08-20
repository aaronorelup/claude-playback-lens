// Path B over the fixture store vs hand-computed totals (make-store.mjs
// EXPECT — literals derived by hand, never by re-running the code under test).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runAudit, splitLinesB, stripHeavyB } from '../server/audit.mjs';
import * as pricing from './fixtures/api/stubs/pricing.mjs';
import { makeStore, STORE, EXPECT, SLUG, S1, S2, A1 } from './fixtures/api/make-store.mjs';

before(async () => { await makeStore(); });

function collect() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }) };
}
const inv = (events, name) => events.find((e) => e.event === 'invariant' && e.data.name === name)?.data;

test('store scope: totals, per-session sums, channels — all hand-computed', async () => {
  const { events, emit } = collect();
  const sum = await runAudit({ projectsDir: STORE, scope: { kind: 'store' }, pricing, emit });

  assert.equal(sum.totals.usd.total, EXPECT.totalTcu);
  assert.equal(sum.totals.requests, EXPECT.totalRequests);
  assert.deepEqual(sum.totals.tokens, EXPECT.tokens);

  const s1 = sum.sessions[EXPECT.s1Key];
  const s2 = sum.sessions[EXPECT.s2Key];
  assert.equal(s1.usd.total, EXPECT.s1Tcu);
  assert.equal(s1.requests, EXPECT.s1Requests);
  assert.equal(s2.usd.total, EXPECT.s2Tcu);
  assert.equal(s2.requests, EXPECT.s2Requests);

  // R7 — unpriced parallel channel, never $0, never blended
  const up = sum.totals.unpriced[EXPECT.unpricedModel];
  assert.ok(up, 'unpriced channel exists for opus-3');
  assert.equal(up.requests, 1);
  assert.equal(up.tokens.input, EXPECT.unpricedTokens.input);
  assert.equal(up.tokens.output, EXPECT.unpricedTokens.output);

  // R2 — the S2 copy is the disclosed inherited channel, keyed by canonical session
  const inherited = s2.inherited[S1];
  assert.ok(inherited, 'S2 discloses the inherited channel to S1');
  assert.equal(inherited.requests, 1);
  assert.equal(inherited.tokens.input, 100);
  assert.equal(inherited.tokens.cache1h, 1000);

  // counts
  assert.equal(sum.counts.duplicateGroups, EXPECT.duplicateGroups);
  assert.equal(sum.counts.tieBreaks, EXPECT.tieBreaks);
  assert.equal(sum.counts.ambiguous, EXPECT.ambiguous);
  assert.equal(sum.counts.torn, EXPECT.torn);
  assert.equal(sum.counts.synthetic, EXPECT.synthetic);
  assert.equal(sum.counts.neverFinalized, EXPECT.neverFinalized);
  assert.equal(sum.counts.ttlAssumed, EXPECT.ttlAssumed);
  assert.equal(sum.counts.mains, EXPECT.mains);
  assert.equal(sum.counts.agents, EXPECT.agents);
  assert.equal(sum.counts.journals, EXPECT.journals);
  assert.equal(sum.counts.r3SplitGroups, EXPECT.r3SplitGroups);
  assert.equal(sum.counts.r3SplitSumBreaks, 0);
  assert.equal(sum.counts.cacheIdentityBreaks, 0);
  assert.equal(sum.fileCensus.files, EXPECT.files);
  assert.deepEqual(sum.counts.forkPairs, [`${S1}↔${S2}`]);

  // invariants over the stream
  assert.deepEqual(inv(events, 'pair-census').actual, EXPECT.pairCensus);
  assert.equal(inv(events, 'torn-lines').actual, 1);
  assert.equal(inv(events, 'r2-census').pass, true);
  assert.deepEqual(inv(events, 'r2-census').actual, { duplicateGroups: 1, tieBreaks: 0, ambiguous: 0 });
  assert.equal(inv(events, 'tcu-non-overflow').pass, true);
  assert.equal(inv(events, 'cache-identity-after-r3').pass, true);
  assert.equal(inv(events, 'r3-split-sums').pass, true);
  assert.equal(inv(events, 'interval-coverage').pass, true);
  assert.equal(inv(events, 'over-200k').pass, true);
  // evidence re-read: max-output billed row (msg_EEE, S2 line 5) re-reads to the same message.id
  const ev = inv(events, 'evidence-reread');
  assert.equal(ev.pass, true);
  assert.equal(ev.expected.msgId, 'msg_EEE');
  assert.equal(ev.actual.line, 5);
  // torn-line problem event carries the 1-based locator
  const torn = events.find((e) => e.event === 'problem' && e.data.code === 'torn-line');
  assert.equal(torn.data.line, 7);
  assert.equal(torn.data.file, `${SLUG}/${S1}.jsonl`);
  // done is emitted with the reconciliation figures
  const done = events.filter((e) => e.event === 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.requests, EXPECT.totalRequests);
  assert.equal(done[0].data.usdTotal, EXPECT.totalTcu);
});

test('web-search tcu is exact (R8: 1 request = 2e7 tcu)', async () => {
  const { emit } = collect();
  const sum = await runAudit({ projectsDir: STORE, scope: { kind: 'store' }, pricing, emit });
  assert.equal(sum.totals.usd.webSearch, EXPECT.webSearchTcu);
});

test('session scope narrows Path B to that session tree', async () => {
  const { emit } = collect();
  const sum = await runAudit({ projectsDir: STORE, scope: { kind: 'session', slug: SLUG, id: S1 }, pricing, emit });
  assert.equal(sum.totals.usd.total, EXPECT.s1Tcu);
  assert.equal(sum.totals.requests, EXPECT.s1Requests);
  assert.equal(sum.fileCensus.files, 7); // main + 2 agent jsonl + 2 meta + journal + script
  assert.equal(Object.keys(sum.sessions).length, 1);
});

test('session scope on the fork: partner is out of scope; Path A r2Inherited is honoured and disclosed', async () => {
  // without Path A knowledge, the copy bills locally (the partner file is unseen)
  let c = collect();
  let sum = await runAudit({ projectsDir: STORE, scope: { kind: 'session', slug: SLUG, id: S2 }, pricing, emit: c.emit });
  assert.equal(sum.totals.requests, EXPECT.s2Requests + 1);
  assert.equal(sum.totals.usd.total, EXPECT.s2Tcu + 51_000_000); // + msg_AAA
  // with Path A's disclosed inherited msgIds, the copy routes to the inherited channel
  c = collect();
  sum = await runAudit({
    projectsDir: STORE, scope: { kind: 'session', slug: SLUG, id: S2 }, pricing, emit: c.emit,
    pathA: { r2Inherited: { msgIds: ['msg_AAA'], canonicalSessionId: S1 } },
  });
  assert.equal(sum.totals.requests, EXPECT.s2Requests);
  assert.equal(sum.totals.usd.total, EXPECT.s2Tcu);
  assert.ok(c.events.some((e) => e.event === 'problem' && /inherited msgIds taken from Path A/.test(e.data.message)),
    'the cross-scope R2 input is disclosed');
});

test('agent scope bills only that agent transcript', async () => {
  const { emit } = collect();
  const sum = await runAudit({ projectsDir: STORE, scope: { kind: 'agent', slug: SLUG, id: S1, agentId: A1 }, pricing, emit });
  assert.equal(sum.totals.requests, 1);
  assert.equal(sum.totals.usd.total, 5_700_000); // msg_FFF: 10 in + 20 out + 100@5m + 500 read
});

test('A/B comparison invariants: pass on agreement, fail loudly on disagreement', async () => {
  const first = collect();
  const b = await runAudit({ projectsDir: STORE, scope: { kind: 'store' }, pricing, emit: first.emit });
  const pathA = {
    fileCensus: b.fileCensus,
    agentCount: b.counts.agents,
    sessions: Object.fromEntries(Object.entries(b.sessions).map(([k, v]) => [k, { requests: v.requests, usdTotal: v.usd.total }])),
    totals: { requests: b.totals.requests, usdTotal: b.totals.usd.total },
  };
  let c = collect();
  await runAudit({ projectsDir: STORE, scope: { kind: 'store' }, pricing, pathA, emit: c.emit });
  assert.equal(inv(c.events, 'file-census').pass, true);
  assert.equal(inv(c.events, 'ab-session-diff').pass, true);
  assert.equal(inv(c.events, 'ab-total').pass, true);
  assert.equal(inv(c.events, 'agents-enumerated').pass, true);

  // now corrupt Path A by one tcu — the diff table must go red, not silent
  const wrong = JSON.parse(JSON.stringify(pathA));
  wrong.totals.usdTotal += 1;
  wrong.sessions[EXPECT.s1Key].usdTotal += 1;
  c = collect();
  await runAudit({ projectsDir: STORE, scope: { kind: 'store' }, pricing, pathA: wrong, emit: c.emit });
  assert.equal(inv(c.events, 'ab-total').pass, false);
  assert.equal(inv(c.events, 'ab-session-diff').pass, false);
  assert.equal(inv(c.events, 'ab-session-diff').actual.mismatches, 1);
});

test('own splitter: \\n-only, held-back tail, raw U+2028 inside strings survives', () => {
  const buf = Buffer.from('{"a":"x y"}\n{"b":2}\r\n{"tail":tr', 'utf8');
  const it = splitLinesB(buf);
  const lines = [];
  let step = it.next();
  while (!step.done) { lines.push(step.value); step = it.next(); }
  assert.equal(lines.length, 2); // the unterminated tail is held back
  assert.equal(JSON.parse(lines[0].text).a, 'x y'); // U+2028 never tears a line
  assert.equal(lines[1].text, '{"b":2}'); // \r stripped
  assert.ok(step.value.heldBackBytes > 0);
});

test('own stripper: 500+ char base64 data/base64 values and signatures are removed', () => {
  const b64 = 'A'.repeat(600);
  const sig = 'B'.repeat(200);
  const tally = { base64: 0, base64Bytes: 0, signature: 0, signatureBytes: 0 };
  const out = stripHeavyB(`{"data":"${b64}","base64":"${b64}","signature":"${sig}","keep":"short"}`, tally);
  assert.equal(tally.base64, 2);
  assert.equal(tally.signature, 1);
  assert.ok(!out.includes('AAAA'));
  const parsed = JSON.parse(out);
  assert.equal(parsed.data, '');
  assert.equal(parsed.keep, 'short');
});
