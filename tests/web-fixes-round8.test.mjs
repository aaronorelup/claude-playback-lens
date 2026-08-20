// tests/web-fixes-round8.test.mjs — named regressions for the round-8 fix pass,
// browser side. The fake DOM mirrors tests/web-fixes-round7.test.mjs (no
// dependencies allowed).
//
//   R8-PROB-2
//       The L0 store problems drawer mapped each row to {code, severity, scope,
//       count, affects, message} and offered no link column, so a reader who
//       spotted a session-scoped problem there had no route to the session it
//       named — while the session-scope drawer (views/inv.mjs) has had a linked
//       `where` column all along.
//
//       The naive fix is wrong twice over. (a) slug/id are not dropped by the
//       row mapping, they are dropped upstream in collapseProblems, which
//       builds a fresh six-key object — so a href reading row.slug/row.id would
//       never produce a single link. (b) more importantly, this census collapses
//       by code|scope ACROSS SESSIONS: the surviving slug/id belong to the FIRST
//       contributor only, so linking them would tell the reader that a
//       three-session condition belongs to one session. That is an inference, in
//       an app whose one rule is that it does not infer. The row therefore has
//       to know its SOURCES before it links anything, and it links only when
//       there is exactly one.

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * fake document (same shape as web-fixes-round7.test.mjs)
 * ------------------------------------------------------------------ */

// The fake DOM itself lives in tests/helpers/fake-dom.mjs (shared by every
// web test file); it is installed here, BEFORE the web modules are imported.
import { doc } from './helpers/fake-dom.mjs';

globalThis.document = doc;

/* ------------------------------------------------------------------ *
 * imports AFTER the fake document exists
 * ------------------------------------------------------------------ */

const L0 = await import('../web/js/views/l0.mjs');
const { collapseProblems, whereCell, sessionHref, buildInventory } = L0;

/** every <a> under a node (the fake DOM has no querySelectorAll on this shape) */
function anchors(node) {
  const out = [];
  const walk = (n) => {
    if (n.localName === 'a') out.push(n);
    for (const c of n.childNodes || []) walk(c);
  };
  walk(node);
  return out;
}

const note = (slug, id) => ({
  code: 'workflow-call-unresolved', severity: 'note', scope: 'session',
  slug, id, message: `names wf_1 (${id})`, affects: 'nothing', count: 1,
});

/* ============================================================ R8-PROB-2 */

test('R8-PROB-2 — collapseProblems carries the identities it used to throw away', () => {
  const rows = collapseProblems([note('projA', 'AAAA'), note('projB', 'BBBB')]);
  assert.equal(rows.length, 1, 'identical code+scope still collapses to one row');
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].sourceCount, 2);
  assert.deepEqual(rows[0].sources.map((s) => s.id), ['AAAA', 'BBBB'],
    'the row used to keep only the first contributor, which is why it could not link');
});

test('R8-PROB-2 — a server row that already carries sources passes them straight through', () => {
  // /api/index does the collapsing server-side; the client must not re-derive
  // identity from the row's own (first-contributor-only) slug/id.
  const rows = collapseProblems([{
    code: 'torn-line', severity: 'error', scope: 'session', slug: 'projA', id: 'AAAA',
    message: 'one torn line', affects: 'aggregates', count: 7,
    sources: [{ slug: 'projA', id: 'AAAA' }, { slug: 'projB', id: 'BBBB' }], sourceCount: 2,
  }]);
  assert.equal(rows[0].count, 7);
  assert.equal(rows[0].sourceCount, 2);
  assert.deepEqual(rows[0].sources.map((s) => s.slug), ['projA', 'projB']);
});

test('R8-PROB-2 — one source is a link to that session', () => {
  const [row] = collapseProblems([note('projA', 'AAAA')]);
  const cell = whereCell(row);
  const links = anchors(cell);
  assert.equal(links.length, 1, 'a row that names exactly one session gets a route to it');
  assert.equal(links[0].getAttribute('href'), sessionHref('projA', 'AAAA'),
    'and it is that session\'s own drill route');
  assert.equal(cell.textContent, 'AAAA'.slice(0, 8));
});

test('R8-PROB-2 — two sources are COUNTED, never linked to the first one', () => {
  const [row] = collapseProblems([note('projA', 'AAAA'), note('projB', 'BBBB')]);
  const cell = whereCell(row);
  assert.deepEqual(anchors(cell), [], 'no link — the row does not know which session the reader means');
  assert.equal(cell.textContent, '2 sessions');
  assert.match(cell.getAttribute('title'), /projA/);
  assert.match(cell.getAttribute('title'), /projB/, 'both ids stay reachable, as text');
});

test('R8-PROB-2 — a row that names nothing renders — with its reason, not an empty cell', () => {
  const [row] = collapseProblems([{
    code: 'cache-write-failed', severity: 'error', scope: 'store',
    message: 'disk full', affects: 'aggregates', count: 1,
  }]);
  assert.equal(row.sourceCount, 0);
  const cell = whereCell(row);
  assert.deepEqual(anchors(cell), []);
  assert.equal(cell.textContent, '—', 'the house rule: unknown is — plus a reason, never a blank');
  assert.match(cell.getAttribute('title'), /do not name/);
});

test('R8-PROB-2 — a file-scope row names the file it came from', () => {
  const [row] = collapseProblems([{
    code: 'unclassified-file', severity: 'note', scope: 'file',
    file: 'proj/33333333-3333-4333-8333-333333333333', message: 'symlink/junction skipped (not followed)',
    affects: 'display', count: 1,
  }]);
  const cell = whereCell(row);
  assert.deepEqual(anchors(cell), [], 'a file is not a session route');
  assert.equal(cell.textContent, 'proj/33333333-3333-4333-8333-333333333333');
});

test('R8-PROB-2 — the sources survive the whole client chain from an /api/index payload', () => {
  const inv = buildInventory({
    sessions: [], projects: [],
    status: { state: 'ready', sessionsDone: 0, sessionsTotal: 0 },
    problems: [note('projA', 'AAAA'), note('projB', 'BBBB'), note('projC', 'CCCC')],
  });
  const row = inv.problems.find((p) => p.code === 'workflow-call-unresolved');
  assert.equal(row.count, 3);
  assert.equal(row.sourceCount, 3);
  assert.equal(whereCell(row).textContent, '3 sessions');
});
