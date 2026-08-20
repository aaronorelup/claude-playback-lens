// tests/web-api.test.mjs — SPEC §9 error envelope, 409 pending, URL building.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError, apiUrl, toQuery, interpret, readPending, isPending, api,
  SSE_EVENTS, setPricingUrl,
} from '../web/js/api.mjs';

test('apiUrl drops empty params and encodes the rest', () => {
  assert.equal(apiUrl('/api/index'), '/api/index');
  assert.equal(apiUrl('api/index', { since: 4 }), '/api/index?since=4');
  assert.equal(apiUrl('/api/records', { scope: 'session:a b/c', from: 0, count: 300 }),
    '/api/records?scope=session%3Aa+b%2Fc&from=0&count=300');
  assert.equal(apiUrl('/api/find', { q: 'x', re: null, case: '' }), '/api/find?q=x');
  assert.equal(toQuery({ k: ['a', 'b'] }), 'k=a&k=b');
  assert.equal(toQuery('?a=1'), 'a=1');
  assert.equal(toQuery(new URLSearchParams('a=1')), 'a=1');
});

test('204 is null (that is /api/index?since=N saying "unchanged")', () => {
  assert.equal(interpret({ status: 204, ok: false, payload: null }), null);
});

test('a 2xx passes the payload straight through', () => {
  const payload = { version: 3, sessions: [], problems: [] };
  assert.equal(interpret({ status: 200, ok: true, payload }), payload);
});

test('409 not-indexed-yet is RETURNED as pending with its denominators, never thrown', () => {
  const payload = {
    error: {
      code: 'not-indexed-yet', message: 'the index is still building',
      detail: { retryAfterMs: 1000, bytesIndexed: 700, bytesTotal: 1000 },
    },
  };
  const out = interpret({ status: 409, ok: false, payload });
  assert.equal(isPending(out), true);
  assert.equal(out.pending.code, 'not-indexed-yet');
  assert.equal(out.pending.retryAfterMs, 1000);
  assert.equal(out.pending.bytesIndexed, 700);
  assert.equal(out.pending.bytesTotal, 1000);
});

test('the 409 denominators are found wherever the server hangs them', () => {
  const flat = readPending({ error: { code: 'not-indexed-yet' }, retryAfterMs: 250, bytesIndexed: 1, bytesTotal: 2 }, 409);
  assert.equal(flat.retryAfterMs, 250);
  assert.equal(flat.bytesTotal, 2);

  const bare = readPending(null, 409);
  assert.equal(bare.code, 'not-indexed-yet');
  assert.equal(bare.retryAfterMs, 1000, 'a default poll interval, not a fabricated denominator');
  assert.equal(bare.bytesIndexed, null, 'an absent denominator stays unknown');
});

test('REGRESSION (report 7): a healthy /api/index payload with its own pending[] ARRAY is never a 409', () => {
  // SPEC §9: /api/index ships `pending: [{slug,id}, ...]` — an array. The old
  // isPending treated ANY object-valued `pending` as the 409 shape, and
  // `typeof [] === 'object'`, so every healthy index rendered "building the
  // index" forever. The array must be excluded; the 409 pending is an object.
  assert.equal(isPending({ version: 3, sessions: [], pending: [], problems: [] }), false);
  assert.equal(isPending({ version: 3, sessions: [], pending: [{ slug: 'p', id: 's' }], problems: [] }), false);
  assert.equal(isPending({ version: 3, sessions: [] }), false);
  assert.equal(isPending(null), false);
  // the real 409 shape (as produced by interpret) still reads as pending
  const p409 = interpret({ status: 409, ok: false, payload: { error: { code: 'not-indexed-yet' } } });
  assert.equal(isPending(p409), true);
});

test('every other failure throws {status, code, message} from the error envelope', () => {
  const cases = [
    [400, 'bad-scope', 'unparseable scope'],
    [403, 'outside-projects-dir', 'that path is not in the FileTable'],
    [404, 'no-such-session', 'unknown session'],
    [416, 'window-unsatisfiable', 'no such line window'],
    [503, 'indexer-down', 'the indexer worker is not running'],
  ];
  for (const [status, code, message] of cases) {
    assert.throws(
      () => interpret({ status, ok: false, payload: { error: { code, message } }, path: '/api/x' }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, status);
        assert.equal(err.code, code);
        assert.equal(err.message, message);
        return true;
      });
  }
});

test('DESIGN §0: only a 404 resolves upward; 400/403 render an error card', () => {
  const notFound = new ApiError({ status: 404, code: 'x', message: 'y' });
  const forbidden = new ApiError({ status: 403, code: 'x', message: 'y' });
  const bad = new ApiError({ status: 400, code: 'x', message: 'y' });
  assert.equal(notFound.resolvesUpward, true);
  assert.equal(forbidden.resolvesUpward, false);
  assert.equal(bad.resolvesUpward, false);
});

test('a failure with no envelope still produces a usable code', () => {
  assert.throws(() => interpret({ status: 500, ok: false, statusText: 'Internal Server Error', payload: null }),
    (err) => err.code === 'http-500' && err.message === 'Internal Server Error');
});

test('api() over a stubbed fetch: JSON, 204, 409 and a network failure', async () => {
  const original = globalThis.fetch;
  const responses = new Map([
    ['/api/hello', { status: 200, body: '{"app":"lens","version":"2","pid":1}' }],
    ['/api/index?since=9', { status: 204, body: '' }],
    ['/api/session/a/b', { status: 409, body: '{"error":{"code":"not-indexed-yet","detail":{"retryAfterMs":500,"bytesIndexed":10,"bytesTotal":100}}}' }],
    ['/api/turn/a/b/99', { status: 404, body: '{"error":{"code":"no-such-turn","message":"idx past end"}}' }],
  ]);
  globalThis.fetch = async (url) => {
    if (url === '/api/boom') throw new TypeError('failed to fetch');
    const r = responses.get(url);
    if (!r) throw new Error(`unexpected url ${url}`);
    return {
      status: r.status, ok: r.status >= 200 && r.status < 300, statusText: '',
      text: async () => r.body,
    };
  };
  try {
    assert.deepEqual(await api('/api/hello'), { app: 'lens', version: '2', pid: 1 });
    assert.equal(await api('/api/index', { since: 9 }), null);

    const pending = await api('/api/session/a/b');
    assert.equal(isPending(pending), true);
    assert.equal(pending.pending.bytesTotal, 100);

    await assert.rejects(() => api('/api/turn/a/b/99'), (e) => e.status === 404 && e.code === 'no-such-turn');
    await assert.rejects(() => api('/api/boom'), (e) => e.code === 'network');
  } finally {
    globalThis.fetch = original;
  }
});

test('the SSE vocabulary is exactly SPEC §9 (+ the progress stream\'s pending event, integration 2026-08-17)', () => {
  assert.deepEqual(SSE_EVENTS, ['progress', 'pending', 'match', 'skip', 'problem', 'invariant', 'done', 'error']);
});

test('the pricing URL is overridable for non-root hosting', () => {
  assert.doesNotThrow(() => setPricingUrl('/shared/pricing.mjs'));
});
