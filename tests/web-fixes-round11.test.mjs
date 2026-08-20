// tests/web-fixes-round11.test.mjs — named regressions for the round-11 fix
// pass, BROWSER side. The server halves live in tests/fixes-round11.test.mjs.
//
//   R11-F1 (web/js/views/l3.mjs — buildTree / parseSel / mountTimetable)
//       buildLanes gives the two non-run groups BARE keys ('plain' for
//       "Agent-tool agents", 'unlinked' for "no recorded spawn edge").
//       buildTree copied the key onto the tree node and treeView built every
//       row's href straight from it, so the app emitted its own link to
//       `?sel=plain` / `?sel=unlinked` — which parseSel did not recognise, so
//       it fell through to `unknown`, which mountTimetable folded into `main`.
//       Clicking a group header therefore rendered the SAME no-selection
//       main-thread pane, with none of the honest "…groups agents; it has no
//       rows of its own" disclosure the sibling workflow/phase groups get —
//       while walk()'s `sel.key === key` DID match, so the row painted itself
//       selected. The UI confirmed a selection it had not honoured. On the live
//       corpus the 'plain' group is the most common group there is.
//
//   R11-F2 (web/js/views/l3.mjs — attachAgents, client half)
//       attachAgents made an agent a root only when it had no RESOLVABLE
//       recorded parent, and node() recurses from roots only. Two .meta.json
//       sidecars naming each other therefore left both members rootless: they
//       were rendered nowhere, while the group header went on counting them —
//       and an innocent non-cyclic child hanging off a cycle member vanished
//       with them. The only signal was a header count that disagreed with the
//       leaves beneath it, and nothing said so.
//
// Both are driven through the REAL renderTurn over a stubbed /api/turn, for
// the reason round 4 recorded in web-fixes-round1.test.mjs: a correct return
// value that the DOM path then discards still passes a payload-level assert.
// The pure-function halves (buildTree/parseSel/attachAgents shapes, including
// the "every key buildTree emits must parse" invariant) live in
// tests/views-drill-l3.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * fake document (same shape as web-dom-smoke.test.mjs / web-fixes-round1)
 * ------------------------------------------------------------------ */

// The fake DOM itself lives in tests/helpers/fake-dom.mjs (shared by every
// web test file); it is installed here, BEFORE the web modules are imported.
import { doc } from './helpers/fake-dom.mjs';

globalThis.document = doc;

/* imports AFTER the fake document exists */
const L3 = await import('../web/js/views/l3.mjs');

/* ------------------------------------------------------------------ *
 * the L3 harness — the REAL renderTurn over one stubbed /api/turn
 * ------------------------------------------------------------------ */

const SLUG = 'C--r11-proj';
const SID = 'cc000000-0000-4000-8000-000000000002';
const IDX = 2;

const el = () => doc.createElement('div');
const textOf = (n) => n.textContent;
import { settle } from './helpers/timing.mjs';
const jsonRes = (body) => async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) });

function turnCtx({ sel = null, path = `/p/${SLUG}/s/${SID}/t/${IDX}` } = {}) {
  const query = new URLSearchParams();
  if (sel !== null) query.set('sel', sel);
  const base = {
    el: el(), stale: false, path, query,
    params: { slug: SLUG, sid: SID, idx: String(IDX) },
    banners: [], stats: [],
    banner: (t, tone) => base.banners.push({ t, tone }),
    statbar: (props) => base.stats.push(props),
  };
  // Same Proxy trick as the round-4 workflow harness: every other render-ctx
  // hook is a no-op, EXCEPT `then` — a catch-all that returns a function for
  // `then` makes the ctx thenable and `await`ing one hangs forever.
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (k === 'then' || typeof k === 'symbol' ? undefined : () => {})),
  });
}

/** Drives the REAL renderTurn over one stubbed /api/turn response. */
async function renderTurn(payload, { sel = null } = {}) {
  const ctx = turnCtx({ sel });
  const realFetch = globalThis.fetch;
  globalThis.fetch = jsonRes(payload);
  try { await L3.renderTurn(ctx); await settle(); } finally { globalThis.fetch = realFetch; }
  return ctx;
}

const AGENT = (agentId, over = {}) => ({
  agentId,
  label: { text: agentId, source: 'fallback' },
  meta: { agentType: 'general-purpose', toolUseId: `toolu_${agentId}` },
  lineage: { kind: 'plain', toolUseId: `toolu_${agentId}` },
  firstAt: 1755400000000, lastAt: 1755400600000, spawnDepth: 1,
  ...over,
});

/**
 * One turn carrying every group shape at once: a workflow run, its two orphan
 * groups, the plain (Agent-tool) group and the no-spawn-edge group. The plain
 * group is the one the live corpus produces constantly — turn 2 of this app's
 * own session 0000000a… has 24 of them.
 */
const TURN_PAYLOAD = (over = {}) => ({
  slug: SLUG, id: SID,
  turn: {
    idx: IDX, preamble: false, at: 1755399990000, endAt: 1755401000000,
    openerLine: 10, rowCount: 3,
    prompt: { text: 'do the thing' },
  },
  agents: [
    // workflow run wf_r1100001-abc: one listed, one running orphan, one superseded orphan
    AGENT('awf1', { runId: 'wf_r1100001-abc', lineage: { kind: 'workflow', runId: 'wf_r1100001-abc' }, stateFacts: { inManifest: true }, state: 'done' }),
    AGENT('awf2', { runId: 'wf_r1100001-abc', lineage: { kind: 'workflow', runId: 'wf_r1100001-abc' }, stateFacts: { inManifest: false }, journal: { started: true } }),
    AGENT('awf3', { runId: 'wf_r1100001-abc', lineage: { kind: 'workflow', runId: 'wf_r1100001-abc' }, stateFacts: { inManifest: false }, journal: { started: true, result: 'ok' } }),
    // Agent-tool agents -> the 'plain' group
    AGENT('aplain1'),
    AGENT('aplain2'),
    // no recorded spawn edge -> the 'unlinked' group
    AGENT('alone1', { meta: {}, lineage: { kind: 'orphan' } }),
  ],
  workflows: [{ runId: 'wf_r1100001-abc', turnIdx: IDX, workflowName: 'build' }],
  agg: null,
  rows: [
    { line: 10, bi: null, kind: 'user', at: 1755399990000, head: 'do the thing' },
    { line: 11, bi: null, kind: 'assistant:text', at: 1755400000000, head: 'on it' },
    { line: 12, bi: null, kind: 'assistant:text', at: 1755400900000, head: 'done' },
  ],
  rowsTotal: 3, turnCount: 4, rowsSumToHeader: null, problems: [],
  ...over,
});

/** Every tree row link, as { label, href, sel, selected }. */
function treeLinks(ctx) {
  return ctx.el.querySelectorAll('.lens-tree__row').map((row) => {
    const link = row.querySelector('a');
    const href = link ? link.getAttribute('href') : null;
    const qs = href && href.includes('?') ? new URLSearchParams(href.slice(href.indexOf('?') + 1)) : null;
    return {
      label: link ? link.textContent : row.textContent,
      href,
      sel: qs ? qs.get('sel') : null,
      selected: row.classList.contains('lens-tree__row--sel'),
      row,
    };
  });
}
const linkNamed = (ctx, label) => treeLinks(ctx).find((l) => l.label === label);
/** The right-hand pane (timetable) text only — never the tree's. */
const paneEl = (ctx) => ctx.el.querySelector('.lens-l3__timetable');
const paneText = (ctx) => { const p = paneEl(ctx); return p ? textOf(p) : ''; };
/** Every unknown() reason in the pane — house rule 3 puts them in `title`. */
const paneReasons = (ctx) => {
  const p = paneEl(ctx);
  return p ? p.querySelectorAll('.lens-unknown').map((n) => n.getAttribute('title')) : [];
};

/* ==================================================================== R11-F1 */

test('R11-F1: the tree emits a group-header link whose ?sel the app itself can parse', async () => {
  const ctx = await renderTurn(TURN_PAYLOAD());
  const plain = linkNamed(ctx, 'Agent-tool agents');
  const unlinked = linkNamed(ctx, 'no recorded spawn edge');
  assert.ok(plain, 'the "Agent-tool agents" group header renders as a link');
  assert.ok(unlinked, 'the "no recorded spawn edge" group header renders as a link');
  assert.equal(plain.sel, 'g:plain', 'the app used to emit ?sel=plain, which its own parseSel called unknown');
  assert.equal(unlinked.sel, 'g:unlinked');
  // and the invariant that makes those links honest, read off the real render
  for (const l of treeLinks(ctx)) {
    if (l.sel === null) continue;
    assert.notEqual(L3.parseSel(l.sel).kind, 'unknown',
      `the tree rendered a link to ?sel=${l.sel}, which parseSel does not recognise`);
  }
});

test('R11-F1: following the tree\'s OWN "Agent-tool agents" link actually selects that group', async () => {
  const first = await renderTurn(TURN_PAYLOAD());
  const sel = linkNamed(first, 'Agent-tool agents').sel;     // exactly what a click navigates to

  const ctx = await renderTurn(TURN_PAYLOAD(), { sel });
  const pane = paneText(ctx);
  assert.match(pane, /Selected: g:plain/, 'the pane names the selection it honoured');
  assert.match(pane, /this node groups agents; it has no rows of its own\./,
    'and gives the same honest disclosure the sibling workflow/phase groups get');
  assert.doesNotMatch(pane, /Main-thread rows of this turn/,
    'the silent failure: the group header rendered the no-selection main-thread pane instead');
  assert.equal(paneReasons(ctx).filter((r) => /is not a selection this turn recognises/.test(r)).length, 0,
    'a key the tree itself emitted is never an unrecognised selection');

  // the row highlight is truthful: exactly the clicked row, and only it
  const selectedRows = treeLinks(ctx).filter((l) => l.selected);
  assert.equal(selectedRows.length, 1);
  assert.equal(selectedRows[0].label, 'Agent-tool agents');
  assert.ok(selectedRows[0].row.querySelector('.lens-tree__label--sel'), 'the label carries the selected class too');
});

test('R11-F1: the same holds for the "no recorded spawn edge" group', async () => {
  const first = await renderTurn(TURN_PAYLOAD());
  const sel = linkNamed(first, 'no recorded spawn edge').sel;

  const ctx = await renderTurn(TURN_PAYLOAD(), { sel });
  const pane = paneText(ctx);
  assert.match(pane, /Selected: g:unlinked/);
  assert.match(pane, /this node groups agents; it has no rows of its own\./);
  assert.doesNotMatch(pane, /Main-thread rows of this turn/);
  const selectedRows = treeLinks(ctx).filter((l) => l.selected);
  assert.equal(selectedRows.length, 1);
  assert.equal(selectedRows[0].label, 'no recorded spawn edge');
});

test('R11-F1: a workflow group selection is unchanged — the fix did not move the keys that worked', async () => {
  const first = await renderTurn(TURN_PAYLOAD());
  const wf = linkNamed(first, 'build');
  assert.equal(wf.sel, 'w:wf_r1100001-abc', 'run groups keep their working key');
  const running = linkNamed(first, 'running — journal records a start, no result yet');
  const superseded = linkNamed(first, 'superseded attempt');
  assert.equal(running.sel, 'w:wf_r1100001-abc:running',
    'blanket-prefixing would have made this g:w:… and broken its workflow parse');
  assert.equal(superseded.sel, 'w:wf_r1100001-abc:superseded');

  const ctx = await renderTurn(TURN_PAYLOAD(), { sel: wf.sel });
  assert.match(paneText(ctx), /Selected: w:wf_r1100001-abc/);
  assert.match(paneText(ctx), /this node groups agents; it has no rows of its own\./);
});

test('R11-F1: an unrecognised ?sel still shows the main thread — but SAYS the selection was not honoured', async () => {
  // 'plain' is the exact string the pre-fix tree generated, and the shape a
  // stale bookmark or hand-edited URL still carries.
  for (const bad of ['plain', 'unlinked', 'garbage']) {
    const ctx = await renderTurn(TURN_PAYLOAD(), { sel: bad });
    const pane = paneText(ctx);
    assert.match(pane, /Main-thread rows of this turn/, `?sel=${bad}: something still renders`);
    // house rule 3: an unknown is '—' CARRYING ITS REASON, which lives in title
    assert.ok(paneReasons(ctx).some((r) => r === `?sel=${bad} is not a selection this turn recognises — showing the main thread`),
      `?sel=${bad}: the fallback must not be silent`);
    // and no tree row claims to be the thing that was selected
    assert.equal(treeLinks(ctx).filter((l) => l.selected).length, 0,
      `?sel=${bad}: no row may paint itself selected for a selection nothing honoured`);
  }
});

test('R11-F1: no selection at all is still the plain main-thread pane, with no spurious disclosure', async () => {
  const ctx = await renderTurn(TURN_PAYLOAD());
  const pane = paneText(ctx);
  assert.match(pane, /Main-thread rows of this turn/);
  assert.equal(paneReasons(ctx).filter((r) => /is not a selection this turn recognises/.test(r)).length, 0);
  const selected = treeLinks(ctx).filter((l) => l.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].label, 'main thread', 'the default selection is main, and it is the row that says so');
});

test('R11-F1: selecting an agent leaf under the plain group still renders that agent\'s rows', async () => {
  const first = await renderTurn(TURN_PAYLOAD());
  const leaf = linkNamed(first, 'aplain1');
  assert.equal(leaf.sel, 'a:aplain1');
  const ctx = await renderTurn(TURN_PAYLOAD(), { sel: leaf.sel });
  assert.match(paneText(ctx), /Rows of agent aplain1, in file order\./);
  assert.doesNotMatch(paneText(ctx), /this node groups agents/);
});

/* ==================================================================== R11-F2 */

const CYCLE_PAYLOAD = () => TURN_PAYLOAD({
  agents: [
    // two sidecars naming each other — the shape that dropped both
    AGENT('acycA', { meta: { agentType: 'general-purpose', parentAgentId: 'acycB' }, lineage: { kind: 'child', parentAgentId: 'acycB' } }),
    AGENT('acycB', { meta: { agentType: 'general-purpose', parentAgentId: 'acycA' }, lineage: { kind: 'child', parentAgentId: 'acycA' } }),
    // an innocent, perfectly well-formed child hanging off one of them
    AGENT('achild', { meta: { agentType: 'general-purpose', parentAgentId: 'acycA' }, lineage: { kind: 'child', parentAgentId: 'acycA' } }),
  ],
  workflows: [],
});

test('R11-F2: a parentAgentId cycle no longer deletes its members from the rendered tree', async () => {
  const ctx = await renderTurn(CYCLE_PAYLOAD());
  const labels = treeLinks(ctx).map((l) => l.label);
  for (const id of ['acycA', 'acycB', 'achild']) {
    assert.ok(labels.includes(id), `${id} must appear in the orchestration tree — all three used to vanish`);
  }
  // the header count and the leaves beneath it must agree — the only signal the
  // old drop ever produced was a disagreement nothing stated
  const group = ctx.el.querySelectorAll('.lens-tree__row--plain')[0];
  assert.ok(group, 'the Agent-tool group row renders');
  assert.equal(group.querySelector('.lens-tree__count').textContent, '3');
  assert.equal(treeLinks(ctx).filter((l) => /^a:/.test(l.sel ?? '')).length, 3,
    'three counted agents, three agent leaves');
});

test('R11-F2: the cycle break is disclosed on the row, never performed silently', async () => {
  const ctx = await renderTurn(CYCLE_PAYLOAD());
  const notes = ctx.el.querySelectorAll('.lens-tree__cycle').map((n) => n.textContent);
  assert.equal(notes.length, 2, 'exactly the two cycle members are marked');
  for (const n of notes) assert.equal(n, 'recorded parentAgentId forms a cycle — shown unnested');
  const rowOf = (label) => treeLinks(ctx).find((l) => l.label === label).row;
  assert.ok(rowOf('acycA').querySelector('.lens-tree__cycle'));
  assert.ok(rowOf('acycB').querySelector('.lens-tree__cycle'));
  assert.equal(rowOf('achild').querySelector('.lens-tree__cycle'), null,
    'the innocent child is not re-parented and is not marked');
});

// (The acyclic control lives in tests/web-fixes-round12.test.mjs — 'R12-D1: an
// acyclic turn still renders no cycle note anywhere' — beside the server-side
// control in tests/fixes-round12.test.mjs; the copy here was a duplicate.)
