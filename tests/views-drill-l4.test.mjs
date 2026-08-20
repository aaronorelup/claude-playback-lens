/**
 * L4 agent: tool-span pairing BY RECORDED ID (DESIGN §3), the censuses that
 * feed the header, the SPEC §8 file-path harvest with its denominator, the
 * header facts and their named sources, and the ?v=raw window arithmetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pairToolSpans, toolHistogram, attributionCensus, census, censusText,
  harvestPaths, headerFacts, windowFor, RAW_WINDOW,
  toolUseIdOf, toolResultIdOf, toolNameOf,
} from '../web/js/views/l4.mjs';

const use = (line, id, name, extra = {}) => ({ kind: 'tool_use', line, at: line * 100, extra: { id, name, ...extra } });
const result = (line, id, extra = {}) => ({ kind: 'tool_result', line, at: line * 100, extra: { tool_use_id: id, ...extra } });

/* ------------------------------------------------------ span pairing */

test('a tool_use pairs with the tool_result carrying the SAME recorded id', () => {
  const { spans, unmatchedUses, unmatchedResults } = pairToolSpans([
    use(10, 't1', 'Read'), use(12, 't2', 'Bash'), result(20, 't1', { is_error: false }),
  ]);
  assert.equal(spans.length, 2);
  const [t1, t2] = spans;
  assert.equal(t1.matched, true);
  assert.equal(t1.startLine, 10);
  assert.equal(t1.endLine, 20);
  assert.equal(t1.startAt, 1000);
  assert.equal(t1.endAt, 2000);
  assert.equal(t1.isError, false);
  assert.equal(t2.matched, false);
  assert.deepEqual(unmatchedUses.map((x) => x.id), ['t2']);
  assert.deepEqual(unmatchedResults, []);
});

test('pairing never falls back to adjacency', () => {
  const { spans, unmatchedUses, unmatchedResults } = pairToolSpans([use(1, 'tA', 'Read'), result(2, 'tB')]);
  assert.equal(spans[0].matched, false, 'the neighbouring result carries a different id, so there is no span');
  assert.equal(unmatchedUses.length, 1);
  assert.deepEqual(unmatchedResults.map((x) => x.id), ['tB']);
});

test('a repeated id pairs first-open-first, in file order', () => {
  const { spans } = pairToolSpans([use(1, 'dup', 'Read'), use(2, 'dup', 'Read'), result(3, 'dup'), result(4, 'dup')]);
  assert.equal(spans[0].endLine, 3);
  assert.equal(spans[1].endLine, 4);
});

test('an unmatched tool_use keeps its recorded toolDenialKind for the ∅ tick', () => {
  const { unmatchedUses } = pairToolSpans([use(5, 't9', 'Edit', { toolDenialKind: 'user-rejected' })]);
  assert.equal(unmatchedUses.length, 1);
  assert.equal(unmatchedUses[0].denialKind, 'user-rejected');
});

test('is_error is tri-state: only === true is an error (SPEC §3)', () => {
  const absent = pairToolSpans([use(1, 't', 'X'), result(2, 't')]).spans[0];
  assert.equal(absent.isError, null, 'an absent key is not "false"');
  assert.equal(pairToolSpans([use(1, 't', 'X'), result(2, 't', { is_error: false })]).spans[0].isError, false);
  assert.equal(pairToolSpans([use(1, 't', 'X'), result(2, 't', { is_error: true })]).spans[0].isError, true);
});

test('a tool_use with no recorded id can never pair', () => {
  const { spans, unmatchedResults } = pairToolSpans([{ kind: 'tool_use', line: 1, at: 1, extra: { name: 'Read' } }, result(2, 'anything')]);
  assert.equal(spans[0].id, null);
  assert.equal(spans[0].matched, false);
  assert.equal(unmatchedResults.length, 1);
});

test('locator accessors read every recorded spelling', () => {
  assert.equal(toolUseIdOf({ extra: { id: 'a' } }), 'a');
  assert.equal(toolUseIdOf({ extra: { toolUseId: 'b' } }), 'b');
  assert.equal(toolResultIdOf({ extra: { tool_use_id: 'c' } }), 'c');
  assert.equal(toolNameOf({ extra: { name: 'Grep' } }), 'Grep');
  assert.equal(toolNameOf({ extra: {} }), null);
});

/* -------------------------------------------------------- histograms */

test('toolHistogram counts recorded tool_use names, most-used first', () => {
  const hist = toolHistogram([use(1, 'a', 'Read'), use(2, 'b', 'Read'), use(3, 'c', 'Bash'), result(4, 'a')]);
  assert.deepEqual(hist, [['Read', 2], ['Bash', 1]]);
});

test('a tool_use with no recorded name is counted, not dropped', () => {
  const hist = toolHistogram([{ kind: 'tool_use', line: 1, extra: {} }]);
  assert.deepEqual(hist, [['(no name recorded)', 1]]);
});

test('attributionCensus reads MCP servers and Skills off the recorded names', () => {
  const hist = toolHistogram([
    use(1, 'a', 'mcp__slack__send_message'), use(2, 'b', 'mcp__slack__read_channel'),
    use(3, 'c', 'mcp__ccd_session__mark_chapter'), use(4, 'd', 'Skill'), use(5, 'e', 'Read'),
  ]);
  const attr = attributionCensus(hist);
  assert.deepEqual(attr.mcp.sort(), [['ccd_session', 1], ['slack', 2]].sort());
  assert.deepEqual(attr.skills, [['Skill', 1]]);
});

test('census reports its own denominator and what was not recorded', () => {
  const c = census([{ extra: { stopReason: 'end_turn' } }, { extra: { stopReason: 'end_turn' } }, { extra: {} }], (r) => r.extra?.stopReason);
  assert.deepEqual(c.entries, [['end_turn', 2]]);
  assert.equal(c.notRecorded, 1);
  assert.equal(c.of, 3);
  assert.equal(censusText(c), 'end_turn 2');
  assert.equal(censusText(census([], () => null)), null);
});

/* ------------------------------------------------------ path harvest */

test('paths come from tool_use.input keyed BY TOOL NAME (SPEC §8)', () => {
  const rows = [
    use(1, 'a', 'Read', { input: { file_path: '/a.txt' } }),
    use(2, 'b', 'Read', { input: { file_path: '/a.txt' } }),
    use(3, 'c', 'Write', { input: { file_path: '/b.txt' } }),
    use(4, 'd', 'Edit', { input: { file_path: '/b.txt' } }),
    use(5, 'e', 'Grep', { input: { path: '/src' } }),
    use(6, 'f', 'NotebookEdit', { input: { notebook_path: '/n.ipynb' } }),
  ];
  const out = harvestPaths(rows);
  const byPath = Object.fromEntries(out.paths.map((p) => [p.path, p]));
  assert.equal(byPath['/a.txt'].read, 2);
  assert.equal(byPath['/b.txt'].write, 1);
  assert.equal(byPath['/b.txt'].edit, 1);
  assert.equal(byPath['/src'].search, 1);
  assert.equal(byPath['/n.ipynb'].edit, 1);
  assert.equal(out.toolCalls, 6);
  assert.equal(out.withPath, 6);
});

test('path-shaped keys inside other tools are payload fields, not file operations', () => {
  const out = harvestPaths([
    use(1, 'a', 'StructuredOutput', { input: { report_path: '/r.md', files_written: ['/x'] } }),
    use(2, 'b', 'mcp__notion__create', { input: { doc_path: '/d' } }),
  ]);
  assert.deepEqual(out.paths, [], 'excluded per SPEC §8');
  assert.equal(out.toolCalls, 2);
  assert.equal(out.withPath, 0, 'the denominator still counts the calls that were examined');
});

test('the harvest counts tool results with no path sidecar — the printed denominator', () => {
  const out = harvestPaths([
    use(1, 'a', 'Read', { input: { file_path: '/a' } }),
    result(2, 'a', { filePath: '/a' }),
    result(3, 'b'),
    result(4, 'c'),
  ]);
  assert.equal(out.resultsWithoutSidecar, 2);
  assert.equal(out.paths.length, 1);
});

/* ------------------------------------------------------ header facts */

test('every header fact names its source, and a missing one carries a reason', () => {
  const facts = headerFacts({
    agentId: 'a0123', agentType: 'Explore', label: 'explorer', labelSource: 'workflowProgress[].label',
    model: 'opus-5', state: 'done', phase: 'plan', attempt: 1, spawnDepth: 2, parentAgentId: 'aPARENT',
    toolUseId: null, runId: 'wf_1', queuedAt: 1000, progStartedAt: 1100, firstAt: 1200, lastAt: 65200,
    durationMs: 64000, cached: false, worktreePath: null,
  });
  const by = Object.fromEntries(facts.map((f) => [f.label, f]));

  assert.equal(by.label.value, 'explorer');
  assert.equal(by.label.source, 'workflowProgress[].label');
  assert.equal(by.agentType.source, 'meta.json agentType');
  assert.equal(by.spawnDepth.value, 2);
  assert.equal(by.wall.value, '1m 4s');
  assert.match(by.wall.source, /arithmetic on the two recorded transcript timestamps/);

  // A missing fact: value null, source null, reason present. Never a zero.
  assert.equal(by['spawn tool_use'].value, null);
  assert.equal(by['spawn tool_use'].source, null);
  assert.match(by['spawn tool_use'].reason, /no spawning tool_use recorded/);
  assert.match(by.parentAgentId.reason, /parent not recorded/);
});

test('a wall figure is never computed from one timestamp', () => {
  const by = Object.fromEntries(headerFacts({ agentId: 'a', firstAt: 1000, lastAt: null }).map((f) => [f.label, f]));
  assert.equal(by.wall.value, null);
  assert.match(by.wall.reason, /needs two recorded timestamps/);
});

test('cwd is deliberately not a header fact (SPEC §2 phantom-project rule)', () => {
  const labels = headerFacts({ agentId: 'a', cwd: 'C:/some/worktree' }).map((f) => f.label);
  assert.ok(!labels.includes('cwd'));
});

test('worktree facts appear only when recorded, and dangle explicitly', () => {
  const plain = headerFacts({ agentId: 'a' }).map((f) => f.label);
  assert.ok(!plain.includes('worktreePath'));

  const wt = Object.fromEntries(
    headerFacts({ agentId: 'a', worktreePath: 'C:/gone', spawnedWithWorktree: true, isolation: 'worktree' }, { worktreeOnDisk: false })
      .map((f) => [f.label, f]));
  assert.equal(wt.worktreePath.value, 'C:/gone');
  assert.equal(wt.worktreePath.note, 'path not on disk');

  const unknownDisk = Object.fromEntries(
    headerFacts({ agentId: 'a', worktreePath: 'C:/maybe' }).map((f) => [f.label, f]));
  assert.match(unknownDisk.worktreePath.note, /not reported by this payload/);
});

test('a cached agent states the replay rule and why its counters are absent', () => {
  const by = Object.fromEntries(headerFacts({ agentId: 'a', cached: true, durationMs: null }).map((f) => [f.label, f]));
  assert.equal(by.cached.value, 'true');
  assert.match(by.cached.note, /replayed from an earlier attempt/);
  assert.match(by['durationMs (manifest)'].reason, /cached replays carry no counters/);
});

test('a recorded [1m] resolvedModel is shown as a fact and noted as priced identically', () => {
  const by = Object.fromEntries(headerFacts({ agentId: 'a', model: 'opus-5', resolvedModel: 'claude-opus-5[1m]' }).map((f) => [f.label, f]));
  assert.equal(by.resolvedModel.value, 'claude-opus-5[1m]');
  assert.match(by.resolvedModel.note, /prices identically/);
});

/* ------------------------------------------------------ raw windows */

test('windowFor aligns to 500-line windows, 1-based', () => {
  assert.deepEqual(windowFor(1), { from: 1, count: RAW_WINDOW });
  assert.deepEqual(windowFor(499), { from: 1, count: 500 });
  assert.deepEqual(windowFor(500), { from: 1, count: 500 });
  assert.deepEqual(windowFor(501), { from: 501, count: 500 });
  assert.deepEqual(windowFor(1234), { from: 1001, count: 500 });
  assert.deepEqual(windowFor(0), { from: 1, count: 500 }, 'line 0 does not exist; clamp to the first window');
});
