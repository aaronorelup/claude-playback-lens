// tests/web-pass3.test.mjs — KAN-105 pass 3: per-view vocabulary, grouping and
// expandables.
//
// What this file pins, and why each one is here:
//
//   * THE STYLESHEET GAP. §0.6 of the brief measures the lens-* classes web/js
//     emits that web/styles.css never defines. It stood at 157 entering this
//     pass. The count is re-measured here so a view that starts emitting a new
//     unstyled class fails the suite rather than shipping invisible.
//   * NO VIEW MODULE THROWS. Every registered route is rendered through the
//     real router; the router's own "This page could not be built" card must
//     not appear. This exists because pass 3 broke L0 in exactly that way — an
//     `export … from` re-export creates no LOCAL binding, so renderStore's own
//     call to viewTabs() was a ReferenceError that no test saw and the browser
//     showed on the home page.
//   * The shared viewTabs(), disclosure() and disclosureTools() helpers.
//   * The L4 header-fact grouping is TOTAL: no recorded fact is dropped.
//   * The recorded vocabularies the CSS styles by value (patch lines, block
//     kinds, the ledger's addressable-path rule).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { doc } from './helpers/fake-dom.mjs';
globalThis.document = doc;

const ORIGIN = 'http://127.0.0.1:8791/';
const loc = {
  _hash: '#/',
  get href() { return ORIGIN + this._hash; },
  set href(v) { const i = String(v).indexOf('#'); this._hash = i === -1 ? '#/' : String(v).slice(i); },
  get hash() { return this._hash; },
  set hash(v) { this._hash = String(v).startsWith('#') ? String(v) : `#${v}`; },
  replace(v) { this.hash = v; },
};
globalThis.location = loc;
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
class FakeEventSource {
  constructor(url) { this.url = String(url); this.readyState = 0; }
  addEventListener() {}
  close() { this.readyState = 2; }
}
globalThis.EventSource = FakeEventSource;

/* imports AFTER the fake document exists */
const Router = await import('../web/js/router.mjs');
const Chrome = await import('../web/js/lib/chrome.mjs');
const Dom = await import('../web/js/lib/dom.mjs');
const L4 = await import('../web/js/views/l4.mjs');
const Blockview = await import('../web/js/views/l5/blockview.mjs');
const Inv = await import('../web/js/views/inv.mjs');
const Statbar = await import('../web/js/components/statbar.mjs');

import { sleep } from './helpers/timing.mjs';
const settle = (ms = 40) => sleep(ms);
const el = () => doc.createElement('div');
const text = (n) => n.textContent;

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

/* ==================================================================== *
 * 1. the §0.6 measurement — the undefined-class count
 * ==================================================================== */

/** Every lens-* class web/styles.css defines. */
function definedClasses() {
  const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
  const out = new Set();
  for (const m of css.matchAll(/\.(lens-[A-Za-z0-9_-]+)/g)) out.add(m[1]);
  return out;
}

/** Every lens-* class web/js/** emits as a literal (concatenated modifier
 *  families are checked separately below — this regex cannot see them). */
function usedClasses() {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.mjs')) files.push(p);
    }
  })(path.join(WEB, 'js'));
  const used = new Map();
  const add = (c, f) => {
    if (!/^lens-[A-Za-z0-9_-]+$/.test(c) || c.endsWith('--')) return;
    if (!used.has(c)) used.set(c, new Set());
    used.get(c).add(path.basename(f));
  };
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/class:\s*[`'"]([^`'"]*)[`'"]/g)) for (const c of m[1].split(/[\s\\${}]+/)) add(c, f);
    for (const m of src.matchAll(/class=[\\]?["']([^"']*)/g)) for (const c of m[1].split(/\s+/)) add(c, f);
  }
  return used;
}

/**
 * The documented allowlist. `lens-json__` is NOT a class: jsonview.mjs builds
 * its part names as `lens-json__${part}` and the measurement's regex captures
 * the literal prefix out of the template. Every real class it produces is
 * defined. The same note is written into styles.css.
 */
const ALLOWED_UNDEFINED = ['lens-json__'];

test('§0.6: no lens-* class reaches the page unstyled (bar the documented allowlist)', () => {
  const defined = definedClasses();
  const missing = [...usedClasses().keys()].filter((c) => !defined.has(c)).sort();
  assert.deepEqual(missing, ALLOWED_UNDEFINED,
    `undefined lens-* classes: ${JSON.stringify(missing)} — define them in web/styles.css, or add a reason to the allowlist block there and here`);
});

test('§0.6: the modifier families built by concatenation are defined for every recorded value', () => {
  const defined = definedClasses();
  // Each list is the emit site's OWN vocabulary, read off the source:
  const GLYPHS = ['done', 'error', 'running', 'superseded', 'no-result', 'other', 'unrecorded']; // l3/state.mjs agentGlyph().code
  const KINDS = ['prompt', 'text', 'thinking', 'tool_use', 'tool_result', 'image',
    'fallback', 'attachment', 'system', 'queue-operation', 'unknown'];                           // SPEC §3
  const GROUPS = ['run', 'orphan-running', 'orphan-superseded', 'plain', 'unlinked', 'reference']; // l3/lanes.mjs
  const families = {
    'lens-lane__bar--': [...GLYPHS, 'main'],
    'lens-lane__glyph--': GLYPHS,
    'lens-tree__glyph--': GLYPHS,
    'lens-lane__tag--': ['cached', 'worktree'],
    'lens-chip--': ['cached', 'worktree', 'note', 'warn', 'error', 'workflow', 'resumed', 'countedin'],
    'lens-lanegroup--': GROUPS,
    'lens-tree__row--': ['main', 'workflow', 'phase', 'agent', 'sel', ...GROUPS],
    'lens-strip__span--': ['error'],
    'lens-strip__tick--': ['unmatched', 'thinking', 'text'],
    'lens-patch__line--': ['add', 'del', 'ctx'],
    // blockKind() + enumerateBlocks' 'prompt' + renderEventLevel's 'event'
    'lens-block--': ['prompt', 'text', 'thinking', 'tool_use', 'tool_result', 'image', 'fallback', 'unknown', 'event'],
    'lens-comp__seg--': KINDS,
    'lens-kind--': KINDS,
    'lens-facts__cell--': ['title', 'mode', 'pr', 'frame', 'last-prompt'],
    'lens-badge--': ['fragment', 'forked', 'no-reply', 'retried', 'running', 'cached', 'live', 'unknown', 'modified', 'error'],
    'lens-affects--': ['aggregates', 'display', 'nothing'],
    'lens-table__row--': ['error', 'warning', 'note'],
    'lens-audit__badge--': ['pass', 'fail', 'pending'],
    'lens-tabs__tab--': ['on', 'current'],
  };
  const missing = [];
  for (const [prefix, values] of Object.entries(families)) {
    for (const v of values) if (!defined.has(prefix + v)) missing.push(prefix + v);
  }
  assert.deepEqual(missing, [], `dynamic modifiers with no rule: ${JSON.stringify(missing)}`);
});

test('no colour literal reaches a component rule — every colour is a --lens-* token', () => {
  const raw = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
  // Comments are prose and may say the word "#FFFFFF"; blank them out first,
  // keeping the line count so an offender can be located.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Layer 1 (the --pc-*/--th-* palette) is the ONE place a literal belongs.
  const offenders = [];
  css.split('\n').forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith('--pc-') || l.startsWith('--th-')) return;
    if (/#[0-9a-fA-F]{3,8}\b/.test(l) || /\brgba?\(/.test(l)) offenders.push(`${i + 1}: ${l}`);
  });
  assert.deepEqual(offenders, [], `colour literals outside the palette layer:\n${offenders.join('\n')}`);
});

/* ==================================================================== *
 * 2. no view module throws
 * ==================================================================== */

const SLUG = 'C--pass3-proj';
const SID = 'dd000000-0000-4000-8000-0000000000bb';
const RUN = 'wf_00000002-b02';
const noHeaders = { get: () => null };
const json = (body) => ({
  ok: true, status: 200, statusText: 'OK', headers: noHeaders,
  text: async () => JSON.stringify(body), json: async () => body,
});
const PLAN = {
  '/api/index': {
    version: 7, boot: 'pass3',
    status: { state: 'ready', sessionsDone: 1, sessionsTotal: 1, bytesIndexed: 1, bytesTotal: 1 },
    agg: null, projects: [{ slug: SLUG, label: SLUG, sessions: 1, turns: 2 }],
    sessions: [{ slug: SLUG, id: SID, state: 'ok', badges: [] }],
    turnBars: [], dayBands: [], pending: [], problems: [],
  },
  '/api/project/': { slug: SLUG, sessions: [], memory: [], fragments: [], problems: [] },
  '/api/session/': {
    slug: SLUG, id: SID, agents: [], turns: [], workflows: [], rows: [], rowsTotal: 0,
    agg: null, problems: [], inventory: { perType: { assistant: 3 }, rows: 3 },
  },
  '/api/turn/': { slug: SLUG, id: SID, turn: { idx: 0, at: null, rowCount: 0 }, agents: [], workflows: [], rows: [], rowsTotal: 0, agg: null, problems: [] },
  '/api/agent/': { slug: SLUG, id: SID, agentId: 'main', rel: `${SID}.jsonl`, rows: [], total: 0, agg: null, problems: [] },
  '/api/line': { slug: SLUG, id: SID, file: `${SID}.jsonl`, line: 1, raw: '{"type":"assistant"}', cost: null, problems: [] },
  '/api/workflow/': { slug: SLUG, id: SID, runId: RUN, record: { runId: RUN, status: 'completed', workflowProgress: [] }, agents: [], journal: {}, problems: [] },
  '/api/file': 'the recorded bytes\n',
  '/api/config': { root: 'C:/store', problems: [] },
};
function installFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init && init.signal && init.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const key = Object.keys(PLAN).find((k) => String(url).includes(k));
    const spec = key ? PLAN[key] : {};
    if (typeof spec === 'string') {
      return { ok: true, status: 200, statusText: 'OK', headers: noHeaders, text: async () => spec, json: async () => { throw new Error('not JSON'); } };
    }
    return json(spec);
  };
  return () => { globalThis.fetch = real; };
}

const PARAM = { slug: SLUG, sid: SID, id: SID, idx: '0', agentId: 'main', eventRef: '1', runId: RUN, name: 'MEMORY.md' };
const REST = { rel: 'tool-results/spill.txt', scope: 'store' };
function hashFor(compiled) {
  const out = [];
  for (const seg of compiled.segs) {
    if (seg.kind === 'lit') out.push(seg.name);
    else if (seg.kind === 'param') out.push(encodeURIComponent(PARAM[seg.name] ?? 'x'));
    else out.push(String(REST[seg.name] ?? 'x').split('/').map(encodeURIComponent).join('/'));
  }
  return '#/' + out.join('/');
}

test('every registered route renders without the router\'s "could not be built" card', async () => {
  const restore = installFetch();
  const shell = Router.buildShell(doc.createElement('div'));
  await Router.loadViewModules();
  const table = Router.routeTable();
  assert.ok(table.length >= 13, `the whole route spine is registered (got ${table.length})`);
  const broken = [];
  for (const entry of table) {
    const compiled = entry.compiled;
    loc.hash = hashFor(compiled);
    await Router.render();
    await settle(20);
    const card = shell.contentEl.querySelector('.lens-card--error');
    // A view's OWN errorCard is legitimate (a bad locator says so); the
    // router's untitled one means the module threw.
    if (card && /could not be built/.test(text(card))) broken.push(`${entry.pattern}: ${text(card)}`);
  }
  restore();
  assert.deepEqual(broken, [], `view modules threw:\n${broken.join('\n')}`);
});

test('the document carries exactly one <h1>, and it names where the reader is', async () => {
  const restore = installFetch();
  const shell = Router.buildShell(doc.createElement('div'));
  await Router.loadViewModules();
  loc.hash = `#/p/${SLUG}/s/${SID}?v=images`;
  await Router.render();
  await settle(20);
  const h1s = shell.root.querySelectorAll('h1');
  assert.equal(h1s.length, 1, 'one document heading, in the shell');
  assert.ok(text(h1s[0]).length > 0, 'and it is not empty');
  assert.match(text(h1s[0]), /images/, 'the named view reaches the heading');
  // …and the rail's last segment is that view, as a non-link.
  const items = shell.crumbEl.querySelectorAll('.lens-crumbs__item');
  assert.match(text(items[items.length - 1]), /images/);
  assert.equal(items[items.length - 1].querySelectorAll('a').length, 0, 'the view segment is where you are, so it is not a link');
  restore();
});

test('a ?v= that is not view-key shaped adds no crumb — an unknown param stays one', () => {
  assert.equal(Router.viewCrumb(new URLSearchParams('v=images')).label, 'images');
  assert.equal(Router.viewCrumb(new URLSearchParams('')), null);
  assert.equal(Router.viewCrumb(new URLSearchParams('v=' + 'x'.repeat(40))), null);
  assert.equal(Router.viewCrumb(new URLSearchParams('v=../etc')), null);
});

/* ==================================================================== *
 * 3. the viewTabs() kit helper
 * ==================================================================== */

function tabCtx(pathStr, queryStr) {
  const registered = [];
  return {
    path: pathStr,
    query: new URLSearchParams(queryStr || ''),
    registerViews: (v) => registered.push(v),
    registered,
  };
}

test('viewTabs draws one strip, marks the active tab, and drops ?v for the default', () => {
  const ctx = tabCtx('/p/x', 'sort=cost&dir=desc');
  const nav = Chrome.viewTabs(ctx, [
    { key: 'sessions', label: 'sessions' },
    { key: 'timeline', label: 'timeline' },
    { key: 'memory', label: 'memory' },
  ], 'timeline');
  const tabs = nav.querySelectorAll('.lens-tabs__tab');
  assert.equal(tabs.length, 3);
  assert.equal(tabs[0].getAttribute('href'), '#/p/x?sort=cost&dir=desc', 'the default tab drops ?v entirely');
  assert.equal(tabs[1].getAttribute('href'), '#/p/x?sort=cost&dir=desc&v=timeline', 'and every other param survives (DESIGN §0)');
  assert.equal(tabs[1].getAttribute('aria-current'), 'page');
  assert.ok(tabs[1].classList.contains('lens-tabs__tab--on'), 'ONE emission marks the active tab');
  assert.equal(tabs[0].getAttribute('aria-current'), null);
});

test('viewTabs registers the view list default-first, so `t` cycling is stable', () => {
  const ctx = tabCtx('/p/x/s/y', '');
  Chrome.viewTabs(ctx, [
    { key: 'turns', label: 'turns' },
    { key: 'agents', label: 'agents', default: true },
    { key: 'files', label: 'files' },
  ], 'files');
  assert.deepEqual(ctx.registered[0].map((v) => v.key), ['agents', 'turns', 'files'],
    'the router drops ?v for views[0], so the DEFAULT view must be first');
  // and the strip still reads in display order
  const nav = Chrome.viewTabs(ctx, [
    { key: 'turns', label: 'turns' },
    { key: 'agents', label: 'agents', default: true },
    { key: 'files', label: 'files' },
  ], 'files');
  assert.deepEqual(nav.querySelectorAll('.lens-tabs__tab').map((t) => text(t)), ['turns', 'agents', 'files']);
  assert.equal(nav.querySelectorAll('.lens-tabs__tab')[1].getAttribute('href'), '#/p/x/s/y',
    'the session default drops ?v even when it is not the first tab');
});

/* ==================================================================== *
 * 4. disclosure() and disclosureTools()
 * ==================================================================== */

test('disclosure() is a native <details> — free keyboard, free find-in-page', () => {
  const d = Dom.disclosure('raw event JSON', doc.createElement('pre'), { count: '3 blocks' });
  assert.equal(d.localName, 'details');
  assert.ok(d.classList.contains('lens-details'));
  assert.equal(d.hasAttribute('open'), false, 'collapsed by default');
  const sum = d.childNodes[0];
  assert.equal(sum.localName, 'summary', 'the summary is the FIRST child, or the UA will not use it');
  assert.match(text(sum), /raw event JSON/);
  assert.match(text(sum), /3 blocks/, 'the size of what is folded is stated before it is opened');
  const open = Dom.disclosure('x', doc.createElement('p'), { open: true });
  assert.equal(open.hasAttribute('open'), true);
});

test('disclosureTools expands and collapses every sibling — and renders nothing below 3', () => {
  const host = el();
  host.appendChild(Dom.disclosure('a', el(), { open: true }));
  host.appendChild(Dom.disclosure('b', el()));
  assert.equal(Dom.disclosureTools(host), null, 'a control for two boxes is noise');
  host.appendChild(Dom.disclosure('c', el()));
  const tools = Dom.disclosureTools(host);
  const [expand, collapse] = tools.querySelectorAll('button');
  assert.equal(expand.getAttribute('type'), 'button', 'a real button — keyboard operable by construction');
  expand.dispatch('click');
  assert.deepEqual(host.querySelectorAll('details').map((d) => d.hasAttribute('open')), [true, true, true]);
  collapse.dispatch('click');
  assert.deepEqual(host.querySelectorAll('details').map((d) => d.hasAttribute('open')), [false, false, false]);
});

/* ==================================================================== *
 * 5. the L4 header-fact grouping
 * ==================================================================== */

test('grouping the L4 header facts drops none of them, and keeps their order', () => {
  const facts = L4.headerFacts({
    agentId: 'a1', label: 'a label', agentType: 'general', model: 'claude-opus-5',
    modelSource: 'recorded model', state: 'done', phase: 'p1', attempt: 1, spawnDepth: 2,
    parentAgentId: 'a0', toolUseId: 'toolu_1', runId: RUN, firstAt: 1000, lastAt: 2000,
    queuedAt: 900, progStartedAt: 950, durationMs: 1000, cached: true,
    worktreePath: 'C:/wt', spawnedWithWorktree: true, isolation: 'worktree',
  });
  const grouped = L4.groupHeaderFacts(facts);
  const flat = [].concat(...L4.FACT_GROUPS.map((g) => grouped[g.key]));
  assert.equal(flat.length, facts.length, 'every recorded fact lands in exactly one group');
  assert.deepEqual(new Set(flat.map((f) => f.label)), new Set(facts.map((f) => f.label)));
  // order inside a group is headerFacts' order
  assert.deepEqual(grouped.identity.map((f) => f.label), ['label', 'agentId', 'agentType']);
  assert.deepEqual(grouped.model.map((f) => f.label), ['model (raw)', 'effort']);
  assert.ok(grouped.lifecycle.some((f) => f.label === 'wall'));
  assert.ok(grouped.provenance.some((f) => f.label === 'worktreePath'));
});

test('a header fact the group table does not name falls into provenance, never off the page', () => {
  const grouped = L4.groupHeaderFacts([{ label: 'a fact invented next year', value: 'x' }]);
  assert.deepEqual(grouped.provenance.map((f) => f.label), ['a fact invented next year']);
});

test('identity, lifecycle and model open by default; tools and provenance are collapsed', () => {
  const open = Object.fromEntries(L4.FACT_GROUPS.map((g) => [g.key, g.open]));
  assert.deepEqual(open, { identity: true, lifecycle: true, model: true, tools: false, provenance: false });
});

/* ==================================================================== *
 * 6. the L5 rendered block
 * ==================================================================== */

test('a tool_use input past the fold threshold goes behind a disclosure stating its exact line count', () => {
  const short = { bi: '0', kind: 'tool_use', node: { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: 'a.mjs' } } };
  const shortBox = Blockview.renderBlock(short, {}, null);
  assert.equal(shortBox.querySelectorAll('details').length, 0, 'a short input prints open');
  assert.ok(shortBox.querySelectorAll('.lens-block__sub').length, 'and keeps its heading');

  const big = {};
  for (let i = 0; i < 60; i++) big[`k${i}`] = i;
  const long = { bi: '0', kind: 'tool_use', node: { type: 'tool_use', name: 'Write', id: 't2', input: big } };
  const longBox = Blockview.renderBlock(long, {}, null);
  const det = longBox.querySelector('details');
  assert.ok(det, `an input over ${Blockview.INPUT_FOLD_LINES} recorded lines folds`);
  assert.equal(det.hasAttribute('open'), false);
  assert.match(text(det.childNodes[0]), /62 recorded lines/, 'the EXACT recorded line count, so the reader knows before opening');
  assert.ok(det.querySelector('.lens-json'), 'and the JSON is still there, verbatim');
});

test('patch lines carry their recorded +/- prefix AND a class — never colour alone', () => {
  const block = { bi: 'r', kind: 'tool_result', node: { type: 'tool_result', tool_use_id: 't1', content: 'ok' } };
  const event = { toolUseResult: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-gone', '+added', ' kept'] }] } };
  const box = Blockview.renderBlock(block, event, null);
  const lines = box.querySelectorAll('.lens-patch__line');
  assert.deepEqual(lines.map((n) => n.getAttribute('class').split(' ')[1]),
    ['lens-patch__line--del', 'lens-patch__line--add', 'lens-patch__line--ctx']);
  assert.match(text(lines[0]), /^-gone/, 'the recorded prefix is part of the line text, so the sign survives greyscale');
  assert.match(text(lines[1]), /^\+added/);
});

/* ==================================================================== *
 * 7. the files ledger's raw-view link
 * ==================================================================== */

test('only a session-relative recorded path is addressable — an absolute one is not guessed at', () => {
  assert.equal(Inv.sessionRelOf('subagents/agent-a1.jsonl'), 'subagents/agent-a1.jsonl');
  assert.equal(Inv.sessionRelOf('subagents\\agent-a1.jsonl'), 'subagents/agent-a1.jsonl', 'a recorded Windows separator is the same path');
  assert.equal(Inv.sessionRelOf('C:/Users/x/proj/README.md'), null, 'an absolute working-tree path has no page here');
  assert.equal(Inv.sessionRelOf('/var/log/x'), null);
  assert.equal(Inv.sessionRelOf('../outside.txt'), null, 'and nothing may escape the session directory');
  assert.equal(Inv.sessionRelOf(''), null);
});

test('surfaceLink sends each recorded class to the page that shows it, carrying the way back', () => {
  const opts = { slug: SLUG, sid: SID };
  const agent = Inv.surfaceLink(Inv.classifyRel('subagents/agent-a1.jsonl'), { ...opts, rel: 'subagents/agent-a1.jsonl' });
  assert.equal(agent.localName, 'a');
  assert.match(agent.getAttribute('href'), /\/a\/a1/);
  const wf = Inv.surfaceLink(Inv.classifyRel('subagents/workflows/r1/journal.jsonl'), { ...opts, rel: 'subagents/workflows/r1/journal.jsonl' });
  assert.match(wf.getAttribute('href'), /\/w\/r1/);
  const spill = Inv.surfaceLink(Inv.classifyRel('tool-results/out.txt'), { ...opts, rel: 'tool-results/out.txt' });
  assert.match(spill.getAttribute('href'), /\/x\/tool-results\/out\.txt/,
    'the RECORDED rel, verbatim — never the pattern\'s matched tail');
  const noRel = Inv.surfaceLink({ surface: 'raw' }, { ...opts, rel: null });
  assert.ok(noRel.classList.contains('lens-unknown'), 'no rel, no link — and it says why');
  assert.ok(noRel.getAttribute('title').length > 0);
});

/* ==================================================================== *
 * 8. the stat-header group divider
 * ==================================================================== */

test('the stat-header divider is a rule, not a glyph the reader could read as a value', () => {
  const node = el();
  Statbar.statbar(node, { agg: { requests: 1, usd: { total: 1 }, tokens: {} }, counts: [{ key: 'rows', label: 'rows', value: 3 }] });
  const seps = node.querySelectorAll('.lens-statbar__sep');
  assert.ok(seps.length >= 1, 'the divider is still emitted');
  for (const s of seps) assert.equal(text(s), '', 'and it carries no text at all');
});
