// tests/scan-group.test.mjs — store walk, session grouping (sessionId alone),
// fragment union, orphan fragments, fingerprint (group B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStore, groupSessions, fingerprint, readMemoryMeta } from '../server/scan.mjs';

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reader', 'store');
const SID = '11111111-1111-4111-8111-111111111111';

test('scanStore walks the tree into a POSIX-keyed FileTable', async () => {
  const table = await scanStore(STORE);
  assert.ok(typeof table.tookMs === 'number');
  assert.ok(Array.isArray(table.problems));
  assert.ok(table.has(`C--fx-projA/${SID}.jsonl`), 'main transcript found with POSIX rel');
  assert.ok(table.has(`C--fx-projA/${SID}/subagents/agent-aplain0000000001.jsonl`));
  assert.ok(table.has('C--fx-projA/memory/MEMORY.md'));
  for (const [rel, info] of table) {
    assert.ok(!rel.includes('\\'), `no backslashes in rel: ${rel}`);
    assert.ok(Number.isFinite(info.size) && Number.isFinite(info.mtimeMs));
  }
});

test('groupSessions keys by sessionId alone and unions cross-project fragment dirs', async () => {
  const table = await scanStore(STORE);
  const { projects, sessions, problems } = groupSessions(table);

  const s = sessions.find((x) => x.id === SID);
  assert.ok(s, 'session 11111111 exists');
  assert.equal(s.slug, 'C--fx-projA', 'owned by the project holding the main .jsonl');
  assert.equal(s.mainRel, `C--fx-projA/${SID}.jsonl`);
  // the projD fragment dir unions into this session (SPEC §2 case a)
  assert.deepEqual(s.fragmentDirs, [{ slug: 'C--fx-projD', rel: `C--fx-projD/${SID}` }]);
  assert.ok(s.files.includes(`C--fx-projD/${SID}/workflows/scripts/stray-wf_00000001-aaa.js`),
    'fragment files belong to the owning session');
  assert.ok(s.files.every((rel) => table.has(rel)));
  const wantBytes = s.files.reduce((n, rel) => n + table.get(rel).size, 0);
  assert.equal(s.bytes, wantBytes, 'session bytes = sum over its files');

  // true orphan fragment (SPEC §2 case b): assigned to the holding project, disclosed
  const orphan = sessions.find((x) => x.id === '33333333-3333-4333-8333-333333333333');
  assert.ok(orphan);
  assert.equal(orphan.mainRel, null);
  assert.equal(orphan.slug, 'C--fx-projD');
  assert.ok(problems.some((p) => p.code === 'session-fragment' && p.id === orphan.id));

  const projA = projects.find((p) => p.slug === 'C--fx-projA');
  assert.ok(projA.sessionIds.includes(SID));
  assert.deepEqual(projA.memoryFiles, ['C--fx-projA/memory/MEMORY.md']);
  const projD = projects.find((p) => p.slug === 'C--fx-projD');
  assert.ok(projD.sessionIds.includes(orphan.id), 'orphan counted in the holding project');
  assert.ok(!projD.sessionIds.includes(SID), 'fragment dir does NOT create a second session');

  // projB holds the two real-corpus-derived mains
  const projB = projects.find((p) => p.slug === 'C--fx-projB');
  assert.equal(projB.sessionIds.length, 2);
});

test('fingerprint is deterministic, order-insensitive, and change-sensitive', () => {
  const files = [
    { rel: 'a/x.jsonl', size: 10, mtimeMs: 1000 },
    { rel: 'a/y.jsonl', size: 20, mtimeMs: 2000 },
  ];
  const fp1 = fingerprint(files);
  const fp2 = fingerprint([...files].reverse());
  assert.equal(fp1, fp2, 'sorted internally');
  assert.match(fp1, /^[0-9a-f]{40}$/);
  const fp3 = fingerprint([files[0], { ...files[1], mtimeMs: 2001 }]);
  assert.notEqual(fp1, fp3, 'mtime change changes the fingerprint');
});

test('readMemoryMeta extracts frontmatter originSessionId', async () => {
  const meta = await readMemoryMeta(path.join(STORE, 'C--fx-projA', 'memory', 'MEMORY.md'));
  assert.equal(meta.originSessionId, SID);
});
