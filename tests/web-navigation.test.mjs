// tests/web-navigation.test.mjs — KAN-105 pass 4, navigation integrity.
//
// THE MECHANICAL NO-DEAD-END ASSERTION (brief §2.4.3). Every registered route
// is rendered through the REAL router over the fake document, and the shell it
// paints must carry at least one `<a href>` that leaves the route's own
// subtree. That is the cheap, mechanical form of "easily navigable with NO
// dead ends": it holds whether the view painted content, an empty state or an
// error card, and a route added later cannot quietly break it.
//
// Around it, the pieces the assertion depends on:
//   * withReturn / returnHref / stripReturn — the return-state mechanism, and
//     the strip that keeps a hash BOUNDED however many times it is nested;
//   * describeHash — the back control's label, derived from the route SHAPE
//     only (no inference about content, house rule 1);
//   * the shell's back control, and `u` / Esc bound to it;
//   * the crumb that prefers `returnTo` over the bare ancestor default (D4);
//   * the footer's global nav and its two facts (D7 + D8);
//   * renderNoViews' exit (D9);
//   * the long-body fold and the table overflow wrapper.

import test from 'node:test';
import assert from 'node:assert/strict';

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

/** audit and find open SSE streams; nothing here drives them. */
class FakeEventSource {
  constructor(url) { this.url = String(url); this.readyState = 0; }
  addEventListener() {}
  close() { this.readyState = 2; }
}
globalThis.EventSource = FakeEventSource;

/* imports AFTER the fake document exists */
const Router = await import('../web/js/router.mjs');
const Links = await import('../web/js/lib/links.mjs');
const Footer = await import('../web/js/lib/footer.mjs');
const Text = await import('../web/js/lib/text.mjs');
const Dom = await import('../web/js/lib/dom.mjs');

import { sleep } from './helpers/timing.mjs';
const settle = (ms = 40) => sleep(ms);

/* ------------------------------------------------------------------ *
 * fixtures + a permissive fetch stub
 * ------------------------------------------------------------------ */

const SLUG = 'C--nav-proj';
const SID = 'cc000000-0000-4000-8000-0000000000aa';
const RUN = 'wf_00000001-a01';

const noHeaders = { get: () => null };
const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? 'Not Found' : 'OK',
  headers: noHeaders,
  text: async () => JSON.stringify(body),
  json: async () => body,
});
const rawBody = (text) => ({
  ok: true, status: 200, statusText: 'OK', headers: noHeaders,
  text: async () => text,
  json: async () => { throw new Error('not JSON'); },
});

const INDEX = {
  version: 7, boot: 'test-boot',
  status: { state: 'ready', sessionsDone: 2, sessionsTotal: 2, bytesIndexed: 10, bytesTotal: 10 },
  agg: null, projects: [], sessions: [], turnBars: [], dayBands: [], pending: [], problems: [],
};
const SESSION = {
  slug: SLUG, id: SID, agents: [], turns: [], workflows: [], rows: [], rowsTotal: 0,
  agg: null, problems: [], inventory: { perType: {}, rows: 0 },
};

const PLAN = {
  '/api/index': INDEX,
  '/api/project/': { slug: SLUG, sessions: [], memory: [], fragments: [], problems: [] },
  '/api/session/': SESSION,
  '/api/turn/': { slug: SLUG, id: SID, turn: { idx: 0, at: null, rowCount: 0 }, agents: [], workflows: [], rows: [], rowsTotal: 0, agg: null, problems: [] },
  '/api/agent/': { slug: SLUG, id: SID, agentId: 'main', rel: `${SID}.jsonl`, rows: [], total: 0, agg: null, problems: [] },
  '/api/line': { slug: SLUG, id: SID, file: `${SID}.jsonl`, line: 1, raw: '{"type":"assistant"}', cost: null, problems: [] },
  '/api/workflow/': { slug: SLUG, id: SID, runId: RUN, record: { runId: RUN, status: 'completed', workflowProgress: [] }, agents: [], journal: {}, problems: [] },
  '/api/file': 'the recorded bytes of a file\n',
  '/api/config': { root: 'C:/store', problems: [] },
};

function installFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init && init.signal && init.signal.aborted) {
      const e = new Error('The operation was aborted.'); e.name = 'AbortError'; throw e;
    }
    const key = Object.keys(PLAN).find((k) => u.includes(k));
    const spec = key ? PLAN[key] : null;
    if (spec === null) return json(200, {});
    if (typeof spec === 'string') return rawBody(spec);
    return json(200, spec);
  };
  return () => { globalThis.fetch = real; };
}

/* ------------------------------------------------------------------ *
 * hash synthesis from the compiled route table
 * ------------------------------------------------------------------ */

const PARAM = {
  slug: SLUG, sid: SID, id: SID, idx: '0', agentId: 'main',
  eventRef: '1', runId: RUN, name: 'MEMORY.md',
};
const REST = { rel: 'tool-results/spill.txt', scope: 'store' };

/** A concrete hash for a compiled pattern — every segment encoded once. */
function hashFor(compiled) {
  const out = [];
  for (const seg of compiled.segs) {
    if (seg.kind === 'lit') out.push(seg.name);
    else if (seg.kind === 'param') out.push(encodeURIComponent(PARAM[seg.name] ?? 'x'));
    else out.push(String(REST[seg.name] ?? 'x').split('/').map(encodeURIComponent).join('/'));
  }
  return '#/' + out.join('/');
}

const pathOf = (href) => {
  const raw = String(href || '').replace(/^#/, '').split('?')[0];
  return raw.startsWith('/') ? raw : '/' + raw;
};

/** "outside its own subtree", with the root treated as "any other page". */
function leavesSubtree(linkPath, curPath) {
  if (curPath === '/') return linkPath !== '/';
  return !(linkPath === curPath || linkPath.startsWith(curPath + '/'));
}

/* ==================================================================== *
 * 1. the mechanical audit — every route, every time
 * ==================================================================== */

test('no dead ends: every registered route emits a link out of its own subtree', async () => {
  const restore = installFetch();
  const shell = Router.buildShell(doc.createElement('div'));
  await Router.loadViewModules();
  const table = Router.routeTable();
  assert.ok(table.length >= 13, `the whole route spine is registered (got ${table.length})`);

  const missing = [];
  const noAncestor = [];
  const noFooter = [];
  for (const entry of table) {
    const hash = hashFor(entry.compiled);
    loc.hash = hash;
    await Router.render();
    await settle();

    const cur = pathOf(hash);
    const hrefs = shell.root.querySelectorAll('a[href]')
      .map((n) => n.getAttribute('href'))
      .filter((x) => x && x.startsWith('#'));
    if (!hrefs.some((x) => leavesSubtree(pathOf(x), cur))) missing.push(entry.pattern);
    if (cur !== '/' && !hrefs.some((x) => cur.startsWith(pathOf(x) === '/' ? '/' : pathOf(x) + '/'))) {
      noAncestor.push(entry.pattern);
    }
    const navEl = shell.footEl.querySelector('.lens-foot__nav');
    const nav = navEl ? navEl.querySelectorAll('a[href]').map((n) => n.getAttribute('href')) : [];
    for (const want of ['#/', '#/find', '#/audit', '#/settings']) {
      if (!nav.includes(want)) { noFooter.push(`${entry.pattern} → ${want}`); break; }
    }
  }
  restore();

  assert.deepEqual(missing, [], 'these routes are dead ends — nothing on them leaves their own subtree');
  assert.deepEqual(noAncestor, [], 'these routes offer no link to an ancestor (the crumb rail is the floor)');
  assert.deepEqual(noFooter, [], 'the global nav must be on every page (D8)');
});

/* ==================================================================== *
 * 2. the return-state mechanism (pure)
 * ==================================================================== */

test('withReturn carries the hash the reader is standing on', () => {
  const href = Links.withReturn('#/p/a/s/b/a/main/e/12.0', '#/find?q=cache');
  assert.equal(pathOf(href), '/p/a/s/b/a/main/e/12.0');
  const q = new URLSearchParams(href.split('?')[1]);
  assert.equal(q.get('returnTo'), '#/find?q=cache');
});

test('withReturn appends with & when the target already has a query', () => {
  const href = Links.withReturn('#/p/a/s/b?v=images', '#/find?q=x');
  assert.ok(href.includes('?v=images&returnTo='), href);
});

test('returnHref decodes it back, and refuses anything that is not an in-app hash', () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(Links.returnHref(q(`returnTo=${encodeURIComponent('#/find?q=x')}`)), '#/find?q=x');
  assert.equal(Links.returnHref(q('')), null);
  assert.equal(Links.returnHref(q(`returnTo=${encodeURIComponent('https://example.com/')}`)), null,
    'a returnTo is a hash in this app or it is not followed at all');
});

test('THE STRIP: returnTo never nests, so a hash stays bounded however often it is re-drilled', () => {
  let here = '#/p/a/s/b?v=images';
  let longest = 0;
  for (let i = 0; i < 40; i++) {
    const next = Links.withReturn(`#/p/a/s/b/a/main/e/${i}`, here);
    longest = Math.max(longest, next.length);
    // and now the reader drills again FROM that page
    here = next;
  }
  assert.ok(longest < 120, `a re-drilled hash stays bounded (longest ${longest})`);
  const params = new URLSearchParams(here.split('?')[1]);
  assert.equal([...params.keys()].filter((k) => k === 'returnTo').length, 1, 'exactly one returnTo, always');
  assert.ok(!params.get('returnTo').includes('returnTo'), 'and nothing nested inside it');
});

test('stripReturn keeps every other param', () => {
  assert.equal(Links.stripReturn('#/p/a?v=images&returnTo=%23%2Ffind&k=text'), '#/p/a?v=images&k=text');
  assert.equal(Links.stripReturn('#/p/a?v=images'), '#/p/a?v=images');
  assert.equal(Links.stripReturn('#/p/a'), '#/p/a');
});

test('withReturn never points a page at itself', () => {
  assert.equal(Links.withReturn('#/find?q=x', '#/find?q=x'), '#/find?q=x');
});

test('describeHash labels a return by ROUTE SHAPE only — never by content', () => {
  const d = Links.describeHash;
  assert.equal(d('#/'), 'the store');
  assert.equal(d('#/find?q=cache'), 'find results for “cache”');
  assert.equal(d('#/audit'), 'the audit');
  assert.equal(d('#/settings'), 'settings');
  assert.equal(d('#/p/proj'), 'project proj');
  assert.equal(d('#/p/proj?v=memory'), 'project proj memory');
  assert.equal(d(`#/p/proj/s/${SID}?v=images`), `session ${SID.slice(0, 8)} images`);
  assert.equal(d(`#/p/proj/s/${SID}/inv`), `the inventory of session ${SID.slice(0, 8)}`);
  assert.equal(d(`#/p/proj/s/${SID}/t/3`), 'turn 3');
  assert.equal(d(`#/p/proj/s/${SID}/a/main`), 'the main thread');
  assert.equal(d(`#/p/proj/s/${SID}/a/main/e/12.0`), 'event 12.0');
  assert.equal(d(`#/p/proj/s/${SID}/w/${RUN}`), `workflow run ${RUN}`);
  assert.equal(d('#/p/proj/mem/MEMORY.md'), 'memory MEMORY.md');
  assert.equal(d('#/p/proj/x/tool-results/spill.txt'), 'file tool-results/spill.txt');
});

/* ==================================================================== *
 * 3. the back control, and `u` / Esc bound to it
 * ==================================================================== */

async function renderWith(hash, routeDefs) {
  Router.clearRoutes();
  const shell = Router.buildShell(doc.createElement('div'));
  for (const [p, fn] of routeDefs) Router.defineRoute(p, fn);
  loc.hash = hash;
  await Router.render();
  await settle(5);
  return shell;
}

const key = (k, extra = {}) => {
  let prevented = false;
  Router.onKeydown({ key: k, preventDefault() { prevented = true; }, target: null, ...extra });
  return prevented;
};

test('a landing page with returnTo renders a labelled a.lens-return', async () => {
  const restore = installFetch();
  const shell = await renderWith(
    `#/p/${SLUG}/s/${SID}/a/main/e/1?returnTo=${encodeURIComponent('#/find?q=cache')}`,
    [['/p/:slug/s/:sid/a/:agentId/e/:eventRef', (ctx) => { ctx.crumbs({ items: [{ label: 'store', href: '#/' }, { label: 'event' }] }); }]]);
  const back = shell.root.querySelector('.lens-return');
  assert.ok(back, 'the back control is mounted by the SHELL, so every route gets it');
  assert.equal(back.getAttribute('href'), '#/find?q=cache');
  assert.match(back.textContent, /back to find results for “cache”/);
  restore();
});

test('no returnTo, no back control — and the previous page\'s control does not linger', async () => {
  const restore = installFetch();
  let shell = await renderWith(`#/p/${SLUG}/s/${SID}?returnTo=${encodeURIComponent('#/find?q=x')}`,
    [['/p/:slug/s/:sid', () => {}]]);
  assert.ok(shell.root.querySelector('.lens-return'), 'control present on the drilled-in render');
  loc.hash = `#/p/${SLUG}/s/${SID}`;
  await Router.render();
  await settle(5);
  assert.equal(shell.root.querySelector('.lens-return'), null, 'and gone the moment the param is');
  restore();
});

test('`u` prefers returnTo over the crumb parent, and Esc follows it when nothing local is open', async () => {
  const restore = installFetch();
  await renderWith(`#/p/${SLUG}/s/${SID}/t/0?returnTo=${encodeURIComponent('#/find?q=cache')}`,
    [['/p/:slug/s/:sid/t/:idx', (ctx) => {
      ctx.crumbs({ items: [{ label: 'store', href: '#/' }, { label: 'turn' }], up: { href: `#/p/${SLUG}/s/${SID}`, label: 'session' } });
      ctx.registerUp(`#/p/${SLUG}/s/${SID}`, 'session');
    }]]);
  assert.equal(key('u'), true);
  assert.equal(loc.hash, '#/find?q=cache', '`u` is the recorded way back, not merely the tree parent');

  await renderWith(`#/p/${SLUG}/s/${SID}/t/0?returnTo=${encodeURIComponent('#/find?q=cache')}`,
    [['/p/:slug/s/:sid/t/:idx', (ctx) => { ctx.crumbs({ items: [{ label: 'turn' }] }); }]]);
  assert.equal(key('Escape'), true);
  assert.equal(loc.hash, '#/find?q=cache');
  restore();
});

test('`u` still goes up when no returnTo was carried — the old binding is untouched', async () => {
  const restore = installFetch();
  await renderWith(`#/p/${SLUG}/s/${SID}/t/0`,
    [['/p/:slug/s/:sid/t/:idx', (ctx) => { ctx.registerUp(`#/p/${SLUG}/s/${SID}`, 'session'); }]]);
  assert.equal(key('u'), true);
  assert.equal(loc.hash, `#/p/${SLUG}/s/${SID}`);
  restore();
});

test('Esc closes an open layer first — the back control never steals it', async () => {
  const restore = installFetch();
  const shell = await renderWith(`#/p/${SLUG}/s/${SID}?returnTo=${encodeURIComponent('#/find?q=x')}`,
    [['/p/:slug/s/:sid', (ctx) => {
      ctx.el.appendChild(doc.createElement('div'));
      ctx.el.childNodes[0].setAttribute('data-lens-layer', 'panel');
    }]]);
  const layer = shell.contentEl.childNodes[0];
  assert.equal(key('Escape'), true);
  assert.ok(layer.hasAttribute('hidden'), 'the layer closed');
  assert.equal(loc.hash, `#/p/${SLUG}/s/${SID}?returnTo=${encodeURIComponent('#/find?q=x')}`, 'and the page did not navigate');
  restore();
});

test('D4: a crumb pointing at the very page returnTo remembers carries that page\'s state', async () => {
  const restore = installFetch();
  const back = `#/p/${SLUG}/s/${SID}?v=images`;
  const shell = await renderWith(
    `#/p/${SLUG}/s/${SID}/a/main/e/1?returnTo=${encodeURIComponent(back)}`,
    [['/p/:slug/s/:sid/a/:agentId/e/:eventRef', (ctx) => {
      ctx.crumbs({
        items: [
          { label: 'store', href: '#/' },
          { label: 'session', href: `#/p/${SLUG}/s/${SID}` },   // the LOSSY default
          { label: 'event' },
        ],
        up: { href: `#/p/${SLUG}/s/${SID}`, label: 'session' },
      });
    }]]);
  const hrefs = shell.crumbEl.querySelectorAll('a[href]').map((n) => n.getAttribute('href'));
  assert.ok(hrefs.includes(back), `the session crumb keeps ?v=images — got ${JSON.stringify(hrefs)}`);
  assert.ok(!hrefs.includes(`#/p/${SLUG}/s/${SID}`), 'and no longer offers the stateless one beside it');
  restore();
});

/* ==================================================================== *
 * 4. the footer (D7 + D8) and renderNoViews' exit (D9)
 * ==================================================================== */

test('the footer states PRICING_VERSION and the index state, and says why when it cannot', () => {
  Footer.resetFooterState();
  const el = doc.createElement('div');
  Footer.mountFooter(el);
  const meta = el.querySelector('.lens-foot__meta');
  assert.ok(meta, 'the meta strip exists');
  assert.match(meta.textContent, /PRICING_VERSION/);
  // Nothing has read /api/index in this process: an unknown, with its reason.
  const unknowns = el.querySelectorAll('.lens-unknown');
  assert.ok(unknowns.length >= 1, 'an unrecorded fact renders — with a reason, never a zero');
  assert.match(unknowns[unknowns.length - 1].getAttribute('title') || '', /\/api\/index/);
});

test('the footer picks up the index state a view already fetched — it never fetches itself', () => {
  Footer.resetFooterState();
  const el = doc.createElement('div');
  Footer.mountFooter(el);
  Footer.noteIndexState({ done: 61, of: 85, building: true, version: 12 });
  assert.match(el.querySelector('.lens-foot__meta').textContent, /index 61 of 85 sessions — indexing…/);
  Footer.noteIndexState({ done: 85, of: 85, building: false, version: 13 });
  assert.match(el.querySelector('.lens-foot__meta').textContent, /index 85 of 85 sessions/);
  assert.ok(!/indexing/.test(el.querySelector('.lens-foot__meta').textContent));
});

test('the footer marks where you are with aria-current, never by colour alone', () => {
  Footer.resetFooterState();
  const el = doc.createElement('div');
  const f = Footer.mountFooter(el);
  f.setCurrent(Footer.navKeyForHash('#/audit/session:a/b'));
  const marked = el.querySelector('.lens-foot__nav').querySelectorAll('a[aria-current]');
  assert.equal(marked.length, 1);
  assert.equal(marked[0].getAttribute('href'), '#/audit');
});

test('navKeyForHash reads the route shape, nothing else', () => {
  assert.equal(Footer.navKeyForHash('#/'), 'store');
  assert.equal(Footer.navKeyForHash('#/?v=table'), 'store');
  assert.equal(Footer.navKeyForHash('#/find?q=x'), 'find');
  assert.equal(Footer.navKeyForHash('#/settings'), 'settings');
  assert.equal(Footer.navKeyForHash('#/p/a/s/b'), null);
});

test('D9: renderNoViews offers a real exit, not just the browser', async () => {
  const restore = installFetch();
  Router.clearRoutes();
  const shell = Router.buildShell(doc.createElement('div'));
  loc.hash = '#/';
  await Router.render();
  await settle(5);
  const card = shell.contentEl.querySelector('.lens-card--error');
  assert.ok(card, 'the no-views card is what renders with an empty route table');
  const exits = card.querySelectorAll('a[href]').map((n) => n.getAttribute('href'));
  assert.ok(exits.includes('#/'), `an error card must carry a way out — got ${JSON.stringify(exits)}`);
  restore();
});

/* ==================================================================== *
 * 5. the long-body fold and the table overflow wrapper
 * ==================================================================== */

test('a body past 40 recorded lines opens folded, and the button states the EXACT count', () => {
  const body = Text.textBody(Array.from({ length: 137 }, (_, i) => `line ${i + 1}`).join('\n'));
  assert.match(body.getAttribute('class'), /lens-body--folded/);
  const fold = body.querySelector('.lens-body__fold');
  assert.ok(fold, 'the fold control exists');
  assert.equal(fold.textContent, 'show all 137 lines', 'the recorded count, not a rounded one');
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  fold.dispatch('click');
  assert.equal(body.getAttribute('class'), 'lens-body', 'clicking unfolds it');
  assert.equal(body.querySelector('.lens-body__fold'), null, 'and the control retires');
});

test('a short body is never folded, and the markdown toggle is untouched either way', () => {
  const short = Text.textBody('one\ntwo\nthree');
  assert.equal(short.getAttribute('class'), 'lens-body');
  assert.equal(short.querySelector('.lens-body__fold'), null);
  assert.ok(short.querySelector('.lens-btn--toggle'), 'the persisted markdown toggle still leads');
  assert.equal(Text.countLines(''), 0, 'an empty body records zero lines — a real zero');
  assert.equal(Text.countLines('a'), 1);
});

test('every emitted table sits in a div.lens-tablewrap so it scrolls in its own box', () => {
  const wrapped = Dom.simpleTable([{ key: 'a', label: 'a' }], [{ a: 1 }]);
  assert.equal(wrapped.localName, 'div');
  assert.match(wrapped.getAttribute('class'), /lens-tablewrap/);
  assert.equal(wrapped.childNodes[0].localName, 'table');
});
