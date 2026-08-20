// tests/fixes-round4.test.mjs — named regressions for the round-4 fix pass
// (fixer, 2026-08-18). Server half:
//
//   R4-UI-1  the journal is read ONCE, above the manifest branch split, and
//            rides BOTH workflow envelopes — and the value is DISCRIMINATED:
//            [] only when the run directory provably lists no journal.jsonl,
//            null when the file is listed but will not read. Before this, the
//            complete branch shipped no journal at all and the client turned
//            that silence into "no journal.jsonl in this run directory",
//            "journal started / result 0 / 0" and "retried: no" — on 52 of the
//            corpus's 53 runs, every one of which HAS a journal.
//   R4-UI-4  wf_*.json records queuedAt/startedAt as bare epoch-millisecond
//            NUMBERS; parse.mjs's tsMs() returns null for anything that is not
//            a string, so both landed on the L4 agent page as "not recorded"
//            for every workflow agent in the corpus (686 of 696 entries carry
//            a numeric queuedAt, 0 carry a string).
//
// Like round 3 these drive the REAL index (createIndexState over the real
// parse / ledger / summary / scan) against a throwaway store, because the
// defects live in the seam between the on-demand parse and the HTTP handlers.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIndexState } from '../lens.mjs';
import { INDEX_VERSION } from '../server/index-store.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import { startServer, getJson } from './fixtures/api/helpers.mjs';

const SLUG = 'C--r4-proj';
const SA = '4f000000-0000-4000-8000-00000000000a';

const RUN_NUM = 'wf_a4000001-abc';   // completed; numeric manifest timestamps
const RUN_NOJ = 'wf_a4000002-def';   // completed; NO journal.jsonl on disk
const RUN_RACE = 'wf_a4000003-ace';  // completed; journal listed but unreadable

const AG_NUM = 'a4000000000000001';  // queuedAt/startedAt recorded as NUMBERS
const AG_ISO = 'a4000000000000002';  // …and as ISO strings, on the same run
const AG_NOJ = 'a4000000000000003';
const AG_RACE = 'a4000000000000004';

// the exact literals the fixture records — asserted against, never re-derived
const Q_NUM = 1786090380798;
const S_NUM = 1786090382727;
const START_NUM = 1786090380000;

const J = JSON.stringify;
const ts = (s) => `2026-08-01T${s}.000Z`;

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage, makeUser } from './fixtures/api/make-store.mjs';
const user = makeUser("C:\\r4\\proj");

function asst({ sid, uuid, at, msgId, model, text, sidechain = false, agentId = null, input = 10, output = 20 }) {
  const ev = {
    parentUuid: null, isSidechain: sidechain, type: 'assistant', uuid, timestamp: at, sessionId: sid,
    message: {
      id: msgId, model, type: 'message', role: 'assistant',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usage(input, output),
    },
  };
  if (agentId) ev.agentId = agentId;
  return J(ev);
}

let store, cacheDir, idx, srv, url;

async function w(rel, text) {
  const abs = path.join(store, ...rel.split('/'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, text, 'utf8');
}

/** The stat walk lens.mjs's own rescan() does — the fileTable is the
 *  enumeration source and moves independently of the parsed cards. */
async function rescan() {
  const table = await scan.scanStore(store);
  const groups = scan.groupSessions(table);
  const S = idx._test.state;
  S.fileTable = table;
  S.projects = groups.projects;
  S.sessions = groups.sessions;
  S.bytesTotal = groups.sessions.reduce((a, s) => a + (s.bytes ?? 0), 0);
  S.version += 1;
}

/** One agent transcript in a run directory. */
async function agentIn(runId, agentId, { at1, at2, msgId, depth = 1 }) {
  await w(`${SLUG}/${SA}/subagents/workflows/${runId}/agent-${agentId}.jsonl`, [
    user({ sid: SA, uuid: `r4-${agentId}-1`, at: at1, text: 'do the thing', sidechain: true, agentId }),
    asst({ sid: SA, uuid: `r4-${agentId}-2`, at: at2, msgId, model: 'claude-fable-5', text: 'done', sidechain: true, agentId }),
  ].join('\n') + '\n');
  await w(`${SLUG}/${SA}/subagents/workflows/${runId}/agent-${agentId}.meta.json`,
    J({ agentType: 'workflow-subagent', spawnDepth: depth, model: 'fable' }));
}

before(async () => {
  store = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r4-store-'));
  cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r4-cache-'));

  await w(`${SLUG}/${SA}.jsonl`, [
    user({ sid: SA, uuid: 'r4-a-1', at: ts('10:00:00'), text: 'run the workflows' }),
    asst({ sid: SA, uuid: 'r4-a-2', at: ts('10:00:10'), msgId: 'msg_R4A', model: 'claude-fable-5', text: 'starting', input: 100, output: 50 }),
  ].join('\n') + '\n');

  // ---- RUN_NUM: the corpus shape. queuedAt/startedAt are bare JSON NUMBERS
  // on one entry and ISO strings on the other, so one manifest proves both
  // shapes are accepted. startTime is numeric too (parse.mjs already had a
  // hand-rolled numeric fallback there; it now shares the one helper).
  await w(`${SLUG}/${SA}/workflows/${RUN_NUM}.json`, J({
    runId: RUN_NUM, workflowName: 'engine', status: 'completed', agentCount: 2,
    startTime: START_NUM, durationMs: 240000, timestamp: ts('10:10:00'),
    result: 'the run finished', logs: ['log line'],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Engine build' },
      { type: 'workflow_phase', index: 2, title: 'Rules audit' },
      {
        type: 'workflow_agent', index: 3, agentId: AG_NUM, label: 'engine-builder',
        phaseIndex: 1, phaseTitle: 'Engine build', model: 'claude-sonnet-5[1m]', state: 'done',
        queuedAt: Q_NUM, startedAt: S_NUM, durationMs: 240000, attempt: '1',
      },
      {
        type: 'workflow_agent', index: 4, agentId: AG_ISO, label: 'rules-auditor',
        phaseIndex: 2, phaseTitle: 'Rules audit', model: 'claude-fable-5', state: 'done',
        queuedAt: ts('10:02:00'), startedAt: ts('10:02:30'), durationMs: 60000, attempt: '1',
      },
    ],
  }));
  await agentIn(RUN_NUM, AG_NUM, { at1: ts('10:00:30'), at2: ts('10:04:30'), msgId: 'msg_R4NUM' });
  await agentIn(RUN_NUM, AG_ISO, { at1: ts('10:02:30'), at2: ts('10:03:30'), msgId: 'msg_R4ISO', depth: 2 });
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_NUM}/journal.jsonl`, [
    J({ type: 'started', key: `v2:${'1'.repeat(64)}`, agentId: AG_NUM }),
    J({ type: 'result', key: `v2:${'1'.repeat(64)}`, agentId: AG_NUM, result: { ok: true, note: 'engine built' } }),
    J({ type: 'started', key: `v2:${'2'.repeat(64)}`, agentId: AG_ISO }),
  ].join('\n') + '\n');

  // ---- RUN_NOJ: completed, and its run directory genuinely has no journal
  await w(`${SLUG}/${SA}/workflows/${RUN_NOJ}.json`, J({
    runId: RUN_NOJ, workflowName: 'quiet', status: 'completed', agentCount: 1,
    workflowProgress: [{ type: 'workflow_agent', index: 1, agentId: AG_NOJ, label: 'quiet-one', state: 'done' }],
  }));
  await agentIn(RUN_NOJ, AG_NOJ, { at1: ts('11:00:00'), at2: ts('11:01:00'), msgId: 'msg_R4NOJ' });

  // ---- RUN_RACE: journal.jsonl exists at scan time; one test unlinks it and
  // reads the run again with the (now stale) listing still naming the file.
  await w(`${SLUG}/${SA}/workflows/${RUN_RACE}.json`, J({
    runId: RUN_RACE, workflowName: 'racy', status: 'completed', agentCount: 1,
    workflowProgress: [{ type: 'workflow_agent', index: 1, agentId: AG_RACE, label: 'racy-one', state: 'done' }],
  }));
  await agentIn(RUN_RACE, AG_RACE, { at1: ts('12:00:00'), at2: ts('12:01:00'), msgId: 'msg_R4RACE' });
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_RACE}/journal.jsonl`,
    J({ type: 'started', key: `v2:${'3'.repeat(64)}`, agentId: AG_RACE }) + '\n');

  idx = createIndexState({
    projectsDir: store, cacheDir,
    mods: { pricing, ledger, jsonl, parse, scan, summary },
    restartDebounceMs: 30,
  });
  await rescan();
  await idx.detail(SLUG, SA);

  srv = await startServer({
    appName: 'lens-r4', appVersion: 'test',
    projectsDir: store, projectsDirSource: 'fixture',
    webDir: path.join(store, 'no-web'), sharedDir: path.join(store, 'no-shared'),
    pricing, ledger, jsonl, config: null, index: idx,
  });
  url = srv.url;
});

after(async () => {
  if (srv) await srv.close();
  await fsp.rm(store, { recursive: true, force: true });
  await fsp.rm(cacheDir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- R4-UI-1 */

test('R4-UI-1 — the COMPLETE workflow envelope carries the run\'s journal entries', async () => {
  const r = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_NUM}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, true, 'the manifest is readable, so this is the complete envelope');
  assert.ok('journal' in r.body,
    'the complete branch shipped NO journal key at all — the client then claimed the file did not exist');
  assert.ok(Array.isArray(r.body.journal));
  assert.equal(r.body.journal.length, 3, 'every line of journal.jsonl, in file order');
  assert.deepEqual(r.body.journal.map((e) => e.type), ['started', 'result', 'started']);
  assert.equal(r.body.journal[0].agentId, AG_NUM);
  assert.deepEqual(r.body.journal[1].result, { ok: true, note: 'engine built' },
    'the recorded result object rides through untouched — journal arithmetic is not a census of nothing');
  assert.deepEqual(r.body.problems, [], 'a journal that reads fine raises no problem');
});

test('R4-UI-1 — a run directory that provably lists no journal.jsonl gets [], not null', async () => {
  const r = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_NOJ}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, true);
  assert.deepEqual(r.body.journal, [],
    'the directory listing is evidence of absence — this is the one case the page may say so out loud');
  assert.deepEqual(r.body.problems, []);
});

test('R4-UI-1 — a journal.jsonl the listing names but the read cannot reach is null + a problem, never []', async () => {
  // exactly the live-file race the old `catch {}` swallowed: the enumeration
  // proves the file, the read does not reach it. [] would let the page print
  // "no journal.jsonl in this run directory" — a claim, not a fact.
  await fsp.unlink(path.join(store, SLUG, SA, 'subagents', 'workflows', RUN_RACE, 'journal.jsonl'));
  const r = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_RACE}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, true, 'the run still serves — an unreadable journal never 404s a real run');
  assert.equal(r.body.journal, null, 'UNKNOWN, discriminated from the provable empty list');
  assert.equal(r.body.problems.length, 1);
  assert.equal(r.body.problems[0].code, 'file-unreadable');
  assert.match(r.body.problems[0].message, /journal\.jsonl/);
  assert.match(r.body.problems[0].message, /undisclosed, not absent/);
});

test('R4-UI-1 — the PARTIAL envelope still ships its journal, and its problems still include the manifest\'s', async () => {
  // the in-flight branch is where the journal used to be read; hoisting it must
  // not have taken it away from the branch that always had it.
  const r = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_NUM}`);
  assert.equal(r.body.complete, true);
  const dir = path.join(store, SLUG, SA, 'workflows', `${RUN_NUM}.json`);
  const saved = await fsp.readFile(dir, 'utf8');
  await fsp.writeFile(dir, '{ this is not json', 'utf8');
  try {
    const p = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_NUM}`);
    assert.equal(p.status, 200);
    assert.equal(p.body.complete, false, 'an unparseable manifest falls back to the partial envelope');
    assert.equal(p.body.journal.length, 3, 'and the journal is still there');
    assert.equal(p.body.problems.length, 1);
    assert.equal(p.body.problems[0].code, 'file-unreadable');
    assert.match(p.body.problems[0].message, new RegExp(`${RUN_NUM}\\.json`));
  } finally {
    await fsp.writeFile(dir, saved, 'utf8');
  }
});

/* --------------------------------------------------------------- R4-UI-4 */

test('R4-UI-4 — a NUMERIC workflowProgress queuedAt/startedAt survives the parse as epoch ms', async () => {
  const table = await scan.scanStore(store);
  const s = scan.groupSessions(table).sessions.find((x) => x.id === SA);
  const m = await parse.parseSession(s, { projectsDir: store });
  const ag = m.agents.find((a) => a.agentId === AG_NUM);
  assert.ok(ag, 'the numeric-timestamp agent is enumerated');
  assert.equal(ag.progress.queuedAt, Q_NUM, 'tsMs() returned null for every non-string — 686 of 696 corpus entries');
  assert.equal(ag.progress.startedAt, S_NUM);
  const wf = m.workflows.find((x) => x.runId === RUN_NUM);
  assert.equal(wf.record.startTime, START_NUM, 'the manifest\'s own numeric startTime reads through the same helper');
  assert.equal(wf.record.endTime, Date.parse(ts('10:10:00')), 'and its ISO timestamp still parses');
});

test('R4-UI-4 — an ISO-string queuedAt on the SAME manifest still parses: both shapes are accepted', async () => {
  const table = await scan.scanStore(store);
  const s = scan.groupSessions(table).sessions.find((x) => x.id === SA);
  const m = await parse.parseSession(s, { projectsDir: store });
  const ag = m.agents.find((a) => a.agentId === AG_ISO);
  assert.equal(ag.progress.queuedAt, Date.parse(ts('10:02:00')), 'the widening is a widening, not a swap');
  assert.equal(ag.progress.startedAt, Date.parse(ts('10:02:30')));
});

test('R4-UI-4 — /api/session flattens both onto the agent record the L4 page reads', async () => {
  const r = await getJson(`${url}/api/session/${SLUG}/${SA}`);
  assert.equal(r.status, 200);
  const num = r.body.agents.find((a) => a.agentId === AG_NUM);
  assert.equal(num.queuedAt, Q_NUM, 'this shipped null for all 80 agents of the live session I checked');
  assert.equal(num.startedAtRecorded, S_NUM);
  assert.equal(num.phaseTitle, 'Engine build', 'the phase rides the same record (R4-UI-2 reads it here)');
  const iso = r.body.agents.find((a) => a.agentId === AG_ISO);
  assert.equal(iso.queuedAt, Date.parse(ts('10:02:00')));
});

test('R4-UI-4 — the transcript-event timestamp reader stays STRICT: the bounds ledger is not widened', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../server/parse.mjs', import.meta.url), 'utf8');
  assert.match(src, /const at = tsMs\(ev\.timestamp\);/,
    'SPEC §4 turn bounds come from ISO-8601 event timestamps (0 numeric matches corpus-wide); '
    + 'admitting a bare number there would let an unrelated integer become a turn bound');
  assert.match(src, /function tsMsLoose\(v\)/, 'the manifest rule lives in ONE helper');
});

test('R4-UI-4 — no INDEX_VERSION bump is owed: the persisted card carries no per-agent manifest timestamp', () => {
  // The rule this test pins: a parse-time change only goes stale on disk if
  // something on disk holds it. The proof is the card content below, not the
  // constant — INDEX_VERSION has since moved to 4, and that move was NOT owed
  // either: round 5 bumped it for an image byte census that lives on the
  // in-memory detail, not on the card (R6-1 re-derived this and left the
  // constant at 4 rather than pay a second full rebuild to undo it). So `>= 3`
  // is the assertion, not `=== 3` — the version is free to move for a real
  // reason later, and the card content below is what actually bites.
  assert.ok(INDEX_VERSION >= 3, 'the cache version never moves backwards');
  const card = idx.cards().get(SA);
  assert.ok(card, 'the session is carded');
  const text = JSON.stringify(card);
  assert.doesNotMatch(text, /queuedAt/, 'progressByAgent lives only in the in-memory detail, rebuilt every parse');
  assert.doesNotMatch(text, /startedAtRecorded/);
  // R6-1: pin the fact the version-4 reason line is about. The persisted card
  // holds no per-image byte census — so nothing on disk ever went stale for it.
  assert.doesNotMatch(text, /b64Chars|b64Length/,
    'the image byte census is detail-only; a card that carried it would have owed the bump');
  assert.equal(typeof card.images, 'number', 'the card holds an integer image COUNT, not a census');
});
