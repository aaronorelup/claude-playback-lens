// tests/parse-agents.test.mjs — agent enumeration (directory glob), the three
// recorded lineage edges, resumed-run FIRST-call attribution, time-window
// fallback for orphans, recorded states, the label ladder, fragment union,
// and summary badges (group B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStore, groupSessions, fingerprint } from '../server/scan.mjs';
import { parseSession } from '../server/parse.mjs';
import { summarise } from '../server/summary.mjs';

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reader', 'store');
const SID = '11111111-1111-4111-8111-111111111111';
const RUN = 'wf_00000001-aaa';

let model = null;
async function getModel() {
  if (model) return model;
  const grouped = groupSessions(await scanStore(STORE));
  const s = grouped.sessions.find((x) => x.id === SID);
  model = await parseSession(s, { projectsDir: STORE });
  return model;
}
const agent = (m, id) => m.agents.find((a) => a.agentId === id);

test('enumeration = the directory glob: every subagents/**/agent-*.jsonl is an agent', async () => {
  const m = await getModel();
  assert.equal(m.agents.length, 8);
  const ids = m.agents.map((a) => a.agentId).sort();
  assert.deepEqual(ids, [
    'achild0000000001', 'aorphan000000001', 'aplain0000000001', 'arunning00000001',
    'awf0000000000001', 'awf0000000000002', 'awf0000000000003', 'awf0000000000004',
  ]);
  assert.equal(m.journalOnly.length, 0, 'every journal agentId has a transcript');
  // every agent belongs to exactly one turn (audit invariant Σ agents over turns == enumerated)
  assert.ok(m.agents.every((a) => a.turnIdx !== null));
});

test('edge 1 (workflow): runId dir -> Workflow tool_use; resumed run stays with the FIRST call', async () => {
  const m = await getModel();
  const wf = m.workflows.find((w) => w.runId === RUN);
  assert.ok(wf);
  assert.deepEqual(wf.spawnLines, [5, 8], 'spawned in turn 1 (L5), resumed in turn 2 (L8)');
  assert.equal(wf.firstSpawnLine, 5);
  assert.equal(wf.turnIdx, 1, 'the run belongs to the turn of its FIRST spawning call');
  assert.equal(wf.resumed, true);
  for (const id of ['awf0000000000001', 'awf0000000000002', 'awf0000000000003', 'awf0000000000004']) {
    const a = agent(m, id);
    assert.equal(a.lineage.kind, 'workflow');
    assert.equal(a.lineage.runId, RUN);
    assert.equal(a.turnIdx, 1, `${id} attributed to turn 1 (never the resuming turn)`);
    assert.equal(a.attributedBy, 'runId');
  }
  // fragment-dir script (from the OTHER project) joined the run
  assert.ok(wf.scriptRels.some((r) => r.startsWith('C--fx-projD/')), 'cross-project fragment script unioned');
  assert.equal(wf.record.status, 'completed');
  assert.equal(wf.record.totalTokens, 1234, 'recorded gauge kept (displayable as "final context size" only)');
});

test('edge 2 (plain): meta.toolUseId -> Agent tool_use in the owning main', async () => {
  const m = await getModel();
  const a = agent(m, 'aplain0000000001');
  assert.equal(a.lineage.kind, 'plain');
  assert.equal(a.lineage.toolUseId, 'toolu_fxPLAIN');
  assert.equal(a.lineage.spawnLine, 3);
  assert.equal(a.turnIdx, 1);
  assert.equal(a.attributedBy, 'toolUseId');
  assert.equal(a.resolvedModel, 'claude-opus-5', 'recorded resolvedModel from the spawn result');
});

test('edge 3 (child): meta.parentAgentId -> parent agent; turn attribution is transitive', async () => {
  const m = await getModel();
  const a = agent(m, 'achild0000000001');
  assert.equal(a.lineage.kind, 'child');
  assert.equal(a.lineage.parentAgentId, 'aplain0000000001');
  assert.equal(a.turnIdx, 1, 'transitively the parent\'s turn');
  assert.equal(a.attributedBy, 'parentAgentId');
});

test('orphan fallback: no recorded spawn edge -> total time-window rule, and it says so', async () => {
  const m = await getModel();
  const a = agent(m, 'aorphan000000001');
  assert.equal(a.lineage.kind, 'orphan');
  assert.equal(a.turnIdx, 3, 'firstAt (12:00:30) falls in turn 3\'s window [12:00:00, +inf)');
  assert.equal(a.attributedBy, 'time-window');
});

test('recorded agent states: done / running / superseded / cached', async () => {
  const m = await getModel();
  assert.equal(agent(m, 'awf0000000000001').state, 'done');
  const sup2 = agent(m, 'awf0000000000002');
  assert.equal(sup2.state, 'superseded', 'a COMPLETED manifest that omits the agent supersedes it, result or not');
  assert.equal(sup2.stateFacts.journalResult, false);
  const running = agent(m, 'arunning00000001');
  assert.equal(running.state, 'running', 'no manifest yet + journal start with no result (glyph source: journal)');
  assert.equal(running.stateFacts.journalStarted, 1);
  assert.equal(running.stateFacts.journalResult, false);
  assert.equal(running.stateFacts.manifestExists, false);
  const sup = agent(m, 'awf0000000000003');
  assert.equal(sup.state, 'superseded', 'journal started+result but absent from the manifest');
  assert.equal(sup.stateFacts.journalResult, true);
  const cached = agent(m, 'awf0000000000004');
  assert.equal(cached.state, 'done');
  assert.equal(cached.stateFacts.cached, true);
  assert.equal(cached.progress.tokens, null, 'cached entries carry no counters — null, never 0');
  assert.equal(cached.progress.model, 'claude-opus-5[1m]', 'the [1m] suffix is a recorded fact here');
  assert.equal(cached.stateFacts.resultEmpty, true, 'genuinely empty recorded result (the ∅ case)');
});

test('label ladder: workflowProgress > [AGENT: x] tag > input.description > meta.description > fallback', async () => {
  const m = await getModel();
  const wf1 = agent(m, 'awf0000000000001');
  assert.deepEqual(wf1.label, { text: 'verify:thing', source: 'workflowProgress' });
  const wf2 = agent(m, 'awf0000000000002');
  assert.deepEqual(wf2.label, { text: 'verify-role', source: 'prompt-tag' });
  assert.equal(wf2.tag, 'verify-role');
  const plain = agent(m, 'aplain0000000001');
  assert.equal(plain.label.source, 'prompt-tag', 'tag outranks input.description');
  assert.equal(plain.tag, 'plain-worker');
  const child = agent(m, 'achild0000000001');
  assert.deepEqual(child.label, { text: 'Child worker', source: 'input.description' },
    'depth-2 description resolves from the tool_use inside the PARENT transcript');
  const wf3 = agent(m, 'awf0000000000003');
  assert.equal(wf3.label.source, 'fallback');
  assert.equal(wf3.label.text, 'workflow-subagent awf0000000000003');
});

test('agent spans come from the agent\'s OWN transcript, never the parent tool_result', async () => {
  const m = await getModel();
  const plain = agent(m, 'aplain0000000001');
  assert.equal(plain.firstAt, Date.parse('2026-08-01T10:00:08.000Z'));
  assert.equal(plain.lastAt, Date.parse('2026-08-01T10:30:00.000Z'),
    'outlives the parent tool_result (10:00:06) — async agents do 100% of the time');
});

test('summarise: card counts, badges (retried/running/cached/fragment), mainMsgIds', async () => {
  const m = await getModel();
  const fp = fingerprint([{ rel: 'x', size: 1, mtimeMs: 2 }]);
  const { card, detail } = summarise(m, null, fp);

  assert.equal(card.id, SID);
  assert.equal(card.slug, 'C--fx-projA');
  assert.equal(card.turnCount, 3);
  assert.equal(card.agentCount, 8);
  assert.equal(card.workflowCount, 2);
  assert.equal(card.fingerprint, fp);
  assert.equal(card.cwd, 'C:\\fx\\projA', 'the recorded cwd that re-encodes to the slug');
  assert.equal(card.mainMsgIds.length, 4, 'main-tier message.id list for R2 detection');
  assert.ok(card.badges.includes('running'), 'journal started without result');
  assert.ok(card.badges.includes('cached'), 'workflowProgress cached:true');
  assert.ok(card.badges.includes('retried'), 'more journal starts (4) than manifest agents (2)');
  assert.ok(card.badges.includes('fragment'), 'cross-project fragment dir disclosed');
  assert.ok(!card.badges.includes('forked'), 'no foreign sessionId events');
  assert.equal(card.usageByModel, null, 'no ledger supplied -> unknown, never 0');

  assert.equal(detail.turns.length, 4);
  assert.equal(detail.turns[1].agentIds.length, 6, 'turn 1 owns plain+child+4 workflow agents');
  assert.deepEqual(detail.turns[3].agentIds.sort(), ['aorphan000000001', 'arunning00000001'],
    'both window-attributed agents land in turn 3');
  assert.deepEqual(detail.turns[1].workflowRunIds, [RUN]);
  assert.equal(detail.turns[1].promptHead, 'run the agents');
});

test('summarise with ledger rows: turn usage sums main rows by line and agents whole', async () => {
  const m = await getModel();
  const mainRel = m.main.rel;
  const plainRel = agent(m, 'aplain0000000001').rel;
  const mkRow = (file, line, msgId, over = {}) => ({
    msgId, model: 'claude-opus-5', input: 5, output: 50, cacheRead: 1000,
    cache5m: 100, cache1h: 0, cacheFlat: 0, thinkingTokens: null,
    webSearch: 0, webFetch: 0, speed: 'standard', serviceTier: 'standard',
    stopReason: 'end_turn', at: 0, file, line, ttl: 'recorded',
    finalized: true, synthetic: false, billedElsewhere: null, iterIndex: null, ...over,
  });
  const rows = [
    mkRow(mainRel, 3, 'm1'),           // turn 1 (opener L2, next opener L7)
    mkRow(mainRel, 8, 'm2'),           // turn 2
    mkRow(mainRel, 11, 'm3'),          // turn 3 (final turn -> has a reply)
    mkRow(plainRel, 2, 'm4'),          // agent -> whole within turn 1
  ];
  const { card, detail } = summarise(m, rows, 'fp');
  assert.equal(detail.turns[1].usage.input, 10, 'main L3 + plain agent row');
  assert.equal(detail.turns[2].usage.input, 5);
  assert.equal(detail.turns[3].usage.input, 5);
  assert.equal(detail.turns[0].usage.input, 0, 'preamble billed nothing (a real zero)');
  assert.equal(card.usageByModel['claude-opus-5'].input, 20);
  assert.ok(!card.badges.includes('no-reply'), 'final turn has an assistant group');
  const noReply = summarise(m, rows.slice(0, 2).concat(rows[3]), 'fp').card;
  assert.ok(noReply.badges.includes('no-reply'), 'zero assistant groups in the final turn');
});
