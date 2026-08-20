/**
 * L3 orchestration: recorded-state → glyph selection (SPEC §7), lane grouping
 * incl. the two fact-named orphan groups, the resumed-run reference-row
 * decision, the ±1 occupancy arithmetic, and the tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentGlyph, stateSignature, agentTags, normalizeAgent, classifyRun, buildLanes,
  buildTree, occupancySegments, laneBounds, parseSel, laneLabel, STATE_GLYPHS, AUTO_COLLAPSE_AGENTS,
} from '../web/js/views/l3.mjs';

/* -------------------------------------------------- glyph selection */

test('a manifest state of done/error gives ✓/✗ and names workflowProgress as its source', () => {
  const done = agentGlyph({ state: 'done' });
  assert.equal(done.code, 'done');
  assert.equal(done.glyph, '✓');
  assert.equal(done.source, 'workflowProgress[].state');

  const err = agentGlyph({ state: 'error' });
  assert.equal(err.code, 'error');
  assert.equal(err.glyph, '✗');
  assert.equal(err.source, 'workflowProgress[].state');
});

test('journal start with no result is ⋯ running, sourced to the journal (SPEC §7)', () => {
  const g = agentGlyph({ journal: { started: true } });
  assert.equal(g.code, 'running');
  assert.equal(g.glyph, '⋯');
  assert.equal(g.label, 'running — journal records a start, no result yet');
  assert.match(g.source, /journal/);
  assert.ok(!/workflowProgress/.test(g.source), 'with no manifest the glyph source must be the journal, never workflowProgress');
});

test('a recorded result that is genuinely empty is ∅, and outranks a done state', () => {
  assert.equal(agentGlyph({ journal: { result: '' } }).code, 'no-result');
  assert.equal(agentGlyph({ journal: { result: '' } }).glyph, '∅');
  assert.equal(agentGlyph({ state: 'done', journal: { result: '' } }).code, 'no-result',
    '∅ is reserved for a recorded result that is genuinely empty');
  assert.equal(agentGlyph({ state: 'done', journal: { result: 'ok' } }).code, 'done');
});

test('an error state outranks everything — a failed run never renders as empty', () => {
  assert.equal(agentGlyph({ state: 'error', journal: { result: '' } }).code, 'error');
});

test('nothing recorded renders — with a reason, never a ✓ and never a 0', () => {
  const g = agentGlyph({});
  assert.equal(g.code, 'unrecorded');
  assert.equal(g.glyph, '—');
  assert.equal(g.source, null);
  assert.notEqual(g.glyph, STATE_GLYPHS.done.glyph);
  assert.notEqual(g.glyph, STATE_GLYPHS['no-result'].glyph);
});

test('an unobserved recorded state is shown as itself, not forced into the pair', () => {
  const g = agentGlyph({ state: 'cancelled' });
  assert.equal(g.code, 'other');
  assert.equal(g.label, 'cancelled');
});

test('stateSignature reads the recorded fields without inventing an empty result', () => {
  const sig = stateSignature({ journal: { started: true } });
  assert.equal(sig.journalStarted, true);
  assert.equal(sig.hasResult, null, 'no result recorded is not the same as an empty result');
  assert.equal(sig.resultEmpty, null);
});

/* -------------------------------------------------------------- tags */

test('cached and worktree are lane tags carrying their recorded wording', () => {
  const cached = agentTags({ cached: true });
  assert.equal(cached[0].text, '— cached');
  assert.match(cached[0].title, /replayed from an earlier attempt of this run/);

  const wt = agentTags({ worktreePath: 'C:/tmp/wt-1' });
  assert.equal(wt[0].text, '⌂ worktree');
  assert.match(wt[0].title, /C:\/tmp\/wt-1/);

  assert.deepEqual(agentTags({}), []);
});

/* ------------------------------------------------ resumed-run decision */

test('a run whose first spawning call is in another turn becomes a reference row', () => {
  const c = classifyRun({ runId: 'wf_1', turnIdx: 1 }, 2);
  assert.equal(c.kind, 'resumed-reference');
  assert.equal(c.countedInTurn, 1);
  assert.match(c.reason, /first spawning call is in turn 1/);
  assert.match(c.reason, /zero tokens/);
});

test('a run spawned in this turn is owned by it, resumed here or not', () => {
  assert.equal(classifyRun({ turnIdx: 2 }, 2).kind, 'owned');
  const both = classifyRun({ turnIdx: 2, resumedInTurns: [2] }, 2);
  assert.equal(both.kind, 'owned');
  assert.match(both.reason, /counted once/);
});

test('a run with no recorded owning turn is rendered where its agents are, and says so', () => {
  const c = classifyRun({ runId: 'wf_x' }, 4);
  assert.equal(c.kind, 'owned');
  assert.equal(c.countedInTurn, null);
  assert.match(c.reason, /no owning turn recorded/);
});

/* --------------------------------------------------------- lane model */

const AGENTS = [
  { agentId: 'a1', runId: 'wf_1', state: 'done', inManifest: true, firstAt: 1000, lastAt: 2000, spawnDepth: 1 },
  { agentId: 'a2', runId: 'wf_1', inManifest: false, journal: { started: true }, firstAt: 1500, lastAt: 2500, spawnDepth: 1 },
  { agentId: 'a3', runId: 'wf_1', inManifest: false, journal: { started: true, result: 'done' }, firstAt: 1200, lastAt: 1300, spawnDepth: 1 },
  { agentId: 'a4', toolUseId: 'toolu_1', firstAt: 900, lastAt: 1000, spawnDepth: 1 },
  { agentId: 'a5', parentAgentId: 'a4', firstAt: 950, lastAt: 990, spawnDepth: 2 },
];

test('buildLanes splits manifest-absent agents into the two fact-named groups', () => {
  const model = buildLanes({ turnIdx: 3, agents: AGENTS, workflows: [{ runId: 'wf_1', turnIdx: 3, workflowName: 'build' }] });
  const kinds = model.groups.map((g) => g.kind);
  assert.deepEqual(kinds, ['run', 'orphan-running', 'orphan-superseded', 'plain']);

  const [run, running, superseded, plain] = model.groups;
  assert.equal(run.label, 'build');
  assert.deepEqual(run.agents.map((x) => x.agentId), ['a1']);
  assert.equal(running.label, 'running — journal records a start, no result yet');
  assert.deepEqual(running.agents.map((x) => x.agentId), ['a2']);
  assert.equal(superseded.label, 'superseded attempt');
  assert.deepEqual(superseded.agents.map((x) => x.agentId), ['a3']);
  assert.deepEqual(plain.agents.map((x) => x.agentId), ['a4', 'a5']);
  assert.equal(model.agentCount, 5);
  assert.deepEqual(model.referenceRows, []);
});

test('lanes sort by recorded start; agents with no timestamp sort last, never first', () => {
  const model = buildLanes({
    turnIdx: 1,
    agents: [
      { agentId: 'z', toolUseId: 't', firstAt: null, lastAt: null },
      { agentId: 'b', toolUseId: 't', firstAt: 200, lastAt: 300 },
      { agentId: 'a', toolUseId: 't', firstAt: 100, lastAt: 150 },
    ],
    workflows: [],
  });
  assert.deepEqual(model.groups[0].agents.map((x) => x.agentId), ['a', 'b', 'z']);
});

test('a resumed run contributes a reference row instead of lanes', () => {
  const model = buildLanes({ turnIdx: 2, agents: AGENTS, workflows: [{ runId: 'wf_1', turnIdx: 1, workflowName: 'build' }] });
  assert.equal(model.groups.some((g) => g.runId === 'wf_1'), false, 'the run itself must not draw lanes in the resuming turn');
  assert.equal(model.referenceRows.length, 1);
  assert.equal(model.referenceRows[0].countedInTurn, 1);
  assert.equal(model.referenceRows[0].agentCount, 3);
});

test('groups auto-collapse above 24 agents (DESIGN §3)', () => {
  const many = Array.from({ length: AUTO_COLLAPSE_AGENTS + 1 }, (_, i) => ({
    agentId: `a${i}`, runId: 'wf_big', inManifest: true, state: 'done', firstAt: i * 10, lastAt: i * 10 + 5,
  }));
  const model = buildLanes({ turnIdx: 1, agents: many, workflows: [{ runId: 'wf_big', turnIdx: 1 }] });
  assert.equal(model.groups[0].collapsed, true);
  assert.equal(model.groups[0].autoCollapsed, true);

  const few = buildLanes({ turnIdx: 1, agents: many.slice(0, 3), workflows: [{ runId: 'wf_big', turnIdx: 1 }] });
  assert.equal(few.groups[0].collapsed, false);
});

test('an agent with no recorded spawn edge lands in its own group with the rule printed', () => {
  const model = buildLanes({ turnIdx: 1, agents: [{ agentId: 'orphan', firstAt: 5, lastAt: 6 }], workflows: [] });
  assert.equal(model.groups[0].kind, 'unlinked');
  assert.match(model.groups[0].note, /time-window fallback/);
});

test('a run named by the turn but with no agents still gets a row', () => {
  const model = buildLanes({ turnIdx: 1, agents: [], workflows: [{ runId: 'wf_empty', turnIdx: 1 }] });
  assert.equal(model.groups.length, 1);
  assert.equal(model.groups[0].runId, 'wf_empty');
  assert.deepEqual(model.groups[0].agents, []);
});

/* ------------------------------------------------------ normalisation */

test('normalizeAgent takes the bar from the transcript, and the queue from the manifest', () => {
  const ag = normalizeAgent({
    agentId: 'a1', firstAt: 1000, lastAt: 5000,
    progress: { queuedAt: 500, startedAt: 900, state: 'done', label: 'phase one', model: 'opus-5' },
  });
  assert.equal(ag.firstAt, 1000, 'the agent bar is its own transcript (SPEC §4)');
  assert.equal(ag.lastAt, 5000);
  assert.equal(ag.queuedAt, 500);
  assert.equal(ag.progStartedAt, 900);
  assert.equal(ag.label, 'phase one');
  assert.equal(ag.labelSource, 'workflowProgress[].label');
  assert.equal(ag.model, 'opus-5');
});

test('normalizeAgent keeps a missing timestamp missing', () => {
  const ag = normalizeAgent({ agentId: 'a1' });
  assert.equal(ag.firstAt, null);
  assert.equal(ag.lastAt, null);
  assert.equal(ag.queuedAt, null);
  assert.equal(ag.spawnDepth, null);
});

test('laneLabel falls back through the recorded sources', () => {
  assert.equal(laneLabel({ label: 'writer', agentId: 'a1' }), 'writer');
  assert.equal(laneLabel({ agentType: 'Explore', agentId: 'a0123456789abcdef' }), 'Explore a012345678');
  assert.equal(laneLabel({ agentId: 'a1' }), 'a1');
});

/* ------------------------------------------------------------ bounds */

test('laneBounds spans the recorded turn and agent timestamps', () => {
  const b = laneBounds({
    turn: { at: 1000, endAt: 4000 },
    agents: [{ queuedAt: 800, firstAt: 1200, lastAt: 6000, progStartedAt: 1100 }],
  });
  assert.equal(b.t0, 800);
  assert.equal(b.t1, 6000);
  assert.equal(b.span, 5200);
});

test('laneBounds returns null when nothing is recorded', () => {
  assert.equal(laneBounds({ turn: {}, agents: [] }), null);
});

/* --------------------------------------------------------- occupancy */

// UI-8 + helper unification: the strip consumes the shared occupancy's EXACT
// segments — one per stretch of constant concurrency, an end at t processed
// before a start at t. No binned projection remains.
test('occupancySegments is exact ±1 arithmetic over recorded intervals', () => {
  const agents = [{ firstAt: 0, lastAt: 10 }, { firstAt: 5, lastAt: 15 }];
  const occ = occupancySegments(agents, 0, 20);
  assert.deepEqual(occ.segments, [
    { start: 0, end: 5, n: 1 },
    { start: 5, end: 10, n: 2 },
    { start: 10, end: 15, n: 1 },
  ]);
  assert.equal(occ.max, 2);
});

test('occupancySegments ignores agents with fewer than two recorded timestamps, and says so', () => {
  const agents = [{ firstAt: 0, lastAt: 10 }, { firstAt: 5, lastAt: null }];
  const occ = occupancySegments(agents, 0, 20);
  assert.deepEqual(occ.segments, [{ start: 0, end: 10, n: 1 }]);
  assert.equal(occ.pointOnly, 1, 'a one-timestamp agent is counted apart, never given invented width');
  assert.deepEqual(occupancySegments([], 0, 10).segments, []);
  assert.deepEqual(occupancySegments([{ firstAt: 1, lastAt: 2 }], 5, 5).segments, [],
    'a zero-width window yields no segments, not a divide-by-zero');
});

/* -------------------------------------------------------------- tree */

test('buildTree nests main → workflow → phase → agent → child', () => {
  const model = buildLanes({
    turnIdx: 1,
    agents: [
      { agentId: 'a1', runId: 'wf_1', inManifest: true, phase: 'plan', firstAt: 1, lastAt: 2 },
      { agentId: 'a2', runId: 'wf_1', inManifest: true, phase: 'build', firstAt: 3, lastAt: 4 },
      { agentId: 'a3', runId: 'wf_1', inManifest: true, phase: 'build', parentAgentId: 'a2', firstAt: 3, lastAt: 4 },
    ],
    workflows: [{ runId: 'wf_1', turnIdx: 1, workflowName: 'build' }],
  });
  const nodes = buildTree(model);
  assert.equal(nodes[0].key, 'main');
  const run = nodes.find((n) => n.kind === 'workflow');
  assert.deepEqual(run.children.map((c) => c.label), ['phase plan', 'phase build']);
  const buildPhase = run.children[1];
  assert.equal(buildPhase.children.length, 1, 'a child agent hangs off its recorded parent, not off the phase');
  assert.equal(buildPhase.children[0].key, 'a:a2');
  assert.equal(buildPhase.children[0].children[0].key, 'a:a3');
});

test('buildTree collapses the phase level when no phase is recorded', () => {
  const model = buildLanes({
    turnIdx: 1,
    agents: [{ agentId: 'a1', runId: 'wf_1', inManifest: true, firstAt: 1, lastAt: 2 }],
    workflows: [{ runId: 'wf_1', turnIdx: 1 }],
  });
  const run = buildTree(model).find((n) => n.kind === 'workflow');
  assert.deepEqual(run.children.map((c) => c.kind), ['agent']);
});

test('buildTree carries the reference row with its counted-in turn', () => {
  const model = buildLanes({ turnIdx: 2, agents: AGENTS, workflows: [{ runId: 'wf_1', turnIdx: 1 }] });
  const ref = buildTree(model).find((n) => n.kind === 'reference');
  assert.equal(ref.countedInTurn, 1);
  assert.equal(ref.reference, true);
});

/* --------------------------------------------------------------- sel */

test('parseSel understands every selection form', () => {
  assert.deepEqual(parseSel(null), { kind: 'main', key: 'main' });
  assert.deepEqual(parseSel('main'), { kind: 'main', key: 'main' });
  assert.equal(parseSel('a:a123').kind, 'agent');
  assert.equal(parseSel('a:a123').agentId, 'a123');
  assert.equal(parseSel('w:wf_1').kind, 'workflow');
  assert.equal(parseSel('w:wf_1').runId, 'wf_1');
  assert.equal(parseSel('w:wf_1|ph:build').kind, 'phase');
  assert.equal(parseSel('w:wf_1|ph:build').runId, 'wf_1');
  assert.equal(parseSel('g:plain').kind, 'group', 'R11-F1: the non-run group keys the tree links to');
  assert.equal(parseSel('g:unlinked').kind, 'group');
  assert.equal(parseSel('garbage').kind, 'unknown');
});

/**
 * R11-F1 — the invariant that would have caught the dead group-header link:
 * treeView() builds every row's href straight from node.key, so ANY key
 * buildTree() emits that parseSel() does not name renders a link which selects
 * nothing while the row still paints itself selected.
 */
test('R11-F1 invariant: every key buildTree emits parses to a kind parseSel names', () => {
  const model = buildLanes({
    turnIdx: 1,
    agents: [
      ...AGENTS,
      { agentId: 'a6', runId: 'wf_1', inManifest: true, phase: 'plan', firstAt: 1, lastAt: 2 },
      { agentId: 'a7', firstAt: 5, lastAt: 6 },                  // -> 'unlinked'
    ],
    workflows: [
      { runId: 'wf_1', turnIdx: 1, workflowName: 'build' },
      { runId: 'wf_ref', turnIdx: 0, workflowName: 'earlier' },  // -> reference row
    ],
  });
  const keys = [];
  const walk = (n) => { keys.push(n); for (const c of n.children ?? []) walk(c); };
  for (const n of buildTree(model)) walk(n);

  // the shapes this turn actually produces — proof the sweep is not vacuous
  const kinds = new Set(keys.map((n) => n.kind));
  for (const want of ['main', 'workflow', 'phase', 'agent', 'plain', 'unlinked', 'orphan-running', 'orphan-superseded']) {
    assert.ok(kinds.has(want), `the fixture must exercise a ${want} node`);
  }
  for (const node of keys) {
    if (node.reference) continue;   // reference rows render as a span, not a link
    const parsed = parseSel(node.key);
    assert.notEqual(parsed.kind, 'unknown',
      `buildTree emitted key "${node.key}" (kind ${node.kind}), which parseSel does not recognise — its tree link would be inert`);
    assert.equal(parsed.key, node.key, 'and the parsed key must round-trip, so the row highlight is truthful');
  }
});

test('R11-F1: the two non-run groups carry scheme-qualified keys; the orphan groups keep theirs', () => {
  const model = buildLanes({
    turnIdx: 3,
    agents: [...AGENTS, { agentId: 'a9', firstAt: 5, lastAt: 6 }],
    workflows: [{ runId: 'wf_1', turnIdx: 3, workflowName: 'build' }],
  });
  const byKind = Object.fromEntries(buildTree(model).map((n) => [n.kind, n]));
  assert.equal(byKind.plain.key, 'g:plain');
  assert.equal(byKind.unlinked.key, 'g:unlinked');
  assert.equal(byKind['orphan-running'].key, 'w:wf_1:running',
    'blanket-prefixing would have turned this into g:w:… and broken its working workflow parse');
  assert.equal(byKind['orphan-superseded'].key, 'w:wf_1:superseded');
  // the LANE model keeps the bare keys — `l3.collapsed.${g.key}` prefs and the
  // group-shape tests are keyed on them, and the fix must not move them.
  const laneKeys = model.groups.map((g) => g.key);
  assert.ok(laneKeys.includes('plain'), 'buildLanes keys are unchanged');
  assert.ok(laneKeys.includes('unlinked'), 'buildLanes keys are unchanged');
});

/* ------------------------------------------------- R11-F2 lineage cycles */

/**
 * A recorded parentAgentId cycle left every member without a root, and node()
 * recurses from roots only — so the whole cycle (plus any innocent descendant
 * of one) vanished from the tree while the group header kept counting it.
 * The invariant: the leaves under buildTree total the model's agentCount.
 */
const leafCount = (nodes) => {
  let n = 0;
  const walk = (node) => { if (node.kind === 'agent') n += 1; for (const c of node.children ?? []) walk(c); };
  for (const node of nodes) walk(node);
  return n;
};
const cyclicLeaves = (agents) => {
  const model = buildLanes({ turnIdx: 1, agents, workflows: [] });
  return { model, nodes: buildTree(model) };
};

test('R11-F2: every agent-leaf shape renders exactly once — a lineage cycle never silently drops rows', () => {
  const shapes = {
    '2-cycle A<->B': [
      { agentId: 'A', parentAgentId: 'B', toolUseId: 't', firstAt: 1, lastAt: 2 },
      { agentId: 'B', parentAgentId: 'A', toolUseId: 't', firstAt: 1, lastAt: 2 },
    ],
    '3-cycle X->Y->Z->X': [
      { agentId: 'X', parentAgentId: 'Y', toolUseId: 't', firstAt: 1, lastAt: 2 },
      { agentId: 'Y', parentAgentId: 'Z', toolUseId: 't', firstAt: 1, lastAt: 2 },
      { agentId: 'Z', parentAgentId: 'X', toolUseId: 't', firstAt: 1, lastAt: 2 },
    ],
    'self-parent S->S beside a normal agent': [
      { agentId: 'S', parentAgentId: 'S', toolUseId: 't', firstAt: 1, lastAt: 2 },
      { agentId: 'N', toolUseId: 't', firstAt: 1, lastAt: 2 },
    ],
    'innocent child A->B hanging off a B<->C cycle': [
      { agentId: 'A', parentAgentId: 'B', toolUseId: 't', firstAt: 1, lastAt: 2 },
      { agentId: 'B', parentAgentId: 'C', toolUseId: 't', firstAt: 1, lastAt: 2 },
      { agentId: 'C', parentAgentId: 'B', toolUseId: 't', firstAt: 1, lastAt: 2 },
    ],
  };
  for (const [name, agents] of Object.entries(shapes)) {
    const { model, nodes } = cyclicLeaves(agents);
    assert.equal(model.agentCount, agents.length, `${name}: the lane model counts them all`);
    assert.equal(leafCount(nodes), agents.length,
      `${name}: the tree must render one leaf per counted agent — the header count and the leaves cannot disagree`);
  }
});

test('R11-F2: the cycle break is DISCLOSED on the row, and only the cycle members are unnested', () => {
  const { nodes } = cyclicLeaves([
    { agentId: 'A', parentAgentId: 'B', toolUseId: 't', firstAt: 1, lastAt: 2 },
    { agentId: 'B', parentAgentId: 'C', toolUseId: 't', firstAt: 1, lastAt: 2 },
    { agentId: 'C', parentAgentId: 'B', toolUseId: 't', firstAt: 1, lastAt: 2 },
  ]);
  const flat = [];
  const walk = (n) => { flat.push(n); for (const c of n.children ?? []) walk(c); };
  for (const n of nodes) walk(n);
  const of = (id) => flat.find((n) => n.key === `a:${id}`);
  assert.equal(of('B').cycleRoot, true, 'B is in the cycle, so it is rooted and marked');
  assert.equal(of('C').cycleRoot, true);
  assert.equal(of('A').cycleRoot, false, 'A\'s own chain never returns to A — it stays nested under its recorded parent');
  assert.equal(of('B').children.map((c) => c.key).includes('a:A'), true,
    'the narrow rule cuts only the back-edge; the innocent descendant keeps its recorded parent');
});

test('R11-F2: an acyclic tree is untouched — no row is marked and nesting is unchanged', () => {
  const { nodes } = cyclicLeaves([
    { agentId: 'p', toolUseId: 't', firstAt: 1, lastAt: 2 },
    { agentId: 'c', parentAgentId: 'p', toolUseId: 't', firstAt: 1, lastAt: 2 },
  ]);
  const group = nodes.find((n) => n.kind === 'plain');
  assert.equal(group.children.length, 1);
  assert.equal(group.children[0].key, 'a:p');
  assert.equal(group.children[0].cycleRoot, false);
  assert.equal(group.children[0].children[0].key, 'a:c');
  assert.equal(group.children[0].children[0].cycleRoot, false);
});
