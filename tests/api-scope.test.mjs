// Scope grammar (SPEC §9) + file-path guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScope, scopeString, resolveFileRef } from '../server/api.mjs';
import { HttpError } from '../server/errors.mjs';
import { buildCtx, SLUG, S1 } from './fixtures/api/helpers.mjs';

test('parseScope accepts all five forms', () => {
  assert.deepEqual(parseScope(undefined), { kind: 'store' });
  assert.deepEqual(parseScope(''), { kind: 'store' });
  assert.deepEqual(parseScope('store'), { kind: 'store' });
  assert.deepEqual(parseScope('project:my-slug'), { kind: 'project', slug: 'my-slug' });
  assert.deepEqual(parseScope(`session:${SLUG}/${S1}`), { kind: 'session', slug: SLUG, id: S1 });
  assert.deepEqual(parseScope(`turn:${SLUG}/${S1}/3`), { kind: 'turn', slug: SLUG, id: S1, idx: 3 });
  assert.deepEqual(parseScope(`agent:${SLUG}/${S1}/a1234567890abcdef`),
    { kind: 'agent', slug: SLUG, id: S1, agentId: 'a1234567890abcdef' });
});

test('parseScope decodes percent-encoded components', () => {
  const s = parseScope('project:C--My%20Projects');
  assert.equal(s.slug, 'C--My Projects');
  const rt = parseScope(scopeString({ kind: 'project', slug: 'C--My Projects' }));
  assert.equal(rt.slug, 'C--My Projects');
});

test('parseScope rejects malformed scopes with 400', () => {
  const bad = ['bogus', 'zebra:x', 'project:', 'project:a/b', 'session:onlyslug',
    'turn:a/b/notanint', 'turn:a/b/-1', 'turn:a/b/1.5', 'agent:a/b', 'session:a/b/c'];
  for (const s of bad) {
    assert.throws(() => parseScope(s), (e) => e instanceof HttpError && e.status === 400 && e.code === 'bad-scope',
      `expected 400 bad-scope for ${JSON.stringify(s)}`);
  }
});

test('resolveFileRef: session-relative, main transcript, mem/, frag/ forms resolve', async () => {
  const ctx = await buildCtx();
  // session-dir file
  const a = resolveFileRef(ctx, { slug: SLUG, id: S1, rel: 'subagents/agent-a1234567890abcdef.jsonl' });
  assert.equal(a.tableRel, `${SLUG}/${S1}/subagents/agent-a1234567890abcdef.jsonl`);
  // the main transcript addressed session-relatively
  const b = resolveFileRef(ctx, { slug: SLUG, id: S1, rel: `${S1}.jsonl` });
  assert.equal(b.tableRel, `${SLUG}/${S1}.jsonl`);
  // project-level memory with id omitted
  const c = resolveFileRef(ctx, { slug: SLUG, id: null, rel: 'mem/notes.md' });
  assert.equal(c.tableRel, `${SLUG}/memory/notes.md`);
  // cross-project fragment form
  const d = resolveFileRef(ctx, { slug: SLUG, id: S1, rel: `frag/${SLUG}/memory/notes.md` });
  assert.equal(d.tableRel, `${SLUG}/memory/notes.md`);
});

test('resolveFileRef: traversal and out-of-table paths are 403', async () => {
  const ctx = await buildCtx();
  const cases = [
    { slug: SLUG, id: S1, rel: '../secret' },
    { slug: SLUG, id: S1, rel: 'a/../../secret' },
    { slug: SLUG, id: S1, rel: 'C:/windows/system32' },
    { slug: SLUG, id: S1, rel: 'a\\b' },
    { slug: SLUG, id: S1, rel: '/absolute' },
    { slug: SLUG, id: S1, rel: 'not-in-table.jsonl' },
    { slug: '..', id: S1, rel: 'x.jsonl' },
    { slug: SLUG, id: S1, rel: '' },
  ];
  for (const c of cases) {
    assert.throws(() => resolveFileRef(ctx, c),
      (e) => e instanceof HttpError && e.status === 403 && e.code === 'path-forbidden',
      `expected 403 for rel=${JSON.stringify(c.rel)}`);
  }
});

test('resolveFileRef: case-insensitive table compare on win32', async (t) => {
  if (process.platform !== 'win32') { t.skip('win32-only behaviour'); return; }
  const ctx = await buildCtx();
  const r = resolveFileRef(ctx, { slug: SLUG.toUpperCase(), id: S1, rel: `${S1}.jsonl` });
  assert.equal(r.tableRel, `${SLUG}/${S1}.jsonl`); // resolves to the true-case key
});
