// Round-1 fix regressions — lens.mjs worker lifecycle (COR-1, COR-4, COR-11,
// COR-15, COR-20) + misc boot fixes (COR-23, ACC-26, ACC-27, ACC-33, ACC-34,
// addendum d payload guarantee).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndexState } from '../lens.mjs';
import { expandPath } from '../server/config.mjs';
import { formatUsd } from '../shared/pricing.mjs';
import { scanStore, groupSessions } from '../server/scan.mjs';
import { parseSession } from '../server/parse.mjs';
import { buildSessionLedger } from '../server/ledger.mjs';
import { summarise } from '../server/summary.mjs';
import { buildCtx, startServer, sseCollect, SLUG } from './fixtures/api/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeState(extra = {}) {
  const idx = createIndexState({
    projectsDir: path.join(HERE, 'fixtures', 'reader', 'store'),
    cacheDir: path.join(HERE, '.tmp-cache-liveness'),
    mods: {},
    restartDebounceMs: 30,
    ...extra,
  });
  return idx;
}

test('COR-4 — worker `ready ok:false` is a FAILED state, never a resolved index; problems are kept', () => {
  const idx = makeState();
  const { handleWorkerMessage } = idx._test;
  handleWorkerMessage({ type: 'problem', problem: { code: 'indexer-crashed', severity: 'error', scope: 'store', message: 'boom', affects: 'aggregates', count: 1 } });
  handleWorkerMessage({ type: 'ready', ok: false });
  assert.equal(idx.status().state, 'failed', 'a failed build must not present as ready');
  assert.ok(idx.problems().some((p) => p.code === 'indexer-crashed'), 'the crash problem is served, not dropped');
  handleWorkerMessage({ type: 'ready' });
  assert.equal(idx.status().state, 'ready', 'a later clean build recovers');
});

test('COR-1 — `stale` re-sends a debounced idempotent start; bursts coalesce; no overlap', async () => {
  const idx = makeState();
  const { state, handleWorkerMessage } = idx._test;
  const sent = [];
  state.worker = { postMessage: (m) => sent.push(m) };
  handleWorkerMessage({ type: 'stale', sessionIds: ['a'] });
  handleWorkerMessage({ type: 'stale', sessionIds: ['b'] });
  handleWorkerMessage({ type: 'stale', sessionIds: ['c'] });
  assert.equal(sent.length, 0, 'trailing debounce — nothing sent yet');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(sent.filter((m) => m.type === 'start').length, 1, 'one coalesced start for the burst');
  // a stale DURING the in-flight build queues exactly one follow-up
  handleWorkerMessage({ type: 'stale', sessionIds: ['d'] });
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(sent.filter((m) => m.type === 'start').length, 1, 'no overlap while the build is in flight');
  handleWorkerMessage({ type: 'ready' });
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(sent.filter((m) => m.type === 'start').length, 2, 'the queued start fires after ready');
});

test('COR-11 — `stale` drops rows/details AND the cards of sessions no longer on disk', () => {
  const idx = makeState();
  const { state, handleWorkerMessage } = idx._test;
  state.sessions = [{ id: 'alive', slug: 's', files: [] }];
  state.cards.set('alive', { id: 'alive' });
  state.cards.set('ghost', { id: 'ghost' });
  state.rowsStore.set('ghost', []);
  state.details.set('ghost', {});
  handleWorkerMessage({ type: 'stale', sessionIds: ['ghost', 'alive'] });
  assert.ok(!state.cards.has('ghost'), 'a deleted session stops feeding L0/aggs/dayBands');
  assert.ok(state.cards.has('alive'), 'a merely-changed session keeps its card until re-summarised');
  assert.ok(!state.rowsStore.has('ghost'));
  assert.ok(!state.details.has('ghost'));
});

test('COR-15 — a session that failed to parse answers 500 session-unparseable, not an endless 409', async () => {
  const idx = makeState();
  const { handleWorkerMessage } = idx._test;
  handleWorkerMessage({
    type: 'problem',
    problem: { code: 'indexer-crashed', severity: 'error', scope: 'session', id: 'deadbeef-dead-4ead-8ead-deadbeefdead', slug: 's', message: 'parse blew up', affects: 'aggregates', count: 1 },
  });
  await assert.rejects(
    () => idx.rows('s', 'deadbeef-dead-4ead-8ead-deadbeefdead'),
    (e) => e.status === 500 && e.code === 'session-unparseable',
    'a permanent failure is a real HTTP error',
  );
});

test('COR-20 — /api/progress poll fallback stops with an error when the index is ready without the card', async () => {
  const ctx = await buildCtx({ extraPendingSession: true });
  const srv = await startServer(ctx);
  try {
    const out = await sseCollect(`${srv.url}/api/progress/${SLUG}/33333333-3333-4333-8333-333333333333`);
    assert.equal(out.status, 200, 'the stream opens (pending arrives as an event, never a 409 transport error)');
    assert.ok(out.events.some((e) => e.event === 'pending'), 'pending event emitted');
    const err = out.events.find((e) => e.event === 'error');
    assert.ok(err, 'bounded: the loop ends with an error event');
    assert.equal(err.data.code, 'session-not-indexed');
  } finally { await srv.close(); }
});

test('COR-23 — expandPath strips a lone trailing quote from shell-escaped Windows paths', () => {
  assert.equal(expandPath('C:\\Users\\x\\projects"'), path.resolve('C:\\Users\\x\\projects\\'));
  assert.equal(expandPath('"C:\\Users\\x\\projects"'), path.resolve('C:\\Users\\x\\projects'));
  assert.equal(expandPath('plain'), path.resolve('plain'));
});

test('ACC-26 — a negative sub-threshold amount renders >-$0.0001 (mathematically correct bound)', () => {
  assert.equal(formatUsd(-100000), '>-$0.0001');
  assert.equal(formatUsd(100000), '<$0.0001');
  assert.equal(formatUsd(0), '0');
  assert.equal(formatUsd(-2e9), '-$1.0000');
});

test('addendum d — detailAgents carry the RECORDED spawn edge fields the drill views classify on', async () => {
  const STORE = path.join(HERE, 'fixtures', 'reader', 'store');
  const SID = '11111111-1111-4111-8111-111111111111';
  const grouped = groupSessions(await scanStore(STORE));
  const s = grouped.sessions.find((x) => x.id === SID);
  const model = await parseSession(s, { projectsDir: STORE });
  const rows = buildSessionLedger(model.assistantLines);
  const { detail } = summarise(model, rows, 'fp');
  const plain = detail.agents.find((a) => a.agentId === 'aplain0000000001');
  assert.ok(plain, 'fixture plain agent present');
  assert.equal(plain.kind, 'plain');
  assert.equal(plain.toolUseId, 'toolu_fxPLAIN', 'the recorded edge SHIPS (walkthrough: omitting it made the client print the §7 fallback)');
  assert.equal(typeof plain.spawnLine, 'number');
  const child = detail.agents.find((a) => a.agentId === 'achild0000000001');
  if (child) assert.equal(typeof child.parentAgentId, 'string', 'depth-2 edge ships too');
  // the client-side lane classifier's routing predicate (l3.mjs buildLanes):
  // an agent with runId | toolUseId | parentAgentId | kind plain/child is NEVER "unlinked"
  for (const a of detail.agents) {
    const linked = a.runId || a.toolUseId || a.parentAgentId || a.kind === 'plain' || a.kind === 'child';
    assert.ok(linked, `agent ${a.agentId} carries a recorded edge in the payload (kind=${a.kind})`);
    assert.equal(typeof a.cached, 'boolean', 'lane-tag fact: cached');
    assert.ok('worktreePath' in a && 'isolation' in a && 'spawnedWithWorktree' in a, 'lane-tag facts present');
  }
});

test('ACC-33 — POSIX absolute paths in "saved to" wordings are captured as spill refs', async () => {
  const { spillRefsFromText } = await import('../server/parse.mjs');
  const refs = [];
  spillRefsFromText('Output has been saved to /home/u/out/result.txt', refs, 'f.jsonl', 1);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, '/home/u/out/result.txt');
  const win = [];
  spillRefsFromText('Output has been saved to C:\\out\\r.txt', win, 'f.jsonl', 1);
  assert.equal(win[0].path, 'C:\\out\\r.txt');
});

test('ACC-27 — scan classifies an uppercase-UUID main as a session with a lowercased id (matching Path B)', async () => {
  const fsp = (await import('node:fs/promises')).default;
  const os = (await import('node:os')).default;
  const root = path.join(os.tmpdir(), `lens-fix-scan-${process.pid.toString(36)}`);
  const slug = 'C--scan';
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const idUpper = 'ABCDEF12-3456-4789-8ABC-DEF123456789';
  await fsp.writeFile(path.join(root, slug, `${idUpper}.jsonl`), '{"type":"user"}\n');
  const grouped = groupSessions(await scanStore(root));
  assert.equal(grouped.sessions.length, 1);
  assert.equal(grouped.sessions[0].id, idUpper.toLowerCase(), 'strict 8-4-4-4-12, case-insensitive, lowercased');
  await fsp.rm(root, { recursive: true, force: true });
});

test('ACC-34 — the reader stripper no longer strips long dotted non-base64 "data" values', async () => {
  const { stripHeavy } = await import('../server/jsonl.mjs');
  const dotted = 'https://example.com/a.b.c/'.repeat(30); // 500+ chars with dots
  const line = `{"data":"${dotted}"}`;
  const out = stripHeavy(line);
  assert.equal(out.blobs.length, 0, 'dotted values are DATA, not base64 — kept (matches the audit stripper)');
  const b64 = 'A'.repeat(600);
  const out2 = stripHeavy(`{"data":"${b64}"}`);
  assert.equal(out2.blobs.length, 1, 'real base64 still strips');
});
