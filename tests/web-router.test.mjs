// tests/web-router.test.mjs — DESIGN §0 routing, as assertions.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHash, splitPath, compilePattern, matchRoute, matchCompiled, splitEventRef,
  ancestorsOf, resolveRoute, href, withQuery, queryString,
  defineRoute, clearRoutes, routeTable, VIEW_MODULES, KEYMAP,
} from '../web/js/router.mjs';

const compiledTable = (patterns) => patterns.map((p) => ({ pattern: p, compiled: compilePattern(p) }));

test('parseHash splits path, segments and query and keeps unknown params', () => {
  const r = parseHash('#/p/proj/s/sid?v=table&zz=keepme');
  assert.equal(r.path, '/p/proj/s/sid');
  assert.deepEqual(r.segments, ['p', 'proj', 's', 'sid']);
  assert.equal(r.query.get('v'), 'table');
  assert.equal(r.query.get('zz'), 'keepme');
  assert.deepEqual(parseHash('').segments, []);
  assert.deepEqual(parseHash('#/').segments, []);
  assert.deepEqual(splitPath('//a//b/'), ['a', 'b']);
});

test('the spine matches, with per-segment decoding', () => {
  const p = matchRoute('/p/:slug/s/:sid/t/:idx', ['p', 'C--Users-x', 's', 'abc', 't', '3']);
  assert.equal(p.slug, 'C--Users-x');
  assert.equal(p.sid, 'abc');
  assert.equal(p.idx, '3');
  assert.equal(p.idxNum, 3);

  const enc = matchRoute('/p/:slug', ['p', 'a%2Fb%20c']);
  assert.equal(enc.slug, 'a/b c');
});

test('a pattern that does not match returns null, and lengths must agree', () => {
  assert.equal(matchRoute('/p/:slug', ['p']), null);
  assert.equal(matchRoute('/p/:slug', ['p', 'a', 'b']), null);
  assert.equal(matchRoute('/p/:slug/s/:sid', ['p', 'a', 'X', 'b']), null);
});

test('DESIGN §0: `x` consumes the REMAINDER, decoded per segment', () => {
  // Both spellings compile to the same thing.
  const auto = compilePattern('/p/:slug/s/:sid/x');
  const explicit = compilePattern('/p/:slug/s/:sid/x/*rel');
  assert.equal(auto.segs.length, explicit.segs.length);
  assert.equal(auto.segs[auto.segs.length - 1].kind, 'rest');

  const segs = ['p', 'proj', 's', 'sid', 'x', 'subagents', 'workflows', 'wf_1', 'agent-a%20b.jsonl'];
  const params = matchCompiled(auto, segs);
  assert.equal(params.rel, 'subagents/workflows/wf_1/agent-a b.jsonl');
  assert.deepEqual(params.relSegments, ['subagents', 'workflows', 'wf_1', 'agent-a b.jsonl']);

  // relpaths reach 4 segments; the remainder must not cap out
  const deep = matchCompiled(auto, ['p', 'a', 's', 'b', 'x', 'v', 'w', 'y', 'z', 'q']);
  assert.equal(deep.relSegments.length, 5);

  // a remainder needs at least one segment
  assert.equal(matchCompiled(auto, ['p', 'proj', 's', 'sid', 'x']), null);

  // ':rel*' is accepted as a synonym for '*rel' so both spellings bind params.rel
  const alt = matchRoute('/p/:slug/s/:sid/x/:rel*', ['p', 'proj', 's', 'sid', 'x', 'a', 'b']);
  assert.equal(alt.rel, 'a/b');
  assert.deepEqual(alt.relSegments, ['a', 'b']);
});

test('project-level raw + memory routes', () => {
  const x = matchRoute('/p/:slug/x', ['p', 'proj', 'x', 'memory', 'note.md']);
  assert.equal(x.rel, 'memory/note.md');
  const mem = matchRoute('/p/:slug/mem/:name', ['p', 'proj', 'mem', 'claude-playback-lens-tool.md']);
  assert.equal(mem.name, 'claude-playback-lens-tool.md');
});

test('SPEC §8: e/<line>[.<bi>] splits on the FIRST dot after the line', () => {
  assert.deepEqual(pick(splitEventRef('123')), { line: 123, bi: null, valid: true });
  assert.deepEqual(pick(splitEventRef('123.4')), { line: 123, bi: '4', valid: true });
  assert.deepEqual(pick(splitEventRef('123.4.5')), { line: 123, bi: '4.5', valid: true });
  assert.deepEqual(pick(splitEventRef('123.r')), { line: 123, bi: 'r', valid: true });
  assert.deepEqual(pick(splitEventRef('123.r.2')), { line: 123, bi: 'r.2', valid: true });
  // 1-based: line 0 and non-numeric are not addresses, and are NOT invented
  assert.deepEqual(pick(splitEventRef('0')), { line: null, bi: null, valid: false });
  assert.deepEqual(pick(splitEventRef('abc.1')), { line: null, bi: '1', valid: false });
  assert.deepEqual(pick(splitEventRef('')), { line: null, bi: null, valid: false });
});

function pick(o) { return { line: o.line, bi: o.bi, valid: o.valid }; }

test('the L5 route yields line + bi whichever way the pattern is written', () => {
  const a = matchRoute('/p/:slug/s/:sid/a/:agentId/e', ['p', 'x', 's', 'y', 'a', 'a0123', 'e', '42.1.2']);
  assert.equal(a.line, 42);
  assert.equal(a.bi, '1.2');
  const b = matchRoute('/p/:slug/s/:sid/a/:agentId/e/:eventRef', ['p', 'x', 's', 'y', 'a', 'a0123', 'e', '42.r']);
  assert.equal(b.line, 42);
  assert.equal(b.bi, 'r');
  assert.equal(b.agentId, 'a0123');
});

test('unknown routes resolve to the NEAREST registered ancestor, with a reason', () => {
  const table = compiledTable(['/', '/p/:slug', '/p/:slug/s/:sid', '/p/:slug/s/:sid/t/:idx']);
  const hit = resolveRoute(['p', 'x', 's', 'y'], table);
  assert.equal(hit.pattern, '/p/:slug/s/:sid');
  assert.equal(hit.fallback, null);

  const miss = resolveRoute(['p', 'x', 's', 'y', 'nope', 'deeper'], table);
  assert.equal(miss.pattern, '/p/:slug/s/:sid');
  assert.equal(miss.params.sid, 'y');
  assert.equal(miss.fallback.requested, '#/p/x/s/y/nope/deeper');
  assert.equal(miss.fallback.resolved, '#/p/x/s/y');

  const nothing = resolveRoute(['zzz'], compiledTable([]));
  assert.equal(nothing.pattern, null);
  assert.equal(nothing.fallback.resolved, '#/');
});

test('ancestorsOf walks nearest-first and ends at the root', () => {
  assert.deepEqual(ancestorsOf(['a', 'b', 'c']), [['a', 'b'], ['a'], []]);
  assert.deepEqual(ancestorsOf([]), []);
});

test('literals outrank params outrank remainders', () => {
  const table = compiledTable(['/p/:slug/s/:sid/inv', '/p/:slug/s/:sid/:anything', '/p/:slug/s/:sid/x']);
  assert.equal(resolveRoute(['p', 'a', 's', 'b', 'inv'], table).pattern, '/p/:slug/s/:sid/inv');
  assert.equal(resolveRoute(['p', 'a', 's', 'b', 'other'], table).pattern, '/p/:slug/s/:sid/:anything');
});

test('href encodes every segment and appends a query', () => {
  assert.equal(href(), '#/');
  assert.equal(href('p', 'a/b'), '#/p/a%2Fb');
  assert.equal(href('p', 'proj', 's', 'sid', 't', 3), '#/p/proj/s/sid/t/3');
  assert.equal(href('p', 'proj', { v: 'table' }), '#/p/proj?v=table');
  assert.equal(href('p', 'proj', { v: null, q: '' }), '#/p/proj');
  assert.equal(href('find', { q: 'a b&c' }), '#/find?q=a+b%26c');
  assert.equal(href('p', 'proj', 's', 'sid', 'x', ['tool-results', 'a b.txt']),
    '#/p/proj/s/sid/x/tool-results/a%20b.txt');
});

test('withQuery preserves unknown params and deletes emptied ones', () => {
  assert.equal(withQuery('#/p/a?v=table&zz=1', { v: 'timeline' }), '#/p/a?v=timeline&zz=1');
  assert.equal(withQuery('#/p/a?v=table&zz=1', { v: null }), '#/p/a?zz=1');
  assert.equal(withQuery('#/p/a', { q: 'x' }), '#/p/a?q=x');
  assert.equal(queryString(null), '');
});

test('defineRoute registers a normalised pattern and rejects a non-function', () => {
  clearRoutes();
  const p = defineRoute('/p/:slug/s/:sid/x', () => {});
  assert.equal(p, '/p/:slug/s/:sid/x');
  assert.equal(routeTable().length, 1);
  assert.throws(() => defineRoute('/bad', null), TypeError);
  clearRoutes();
});

test('the view-module list and keyboard map are the documented ones', () => {
  assert.deepEqual(VIEW_MODULES,
    ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'workflow', 'inv', 'find', 'audit', 'settings', 'memory']);
  const keys = KEYMAP.map((k) => k.keys);
  for (const expected of ['j / k', 'Enter', 'u', '[ / ]', '/', '\\', 'g0 … g5', 't', '?']) {
    assert.ok(keys.includes(expected), `keyboard map is missing ${expected}`);
  }
});
