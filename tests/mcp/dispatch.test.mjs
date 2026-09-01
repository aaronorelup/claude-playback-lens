// tests/dispatch.test.mjs — the in-process router dispatch (src/dispatch.mjs).
//
// What is being proved here is the load-bearing claim of the whole server:
// dispatching a synthetic request through the lens's own router produces the
// same payload the lens's HTTP server would, and every HTTP-level failure
// comes back as a VALUE rather than an exception. A tool handler has to render
// a 404 or a 409; it cannot render a thrown error.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDispatcher } from '../src/dispatch.mjs';
import { fixtureContext } from './helpers.mjs';

let H; // { ctx, lens, fixtures, close }
let call;

before(async () => {
  H = await fixtureContext();
  call = createDispatcher(H.lens, H.ctx);
});

after(async () => { if (H) await H.close(); });

test('GET /api/hello answers the lens identity', async () => {
  const r = await call('GET', '/api/hello');
  assert.equal(r.status, 200);
  assert.equal(r.json.app, H.ctx.appName);
  assert.equal(r.json.version, H.ctx.appVersion);
  assert.equal(typeof r.json.pid, 'number');
});

test('GET /api/index matches the fixture store\'s hand-computed totals', async () => {
  const { EXPECT, SLUG, S1, S2 } = H.fixtures;
  const r = await call('GET', '/api/index');
  assert.equal(r.status, 200);

  const v = r.json;
  assert.equal(v.status.state, 'ready');
  assert.equal(v.status.sessionsDone, 2);
  assert.equal(v.status.sessionsTotal, 2);

  // The fixture's two sessions, one project.
  assert.equal(v.projects.length, 1);
  assert.equal(v.projects[0].slug, SLUG);
  const ids = v.sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, [S1, S2].sort());

  // Totals in exact integer tcu, never rounded dollars. These literals are
  // hand-computed in the lens's make-store.mjs; asserting on them is what
  // makes this a check of the ledger rather than of itself.
  assert.equal(v.agg.usd.total, EXPECT.totalTcu);
  assert.equal(v.agg.requests, EXPECT.totalRequests);
  // EXPECT.tokens counts PRICED canonical rows only — it is written for the
  // audit's Path B totals. A CostAgg's `tokens` is Σ over every billed row,
  // including the R7 unpriced ones (whose tokens are ALSO carried separately
  // in the unpriced channel). The difference is exactly the fixture's one
  // unpriced row, and naming it here is the point: token mass is never
  // dropped just because a rate was missing.
  assert.deepEqual(v.agg.tokens, {
    ...EXPECT.tokens,
    input: EXPECT.tokens.input + EXPECT.unpricedTokens.input,
    output: EXPECT.tokens.output + EXPECT.unpricedTokens.output,
  });

  // R7 — the unpriced channel is parallel, keyed by the RAW model string.
  const up = v.agg.unpriced[EXPECT.unpricedModel];
  assert.ok(up, 'unpriced channel present for the rate-less model');
  assert.equal(up.requests, 1);

  // R2 — the duplicated message is billed once and disclosed in the other
  // session's inherited channel.
  assert.ok(Object.keys(v.agg.inherited).length > 0, 'inherited channel is populated');

  // Every aggregate ships its denominator.
  assert.deepEqual(v.aggScope, { sessions: 2, of: 2 });

  // The independent cross-check rides the payload.
  assert.ok(v.rowsSumToHeader === true || (v.rowsSumToHeader && 'delta' in v.rowsSumToHeader),
    'rowsSumToHeader is true or a delta, never absent');
});

test('per-session aggs sum to the store agg (parent = Σ children)', async () => {
  const { EXPECT, S1, S2 } = H.fixtures;
  const r = await call('GET', '/api/index');
  const bySession = new Map(r.json.sessions.map((s) => [s.id, s.agg]));
  assert.equal(bySession.get(S1).usd.total, EXPECT.s1Tcu);
  assert.equal(bySession.get(S2).usd.total, EXPECT.s2Tcu);
  assert.equal(
    bySession.get(S1).usd.total + bySession.get(S2).usd.total,
    r.json.agg.usd.total,
  );
});

test('an unknown /api/ path is a 404 VALUE, not a throw', async () => {
  const r = await call('GET', '/api/nonsense/there-is-no-such-route');
  assert.equal(r.status, 404);
  // The lens's error envelope is nested: { error: { code, message, detail? } }.
  assert.equal(r.json.error.code, 'unknown-route');
  assert.match(r.json.error.message, /no route for GET/);
});

test('a path off /api/ is a 404 with the static-fallback code', async () => {
  const r = await call('GET', '/index.html');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'not-found');
});

test('a path that exists under another method answers 405 and names it', async () => {
  // /api/reindex is registered for POST only.
  const r = await call('GET', '/api/reindex');
  assert.equal(r.status, 405);
  assert.equal(r.json.error.code, 'method-not-allowed');
  assert.equal(r.headers.Allow, 'POST');
});

test('a bogus session id comes back as a 404 value, never an exception', async () => {
  const { SLUG } = H.fixtures;
  const bogus = '00000000-0000-4000-8000-000000000000';
  const r = await call('GET', `/api/session/${SLUG}/${bogus}`);
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'unknown-session');
  assert.match(r.json.error.message, new RegExp(bogus));
});

test('a bogus project slug comes back as a 404 value', async () => {
  const r = await call('GET', '/api/project/no-such-project-slug');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'unknown-project');
});

test('a real session route answers 200 with an agg', async () => {
  const { SLUG, S1, EXPECT } = H.fixtures;
  const r = await call('GET', `/api/session/${SLUG}/${S1}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.agg.usd.total, EXPECT.s1Tcu);
});

test('query parameters reach the handler', async () => {
  const r0 = await call('GET', '/api/index');
  // ?since=<version>&boot=<boot> is the 204 short-circuit the UI polls with.
  const r1 = await call('GET', '/api/index', { since: String(r0.json.version), boot: r0.json.boot });
  assert.equal(r1.status, 204);
  assert.equal(r1.json, null, 'an empty body yields json:null, not {}');
});
