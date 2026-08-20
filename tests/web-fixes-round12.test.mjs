// tests/web-fixes-round12.test.mjs — named regressions for the round-12 fix
// pass, BROWSER side. The server halves live in tests/fixes-round12.test.mjs.
//
//   R12-F2 (web/js/views/settings.mjs — the validate preview)
//       POST /api/validate-dir has always answered with the RESOLVED
//       directory in `res.dir`, and the settings page rendered only the
//       counts. So when what the user typed resolved to something else — any
//       relative path, and in particular the bare Windows drive spec "C:",
//       which resolved against the server's own launch cwd — the page showed
//       plausible counts of a directory it never named, and the save button
//       enabled on them. The counts are counts OF something; this row is what
//       says of what.
//
//   R12-D1 (web/js/views/l3.mjs — the rendered cycle note)
//       The pure-function half is in tests/fixes-round12.test.mjs. This half
//       drives the REAL renderTurn, for the reason round 4 recorded: a correct
//       return value the DOM path then discards still passes a payload-level
//       assert. R11-F2's row note must actually appear on both members of a
//       cycle that spans two lane groups.

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
const Settings = await import('../web/js/views/settings.mjs');

const el = () => doc.createElement('div');
const textOf = (n) => n.textContent;
import { settle } from './helpers/timing.mjs';

/** ctx with every unused render hook a no-op. `then` must stay undefined or
 *  awaiting the ctx hangs forever (the round-4 workflow-harness trap). */
function viewCtx(extra = {}) {
  const base = { el: el(), stale: false, path: '/settings', query: new URLSearchParams(), params: {}, banners: [], stats: [], ...extra };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (k === 'then' || typeof k === 'symbol' ? undefined : () => {})),
  });
}

/* ==================================================================== R12-F2 */

/** Drive the REAL renderSettings, then click its own "validate" button. */
async function renderSettingsAndValidate({ typed, resolvedTo, projects = 3, sessions = 0, bytes = 1116561 }) {
  const ctx = viewCtx();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/api/validate-dir')
      // the real shape of the endpoint's answer, resolved dir and all
      ? { ok: true, dir: resolvedTo, projects, sessions, bytes, files: 42, truncated: false, tookMs: 3, problems: [] }
      : u.includes('/api/config')
        ? { activeProjectsDir: 'C:\\active', savedProjectsDir: 'C:\\active', projectsDirSource: 'config', cacheDir: 'C:\\cache', config: {}, problems: [] }
        : { rates: {}, version: 'test', sources: [] };
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
  };
  try {
    await Settings.renderSettings(ctx);
    await settle();
    const input = ctx.el.querySelector('.lens-settings__dir');
    input.value = typed;
    const validateBtn = ctx.el.querySelectorAll('button').find((b) => b.textContent === 'validate');
    validateBtn.dispatch('click');
    await settle();
  } finally { globalThis.fetch = realFetch; }
  return ctx;
}

const previewText = (ctx) => textOf(ctx.el.querySelector('.lens-settings__preview'));

test('R12-F2: the validate preview NAMES the directory its counts describe', async () => {
  // the finding's own case: the user types the bare drive spec, and before the
  // server fix that resolved to the app's own working directory
  const ctx = await renderSettingsAndValidate({ typed: 'C:', resolvedTo: 'C:\\' });
  const pane = previewText(ctx);
  assert.match(pane, /resolved to/, 'the row exists at all — this is the whole disclosure');
  assert.match(pane, /C:\\/, 'and it carries the server\'s resolved path, not the raw string');
  assert.match(pane, /source: server path resolution/, 'house rule: every fact names its source');
  // the counts are still there — the row is added beside them, not instead
  assert.match(pane, /projects/);
  assert.match(pane, /sessions/);
});

test('R12-F2: a resolved path that differs from what was typed is visible on the page', async () => {
  // this is the shape that used to be a silent substitution: typed "corpus",
  // served counts for <server cwd>/corpus, and never said so
  const ctx = await renderSettingsAndValidate({ typed: 'corpus', resolvedTo: 'D:\\somewhere\\else\\corpus' });
  assert.match(previewText(ctx), /D:\\somewhere\\else\\corpus/,
    'the user must be able to see that "corpus" is not where they meant');
});

test('R12-F2: a response with no resolved dir says so — never a blank row', async () => {
  const ctx = await renderSettingsAndValidate({ typed: 'C:', resolvedTo: null });
  assert.match(previewText(ctx), /resolved to/, 'the row is still drawn');
  // house rule 3: an unknown renders as — and CARRIES ITS REASON in `title`
  const reasons = ctx.el.querySelector('.lens-settings__preview')
    .querySelectorAll('.lens-unknown').map((n) => n.getAttribute('title'));
  assert.ok(reasons.includes('the server did not report a resolved path'),
    `an unknown must carry its reason, got ${JSON.stringify(reasons)}`);
});

/* ==================================================================== R12-D1 */

const SLUG = 'C--r12-proj';
const SID = 'cc000000-0000-4000-8000-000000000001';
const IDX = 2;
const RUN = 'wf_r1200002-def';

const AGENT = (agentId, over = {}) => ({
  agentId,
  label: { text: agentId, source: 'fallback' },
  meta: { agentType: 'general-purpose', toolUseId: `toolu_${agentId}` },
  lineage: { kind: 'plain', toolUseId: `toolu_${agentId}` },
  firstAt: 1755400000000, lastAt: 1755400600000, spawnDepth: 1,
  ...over,
});

const TURN_PAYLOAD = (agents, workflows = []) => ({
  slug: SLUG, id: SID,
  turn: {
    idx: IDX, preamble: false, at: 1755399990000, endAt: 1755401000000,
    openerLine: 10, rowCount: 1, prompt: { text: 'do the thing' },
  },
  agents, workflows, agg: null,
  rows: [{ line: 10, bi: null, kind: 'user', at: 1755399990000, head: 'do the thing' }],
  rowsTotal: 1, turnCount: 4, rowsSumToHeader: null, problems: [],
});

async function renderTurn(payload) {
  const ctx = viewCtx({ path: `/p/${SLUG}/s/${SID}/t/${IDX}`, params: { slug: SLUG, sid: SID, idx: String(IDX) } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) });
  try { await L3.renderTurn(ctx); await settle(); } finally { globalThis.fetch = realFetch; }
  return ctx;
}

const treeRows = (ctx) => ctx.el.querySelectorAll('.lens-tree__row').map((row) => {
  const link = row.querySelector('a');
  return { label: link ? link.textContent : row.textContent, row };
});

test('R12-D1: a cross-GROUP cycle renders the note on both rows, not just in a Problem the page never shows', async () => {
  const ctx = await renderTurn(TURN_PAYLOAD([
    AGENT('xgrp', { runId: RUN, parentAgentId: 'ygrp', lineage: { kind: 'workflow', runId: RUN, parentAgentId: 'ygrp' } }),
    AGENT('ygrp', { parentAgentId: 'xgrp', lineage: { kind: 'child', parentAgentId: 'xgrp' } }),
  ], [{ runId: RUN, turnIdx: IDX, workflowName: 'build' }]));

  const notes = ctx.el.querySelectorAll('.lens-tree__cycle').map((n) => n.textContent);
  assert.equal(notes.length, 2, 'both members are marked — the page used to render zero notes');
  for (const n of notes) assert.equal(n, 'recorded parentAgentId forms a cycle — shown unnested');

  const rowOf = (label) => treeRows(ctx).find((r) => r.label === label).row;
  assert.ok(rowOf('xgrp').querySelector('.lens-tree__cycle'), 'the run-group member');
  assert.ok(rowOf('ygrp').querySelector('.lens-tree__cycle'), 'the plain-group member');
});

test('R12-D1: a cross-PHASE cycle inside one run renders both notes too', async () => {
  const ctx = await renderTurn(TURN_PAYLOAD([
    AGENT('pph', { runId: RUN, phase: 'one', parentAgentId: 'qph', lineage: { kind: 'workflow', runId: RUN } }),
    AGENT('qph', { runId: RUN, phase: 'two', parentAgentId: 'pph', lineage: { kind: 'workflow', runId: RUN } }),
  ], [{ runId: RUN, turnIdx: IDX, workflowName: 'build' }]));
  assert.equal(ctx.el.querySelectorAll('.lens-tree__cycle').length, 2);
});

test('R12-D1: an acyclic turn still renders no cycle note anywhere', async () => {
  const ctx = await renderTurn(TURN_PAYLOAD([
    AGENT('par'),
    AGENT('kid', { parentAgentId: 'par', lineage: { kind: 'child', parentAgentId: 'par' } }),
  ]));
  assert.equal(ctx.el.querySelectorAll('.lens-tree__cycle').length, 0);
  assert.doesNotMatch(textOf(ctx.el), /forms a cycle/);
});
