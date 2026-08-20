/**
 * The proof pages: inventory (store-layout classification, the events ledger,
 * the problems drawer), find (scan-order grouping + skip report), audit
 * (invariant-table assembly from the SSE stream), settings (the R10 interval
 * table and its exact multiplier arithmetic), workflow (the five recorded
 * Workflow.input shapes, journal census) and memory (frontmatter + origin
 * session resolution).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRel, ledgerSummary, bucketEvents, impactsTotals, collapseProblems, relFromParams, SNAPSHOT_TYPES } from '../web/js/views/inv.mjs';
import { groupMatchesByScanOrder, contextWindow, skipReport, describeSkips, matchHref, RESULT_CAP } from '../web/js/views/find.mjs';
import { assembleInvariants, valueText, sessionOfRow, censusPairs } from '../web/js/views/audit.mjs';
import { pricingRows, unitsToUsdPerM, fmtRate, fmtInterval, KEYMAP } from '../web/js/views/settings.mjs';
import { describeWorkflowInput, journalCensus, reconcileAgents } from '../web/js/views/workflow.mjs';
import { parseFrontmatter, findOriginSessionId, resolveOrigin } from '../web/js/views/memory.mjs';

/* ==================================================== inventory ======= */

test('classifyRel covers the ten verified store patterns (SPEC §2)', () => {
  assert.equal(classifyRel('0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d.jsonl').class, 'main transcript');
  assert.equal(classifyRel('0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d.jsonl').agentId, 'main');

  const plain = classifyRel('subagents/agent-a0123456789abcde.jsonl');
  assert.equal(plain.class, 'agent transcript');
  assert.equal(plain.agentId, 'a0123456789abcde');
  assert.equal(classifyRel('subagents/agent-a0123456789abcde.meta.json').class, 'agent sidecar');

  const wf = classifyRel('subagents/workflows/wf_00000003-a03/agent-a1.jsonl');
  assert.equal(wf.class, 'workflow agent transcript');
  assert.equal(wf.runId, 'wf_00000003-a03');
  assert.equal(wf.agentId, 'a1');

  assert.equal(classifyRel('subagents/workflows/wf_00000003-a03/journal.jsonl').class, 'workflow journal');
  assert.equal(classifyRel('workflows/wf_00000003-a03.json').class, 'workflow record');

  const script = classifyRel('workflows/scripts/build-wf_00000003-a03.js');
  assert.equal(script.class, 'workflow script');
  assert.equal(script.runId, 'wf_00000003-a03');

  assert.equal(classifyRel('tool-results/bash-out-1.txt').class, 'spilled tool result');
  assert.equal(classifyRel('mem/MEMORY.md').class, 'project memory');
  assert.equal(classifyRel('mem/MEMORY.md').name, 'MEMORY.md');
});

test('a cross-project fragment path keeps both its slug and its inner class (SPEC §9)', () => {
  const frag = classifyRel('frag/other-project/subagents/agent-a9.jsonl');
  assert.equal(frag.fragmentSlug, 'other-project');
  assert.equal(frag.agentId, 'a9');
  assert.match(frag.class, /^fragment \(other-project\) · agent transcript$/);
});

test('an unrecognised path is unclassified — the number the ledger exists to print', () => {
  assert.equal(classifyRel('mystery.bin').class, 'unclassified');
  assert.equal(classifyRel('').class, 'unclassified');
});

test('ledgerSummary produces the closing line', () => {
  const files = [
    { rel: 'a.jsonl', bytes: 100, class: 'main transcript' },
    { rel: 'mem/M.md', bytes: 50 },
    { rel: 'mystery.bin', bytes: 7 },
  ];
  const s = ledgerSummary(files);
  assert.equal(s.files, 3);
  assert.equal(s.classified, 2);
  assert.equal(s.unclassified, 1);
  assert.equal(s.bytes, 157);
});

test('bucketEvents enumerates every not-rendered bucket with its recorded reason', () => {
  const out = bucketEvents({
    perType: { assistant: 50, user: 30, 'last-prompt': 100, 'ai-title': 168, 'unknown:wormhole': 2 },
    rows: 80, tornLines: 0,
  });
  assert.equal(out.parsed, 350);
  assert.equal(out.rendered, 80);
  const buckets = Object.fromEntries(out.notRendered.map((b) => [b.bucket, b]));
  assert.equal(buckets['last-prompt'].count, 100);
  assert.match(buckets['ai-title'].why, /state snapshot/);
  assert.match(buckets['unknown:wormhole'].why, /never dropped/);
  assert.equal(out.notRenderedTotal, 270);
});

test('a torn line becomes its own bucket; zero torn lines produces no bucket', () => {
  assert.equal(bucketEvents({ perType: { assistant: 1 }, rows: 1, tornLines: 0 }).notRendered.length, 0);
  const torn = bucketEvents({ perType: { assistant: 1 }, rows: 1, tornLines: 3 });
  assert.equal(torn.notRendered[0].bucket, 'torn line');
  assert.match(torn.notRendered[0].why, /contributing zero everywhere/);
});

test('bucketEvents reports an unknown row count as unknown, not as zero', () => {
  assert.equal(bucketEvents({ perType: { assistant: 5 } }).rendered, null);
});

test('the six state-snapshot types are the ones SPEC §3 names', () => {
  assert.deepEqual(SNAPSHOT_TYPES, ['last-prompt', 'ai-title', 'custom-title', 'mode', 'pr-link', 'frame-link']);
});

test('impactsTotals is driven by Problem.affects, and says nothing without it', () => {
  assert.match(impactsTotals({ affects: 'aggregates' }), /^yes/);
  assert.match(impactsTotals({ affects: 'display' }), /^no/);
  assert.equal(impactsTotals({ affects: 'nothing' }), 'no');
  assert.equal(impactsTotals({}), null);
});

test('identical code+scope problems collapse to one row carrying the count (SPEC §9)', () => {
  const rows = collapseProblems([
    { code: 'torn-line', scope: 'file', message: 'a' },
    { code: 'torn-line', scope: 'file', message: 'b' },
    { code: 'model-unpriced', scope: 'session', message: 'c', count: 4 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].examples.length, 2);
  assert.equal(rows[1].count, 4);
});

test('relFromParams takes the router remainder and never decodes it twice', () => {
  // router.matchCompiled decodes every segment and supplies both forms.
  assert.equal(
    relFromParams({ rel: 'subagents/workflows/wf_1/journal.jsonl', relSegments: ['subagents', 'workflows', 'wf_1', 'journal.jsonl'] }),
    'subagents/workflows/wf_1/journal.jsonl');
  assert.equal(relFromParams({ rel: 'tool-results/a b.txt' }), 'tool-results/a b.txt');
  assert.equal(
    relFromParams({ rel: 'tool-results/100%25-done.txt', relSegments: ['tool-results', '100%-done.txt'] }),
    'tool-results/100%-done.txt',
    'the already-decoded segments win — decoding the joined form again would corrupt a literal %');
  assert.equal(relFromParams({}), '');
  assert.equal(relFromParams(null), '');
});

/* ========================================================= find ======= */

test('matches group by session in first-appearance (scan) order, never re-sorted', () => {
  const groups = groupMatchesByScanOrder([
    { slug: 'p1', id: 's1', line: 5 }, { slug: 'p2', id: 's2', line: 1 },
    { slug: 'p1', id: 's1', line: 9 }, { slug: 'p2', id: 's2', line: 3 },
  ]);
  assert.deepEqual(groups.map((g) => g.id), ['s1', 's2']);
  assert.deepEqual(groups[0].matches.map((m) => m.line), [5, 9]);
  assert.deepEqual(groups[1].matches.map((m) => m.line), [1, 3]);
});

test('the context window is capped at 80 characters', () => {
  assert.equal(contextWindow('short'), 'short');
  assert.equal(contextWindow('x'.repeat(200)).length, 80);
});

test('the skip report speaks in image payloads and signatures (SPEC §9)', () => {
  const rep = skipReport([
    { reason: 'base64 image payload', bytes: 1000 },
    { reason: 'base64 image payload', bytes: 2000 },
    { reason: 'thinking signature', bytes: 30 },
    { reason: 'something else', bytes: 1 },
  ]);
  assert.equal(rep.images, 2);
  assert.equal(rep.signatures, 1);
  assert.equal(rep.other, 1);
  assert.equal(rep.bytes, 3031);
  assert.match(describeSkips(rep), /2 image payloads and 1 signatures skipped/);
  assert.equal(describeSkips(skipReport([])), '0 spans skipped.');
});

test('a match links to a real L5 address, and a block-less match to the line alone', () => {
  assert.equal(
    matchHref({ slug: 'proj', id: 'sess', file: 'subagents/agent-a1.jsonl', line: 5, bi: '2.1' }),
    '#/p/proj/s/sess/a/a1/e/5.2.1');
  assert.equal(
    matchHref({ slug: 'proj', id: 'sess', file: 'sess.jsonl', line: 5, bi: null }),
    '#/p/proj/s/sess/a/main/e/5', 'no block index means no fabricated one');
});

test('the result cap is the documented 500', () => {
  assert.equal(RESULT_CAP, 500);
});

/* ======================================================== audit ======= */

test('assembleInvariants folds the stream, last report per name winning', () => {
  const model = assembleInvariants([
    { name: 'never-finalized', pass: false, expected: 1584, actual: 1583 },
    { name: 'never-finalized', pass: true, expected: 1584, actual: 1584 },
    { name: 'torn-lines', pass: true, expected: 0, actual: 0 },
  ]);
  assert.equal(model.invariants.length, 2);
  assert.equal(model.total, 2);
  assert.equal(model.passed, 2);
  assert.equal(model.failed, 0);
  assert.equal(model.allPass, true);
});

test('a failing invariant is counted and never rounded away', () => {
  const model = assembleInvariants([
    { name: 'session = Σ turns + channels', pass: true, expected: 85, actual: 85 },
    { name: 'agents over turns == enumerated', pass: false, expected: 821, actual: 820 },
  ]);
  assert.equal(model.failed, 1);
  assert.equal(model.passed, 1);
  assert.equal(model.allPass, false);
});

test('per-session A/B rows are separated from global invariants by name', () => {
  const model = assembleInvariants([
    { name: 'session:proj/sess-1', pass: true, expected: '$1.2345', actual: '$1.2345' },
    { name: 'unpriced census', pass: true, expected: 0, actual: 0 },
  ]);
  assert.equal(model.sessions.length, 1);
  assert.equal(model.invariants.length, 1);
  assert.deepEqual(sessionOfRow(model.sessions[0]), { slug: 'proj', id: 'sess-1' });
});

test('an invariant reported without a verdict is not counted as passing', () => {
  const model = assembleInvariants([{ name: 'x', expected: 1, actual: 1 }]);
  assert.equal(model.total, 0);
  assert.equal(model.unreported, 1);
  assert.equal(model.allPass, false, 'no verdict is not a pass');
});

test('assembleInvariants tolerates an empty or junk stream', () => {
  const empty = assembleInvariants([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.allPass, false);
  assert.equal(assembleInvariants([null, {}, { name: null }]).rows.length, 0);
});

test('valueText renders recorded values without inventing one', () => {
  assert.equal(valueText(0), '0');
  assert.equal(valueText(null), null);
  assert.equal(valueText(undefined), null);
  assert.equal(valueText({ a: 1 }), '{ "a": 1 }');
});

test('censusPairs puts both paths side by side and marks disagreement', () => {
  const pairs = censusPairs({ pathA: { files: 197, bytes: 100 }, pathB: { files: 197, bytes: 101 } });
  const by = Object.fromEntries(pairs.map((p) => [p.key, p]));
  assert.equal(by.files.equal, true);
  assert.equal(by.bytes.equal, false);
  assert.equal(censusPairs({}), null);
});

/* ===================================================== settings ======= */

test('rate units convert exactly to USD per Mtok (SPEC §6)', () => {
  assert.equal(unitsToUsdPerM(500), 0.25, 'haiku-3 = 500 units = $0.25/M');
  assert.equal(unitsToUsdPerM(10000), 5);
  assert.equal(unitsToUsdPerM(null), null);
});

test('pricingRows applies the three multipliers exactly', () => {
  const rows = pricingRows({ 'haiku-3': [{ from: null, to: null, inputU: 500, outputU: 2500 }] });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.input, 0.25);
  assert.equal(r.output, 1.25);
  assert.equal(r.cacheWrite5m, 0.3125, 'cache write 5m = 1.25 × input');
  assert.equal(r.cacheWrite1h, 0.5, 'cache write 1h = 2 × input');
  assert.equal(r.cacheRead, 0.025, 'cache read = 0.1 × input');
});

test('pricingRows flattens an interval list into one row per interval (R10)', () => {
  const rows = pricingRows({
    'sonnet-5': [
      { from: null, to: '2026-08-31', inputU: 4000, outputU: 20000 },
      { from: '2026-09-01', to: null, inputU: 6000, outputU: 30000 },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].input, 2, 'the intro interval is $2/M');
  assert.equal(rows[1].input, 3, 'the post-intro interval is $3/M');
  assert.equal(fmtInterval(rows[0].from, rows[0].to), '… → 2026-08-31');
  assert.equal(fmtInterval(rows[1].from, rows[1].to), '2026-09-01 → …');
  assert.equal(fmtInterval(null, null), 'always (open-ended both ways)');
});

test('fmtRate prints whole dollars to 2dp and fractions without trailing zeros', () => {
  assert.equal(fmtRate(5), '$5.00/M');
  assert.equal(fmtRate(0.25), '$0.25/M');
  assert.equal(fmtRate(0.025), '$0.025/M');
  assert.equal(fmtRate(null), null);
});

test('the keyboard sheet is DESIGN §5 in full', () => {
  const keys = KEYMAP.map(([k]) => k);
  for (const k of ['j / k', 'Enter', 'u', '[ / ]', '/', '\\', 'g0 – g5', 't', '?']) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
});

/* ===================================================== workflow ======= */

test('all five recorded Workflow.input shapes are named, never collapsed', () => {
  assert.equal(describeWorkflowInput({ script: 'console.log(1)' }).shape, 'inline script');
  assert.equal(describeWorkflowInput({ scriptPath: '/x.js' }).shape, 'scriptPath');
  assert.equal(describeWorkflowInput({ name: 'build' }).shape, 'registered workflow');
  assert.equal(describeWorkflowInput({ name: 'build', args: { a: 1 } }).shape, 'registered workflow with args');
  const resume = describeWorkflowInput({ resumeFromRunId: 'wf_1' });
  assert.equal(resume.shape, 'resume');
  assert.equal(resume.detail, 'wf_1');
  assert.match(resume.note, /same run directory in place/);
});

test('an absent or unrecognised Workflow.input says so rather than guessing', () => {
  assert.equal(describeWorkflowInput(null).shape, 'not recorded');
  assert.match(describeWorkflowInput(null).reason, /no Workflow tool_use input is recorded/);
  assert.equal(describeWorkflowInput({ mystery: 1 }).shape, 'unrecognised shape');
});

test('a resume is detected even when other keys are present', () => {
  assert.equal(describeWorkflowInput({ resumeFromRunId: 'wf_1', name: 'build' }).shape, 'resume');
});

test('journalCensus joins on agentId only, and detects a retry', () => {
  const c = journalCensus([
    { type: 'started', key: 'v2:aaa', agentId: 'a1' },
    { type: 'started', key: 'v2:aaa', agentId: 'a1' },   // same non-unique key, same agent: a retry
    { type: 'result', key: 'v2:aaa', agentId: 'a1', result: 'ok' },
    { type: 'started', key: 'v2:bbb', agentId: 'a2' },
  ]);
  assert.equal(c.startedEvents, 3);
  assert.equal(c.resultEvents, 1);
  assert.deepEqual(c.running, ['a2']);
  assert.equal(c.retried, true);
});

test('a journal entry with no agentId joins to nothing and is counted', () => {
  const c = journalCensus([{ type: 'started', key: 'v2:x' }]);
  assert.equal(c.noAgentId, 1);
  assert.equal(c.startedEvents, 0);
});

test('reconcileAgents splits on-disk-but-unlisted into running and superseded (SPEC §7)', () => {
  const r = reconcileAgents({
    manifestIds: ['a1'],
    transcriptIds: ['a1', 'a2', 'a3'],
    journal: [
      { type: 'started', agentId: 'a2' },
      { type: 'started', agentId: 'a3' }, { type: 'result', agentId: 'a3', result: 'x' },
    ],
  });
  assert.deepEqual(r.onDiskNotInManifest, ['a2', 'a3']);
  assert.deepEqual(r.running, ['a2']);
  assert.deepEqual(r.superseded, ['a3']);
  assert.deepEqual(r.inManifestNotOnDisk, []);
  assert.equal(r.transcriptCount, 3, 'enumeration is the directory listing, not the manifest');
});

/* ======================================================= memory ======= */

const MEMO = `---
title: Playback Lens notes
metadata:
  originSessionId: dd000000-1111-2222-3333-444455556666
  author: fleet
tags:
  - lens
  - design
---
# Body

Some text.
`;

test('parseFrontmatter splits the block and parses the recorded subset', () => {
  const out = parseFrontmatter(MEMO);
  assert.equal(out.hasFrontmatter, true);
  assert.equal(out.frontmatter.title, 'Playback Lens notes');
  assert.equal(out.frontmatter.metadata.originSessionId, 'dd000000-1111-2222-3333-444455556666');
  assert.equal(out.frontmatter.metadata.author, 'fleet');
  assert.deepEqual(out.frontmatter.tags, ['lens', 'design']);
  assert.match(out.body, /^# Body/);
  assert.match(out.raw, /^title: Playback Lens notes/);
});

test('a file with no frontmatter keeps its whole text as the body', () => {
  const out = parseFrontmatter('# Just a heading\n');
  assert.equal(out.hasFrontmatter, false);
  assert.equal(out.frontmatter, null);
  assert.equal(out.body, '# Just a heading\n');
});

test('findOriginSessionId reads both recorded placements', () => {
  assert.equal(findOriginSessionId({ metadata: { originSessionId: 'a' } }), 'a');
  assert.equal(findOriginSessionId({ originSessionId: 'b' }), 'b');
  assert.equal(findOriginSessionId({}), null);
  assert.equal(findOriginSessionId(null), null);
});

test('an origin session that resolves, cross-links, or dangles is named exactly (SPEC §8)', () => {
  const sessions = [{ id: 's-here', slug: 'proj-a' }, { id: 's-there', slug: 'proj-b' }];
  assert.equal(resolveOrigin('s-here', sessions, 'proj-a').state, 'resolved');

  const cross = resolveOrigin('s-there', sessions, 'proj-a');
  assert.equal(cross.state, 'cross-project');
  assert.equal(cross.slug, 'proj-b');

  const gone = resolveOrigin('s-deleted', sessions, 'proj-a');
  assert.equal(gone.state, 'dangling');
  assert.match(gone.message, /session not on disk/);

  assert.equal(resolveOrigin(null, sessions, 'proj-a').state, 'none');
});
