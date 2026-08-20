// tests/views-overview-l2.test.mjs — group F, L2 (one session) pure logic.
// Loader rationale is documented in tests/views-overview-l0.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const VIEW_DIR = new URL('../web/js/views/', import.meta.url);
const JS_DIR = new URL('../web/js/', import.meta.url);
// router.mjs / api.mjs are the DOM-facing shell -- stripped as before. The
// LEAF modules (format.mjs, components/*.mjs) are node-loadable and are the
// helper-unification sources, so their imports become real file: URLs.
const STRIP_IMPORT = /^import\s+[^;]*?\s+from\s+'\.\.\/(?:router|api)\.mjs';[ \t]*$/gm;

async function strippedSource(name) {
  let src = await readFile(new URL(`${name}.mjs`, VIEW_DIR), 'utf8');
  src = src.replace(STRIP_IMPORT, '');
  src = src.replace(/from\s+'\.\.\/((?:format|components\/[^']+)\.mjs)'/g,
    (m, rel) => `from '${new URL(rel, JS_DIR).href}'`);
  // cross-view imports of node-loadable group-G modules resolve to the real
  // files. l3 joined the list with R4-UI-2: agentRows reads the ONE phase
  // alias (phaseLabelOf) from there instead of spelling it a third time.
  src = src.replace(/from\s+'\.\/(inv|l3|l5)\.mjs'/g,
    (m, name2) => `from '${new URL(`views/${name2}.mjs`, JS_DIR).href}'`);
  return src;
}
const dataUrl = (code) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code).replace(/'/g, '%27');
async function loadView(name) {
  let code = await strippedSource(name);
  if (name !== 'l0') {
    const l0 = dataUrl(await strippedSource('l0'));
    code = code.replace(/from\s+'\.\/l0\.mjs'/g, `from '${l0}'`);
  }
  return import(dataUrl(code));
}

// The stripped foundation imports leave free identifiers behind. Provide the one
// the pure functions actually call (router.href), mirroring its documented
// behaviour, so link building stays exercised rather than stubbed away.
globalThis.href = (...parts) => {
  const segs = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === null || p === undefined || p === '') continue;
    if (i === parts.length - 1 && typeof p === 'object' && !Array.isArray(p)) continue;
    segs.push(encodeURIComponent(String(p)));
  }
  return '#/' + segs.join('/');
};

const L2 = await loadView('l2');
const T = (iso) => Date.parse(iso);

/* ------------------------------------------------------- degenerate flip */

test('a normal multi-turn session stays on the turn list', () => {
  const d = { turns: [{ idx: 0, preamble: true }, { idx: 1 }, { idx: 2 }, { idx: 3 }], agentCount: 12 };
  assert.deepEqual(L2.chooseSessionView(d, null), { view: 'turns', flipped: false, note: null });
});

test('≤1 non-preamble turn AND agents > 0 flips the default to the agents table', () => {
  const d = { turns: [{ idx: 0, preamble: true }, { idx: 1 }], agentCount: 80 };
  const c = L2.chooseSessionView(d, null);
  assert.equal(c.view, 'agents');
  assert.equal(c.flipped, true);
  assert.match(c.note, /1 non-preamble turn, 80 agents/);
});

test('1 turn and 0 agents stays on the turn list — the flip must not empty the screen', () => {
  // measured: 21 one-turn sessions, 19 of them agentless (DESIGN §3 L2)
  const d = { turns: [{ idx: 0, preamble: true }, { idx: 1 }], agentCount: 0 };
  const c = L2.chooseSessionView(d, null);
  assert.equal(c.view, 'turns');
  assert.equal(c.flipped, false);
  assert.equal(c.note, '1 turn, 0 agents — showing the turn');
});

test('a preamble-only session says so rather than showing an empty table', () => {
  const c = L2.chooseSessionView({ turns: [{ idx: 0, preamble: true }], agentCount: 0 }, null);
  assert.equal(c.view, 'turns');
  assert.match(c.note, /only the preamble/);
});

test('a preamble-only session that has agents still flips', () => {
  const c = L2.chooseSessionView({ turns: [{ idx: 0, preamble: true }], agentCount: 4 }, null);
  assert.equal(c.view, 'agents');
  assert.equal(c.flipped, true);
});

test('an explicit ?v= always wins over the flip, and an unknown ?v= does not', () => {
  const d = { turns: [{ idx: 0, preamble: true }, { idx: 1 }], agentCount: 80 };
  assert.equal(L2.chooseSessionView(d, 'turns').view, 'turns');
  assert.equal(L2.chooseSessionView(d, 'images').view, 'images');
  assert.equal(L2.chooseSessionView(d, 'nonsense').view, 'agents');   // falls back to the default rule
});

test('the agent count falls back to the enumerated agent list', () => {
  assert.equal(L2.agentCountOf({ agents: [{ agentId: 'a' }, { agentId: 'b' }] }), 2);
  assert.equal(L2.agentCountOf({ agentCount: 0, agents: [] }), 0);
  assert.equal(L2.nonPreambleTurns({ turns: [{ preamble: true }, {}, {}] }), 2);
});

/* --------------------------------------------------------- occupancy ±1 */

test('agent occupancy is exact ±1 arithmetic over recorded intervals', () => {
  const o = L2.occupancy([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 20, end: 25 }]);
  assert.deepEqual(o.segments, [
    { start: 0, end: 5, n: 1 },
    { start: 5, end: 10, n: 2 },
    { start: 10, end: 15, n: 1 },
    { start: 15, end: 20, n: 0 },
    { start: 20, end: 25, n: 1 },
  ]);
  assert.equal(o.max, 2);
});

test('an interval that ends exactly where the next begins never reads as 2', () => {
  const o = L2.occupancy([{ start: 0, end: 10 }, { start: 10, end: 20 }]);
  assert.equal(o.max, 1);
  assert.deepEqual(o.segments, [{ start: 0, end: 10, n: 1 }, { start: 10, end: 20, n: 1 }]);
});

test('an agent with a single recorded timestamp has no width and is reported apart', () => {
  const o = L2.occupancy([{ start: 5, end: null }, { start: 0, end: 10 }, { start: 3, end: 3 }]);
  assert.equal(o.pointOnly, 2);
  assert.equal(o.max, 1);
  assert.deepEqual(o.segments, [{ start: 0, end: 10, n: 1 }]);
});

test('no agents means no occupancy at all', () => {
  assert.deepEqual(L2.occupancy([]), { segments: [], max: 0, pointOnly: 0 });
  assert.deepEqual(L2.occupancy(null).segments, []);
});

/* -------------------------------------------------- turn bars + overhang */

const DETAIL = {
  slug: 'C--proj', id: 'sess-1', state: 'ok', bytes: 1000,
  customTitle: 'the rebuild', aiTitle: 'Rebuilding the lens', aiTitleCount: 168,
  mode: 'default', modeCount: 3, lastPromptCount: 4647,
  prLinks: [{ prNumber: 12, prRepository: 'me/repo', prUrl: 'https://github.com/me/repo/pull/12' }],
  frameLinks: [{ frameUrl: 'https://x/y', path: '/y', title: 'a frame' }],
  turnCount: 2, agentCount: 2, workflowCount: 1,
  turns: [
    { idx: 0, preamble: true, at: T('2026-08-17T17:00:00Z'), endedAt: T('2026-08-17T17:05:00Z'), promptHead: '', kinds: { system: 2, attachment: 1 } },
    { idx: 1, at: T('2026-08-17T18:00:00Z'), endedAt: T('2026-08-17T18:30:00Z'), agentIds: ['a1', 'a2'], workflowRunIds: ['wf_00000003-a03'], promptHead: 'first line\nsecond line\nthird line\nfourth line', kinds: { text: 10, tool_use: 4, thinking: 2 } },
    { idx: 2, at: T('2026-08-17T19:00:00Z'), endedAt: null, agentIds: [], promptHead: 'only line' },
  ],
  agents: [
    { agentId: 'a1', firstAt: T('2026-08-17T18:05:00Z'), lastAt: T('2026-08-17T19:30:00Z'), agentType: 'Explore', model: 'opus-5', state: 'done', spawnDepth: 1, turnIdx: 1, lineage: { kind: 'workflow', runId: 'wf_00000003-a03' }, label: { text: 'scout', source: 'workflowProgress.label' } },
    { agentId: 'a2', firstAt: T('2026-08-17T18:10:00Z'), lastAt: T('2026-08-17T18:20:00Z'), agentType: 'Plan', spawnDepth: 1, turnIdx: 1, cached: true, worktreePath: 'D:\\gone' },
  ],
};

test('a turn bar ends at its recorded end; the hatched extension runs to its agents’ last timestamps', () => {
  const bars = L2.turnBarModel(DETAIL);
  const t1 = bars.find((b) => b.idx === 1);
  assert.equal(t1.at, T('2026-08-17T18:00:00Z'));
  assert.equal(t1.end, T('2026-08-17T18:30:00Z'));
  assert.deepEqual(t1.overhang, { start: T('2026-08-17T18:30:00Z'), end: T('2026-08-17T19:30:00Z') });
  assert.equal(t1.agents, 2);
  assert.equal(t1.wall, 1800000);
});

test('a turn whose agents finish inside it gets no overhang', () => {
  const bars = L2.turnBarModel({
    turns: [{ idx: 1, at: 0, endedAt: 100, agentIds: ['a'] }],
    agents: [{ agentId: 'a', firstAt: 10, lastAt: 50 }],
  });
  assert.equal(bars[0].overhang, null);
});

test('a turn with one timestamp is a tick and still carries an overhang if its agents ran on', () => {
  const bars = L2.turnBarModel({
    turns: [{ idx: 1, at: 0, endedAt: null, agentIds: ['a'] }],
    agents: [{ agentId: 'a', firstAt: 10, lastAt: 500 }],
  });
  assert.equal(bars[0].end, null);
  assert.deepEqual(bars[0].overhang, { start: 0, end: 500 });
});

test('the preamble is idx 0 and is marked, never numbered as a turn', () => {
  const bars = L2.turnBarModel(DETAIL);
  assert.equal(bars[0].idx, 0);
  assert.equal(bars[0].preamble, true);
  assert.equal(bars.filter((b) => !b.preamble).length, 2);
});

test('agent bars come from the agent’s own transcript bounds', () => {
  const iv = L2.agentIntervals(DETAIL);
  assert.deepEqual(iv.map((x) => x.agentId), ['a1', 'a2']);
  assert.equal(iv[0].start, T('2026-08-17T18:05:00Z'));
  assert.equal(iv[0].end, T('2026-08-17T19:30:00Z'));
  assert.equal(iv[0].label, 'scout');
  assert.equal(iv[1].label, 'Plan a2');       // no recorded label → agentType + id, with the source named
});

test('the session bar spans min over turn/agent starts to max over their ends', () => {
  const b = L2.sessionBounds(DETAIL);
  assert.equal(b.start, T('2026-08-17T17:00:00Z'));
  assert.equal(b.end, T('2026-08-17T19:30:00Z'));   // the agent overhang, not the last turn
  assert.equal(b.span, 9000000);
});

test('a session with no timestamps at all reports no bounds', () => {
  assert.deepEqual(L2.sessionBounds({ turns: [], agents: [] }), { start: null, end: null, span: null });
});

/* ------------------------------------------------------------ fork banner */

test('the fork banner cites R2 with the recorded inherited counts and its denominator', () => {
  const fb = L2.forkBanner({ requests: 10, inherited: { '0000000b': { requests: 250, tokens: { input: 1 } } } });
  assert.equal(fb.inherited, 250);
  assert.equal(fb.billedHere, 10);
  assert.equal(fb.fileRows, 260);
  assert.match(fb.text, /250 of 260 billed rows/);
  assert.match(fb.text, /0000000b/);
  assert.match(fb.text, /R2/);
  assert.match(fb.denominatorNote, /rows billed here \+ rows inherited/);
  assert.deepEqual(fb.sessions.map((s) => s.id), ['0000000b']);
});

test('no inherited channel means no fork banner', () => {
  assert.equal(L2.forkBanner({ requests: 10, inherited: {} }), null);
  assert.equal(L2.forkBanner({ requests: 10 }), null);
  assert.equal(L2.forkBanner(null), null);
});

test('a fork banner with no recorded local request count refuses to invent a denominator', () => {
  const fb = L2.forkBanner({ inherited: { s1: { requests: 5 } } });
  assert.equal(fb.fileRows, null);
  assert.ok(!/ of /.test(fb.text));
});

/* ------------------------------------------------ F48 canonical-side banner */

test('F48 — the canonical side banners from forkPartners, the channel agg.inherited cannot provide', () => {
  const fb = L2.forkPartnerBanner({
    forkPartners: {
      '0000000a-0000-4000-8000-000000000002': { slug: 'C--proj', sharedMsgIds: 44, billedHere: 43, billedThere: 0, billedElsewhere: 0 },
    },
  });
  assert.equal(fb.partners.length, 1);
  assert.equal(fb.partners[0].billedHere, 43);
  assert.equal(fb.partners[0].slug, 'C--proj', 'partners can be cross-project — the entry carries its own slug');
  assert.match(fb.text, /43 of 44 msgIds in this file also appear in 0000000a/);
  assert.match(fb.text, /billed here, not there/);
  assert.match(fb.text, /R2$/);
  assert.match(fb.denominatorNote, /synthetic or embedded-sidechain/);
  assert.ok(!/rows billed here \+ rows inherited/.test(fb.denominatorNote),
    'the inherited side\'s denominator is FALSE here — these rows are billed in this file');
});

test('F48 — forkPartners null is UNKNOWN (index still building), never a claim of "no fork"', () => {
  assert.equal(L2.forkPartnerBanner({ forkPartners: null }), null);
  assert.equal(L2.forkPartnerBanner({}), null);
  assert.equal(L2.forkPartnerBanner(null), null);
  assert.equal(L2.forkPartnerBanner({ forkPartners: {} }), null, 'a real none banners nothing');
});

test('F48 — a partner with billedHere 0 is the INHERITED side: forkBanner owns it, no double banner', () => {
  assert.equal(L2.forkPartnerBanner({
    forkPartners: { s1: { slug: 'p', sharedMsgIds: 44, billedHere: 0, billedThere: 43, billedElsewhere: 0 } },
  }), null);
});

test('F48 — a 3-way group discloses the third session, and never gates on agg.inherited being empty', () => {
  const fb = L2.forkPartnerBanner({
    forkPartners: { 'bbbbbbbb-0000-4000-8000-000000000000': { slug: 'C--other', sharedMsgIds: 9, billedHere: 5, billedThere: 0, billedElsewhere: 4 } },
  });
  assert.match(fb.text, /5 of 9 msgIds/);
  assert.match(fb.text, /4 more are billed in a third session/);
});

test('F48 — forkBanner keeps its one-argument signature (the inherited side is untouched)', () => {
  const fb = L2.forkBanner({ requests: 1, inherited: { '0000000b': { requests: 43 } } });
  assert.equal(fb.inherited, 43);
  assert.equal(L2.forkBanner({ requests: 10, inherited: {} }), null);
});

/* ------------------------------------------------------------ liveness */

test('the live badge prints the recorded byte progress', () => {
  const p = L2.liveProgress({ state: 'live', bytesIndexed: 936, bytes: 1000 });
  assert.equal(p.live, true);
  assert.equal(p.text, 'indexed through 936 of 1,000 bytes (93.6%)');
});

test('a live file with no recorded prefix says why instead of guessing', () => {
  const p = L2.liveProgress({ state: 'live', bytes: 1000 });
  assert.equal(p.live, true);
  assert.equal(p.text, null);
  assert.match(p.reason, /no indexed-byte prefix/);
});

test('a settled session is not live', () => {
  assert.equal(L2.liveProgress(DETAIL).live, false);
  assert.equal(L2.liveProgress(null).live, false);
});

/* -------------------------------------------------- files-view denominator */

test('the files view prints its coverage denominator from recorded counts', () => {
  // the /files endpoint's shipped names (integration 2026-08-17)
  const c = L2.coverageSentence({ mainToolCallsWithPath: 18268, agentToolCallsWithPath: 21445, agentResultsNoSidecar: 20292 });
  assert.equal(c.known, true);
  assert.equal(c.text, 'paths from 18,268 main-thread and 21,445 agent tool calls that carry a path key; 20,292 agent tool results carry no path sidecar.');
  // the older fixture aliases still resolve
  const alias = L2.coverageSentence({ mainToolCalls: 1, agentToolCalls: 2, agentResultsWithoutSidecar: 3 });
  assert.equal(alias.known, true);
  assert.match(alias.text, /paths from 1 main-thread and 2 agent tool calls/);
});

test('an unrecorded denominator renders as — with a reason, not a zero', () => {
  const c = L2.coverageSentence(undefined);
  assert.equal(c.known, false);
  assert.match(c.text, /paths from — main-thread and — agent tool calls/);
  assert.match(c.reason, /no tool-call denominators/);
});

/* ------------------------------------------------------------ facts row */

test('the facts row shows custom ▸ ai with the ai-title rewrite count and names its source', () => {
  const facts = L2.sessionFacts(DETAIL);
  const title = facts.find((f) => f.key === 'title');
  assert.equal(title.display, 'the rebuild ▸ Rebuilding the lens');
  assert.equal(title.source, 'custom-title (latest in file order)');
  assert.deepEqual(title.counts.find((c) => c.label === 'ai-title rewrites').n, 168);
  assert.equal(title.untimed, true);          // four types carry no timestamp — file order only
});

test('PR links render as real links labelled repo#number', () => {
  const pr = L2.sessionFacts(DETAIL).find((f) => f.key === 'pr');
  assert.deepEqual(pr.links, [{ href: 'https://github.com/me/repo/pull/12', label: 'me/repo#12', title: 'https://github.com/me/repo/pull/12' }]);
});

test('frame links render by title and last-prompt reports its checkpoint count', () => {
  const facts = L2.sessionFacts(DETAIL);
  assert.equal(facts.find((f) => f.key === 'frame').links[0].label, 'a frame');
  assert.equal(facts.find((f) => f.key === 'last-prompt').display, '4,647 checkpoints');
});

test('a session whose payload STATES the absence says "no … event recorded"', () => {
  // R10-S1: a recorded zero (the server shipping count 0 / an empty list) is
  // the one thing that licenses the positive denial.
  const facts = L2.sessionFacts({ modeCount: 0, prLinks: [], prLinkCount: 0, frameLinks: [], frameLinkCount: 0 });
  const title = facts.find((f) => f.key === 'title');
  assert.equal(title.display, null);
  assert.match(title.reason, /no custom-title or ai-title event/);
  assert.match(facts.find((f) => f.key === 'mode').reason, /no mode event in this file/);
  assert.match(facts.find((f) => f.key === 'pr').reason, /no pr-link event in this file/);
  assert.match(facts.find((f) => f.key === 'frame').reason, /no frame-link event in this file/);
  assert.match(facts.find((f) => f.key === 'last-prompt').reason, /no last-prompt count/);
});

test('a payload that carries no metadata fields at all denies nothing (R10-S1)', () => {
  const facts = L2.sessionFacts({});
  for (const [key, re] of [['mode', /no mode fact/], ['pr', /no pr-link list/], ['frame', /no frame-link list/]]) {
    const f = facts.find((x) => x.key === key);
    assert.match(f.reason, re, `${key} must blame the payload, not the file`);
    assert.match(f.source, /not recorded in this payload/, `${key} source must not claim the file is empty`);
    assert.doesNotMatch(f.source, /^no .* event recorded$/, `${key} must not deny a fact the payload never spoke about`);
  }
});

test('facts also read a normalised `facts` object when the payload ships one', () => {
  const facts = L2.sessionFacts({ facts: { aiTitle: { value: 'x', count: 5 }, mode: { value: 'plan', count: 2 } } });
  const title = facts.find((f) => f.key === 'title');
  assert.equal(title.display, 'x');
  assert.equal(title.source, 'ai-title (latest in file order)');
  assert.equal(title.counts[0].n, 5);
  assert.equal(facts.find((f) => f.key === 'mode').display, 'plan');
});

/* ------------------------------------------------- prompt + composition */

test('the turn card shows the first three recorded prompt lines verbatim', () => {
  const p = L2.promptLines('first line\nsecond line\nthird line\nfourth line');
  assert.deepEqual(p.lines, ['first line', 'second line', 'third line']);
  assert.equal(p.more, true);
  assert.equal(p.empty, false);
});

test('leading blank lines are skipped but the text itself is untouched', () => {
  const p = L2.promptLines('\n\n  <command-message>run</command-message>');
  assert.deepEqual(p.lines, ['  <command-message>run</command-message>']);
  assert.equal(p.more, false);
});

test('an unrecorded prompt head is empty, not invented', () => {
  assert.equal(L2.promptLines('').empty, true);
  assert.equal(L2.promptLines(undefined).empty, true);
});

test('the composition bar counts exactly the recorded block kinds', () => {
  const c = L2.compositionOf(DETAIL.turns[1]);
  assert.deepEqual(c.entries, [{ kind: 'text', count: 10 }, { kind: 'tool_use', count: 4 }, { kind: 'thinking', count: 2 }]);
  assert.equal(c.total, 16);
  assert.equal(L2.compositionOf({}), null);
  assert.equal(L2.compositionOf({ kinds: {} }), null);
});

test('composition accepts the array form and keeps namespaced kinds intact', () => {
  const c = L2.compositionOf({ composition: [{ kind: 'attachment:file', count: 3 }, { kind: 'system:api_error', count: 1 }] });
  assert.deepEqual(c.entries.map((e) => e.kind), ['attachment:file', 'system:api_error']);
  assert.equal(L2.kindFamily('attachment:file'), 'attachment');
  assert.equal(L2.kindFamily('tool_use'), 'tool_use');
});

/* -------------------------------------------------------------- agents */

test('agent rows carry the recorded facts, the label source and an honest cost', () => {
  const rows = L2.agentRows(DETAIL);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, 'scout');
  assert.equal(rows[0].labelSource, 'workflowProgress.label');
  assert.equal(rows[0].model, 'opus-5');
  assert.equal(rows[0].state, 'done');
  assert.equal(rows[0].depth, 1);
  assert.equal(rows[0].spawnSource, 'workflow');
  assert.equal(rows[0].runId, 'wf_00000003-a03');
  assert.equal(rows[0].wall, 5100000);
  assert.equal(rows[0].usd, null);
  assert.match(rows[0].usdReason, /CostAgg/);
});

test('agent rows read the field names /api/session actually ships', () => {
  // the real payload: kind, depth, models[], stateFacts{}, usage{}, turnIdx
  const [r] = L2.agentRows({
    agents: [{
      agentId: 'a505a7c841dfbea29', kind: 'plain', depth: 1, agentType: 'general-purpose',
      metaModel: 'sonnet', models: ['claude-sonnet-5'], resolvedModel: 'claude-sonnet-5',
      label: { text: 'mirror-gap-1', source: 'prompt-tag' }, tag: 'mirror-gap-1',
      state: null, turnIdx: 4, attributedBy: 'toolUseId', spawnLine: 561,
      firstAt: 100, lastAt: 900, usage: { input: 5, output: 6, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 7 },
      stateFacts: { manifestState: null, cached: false, attempt: null, inManifest: false, manifestExists: false, journalStarted: 0, journalResult: false, resultEmpty: null, spawnStatus: 'async_launched' },
    }],
  });
  assert.equal(r.label, 'mirror-gap-1');
  assert.equal(r.model, 'claude-sonnet-5');       // the raw id, not the sidecar alias
  assert.equal(r.spawnSource, 'plain');
  assert.equal(r.attributedBy, 'toolUseId');
  assert.equal(r.spawnLine, 561);
  assert.equal(r.depth, 1);
  assert.equal(r.turnIdx, 4);
  assert.equal(r.wall, 800);
  assert.equal(r.tokens.cacheRead, 7);
  assert.equal(r.state, 'async_launched');
});

test('agent state is a recorded signature, never a diagnosis', () => {
  const s = (stateFacts) => L2.agentStateOf({ stateFacts });
  assert.equal(s({ manifestState: 'done' }).text, 'done');
  assert.equal(s({ manifestState: 'error' }).text, 'error');
  assert.equal(s({ journalStarted: 1, journalResult: false }).text, 'running — journal records a start, no result yet');
  assert.equal(s({ journalStarted: 1, journalResult: true, manifestExists: true, inManifest: false }).text, 'superseded attempt');
  assert.equal(s({ resultEmpty: true }).text, '∅ no-result');
  const none = s({});
  assert.equal(none.text, null);
  assert.match(none.reason, /no manifest and no journal record a state/);
  // a plain agent with a journal result but no manifest is NOT "superseded"
  assert.equal(s({ journalStarted: 1, journalResult: true, manifestExists: false, inManifest: false }).text, null);
});

test('the raw model string wins over the sidecar alias, and every source is named', () => {
  assert.deepEqual(L2.agentModelOf({ models: ['claude-opus-5[1m]'], metaModel: 'opus' }).text, 'claude-opus-5[1m]');
  assert.match(L2.agentModelOf({ metaModel: 'sonnet' }).source, /bare alias/);
  assert.equal(L2.agentModelOf({}).text, null);
  assert.match(L2.agentModelOf({}).reason, /83%/);
});

test('a payload that ships only a COUNT is not reported as "none recorded"', () => {
  const list = L2.listOrCount([{ line: 1 }, { line: 2 }], 'images');
  assert.deepEqual([list.count, list.countOnly, list.note], [2, false, null]);

  const countOnly = L2.listOrCount(2573, 'images');
  assert.equal(countOnly.count, 2573);
  assert.equal(countOnly.countOnly, true);
  assert.match(countOnly.note, /2,573 images are recorded/);
  assert.match(countOnly.note, /count only/);

  const zero = L2.listOrCount(0, 'images');
  assert.deepEqual([zero.count, zero.countOnly, zero.note], [0, false, null]);
  assert.deepEqual(L2.listOrCount(undefined, 'files').count, null);
});

test('cached replays and worktree agents are flagged from recorded fields', () => {
  const rows = L2.agentRows(DETAIL);
  assert.equal(rows[1].cached, true);
  assert.equal(rows[1].worktree, true);
  assert.equal(rows[1].model, null);          // model is 83% covered in the sidecars
  assert.equal(rows[1].state, null);
});

test('no agents, no rows', () => {
  assert.deepEqual(L2.agentRows({ agents: [] }), []);
  assert.deepEqual(L2.agentRows(null), []);
});

/* ------------------------------------------------------------ sentence */

test('the L2 scope props name the enumeration rule and disclose the flip', () => {
  const choice = L2.chooseSessionView({ turns: [{ preamble: true }, {}], agentCount: 80 }, null);
  const s = L2.scopeSentenceL2({
    view: choice.view, detail: DETAIL, choice, agents: 80, turns: 1, workflows: 1,
    st: { done: 85, of: 85, building: false },
  });
  assert.equal(s.subject, 'session the rebuild');
  assert.deepEqual(s.counts, [{ n: 1, noun: 'turn' }, { n: 80, noun: 'agent' }, { n: 1, noun: 'workflow run' }]);
  assert.match(s.rule, /directory listing, not workflowProgress/);
  assert.ok(s.extra.some((e) => /1 non-preamble turn, 80 agents — showing the agents/.test(e)));
  assert.ok(s.extra.some((e) => /totals over 85 of 85 sessions/.test(e)));
});

test('the turn-list props state R-T and, at 0 agents, why there is no concurrency strip', () => {
  const s = L2.scopeSentenceL2({ view: 'turns', detail: DETAIL, choice: { note: null }, agents: 0, turns: 2, st: {} });
  assert.match(s.rule, /topological order of the uuid DAG/);
  assert.match(s.rule, /origin\.kind is human \(R-T\)/);
  assert.ok(s.extra.some((e) => /no agent-concurrency strip is drawn/.test(e)));
});

/* ------------------------------------------------------------- R4-UI-2 *
 * The session agents table read `a.phase`, a key /api/session has never
 * shipped (summary.mjs emits phaseIndex/phaseTitle). The column read unknown
 * for every agent in the corpus, and — worse — the named ?group=phase feature
 * collapsed every session into ONE group whose own label claimed the field
 * was absent.
 */

const PHASED_DETAIL = {
  agents: [
    { agentId: 'a00000000000000a1', phaseIndex: 1, phaseTitle: 'Engine build', firstAt: 100, lastAt: 900, turnIdx: 1 },
    { agentId: 'a00000000000000a2', phaseIndex: 1, phaseTitle: 'Engine build', firstAt: 120, lastAt: 800, turnIdx: 1 },
    { agentId: 'a00000000000000a3', phaseIndex: 2, phaseTitle: 'Rules audit', firstAt: 200, lastAt: 950, turnIdx: 1 },
    { agentId: 'a00000000000000a4', firstAt: 300, lastAt: 999, turnIdx: 1 },
  ],
};

test('R4-UI-2: agent rows read the phase under the name /api/session actually ships (phaseTitle)', () => {
  const rows = L2.agentRows(PHASED_DETAIL);
  assert.equal(rows[0].phase, 'Engine build', '`a.phase` does not exist on this payload — phaseTitle does');
  assert.equal(rows[2].phase, 'Rules audit');
  assert.equal(rows[3].phase, null, 'an agent with no recorded phase stays honestly unknown');
});

test('R4-UI-2: a recorded phaseIndex of 0 is a phase, and an empty phaseTitle is not', () => {
  const [zeroIdx, blank] = L2.agentRows({
    agents: [
      { agentId: 'a00000000000000b1', phaseIndex: 0 },
      { agentId: 'a00000000000000b2', phaseTitle: '' },
    ],
  });
  assert.equal(zeroIdx.phase, 'phase 0', 'truthiness on phaseIndex would have swallowed the first phase of every run');
  assert.equal(blank.phase, null, 'a recorded blank must not become a "known" blank group key');
});

test('R4-UI-2: ?group=phase produces real groups again — it collapsed every session into one', async () => {
  const { groupRows } = await import('../web/js/components/vtable.mjs');
  const groups = groupRows(L2.agentRows(PHASED_DETAIL), 'phase');
  assert.ok(groups.length > 1, 'the named grouping feature was completely non-functional corpus-wide');
  const keys = groups.map((g) => g.key).sort();
  assert.ok(keys.includes('Engine build') && keys.includes('Rules audit'), 'grouped by the recorded titles');
  const engine = groups.find((g) => g.key === 'Engine build');
  assert.equal(engine.rows.length, 2, 'and the rows land in the group their manifest entry records');
});
