// tests/web-scope.test.mjs — the scope sentence (the contract between the
// header and the rows) and the SPEC §9 scope grammar.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScopeSentence, scopeString, parseScopeString, scopeLabel, filtersFromQuery,
} from '../web/js/components/scope.mjs';

test('the sentence states what is covered and by what rule', () => {
  const s = buildScopeSentence({
    subject: 'session 0000000a',
    counts: [{ n: 24, noun: 'turn' }, { n: 821, noun: 'agent' }],
    rule: 'a turn opens at a user event whose origin.kind is human (R-T)',
  });
  assert.equal(s, 'Showing 24 turns, 821 agents in session 0000000a. '
    + 'A turn opens at a user event whose origin.kind is human (R-T).');
});

test('singular and plural nouns follow the recorded count', () => {
  assert.match(buildScopeSentence({ subject: 'x', counts: [{ n: 1, noun: 'turn' }] }), /^Showing 1 turn in x\./);
  assert.match(buildScopeSentence({ subject: 'x', counts: [{ n: 0, noun: 'turn' }] }), /^Showing 0 turns in x\./);
});

test('a filter adds a clause naming BOTH counts and what the header totals', () => {
  const s = buildScopeSentence({
    subject: 'the whole store',
    counts: [{ n: 85, noun: 'session' }],
    filters: [{ label: 'dates', value: '2026-08-01 to 2026-08-17' }],
    totals: { all: 85, filtered: 12 },
    sigma: 'all',
    sigmaAvailable: true,   // UI-27: the invite renders only when a toggle will
  });
  assert.match(s, /Filtered by dates 2026-08-01 to 2026-08-17 — 12 of 85 rows match\./);
  assert.match(s, /The header totals all rows; switch to Σ filtered to total the matches instead\./);

  // UI-27: with NO toggle wired, the sentence must not promise one.
  const noToggle = buildScopeSentence({
    subject: 'the whole store',
    counts: [{ n: 85, noun: 'session' }],
    filters: [{ label: 'dates', value: '2026-08-01 to 2026-08-17' }],
    totals: { all: 85, filtered: 12 },
    sigma: 'all',
  });
  assert.match(noToggle, /The header totals all rows\./);
  assert.doesNotMatch(noToggle, /switch to Σ filtered/);

  const filtered = buildScopeSentence({
    subject: 'the whole store', filters: [{ label: 'text containing', value: '“agent”' }],
    totals: { all: 100, filtered: 3 }, sigma: 'filtered',
  });
  assert.match(filtered, /The header totals the filtered rows\./);
});

test('no filter, no sigma clause', () => {
  const s = buildScopeSentence({ subject: 'project proj-h', counts: [{ n: 11, noun: 'session' }] });
  assert.doesNotMatch(s, /Σ/);
  assert.doesNotMatch(s, /Filtered/);
});

test('extra clauses are appended verbatim and always end in a stop', () => {
  const s = buildScopeSentence({
    subject: 'turn 1',
    extra: ['1 turn, 0 agents — showing the turn', 'Agents are attributed by their spawning tool_use line (SPEC §7).'],
  });
  assert.match(s, /1 turn, 0 agents — showing the turn\./);
  assert.match(s, /\(SPEC §7\)\.$/);
});

test('SPEC §9 scope grammar round-trips, with percent-encoded components', () => {
  assert.equal(scopeString('store'), 'store');
  assert.equal(scopeString('project', { slug: 'C--Users-x' }), 'project:C--Users-x');
  assert.equal(scopeString('session', { slug: 'a b', id: 'sid' }), 'session:a%20b/sid');
  assert.equal(scopeString('turn', { slug: 's', id: 'i', idx: 3 }), 'turn:s/i/3');
  assert.equal(scopeString('agent', { slug: 's', id: 'i', agentId: 'a0123' }), 'agent:s/i/a0123');
  assert.throws(() => scopeString('nope', {}), TypeError);

  assert.deepEqual(parseScopeString('store'), { level: 'store', parts: {} });
  assert.deepEqual(parseScopeString('session:a%20b/sid'), { level: 'session', parts: { slug: 'a b', id: 'sid' } });
  assert.deepEqual(parseScopeString('turn:s/i/3'), { level: 'turn', parts: { slug: 's', id: 'i', idx: '3' } });
  assert.equal(parseScopeString('session:onlyone'), null);
  assert.equal(parseScopeString('garbage'), null);
});

test('scopeLabel names a scope in prose for panels and the find page', () => {
  assert.equal(scopeLabel('store'), 'the whole store');
  assert.equal(scopeLabel('agent:s/i/a01'), 'agent a01');
  assert.equal(scopeLabel('not a scope'), 'not a scope');
});

test('filtersFromQuery turns the URL into scope-sentence clauses', () => {
  const q = new URLSearchParams('q=agent&k=tool_use,system&from=2026-08-01&to=2026-08-17');
  const filters = filtersFromQuery(q);
  assert.deepEqual(filters, [
    { label: 'text containing', value: '“agent”' },
    { label: 'row kinds', value: 'tool_use,system' },
    { label: 'dates', value: '2026-08-01 to 2026-08-17' },
  ]);
  assert.deepEqual(filtersFromQuery(new URLSearchParams('')), []);
  assert.equal(filtersFromQuery(new URLSearchParams('q=x&re=1'))[0].label, 'regex');
  assert.equal(filtersFromQuery(new URLSearchParams('from=2026-01-01'))[0].value, 'from 2026-01-01');
});
