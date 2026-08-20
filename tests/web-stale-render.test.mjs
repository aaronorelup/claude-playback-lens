// tests/web-stale-render.test.mjs — the STALE-RENDER RULE, pinned across the
// view modules. Merged from tests/web-fixes-round13.test.mjs and
// tests/web-fixes-round14.test.mjs, which shared this harness line for line;
// both files' complete defect narratives are preserved below, labelled by
// round, and every test from both files survives here.
//
// ===================== ROUND 13 (fixer pass, BROWSER side) =====================
//
//   R13-F1 (web/js/router.mjs + views/l3.mjs, l4.mjs, workflow.mjs, inv.mjs)
//       The stale-render guard (renderToken / ctx.stale) protected only the
//       CONTENT the view painted. The three chrome bands — crumb rail, scope
//       sentence, cost/token stat band — plus the document title are the
//       SHELL's own persistent nodes, repainted unconditionally by
//       ctx.crumbs()/ctx.scopeSentence()/ctx.statbar()/ctx.setTitle() with no
//       staleness check anywhere in the chain. l1/l2 defended themselves with
//       `if (ctx.stale) return;` after every await; l3, l4, workflow and inv —
//       turn, agent, workflow-run and session-inventory, four of the six
//       levels — did neither that NOR pass `signal`, so an abandoned request
//       was never even cancelled. When it finally resolved, the abandoned
//       page's title, scope sentence and REAL COST FIGURES were painted over
//       the page the reader was actually on, under the correct crumb rail and
//       correct URL, with no disclosure at all. Reproduced live twice by the
//       finder and again by the validator (a $1.66 agent's tokens printed
//       under a $5.98 agent's name).
//
//       The escalation the finding missed and the validator reproduced: the
//       unguarded CATCH arm calls handle404(), which banners AND navigates —
//       so a stale 404 continuation does not merely mislabel the page, it
//       yanks the reader off it seconds later.
//
//   COVERAGE NOTE (R14-D1): the five R13-F1 tests below are all l3/l4/inv/
//   workflow. l5, audit, find, memory and settings had the identical gap and
//   no test here caught it — which is exactly how it shipped. Their cases now
//   live in the R14-D1 sections of THIS file. When a view is added, its
//   staleness case belongs beside them: the STALE-RENDER RULE binds all
//   twelve views.
//
// ===================== ROUND 14 (fixer pass, BROWSER side) =====================
//
//   R14-D1 (web/js/views/l5.mjs — renderEvent + the shared handle404;
//           collateral in audit.mjs, find.mjs, memory.mjs, settings.mjs)
//       R13-F1 wrote the STALE-RENDER RULE into BUILD-CONTRACTS and applied it
//       to l3, l4, inv and workflow. It never touched l5 — and renderEvent, the
//       L5 event/block drill-down linked from every row locator in L3 and L4,
//       had NO ctx.stale check at any resume point, NO { signal: ctx.signal } on
//       either of its fetches, and both catch arms called handle404() as their
//       first statement. handle404 ends in `ctx.navigate(ancestor.href,
//       {replace:true})`, and `navigate` is the ONE chrome surface the router's
//       R13-F1 backstop deliberately does not wrap (find.mjs calls it from a
//       live submit handler). So an abandoned event page whose /api/line
//       finally answered 404 yanked the reader off the page they were actually
//       reading, seconds later, with a banner about the page they had left.
//
//       A contract every view MUST follow is only a contract if every view
//       follows it: audit.mjs, find.mjs, memory.mjs and settings.mjs carried
//       the same gap and are fixed and covered here too.
//
//       WHY THE R14-D1 CASES EXIST AT ALL: the five R13-F1 tests above them
//       are all l3/l4/inv/workflow. There was no l5 case, and that omission is
//       precisely why the class recurred. Each navigation assertion below is
//       paired with a CONTROL that fires a real navigation through the same
//       harness, so a future harness regression cannot make these pass
//       vacuously.
//
// Both rounds drive the REAL router over the fake document: buildShell() +
// real defineRoute() + real render(), with fetch stubbed so ONE route hangs.
// That is the shipped mechanism, not a model of it — the bands under
// assertion are the shell's own nodes, mounted by the real components.

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * fake document (same shape as web-dom-smoke / web-fixes-round12)
 * ------------------------------------------------------------------ */

// The fake DOM itself lives in tests/helpers/fake-dom.mjs (shared by every
// web test file); it is installed here, BEFORE the web modules are imported.
import { doc } from './helpers/fake-dom.mjs';

globalThis.document = doc;

/** The router reads location.href (COR-29) and navigate() writes location.hash. */
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

/** EventSource does not exist under node: audit and find open their SSE streams
 *  through it, so this stub is how "did the superseded render start a
 *  whole-corpus scan?" becomes an assertion rather than a code reading. */
const sseLog = { opened: [], closed: 0 };
class FakeEventSource {
  constructor(url) { this.url = String(url); this.readyState = 0; sseLog.opened.push(this.url); }
  addEventListener() {}
  close() { this.readyState = 2; sseLog.closed += 1; }
}
globalThis.EventSource = FakeEventSource;

/* imports AFTER the fake document exists */
const Router = await import('../web/js/router.mjs');
const L3 = await import('../web/js/views/l3.mjs');
const L4 = await import('../web/js/views/l4.mjs');
const L5 = await import('../web/js/views/l5.mjs');
const Audit = await import('../web/js/views/audit.mjs');
const Find = await import('../web/js/views/find.mjs');
const Memory = await import('../web/js/views/memory.mjs');
const Settings = await import('../web/js/views/settings.mjs');
const ServerConfig = await import('../server/config.mjs');

import { sleep } from './helpers/timing.mjs';
const settle = (ms = 20) => sleep(ms); // this file settles on 20ms, not the shared 30

/* ------------------------------------------------------------------ *
 * fixture payloads
 * ------------------------------------------------------------------ */

// The source files each used their own arbitrary slug (C--r13-proj /
// C--r14-proj); the slug is a routing key internal to each test — fetch is
// stubbed, nothing asserts on it — so one value serves every section.
const SLUG = 'C--stale-render';
const SID = 'cc000000-0000-4000-8000-000000000003';
const AGENT = 'main';

/** The ABANDONED page's figures — nothing here may ever reach the shell. */
const STALE_USD = 1.6596;
/** The page the reader is actually on. */
const LIVE_USD = 5.9811;

// SPEC §6 / shared/pricing.mjs: cost is carried as integer tcu, USD = tcu / 2e9.
const TCU_PER_USD = 2e9;
const agg = (usd, requests) => ({
  usd: { total: Math.round(usd * TCU_PER_USD) },
  requests,
  tokens: { input: 120, output: 40504, cacheWrite: 101538, cacheRead: 5002559 },
});

const turnPayload = (idx, usd) => ({
  slug: SLUG, id: SID,
  turn: {
    idx, preamble: false, at: 1755399990000, endAt: 1755401000000,
    openerLine: 10, rowCount: 1, prompt: { text: `prompt for turn ${idx}` },
  },
  agents: [], workflows: [],
  agg: agg(usd, idx === 1 ? 111 : 222),
  rows: [{ line: 10, bi: null, kind: 'user', at: 1755399990000, head: `row of turn ${idx}` }],
  rowsTotal: 1, turnCount: 9, rowsSumToHeader: null, problems: [],
});

/** The L4 agent-page payload (round 13's agent test). */
const l4AgentPayload = (agentId, usd) => ({
  slug: SLUG, id: SID, agentId,
  rel: `${SLUG}/${SID}/subagents/agent-${agentId}.jsonl`,
  rows: [{ line: 1, bi: null, kind: 'assistant', at: 1755399990000, head: `row of ${agentId}` }],
  total: 170, toolCalls: 616,
  firstAt: 1755399990000, lastAt: 1755400596000,
  agg: agg(usd, 616),
  problems: [],
});

/** The minimal agent payload the l5 event harness resolves files through. */
const l5AgentPayload = {
  slug: SLUG, id: SID, agentId: AGENT,
  rel: `${SID}.jsonl`,
  rows: [{ line: 1, bi: null, kind: 'assistant', at: 1755399990000, head: 'row' }],
  total: 1, agg: null, problems: [],
};

const linePayload = (usd) => ({
  slug: SLUG, id: SID, file: `${SID}.jsonl`, line: 42,
  at: 1755399990000,
  raw: JSON.stringify({
    type: 'assistant', uuid: 'aSTALE', timestamp: '2026-08-01T10:00:00.000Z',
    message: { id: 'msg_stale', role: 'assistant', content: [{ type: 'text', text: 'the abandoned event body' }] },
  }),
  cost: agg(usd, 1),
  problems: [],
});

/* ------------------------------------------------------------------ *
 * the harness: one route hangs, the reader navigates away, it resolves
 * ------------------------------------------------------------------ */

let shell = Router.buildShell(doc.createElement('div'));

/** Install a fetch stub. `plan` maps a URL substring to a payload, or to
 *  `{ hold }` / `{ hold404 }` / `{ holdPending }` — parked until release().
 *  A hold404 spec may carry `code` to keep each test's wire bytes exact
 *  (round 13 answered `unknown-turn`, round 14 `unknown-line`).
 *  Every request's AbortSignal is recorded so "was it actually cancelled?"
 *  is an assertion rather than a hope. */
function installFetch(plan) {
  const holds = [];
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const signal = init && init.signal;
    seen.push({ url: u, signal });
    // Honour the signal the way the platform does — otherwise a test could
    // "pass" while the code never actually cancels anything.
    if (signal && signal.aborted) {
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      throw e;
    }
    const key = Object.keys(plan).find((k) => u.includes(k));
    const spec = key ? plan[key] : null;
    if (spec === null || spec === undefined) return json(200, {});
    if (typeof spec === 'string') return raw(spec);      // /api/file serves bytes
    if (spec.hold !== undefined || spec.hold404 !== undefined || spec.holdPending !== undefined) {
      await new Promise((r) => holds.push(r));
      if (spec.hold404 !== undefined) return json(404, { error: { code: spec.code || 'unknown-line', message: spec.hold404 } });
      if (spec.holdPending !== undefined) return json(409, { error: { code: 'not-indexed-yet', message: 'building', detail: spec.holdPending } });
      return json(200, spec.hold);
    }
    return json(200, spec);
  };
  return {
    release: () => { for (const r of holds.splice(0)) r(); },
    restore: () => { globalThis.fetch = realFetch; },
    get held() { return holds.length; },
    seen,
    forUrl: (frag) => seen.filter((s) => s.url.includes(frag)),
  };
}
const noHeaders = { get: () => null };
const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'OK',
  headers: noHeaders,
  text: async () => JSON.stringify(body),
  json: async () => body,
});
/** fetchRaw() reads bytes, not JSON — /api/file answers with the file itself. */
const raw = (text) => ({
  ok: true, status: 200, statusText: 'OK', headers: noHeaders,
  text: async () => text,
  json: async () => { throw new Error('not JSON'); },
});

/** Fresh shell + route table for each test. */
function reset(routeDefs) {
  Router.clearRoutes();
  shell = Router.buildShell(doc.createElement('div'));
  doc.title = '';
  sseLog.opened.length = 0;
  sseLog.closed = 0;
  for (const [pattern, fn] of routeDefs) Router.defineRoute(pattern, fn);
}

const bandText = () => ({
  crumb: shell.crumbEl.textContent,
  scope: shell.scopeEl.textContent,
  stat: shell.statEl.textContent,
  content: shell.contentEl.textContent,
  banner: shell.bannerEl.textContent,
  title: doc.title,
});

const eventHash = (line) => `#/p/${SLUG}/s/${SID}/a/${AGENT}/e/${line}`;
const turnHash = (idx) => `#/p/${SLUG}/s/${SID}/t/${idx}`;

/* ==================================================================== *
 * l3 (turn) + l4 (agent) + the router backstop — round 13's R13-F1
 * ==================================================================== */

test('R13-F1: a superseded TURN render cannot repaint the title, scope sentence or stat band', async () => {
  reset([['/p/:slug/s/:sid/t/:idx', L3.renderTurn]]);
  const net = installFetch({
    // the ABANDONED route hangs (a heavy turn on a 1.3 GB store)
    [`/api/turn/${SLUG}/${SID}/1`]: { hold: turnPayload(1, STALE_USD) },
    // the route the reader actually lands on answers at once
    [`/api/turn/${SLUG}/${SID}/2`]: turnPayload(2, LIVE_USD),
  });
  try {
    loc.hash = `#/p/${SLUG}/s/${SID}/t/1`;
    const abandoned = Router.render();          // deliberately NOT awaited
    await settle();
    assert.equal(net.held, 1, 'the first render is parked inside its fetch — the window this is about');

    loc.hash = `#/p/${SLUG}/s/${SID}/t/2`;
    await Router.render();                      // the reader is now on turn 2
    await settle();
    const live = bandText();
    assert.match(live.title, /turn 2/, 'sanity: the live render owns the chrome');
    assert.match(live.scope, /turn 2/);

    net.release();                              // …and NOW the abandoned fetch lands
    await abandoned;
    await settle();

    const after = bandText();
    assert.match(after.title, /turn 2/, 'the tab title still names the page the reader is on');
    assert.doesNotMatch(after.title, /turn 1/, 'the abandoned render must not rename the page');
    assert.match(after.crumb, /turn 2/, 'the crumb rail was always right — it is mounted pre-await');
    assert.match(after.scope, /turn 2/, 'and the scope sentence must agree with it');
    assert.doesNotMatch(after.scope, /turn 1 of session/,
      'the scope sentence used to describe the page the reader had already left');
    assert.doesNotMatch(after.stat, /\$1\.65/,
      'and the stat band used to print the abandoned turn\'s real money under the current turn\'s name');
    assert.match(after.stat, /\$5\.98/, 'the band keeps the figures of the page it sits above');
  } finally { net.restore(); }
});

test('R13-F1: a superseded AGENT render cannot repaint the cost/token band — the live repro', async () => {
  reset([['/p/:slug/s/:sid/a/:agentId', L4.renderAgent]]);
  const SLOW = 'a83a29905cb460f05';
  const FAST = 'aa262c0cddfa00b76';
  const net = installFetch({
    [`/api/agent/${SLUG}/${SID}/${SLOW}`]: { hold: l4AgentPayload(SLOW, STALE_USD) },
    [`/api/agent/${SLUG}/${SID}/${FAST}`]: l4AgentPayload(FAST, LIVE_USD),
    // siblingAgents' session detail — answered for both
    [`/api/session/${SLUG}/${SID}`]: { agents: [{ agentId: SLOW }, { agentId: FAST }] },
  });
  try {
    loc.hash = `#/p/${SLUG}/s/${SID}/a/${SLOW}`;
    const abandoned = Router.render();
    await settle();

    loc.hash = `#/p/${SLUG}/s/${SID}/a/${FAST}`;
    await Router.render();
    await settle();

    net.release();
    await abandoned;
    await settle();

    const after = bandText();
    assert.match(after.title, /aa262c0c/, 'the title names the agent in the URL');
    assert.doesNotMatch(after.title, /a83a2990/);
    assert.match(after.crumb, /aa262c0c/);
    assert.doesNotMatch(after.scope, /a83a2990/,
      'the scope sentence used to say "Showing 170 rows in agent a83a2990" on a page addressed to another agent');
    assert.match(after.stat, /\$5\.98/);
    assert.doesNotMatch(after.stat, /\$1\.65/,
      'the band printed one agent\'s real dollars under another agent\'s crumb — the whole finding, in one assertion');
  } finally { net.restore(); }
});

test('R13-F1: a superseded 404 continuation must NOT navigate the reader off the page they are on', async () => {
  // The escalation: handle404() banners AND navigates. Reproduced live — a
  // slow unknown-agent 404 pulled the browser off a valid agent 7 s later.
  reset([['/p/:slug/s/:sid/t/:idx', L3.renderTurn]]);
  const net = installFetch({
    [`/api/turn/${SLUG}/${SID}/7`]: { hold404: 'no such turn', code: 'unknown-turn' },
    [`/api/turn/${SLUG}/${SID}/2`]: turnPayload(2, LIVE_USD),
  });
  try {
    loc.hash = `#/p/${SLUG}/s/${SID}/t/7`;
    const abandoned = Router.render();
    await settle();

    loc.hash = `#/p/${SLUG}/s/${SID}/t/2`;
    await Router.render();
    await settle();
    const hashBefore = loc.hash;

    net.release();
    await abandoned;
    await settle();

    assert.equal(loc.hash, hashBefore,
      'a stale 404 must not yank the reader to the ancestor of a page they already left');
    assert.doesNotMatch(shell.bannerEl.textContent, /no turn 7/,
      'and it must not banner about it either');
    assert.match(bandText().title, /turn 2/);
  } finally { net.restore(); }
});

test('R13-F1: a superseded PENDING envelope must not blank the live page (ctx.el IS shell.contentEl)', async () => {
  reset([['/p/:slug/s/:sid/t/:idx', L3.renderTurn]]);
  const net = installFetch({
    [`/api/turn/${SLUG}/${SID}/5`]: { holdPending: { retryAfterMs: 100000, bytesIndexed: 1, bytesTotal: 10 } },
    [`/api/turn/${SLUG}/${SID}/2`]: turnPayload(2, LIVE_USD),
  });
  try {
    loc.hash = `#/p/${SLUG}/s/${SID}/t/5`;
    const abandoned = Router.render();
    await settle();

    loc.hash = `#/p/${SLUG}/s/${SID}/t/2`;
    await Router.render();
    await settle();
    const liveContent = bandText().content;
    assert.ok(liveContent.length > 0, 'sanity: the live page painted something');

    net.release();
    await abandoned;
    await settle();

    assert.equal(bandText().content, liveContent,
      'a stale pending envelope replaced the live page body with a progress bar for a route nobody is on');
    assert.doesNotMatch(bandText().content, /this route is not indexed yet/);
  } finally { net.restore(); }
});

test('R13-F1: the router-level guard is the backstop — the chrome wrappers no-op once superseded', async () => {
  // Belt and braces at the ONE shared site, so the class cannot recur the next
  // time a view is added. This drives the wrappers directly through a view
  // that ignores ctx.stale entirely.
  let captured = null;
  reset([['/p/:slug/s/:sid/t/:idx', async (ctx) => {
    if (ctx.params.idx === '2') {
      ctx.setTitle('the live page');
      ctx.crumbs({ items: [{ label: 'the live crumb' }] });
      ctx.scopeSentence({ subject: 'the live subject' });
      ctx.statbar({ pending: true, counts: [] });
      return;
    }
    captured = ctx;
    await new Promise((r) => setTimeout(r, 5));
    // A view that never checks ctx.stale — every one of these used to land.
    ctx.setTitle('the abandoned page');
    ctx.crumbs({ items: [{ label: 'the abandoned crumb' }] });
    ctx.scopeSentence({ subject: 'the abandoned subject' });
    ctx.statbar({ pending: true, counts: [{ key: 'k', label: 'abandoned rows', value: 7 }] });
    ctx.banner('a banner from a page nobody is on', 'warn');
    ctx.loading({ label: 'progress for a route nobody is on' });
  }]]);

  loc.hash = `#/p/${SLUG}/s/${SID}/t/1`;
  const abandoned = Router.render();
  loc.hash = `#/p/${SLUG}/s/${SID}/t/2`;
  await Router.render();
  const liveContent = shell.contentEl.textContent;
  await abandoned;

  assert.equal(captured.stale, true, 'the abandoned render knows it is stale — it simply never asked');
  const after = bandText();
  assert.doesNotMatch(after.title, /abandoned/, 'setTitle is token-guarded');
  assert.doesNotMatch(after.crumb, /abandoned/, 'ctx.crumbs is token-guarded');
  assert.doesNotMatch(after.scope, /abandoned/, 'ctx.scopeSentence is token-guarded');
  assert.doesNotMatch(after.stat, /abandoned/, 'ctx.statbar is token-guarded');
  assert.doesNotMatch(shell.bannerEl.textContent, /nobody is on/, 'ctx.banner is token-guarded');
  assert.equal(shell.contentEl.textContent, liveContent, 'ctx.loading is token-guarded');
  assert.match(after.title, /the live page/);
  assert.match(after.crumb, /the live crumb/);
});

/* ==================================================================== *
 * l5 (event) — round 14's R14-D1
 * ==================================================================== */

test('R14-D1: a superseded EVENT render\'s stale 404 must NOT navigate the reader off the page they are on', async () => {
  // The blocker, exactly as reproduced: the reader opens an event page whose
  // /api/line is slow, gives up, opens a real turn page — and the abandoned
  // page's 404 lands and rewrites location.hash out from under them.
  reset([
    ['/p/:slug/s/:sid/a/:agentId/e', L5.renderEvent],
    ['/p/:slug/s/:sid/t/:idx', L3.renderTurn],
  ]);
  const net = installFetch({
    [`/api/agent/${SLUG}/${SID}/${AGENT}`]: l5AgentPayload,
    '/api/line': { hold404: 'no such line' },
    [`/api/turn/${SLUG}/${SID}/2`]: turnPayload(2, LIVE_USD),
  });
  try {
    loc.hash = eventHash('999');
    const abandoned = Router.render();          // deliberately NOT awaited
    await settle();
    assert.equal(net.held, 1, 'the event render is parked inside /api/line — the window this is about');

    loc.hash = turnHash(2);
    await Router.render();
    await settle();
    const hashBefore = loc.hash;
    assert.match(bandText().title, /turn 2/, 'sanity: the live render owns the chrome');

    net.release();
    await abandoned;
    await settle();

    assert.equal(loc.hash, hashBefore,
      'the abandoned event page\'s stale 404 yanked the reader off the live turn page');
    assert.doesNotMatch(bandText().banner, /no line 999/,
      'and it must not banner about the page they already left');
    assert.match(bandText().title, /turn 2/);
  } finally { net.restore(); }
});

test('R14-D1 CONTROL: the harness DOES observe a navigation when one really happens', async () => {
  // Without this the assertion above could pass because the harness cannot see
  // a hash change at all. A view that calls ctx.navigate() directly — which is
  // exactly what handle404 escalates to — must move the hash here.
  reset([
    ['/p/:slug/s/:sid/t/:idx', async (ctx) => {
      if (ctx.params.idx === '2') return;
      ctx.navigate(`#/p/${SLUG}/s/${SID}`, { replace: true });
    }],
  ]);
  loc.hash = turnHash(2);
  await Router.render();
  const before = loc.hash;
  loc.hash = turnHash(1);
  await Router.render();
  await settle();
  assert.notEqual(loc.hash, before, 'ctx.navigate moves location.hash — the assertion above is not vacuous');
  assert.equal(loc.hash, `#/p/${SLUG}/s/${SID}`);
});

// The next two pass against the UNFIXED l5 as well, and are kept deliberately:
// they pin the ROUTER-level backstop (setTitle/scopeSentence/statbar/loading
// no-op once superseded) for the one view that had no guards of its own. The
// four tests around them are the ones that actually discriminate.
test('R14-D1: a superseded EVENT render cannot repaint the title, scope sentence or stat band', async () => {
  reset([
    ['/p/:slug/s/:sid/a/:agentId/e', L5.renderEvent],
    ['/p/:slug/s/:sid/t/:idx', L3.renderTurn],
  ]);
  const net = installFetch({
    [`/api/agent/${SLUG}/${SID}/${AGENT}`]: l5AgentPayload,
    '/api/line': { hold: linePayload(STALE_USD) },
    [`/api/turn/${SLUG}/${SID}/2`]: turnPayload(2, LIVE_USD),
  });
  try {
    loc.hash = eventHash('42');
    const abandoned = Router.render();
    await settle();

    loc.hash = turnHash(2);
    await Router.render();
    await settle();

    net.release();
    await abandoned;
    await settle();

    const after = bandText();
    assert.match(after.title, /turn 2/, 'the tab title still names the page the reader is on');
    assert.doesNotMatch(after.title, /line 42|\.jsonl/, 'the abandoned event must not rename the page');
    assert.match(after.crumb, /turn 2/);
    assert.doesNotMatch(after.scope, /One recorded event/,
      'the scope sentence used to describe the event page the reader had already left');
    assert.match(after.stat, /\$5\.98/, 'the band keeps the figures of the page it sits above');
    assert.doesNotMatch(after.stat, /\$1\.65/,
      'and never the abandoned event\'s real money under the live page\'s name');
  } finally { net.restore(); }
});

test('R14-D1: a superseded EVENT pending envelope must not blank the live page', async () => {
  reset([
    ['/p/:slug/s/:sid/a/:agentId/e', L5.renderEvent],
    ['/p/:slug/s/:sid/t/:idx', L3.renderTurn],
  ]);
  const net = installFetch({
    [`/api/agent/${SLUG}/${SID}/${AGENT}`]: l5AgentPayload,
    '/api/line': { holdPending: { retryAfterMs: 100000, bytesIndexed: 1, bytesTotal: 10 } },
    [`/api/turn/${SLUG}/${SID}/2`]: turnPayload(2, LIVE_USD),
  });
  try {
    loc.hash = eventHash('42');
    const abandoned = Router.render();
    await settle();

    loc.hash = turnHash(2);
    await Router.render();
    await settle();
    const liveContent = bandText().content;
    assert.ok(liveContent.length > 0, 'sanity: the live page painted something');

    net.release();
    await abandoned;
    await settle();

    assert.equal(bandText().content, liveContent,
      'ctx.el IS shell.contentEl — a stale pending envelope used to replace the live body with a progress bar');
    assert.doesNotMatch(bandText().content, /this route is not indexed yet/);
  } finally { net.restore(); }
});

test('R14-D1: the abandoned EVENT render\'s fetches carry ctx.signal and are actually aborted', async () => {
  // The other half of the rule: an abandoned request must be CANCELLED, not
  // merely ignored. Without the signal, l5 kept a /api/line read alive over a
  // 240 MB store for a page nobody was on.
  reset([
    ['/p/:slug/s/:sid/a/:agentId/e', L5.renderEvent],
    ['/p/:slug/s/:sid/t/:idx', L3.renderTurn],
  ]);
  const net = installFetch({
    [`/api/agent/${SLUG}/${SID}/${AGENT}`]: l5AgentPayload,
    '/api/line': { hold: linePayload(STALE_USD) },
    [`/api/turn/${SLUG}/${SID}/2`]: turnPayload(2, LIVE_USD),
  });
  try {
    loc.hash = eventHash('42');
    const abandoned = Router.render();
    await settle();

    const lineReq = net.forUrl('/api/line');
    assert.equal(lineReq.length, 1, 'the event render issued its /api/line read');
    assert.ok(lineReq[0].signal, '…and passed an AbortSignal with it (it used to pass none at all)');
    assert.equal(lineReq[0].signal.aborted, false, 'still live while the reader is on the page');

    loc.hash = turnHash(2);
    await Router.render();
    await settle();

    assert.equal(lineReq[0].signal.aborted, true,
      'leaving the page cancels the read — the router aborts the superseded ctx');

    net.release();
    await abandoned;
    await settle();
  } finally { net.restore(); }
});

test('R14-D1: resolveAgentFile threads the signal, and _relCache stays a VALUE cache', async () => {
  // The round-12 trap, restated: memoising a promise (or memoising a failure)
  // lets ONE aborted render poison every later one. Only a resolved rel is
  // cached, so an aborted resolve must leave the next render able to succeed.
  const ac = new AbortController();
  ac.abort();
  const SID2 = 'c0ffee00-0000-4000-8000-00000000beef';
  const net = installFetch({ [`/api/agent/${SLUG}/${SID2}/${AGENT}`]: { ...l5AgentPayload, id: SID2, rel: `${SID2}.jsonl` } });
  try {
    await assert.rejects(
      () => L5.resolveAgentFile(SLUG, SID2, AGENT, ac.signal),
      'an already-aborted signal rejects rather than resolving',
    );
    const again = await L5.resolveAgentFile(SLUG, SID2, AGENT, undefined);
    assert.equal(again.rel, `${SID2}.jsonl`,
      'the aborted attempt cached nothing — the next render resolves normally');
  } finally { net.restore(); }
});

test('R14-D1: handle404 short-circuits for ANY stale ctx, whatever the status (widened contract)', async () => {
  // The backstop at the one shared site. Every call site is
  // `if (handle404(...)) return;`, so "handled" is the right answer for a
  // superseded render: the caller returns and paints nothing.
  const calls = { navigate: 0 };
  const staleCtx = { stale: true, navigate: () => { calls.navigate += 1; } };
  const liveCtx = { stale: false, navigate: () => { calls.navigate += 1; } };

  assert.equal(handled(staleCtx, { status: 404, code: 'unknown-line', message: 'x' }), true);
  assert.equal(handled(staleCtx, { status: 500, code: 'boom', message: 'x' }), true,
    'it is no longer 404-only — a stale ctx is handled whatever the status');
  assert.equal(handled(staleCtx, null), true, 'including an AbortError with no status at all');
  assert.equal(calls.navigate, 0, 'and it never escalates to navigate for a superseded render');

  assert.equal(handled(liveCtx, { status: 400, code: 'bad-locator', message: 'x' }), false,
    'a LIVE 400 still keeps its error card — DESIGN §0 is unchanged');
  assert.equal(handled(liveCtx, { status: 403, code: 'forbidden', message: 'x' }), false);
  assert.equal(calls.navigate, 0);

  function handled(ctx, err) {
    return L5.handle404(ctx, err, { slug: SLUG, sid: SID, thing: 'thing' });
  }
});

/* ------------------------------------------------ R14-D1 collateral views */
//
// audit.mjs, find.mjs, memory.mjs and settings.mjs carried the same gap against
// the same documented MUST. None of them calls handle404, so none could yank
// the reader off a page — but "the views that happen to call handle404" was
// never the scope of the rule.

/** ctx with every unused render hook a no-op. `then` must stay undefined or
 *  awaiting the ctx hangs forever (the round-4 workflow-harness trap). */
function viewCtx(extra = {}) {
  const base = {
    el: doc.createElement('div'), stale: false, signal: undefined,
    path: '/settings', query: new URLSearchParams(), params: {}, ...extra,
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (k === 'then' || typeof k === 'symbol' ? undefined : () => {})),
  });
}

test('R14-D1 collateral: a superseded AUDIT render opens no SSE stream', async () => {
  // Load-bearing beyond repainting: audit registers its `abort` listener — the
  // stream's ONLY lifecycle hook — at the END of the render. A render
  // superseded during `await kit()` would open a whole-corpus reconciliation
  // whose abort has already fired and which nothing is left to close.
  reset([]);
  const net = installFetch({});
  try {
    await Audit.renderAudit(viewCtx({ stale: true, path: '/audit' }));
    await settle();
    assert.equal(sseLog.opened.length, 0,
      'a superseded audit render must not start a Path A vs Path B rescan of the store');

    await Audit.renderAudit(viewCtx({ path: '/audit' }));
    await settle();
    assert.equal(sseLog.opened.length, 1, 'CONTROL: a LIVE render does open exactly one stream');
    assert.match(sseLog.opened[0], /\/api\/audit/);
  } finally { net.restore(); }
});

test('R14-D1 collateral: a superseded FIND render opens no SSE stream', async () => {
  reset([]);
  const net = installFetch({});
  const query = new URLSearchParams('q=needle');
  try {
    await Find.renderFind(viewCtx({ stale: true, path: '/find', query }));
    await settle();
    assert.equal(sseLog.opened.length, 0,
      'a superseded find render must not start a scan of every byte in the store');

    await Find.renderFind(viewCtx({ path: '/find', query }));
    await settle();
    assert.equal(sseLog.opened.length, 1, 'CONTROL: a LIVE render does open exactly one scan');
    assert.match(sseLog.opened[0], /\/api\/find/);
  } finally { net.restore(); }
});

test('R14-D1 collateral: a superseded SETTINGS render paints nothing', async () => {
  reset([]);
  const net = installFetch({
    '/api/config': { activeProjectsDir: 'C:\\corpus', cacheDir: 'C:\\cache' },
    '/api/pricing': { rates: {}, version: 'test', sources: [] },
    '/api/index': { sessions: [], status: { state: 'ready' } },
  });
  try {
    const stale = viewCtx({ stale: true, path: '/settings' });
    await Settings.renderSettings(stale);
    await settle();
    assert.doesNotMatch(stale.el.textContent, /projects directory/,
      'a superseded settings render used to append three fetched sections to the live page');

    const live = viewCtx({ path: '/settings' });
    await Settings.renderSettings(live);
    await settle();
    assert.match(live.el.textContent, /projects directory/, 'CONTROL: a LIVE render does paint them');
    assert.match(live.el.textContent, /keyboard/);
  } finally { net.restore(); }
});

test('R14-D1 collateral: a superseded MEMORY render paints nothing, and its fetch carries the signal', async () => {
  reset([]);
  const net = installFetch({ '/api/file': 'no frontmatter here, just a body', '/api/index': { sessions: [] } });
  try {
    const stale = viewCtx({ stale: true, path: '/p/x/mem/y', params: { slug: SLUG, name: 'MEMORY.md' } });
    await Memory.renderMemory(stale);
    await settle();
    assert.equal(stale.el.textContent, '', 'a superseded memory render paints nothing at all');

    const live = viewCtx({ path: '/p/x/mem/y', params: { slug: SLUG, name: 'MEMORY.md' } });
    await Memory.renderMemory(live);
    await settle();
    assert.match(live.el.textContent, /frontmatter/, 'CONTROL: a LIVE render does paint the file');
    const fileReq = net.forUrl('/api/file');
    assert.equal(fileReq.length, 1);
    assert.ok('signal' in fileReq[0], 'the raw byte fetch is issued with a signal slot (STALE-RENDER RULE)');
  } finally { net.restore(); }
});

/* ==================================================================== *
 * settings — round 13's R13-D2, R13-F2 and R9-F1-COLLATERAL-VIEW
 * ==================================================================== */

/* ==================================================================== R13-D2 */
//   R13-D2 (web/js/views/settings.mjs — the projects-directory fact list)
//       GET /api/config passed config.json's projectsDir through expandPath
//       before returning it, and settings.mjs read only that pre-resolved
//       value — so the row labelled "saved in config.json", sourced to
//       "config.json", printed a path config.json does not contain. The
//       R12-F2 "resolved to" disclosure existed only inside the live validate
//       preview (triggered by TYPING a new path), never against the value
//       already on disk at page load.
//
/* ==================================================================== R13-F2 */
//   R13-F2 (web/js/views/settings.mjs — the validate() failure branch)
//       It read `res.message`, a field the server never sent, so every one of
//       validateDir's four recorded reasons rendered one hardcoded sentence.

/** Drive the REAL renderSettings against a stubbed /api/config. */
async function renderSettings(configBody) {
  const ctx = viewCtx();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/api/config') ? configBody
      : u.includes('/api/pricing') ? { rates: {}, version: 'test', sources: [] }
        : {};
    return json(200, body);
  };
  try { await Settings.renderSettings(ctx); await settle(); }
  finally { globalThis.fetch = realFetch; }
  return ctx;
}

/** Every dt/dd pair of the projects-directory fact list, as {label, text}. */
function factRows(ctx) {
  const dl = ctx.el.querySelectorAll('dl')[0];
  const out = [];
  if (!dl) return out;
  for (let i = 0; i < dl.childNodes.length; i += 2) {
    const dt = dl.childNodes[i], dd = dl.childNodes[i + 1];
    if (!dt || !dd) break;
    out.push({ label: dt.textContent, text: dd.textContent });
  }
  return out;
}
const rowNamed = (ctx, label) => factRows(ctx).find((r) => r.label === label);

test('R13-D2: the "saved in config.json" row prints what config.json LITERALLY holds', async () => {
  const ctx = await renderSettings({
    activeProjectsDir: 'C:\\active\\corpus',
    activeSource: 'config.json',
    savedProjectsDirRaw: 'corpus',
    savedProjectsDir: 'C:\\app\\corpus',
    pendingRestart: true,
    cacheDir: 'C:\\cache',
    config: { projectsDir: 'corpus' },
    problems: [],
  });
  const saved = rowNamed(ctx, 'saved in config.json');
  assert.ok(saved, 'the row exists');
  assert.match(saved.text, /corpus/);
  assert.doesNotMatch(saved.text, /C:\\app\\corpus/,
    'a row sourced to "config.json" must print the string config.json contains, not a resolution of it');
  assert.match(saved.text, /source: config\.json/);
});

test('R13-D2: a raw value that differs from its resolution gets the "resolved to" row', async () => {
  const ctx = await renderSettings({
    activeProjectsDir: 'C:\\active\\corpus',
    activeSource: 'config.json',
    savedProjectsDirRaw: 'corpus',
    savedProjectsDir: 'C:\\app\\corpus',
    pendingRestart: true,
    cacheDir: 'C:\\cache', config: {}, problems: [],
  });
  const resolved = rowNamed(ctx, 'resolved to');
  assert.ok(resolved, 'the disclosure R12-F2 built for the live preview now fires at page load too');
  assert.match(resolved.text, /C:\\app\\corpus/);
  assert.match(resolved.text, /source: server path resolution/, 'house rule: every fact names its source');
  assert.match(resolved.text, /config\.json itself lives in/,
    'and it says WHY the two differ, so the reader can act on it');
});

test('R13-D2: an ABSOLUTE saved value adds no "resolved to" row — there is nothing to disclose', async () => {
  const ctx = await renderSettings({
    activeProjectsDir: 'C:\\corpus',
    activeSource: 'config.json',
    savedProjectsDirRaw: 'C:\\corpus',
    savedProjectsDir: 'C:\\corpus',
    pendingRestart: false,
    cacheDir: 'C:\\cache', config: {}, problems: [],
  });
  assert.equal(rowNamed(ctx, 'resolved to'), undefined);
  assert.match(rowNamed(ctx, 'saved in config.json').text, /C:\\corpus/);
});

test('R13-D2: an older server that sends no raw field still fills the row from what it does send', async () => {
  const ctx = await renderSettings({
    activeProjectsDir: 'C:\\corpus', activeSource: 'config.json',
    savedProjectsDir: 'C:\\corpus', pendingRestart: false,
    cacheDir: 'C:\\cache', config: {}, problems: [],
  });
  assert.match(rowNamed(ctx, 'saved in config.json').text, /C:\\corpus/,
    'the new field is additive — its absence must not blank a row that used to say something');
  assert.equal(rowNamed(ctx, 'resolved to'), undefined);
});

/** Render settings, type a path, click validate, return the preview text. */
async function validateAndRead(typed, response) {
  const ctx = viewCtx();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/validate-dir')) return json(200, response);
    if (u.includes('/api/config')) {
      return json(200, {
        activeProjectsDir: 'C:\\active', activeSource: 'config.json',
        savedProjectsDirRaw: 'C:\\active', savedProjectsDir: 'C:\\active',
        pendingRestart: false, cacheDir: 'C:\\cache', config: {}, problems: [],
      });
    }
    return json(200, { rates: {}, version: 'test', sources: [] });
  };
  try {
    await Settings.renderSettings(ctx);
    await settle();
    const input = ctx.el.querySelector('.lens-settings__dir');
    input.value = typed;
    ctx.el.querySelectorAll('button').find((b) => b.textContent === 'validate').dispatch('click');
    await settle();
  } finally { globalThis.fetch = realFetch; }
  return ctx.el.querySelector('.lens-settings__preview').textContent;
}

const failure = (reason, over = {}) => ({
  ok: false, dir: 'C:\\resolved\\somewhere', reason,
  message: ServerConfig.REASON_MESSAGE[reason],
  projects: null, sessions: null, bytes: null, files: null,
  truncated: false, tookMs: 1, problems: [], ...over,
});

test('R13-F2: the four failure reasons render four DIFFERENT sentences', async () => {
  const seen = new Map();
  for (const reason of ['empty', 'missing', 'not-a-directory', 'unreadable']) {
    seen.set(reason, await validateAndRead('whatever', failure(reason)));
  }
  assert.match(seen.get('not-a-directory'), /that path is a file, not a folder/);
  assert.match(seen.get('missing'), /no such path exists/);
  assert.match(seen.get('empty'), /type a path first/);
  assert.match(seen.get('unreadable'), /could not be read/);
  assert.equal(new Set(seen.values()).size, 4,
    'all four used to be byte-identical — that identity IS the finding');
  assert.doesNotMatch(seen.get('not-a-directory'), /not a readable Claude projects folder/,
    'the old sentence asserted "not readable" about a path the server had just successfully read');
});

test('R13-F2: the client map and the server vocabulary are the same four sentences', () => {
  assert.deepEqual(
    Object.keys(Settings.REASON_TEXT).sort(),
    Object.keys(ServerConfig.REASON_MESSAGE).sort());
  for (const k of Object.keys(ServerConfig.REASON_MESSAGE)) {
    assert.equal(Settings.REASON_TEXT[k], ServerConfig.REASON_MESSAGE[k],
      `the fallback must not drift from the server's wording for ${k}`);
  }
});

test('R13-F2: an OLDER server that sends only `reason` still gets a specific sentence', async () => {
  const text = await validateAndRead('C:\\some\\file.md', failure('not-a-directory', { message: undefined }));
  assert.match(text, /that path is a file, not a folder/,
    'REASON_TEXT is the fallback that keeps the vocabulary working across versions');
});

test('R13-F2: an unrecognised reason falls back to the generic sentence rather than printing nothing', async () => {
  const text = await validateAndRead('x', failure('some-future-reason', { message: undefined }));
  assert.match(text, /not a readable Claude projects folder/,
    'the last resort is still there — an unknown reason must not render a blank problem line');
});

test('R13-F2: the real OS error rides along when validateDir attached one', async () => {
  const text = await validateAndRead('C:\\locked', failure('unreadable', {
    problems: [{ code: 'dir-unreadable', severity: 'warning', scope: 'store', file: 'C:\\locked', message: 'Could not read C:\\locked (EPERM).', affects: 'aggregates', count: 1 }],
  }));
  assert.match(text, /Could not read C:\\locked \(EPERM\)/,
    'an EPERM on a real directory is precisely the case no generic sentence lets anyone diagnose');
});

test('R13-F2: the FAILURE branch names the directory the server actually resolved', async () => {
  const text = await validateAndRead('corpus', failure('missing'));
  assert.match(text, /resolved to/);
  assert.match(text, /C:\\resolved\\somewhere/,
    'failure is where "what you typed is not what the server resolved" bites hardest');
});

/* ======================================================= R9-F1-COLLATERAL-VIEW */
//   R9-F1-COLLATERAL-VIEW (web/js/views/settings.mjs — the save button)
//       The browser half of the finding tests/fixes-config-save.test.mjs pins
//       on the server. PUT /api/config now answers honestly — `saved:false`
//       plus the Problem saveConfig recorded (SPEC §9) — when config.json
//       could not be rewritten. The view rendered `saveMessage(res)`
//       unconditionally, and saveMessage() opens with "saved to config.json"
//       in every one of its three branches, so a failed write still told the
//       reader the setting had been persisted: the same silent-absence lie the
//       route was just fixed for, one layer up, where the reader actually sees
//       it. These drive the REAL renderSettings over the fake document —
//       validate, then save — with the PUT answering the full shipped
//       envelope, and read the preview the page paints.

/** Render settings, validate a path, click save, return what the preview says. */
async function saveAndRead(putBody, typed = 'C:\\corpus') {
  const ctx = viewCtx();
  const realFetch = globalThis.fetch;
  let puts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/api/validate-dir')) {
      return json(200, {
        ok: true, dir: typed, reason: null, message: null,
        projects: 3, sessions: 9, bytes: 4096, files: 9,
        truncated: false, tookMs: 2, problems: [],
      });
    }
    if (u.includes('/api/config')) {
      if (method === 'PUT') { puts += 1; return json(200, putBody); }
      return json(200, {
        activeProjectsDir: 'C:\\active', activeSource: 'config.json',
        savedProjectsDirRaw: 'C:\\active', savedProjectsDir: 'C:\\active',
        pendingRestart: false, cacheDir: 'C:\\cache', config: {}, problems: [],
      });
    }
    return json(200, { rates: {}, version: 'test', sources: [] });
  };
  try {
    await Settings.renderSettings(ctx);
    await settle();
    ctx.el.querySelector('.lens-settings__dir').value = typed;
    const button = (label) => ctx.el.querySelectorAll('button').find((b) => b.textContent === label);
    button('validate').dispatch('click');
    await settle();
    button('save').dispatch('click');
    await settle();
  } finally { globalThis.fetch = realFetch; }
  const preview = ctx.el.querySelector('.lens-settings__preview');
  return {
    puts,
    text: preview.textContent,
    problems: preview.querySelectorAll('.lens-note--problem').map((n) => n.textContent),
  };
}

/** The envelope PUT /api/config actually ships (server/api.mjs:2034). */
const saveFailed = (over = {}) => ({
  saved: false,
  applied: false,
  activeProjectsDir: 'C:\\active',
  savedProjectsDir: null,
  pendingRestart: false,
  savedOutrankedBy: null,
  preview: { ok: true, dir: 'C:\\corpus', projects: 3, sessions: 9, bytes: 4096, problems: [] },
  problems: [{
    code: 'cache-write-failed', severity: 'warning', scope: 'store',
    file: 'C:\\Users\\me\\.claude-playback-lens\\config.json',
    // config.mjs rewords index-store's record to name the config file.
    message: 'Could not write the config file config.json (EACCES). Serving from memory; the next run will rebuild.',
    affects: 'nothing', count: 1,
  }],
  ...over,
});

test('R9-F1-COLLATERAL-VIEW: a save that FAILED must not print "saved to config.json"', async () => {
  const out = await saveAndRead(saveFailed());
  assert.equal(out.puts, 1, 'sanity: the save button really did PUT /api/config');
  assert.doesNotMatch(out.text, /saved to config\.json/,
    'the route answered saved:false — the page claimed the opposite, which is the finding');
  assert.match(out.text, /Could not write the config file config\.json \(EACCES\)/,
    'the Problem saveConfig records exists so the reader can be told WHY');
  assert.doesNotMatch(out.text, /restart the app/,
    'nothing was written, so there is no restart that would read it');
});

test('R9-F1-COLLATERAL-VIEW: the failure wears the page\'s problem styling, like validate()\'s', async () => {
  const out = await saveAndRead(saveFailed());
  assert.equal(out.problems.length, 1, 'one problem line, in the same class validate() uses');
  assert.match(out.problems[0], /Could not write the config file/);
});

test('R9-F1-COLLATERAL-VIEW: saved:false with an EMPTY problems array says so — never a blank', async () => {
  const out = await saveAndRead(saveFailed({ problems: [] }));
  assert.doesNotMatch(out.text, /saved to config\.json/);
  assert.equal(out.problems.length, 1, 'the problem line is still painted');
  assert.match(out.problems[0], /the save failed, and the server recorded no reason for it/,
    'an honest unknown — a blank problem line reads as "nothing went wrong"');
});

test('R9-F1-COLLATERAL-VIEW: the failure still names the directory this instance is reading', async () => {
  const out = await saveAndRead(saveFailed());
  assert.match(out.text, /the save did not complete; this instance is still reading C:\\active/,
    'the only two facts the failed envelope carries: the write did not complete, and what is being served');
  assert.doesNotMatch(out.text, /config\.json (now )?(holds|contains|names)/,
    'and nothing is claimed about what config.json now contains — the response does not say');
});

test('R9-F1-COLLATERAL-VIEW: the SUCCESS path is untouched — saveMessage() still speaks', async () => {
  const out = await saveAndRead({
    saved: true, applied: false,
    activeProjectsDir: 'C:\\active', savedProjectsDir: 'C:\\corpus',
    pendingRestart: true, savedOutrankedBy: null,
    preview: { ok: true, dir: 'C:\\corpus', projects: 3, sessions: 9, bytes: 4096, problems: [] },
    problems: [],
  });
  assert.match(out.text, /saved to config\.json/);
  assert.match(out.text, /restart the app to read C:\\corpus/);
  assert.equal(out.problems.length, 0, 'a successful save paints no problem line');
});

test('R9-F1-COLLATERAL-VIEW: an older server that omits `saved` keeps the message it always got', async () => {
  const out = await saveAndRead({
    applied: false, activeProjectsDir: 'C:\\active', savedProjectsDir: 'C:\\corpus',
    pendingRestart: true, preview: {}, problems: [],
  });
  assert.match(out.text, /saved to config\.json/,
    'the branch keys on an explicit saved:false — an absent field must not be read as failure');
});
