// tests/fixes-round3.test.mjs — named regressions for the round-3 fix pass
// (fixer, 2026-08-18). Server half:
//
//   R3-1  /api/session must derive its `forked` badge and its R2-pending chip
//         from the card as it stands AFTER the request's own on-demand reparse
//         — not from the snapshot taken before detail()/rows() ran.
//   WF-1  a COMPLETE workflow run ships an `agents` array (it shipped none, so
//         every completed run claimed "no agent transcript in this run
//         directory" and fabricated a manifest-vs-disk discrepancy).
//   WF-2  both envelopes ship agent OBJECTS, never bare filename strings.
//
// These drive the REAL index (lens.mjs createIndexState + the real parse /
// ledger / summary / scan modules) over a throwaway store, because the defects
// live in the seam between the on-demand parse and the HTTP handlers — a stub
// index cannot express "the card is stale while the rows are gone".

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIndexState } from '../lens.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import { startServer, getJson } from './fixtures/api/helpers.mjs';

const SLUG = 'C--r3-proj';
const SA = '3f000000-0000-4000-8000-00000000000a';
const SB = '3f000000-0000-4000-8000-00000000000b';
const RUN_DONE = 'wf_aa000001-abc';   // completed: has its wf_*.json manifest
const RUN_FLY = 'wf_bb000002-def';    // in flight: no manifest yet
const AG_DONE = 'a0000000000000001';
const AG_LATE = 'a0000000000000002';  // lands on disk AFTER the parse
const AG_FLY = 'a0000000000000003';
const SHARED = 'msg_SHARED_R3';

const J = JSON.stringify;
const ts = (s) => `2026-08-01T${s}.000Z`;

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage, makeUser } from './fixtures/api/make-store.mjs';
const user = makeUser("C:\\r3\\proj");

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
 *  enumeration source, and it moves independently of the parsed cards. */
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

before(async () => {
  store = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r3-store-'));
  cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r3-cache-'));

  // ---- session A: one turn, one completed run, one in-flight run
  await w(`${SLUG}/${SA}.jsonl`, [
    user({ sid: SA, uuid: 'r3-a-1', at: ts('10:00:00'), text: 'run the workflow' }),
    asst({ sid: SA, uuid: 'r3-a-2', at: ts('10:00:10'), msgId: 'msg_A1', model: 'claude-fable-5', text: 'starting', input: 100, output: 50 }),
  ].join('\n') + '\n');

  // completed run: manifest + one transcript + a journal that resulted
  await w(`${SLUG}/${SA}/workflows/${RUN_DONE}.json`, J({
    runId: RUN_DONE, workflowName: 'build', status: 'completed', agentCount: 1,
    startTime: Date.parse(ts('10:00:20')), durationMs: 240000,
    result: { note: 'fixture' }, logs: ['log line'],
    workflowProgress: [
      { type: 'workflow_phase', index: 0, title: 'phase one' },
      {
        type: 'workflow_agent', index: 1, agentId: AG_DONE, label: 'verify:thing',
        phaseIndex: 0, phaseTitle: 'phase one', model: 'claude-sonnet-5[1m]', state: 'done',
        queuedAt: ts('10:00:20'), startedAt: ts('10:00:30'), durationMs: 240000, attempt: '1',
      },
    ],
  }));
  await w(`${SLUG}/${SA}/workflows/scripts/build-${RUN_DONE}.js`, '// r3 fixture script\n');
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_DONE}/agent-${AG_DONE}.jsonl`, [
    user({ sid: SA, uuid: 'r3-d-1', at: ts('10:00:30'), text: 'do the thing', sidechain: true, agentId: AG_DONE }),
    asst({ sid: SA, uuid: 'r3-d-2', at: ts('10:04:30'), msgId: 'msg_DONE', model: 'claude-fable-5', text: 'done', sidechain: true, agentId: AG_DONE, input: 10, output: 20 }),
  ].join('\n') + '\n');
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_DONE}/agent-${AG_DONE}.meta.json`,
    J({ agentType: 'workflow-subagent', spawnDepth: 1, model: 'fable' }));
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_DONE}/journal.jsonl`, [
    J({ type: 'started', key: `v2:${'1'.repeat(64)}`, agentId: AG_DONE }),
    J({ type: 'result', key: `v2:${'1'.repeat(64)}`, agentId: AG_DONE, result: { ok: true } }),
  ].join('\n') + '\n');

  // in-flight run: transcript + a journal start, NO manifest
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_FLY}/agent-${AG_FLY}.jsonl`, [
    user({ sid: SA, uuid: 'r3-f-1', at: ts('10:06:00'), text: 'still working', sidechain: true, agentId: AG_FLY }),
    asst({ sid: SA, uuid: 'r3-f-2', at: ts('10:07:00'), msgId: 'msg_FLY', model: 'claude-fable-5', text: 'partial', sidechain: true, agentId: AG_FLY, input: 5, output: 5 }),
  ].join('\n') + '\n');
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_FLY}/agent-${AG_FLY}.meta.json`,
    J({ agentType: 'workflow-subagent', spawnDepth: 2, model: 'fable' }));
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_FLY}/journal.jsonl`,
    J({ type: 'started', key: `v2:${'2'.repeat(64)}`, agentId: AG_FLY }) + '\n');

  // ---- session B: records SHARED, which session A will record later
  await w(`${SLUG}/${SB}.jsonl`, [
    user({ sid: SB, uuid: 'r3-b-1', at: ts('11:00:00'), text: 'the other file' }),
    asst({ sid: SB, uuid: 'r3-b-2', at: ts('11:00:10'), msgId: SHARED, model: 'claude-fable-5', text: 'shared line', input: 7, output: 9 }),
  ].join('\n') + '\n');

  idx = createIndexState({
    projectsDir: store, cacheDir,
    mods: { pricing, ledger, jsonl, parse, scan, summary },
    restartDebounceMs: 30,
  });
  await rescan();
  // parse both sessions on demand (the same door /api/session uses); the index
  // state stays 'building', which is what makes r2 pending and the R2 chip live
  await idx.detail(SLUG, SA);
  await idx.detail(SLUG, SB);

  const ctx = {
    appName: 'lens-r3', appVersion: 'test',
    projectsDir: store, projectsDirSource: 'fixture',
    webDir: path.join(store, 'no-web'), sharedDir: path.join(store, 'no-shared'),
    pricing, ledger, jsonl, config: null, index: idx,
  };
  srv = await startServer(ctx);
  url = srv.url;
});

after(async () => {
  if (srv) await srv.close();
  await fsp.rm(store, { recursive: true, force: true });
  await fsp.rm(cacheDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ WF-1 */

test('WF-1 — a COMPLETE workflow run ships the agents array the directory listing enumerates', async () => {
  const r = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_DONE}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, true, 'the manifest exists, so this is the complete envelope');
  assert.ok(Array.isArray(r.body.agents), 'the complete branch ships `agents` too — it used to ship none at all');
  assert.equal(r.body.agents.length, 1, 'one row per transcript in the run directory (SPEC §7 enumeration source)');

  const ag = r.body.agents[0];
  assert.equal(typeof ag, 'object');
  assert.equal(ag.agentId, AG_DONE);
  assert.equal(ag.rel, `${SLUG}/${SA}/subagents/workflows/${RUN_DONE}/agent-${AG_DONE}.jsonl`);
  assert.equal(ag.file, `agent-${AG_DONE}.jsonl`);
  assert.equal(ag.runId, RUN_DONE);
  // enriched from the SAME per-agent projection /api/session emits
  assert.equal(ag.label.text, 'verify:thing');
  assert.equal(ag.label.source, 'workflowProgress');
  assert.equal(ag.phaseTitle, 'phase one');
  assert.equal(ag.state, 'done');
  assert.equal(ag.spawnDepth, 1);
  assert.equal(ag.firstAt, Date.parse(ts('10:00:30')), 'the run\'s time anchor comes back with the agents');
  assert.equal(ag.lastAt, Date.parse(ts('10:04:30')));
  // normalizeAgent (web/js/views/l3.mjs) reads raw.model ONLY — the projection
  // records the model under resolvedModel/progressModel/models/metaModel, so a
  // naive copy renders the model column '—' on a model that IS recorded.
  assert.equal(ag.model, 'claude-sonnet-5[1m]', 'the recorded manifest model, suffix and all');
});

test('WF-1 — the run\'s per-agent aggregates sum to its own cost headline', async () => {
  const r = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_DONE}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.cost, 'the run is costed');
  assert.ok(r.body.cost.usd.total > 0, 'and the fixture run really is billed (not a vacuous 0 === 0)');
  const sum = r.body.agents.reduce((n, a) => n + (a.agg?.usd?.total ?? 0), 0);
  assert.equal(sum, r.body.cost.usd.total,
    'the agents carry the very partition the header was folded from — one pricing pass, not two');
  assert.equal(r.body.agents.reduce((n, a) => n + (a.agg?.requests ?? 0), 0), r.body.cost.requests);
  assert.equal(r.body.rowsSumToHeader, true, 'and the independent row-sum cross-check still holds');
});

/* ------------------------------------------------------------------ WF-2 */

test('WF-2 — an IN-FLIGHT run ships agent objects, never filename strings', async () => {
  const r = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_FLY}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, false);
  assert.equal(r.body.agents.length, 1);
  const ag = r.body.agents[0];
  assert.notEqual(typeof ag, 'string',
    'a bare "agent-….jsonl" string reads as undefined through every field normalizeAgent looks at');
  assert.equal(ag.agentId, AG_FLY, 'recoverable from the filename alone — never an unknown, never a dead link');
  // pre-manifest facts that ARE recorded must not render '—' either
  assert.equal(ag.model, 'claude-fable-5', 'the transcript\'s own recorded message.model (no manifest to say otherwise)');
  assert.equal(ag.firstAt, Date.parse(ts('10:06:00')));
  assert.equal(ag.lastAt, Date.parse(ts('10:07:00')));
  assert.equal(ag.spawnDepth, 2);
  assert.equal(ag.state, 'running', 'journal records a start and no result, and no manifest exists (SPEC §7)');
  assert.ok(ag.agg && ag.agg.requests === 1, 'and it carries its own slice of the run\'s cost');
});

test('WF-2 — a transcript on disk that the last parse never saw still gets a row, with unknowns null', async () => {
  // a real in-flight shape: the run directory grows between parses. The
  // directory listing is the enumeration source, so the new transcript MUST
  // appear — carrying the one fact its filename proves and nothing more.
  await w(`${SLUG}/${SA}/subagents/workflows/${RUN_DONE}/agent-${AG_LATE}.jsonl`,
    asst({ sid: SA, uuid: 'r3-l-1', at: ts('10:09:00'), msgId: 'msg_LATE', model: 'claude-fable-5', text: 'late', sidechain: true, agentId: AG_LATE }) + '\n');
  await rescan(); // the stat walk sees it; nothing has re-parsed the session

  const r = await getJson(`${url}/api/workflow/${SLUG}/${SA}/${RUN_DONE}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.agents.length, 2, 'the listing enumerates 2, and the listing is the enumeration source');
  const late = r.body.agents.find((a) => a.agentId === AG_LATE);
  assert.ok(late, 'the unparsed transcript is not silently dropped');
  assert.equal(late.model, null, 'nothing about it is recorded HERE yet — null, never a guess');
  assert.equal(late.label, undefined, 'and no label is invented for it');
  assert.equal(late.agg, null,
    'its billing is UNKNOWN (this file was never read), which is not the same as a provable zero');
  const known = r.body.agents.find((a) => a.agentId === AG_DONE);
  assert.equal(known.label.text, 'verify:thing', 'the projected row beside it is unaffected');
});

/* ------------------------------------------------------------------ R3-1 */

test('R3-1 — after a `stale` message keeps the card but drops the rows, /api/session discloses from the REPARSED msgIds', async () => {
  // before: session A records nothing session B records, so nothing is contested
  let r = await getJson(`${url}/api/session/${SLUG}/${SA}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.r2, 'pending', 'the index is still building — R2 is not resolved');
  assert.ok(!(r.body.badges ?? []).includes('forked'));
  assert.equal(r.body.agg.inheritedPending, undefined, 'no contested msgId yet, so no chip');

  // the live file grows: session A now records the msgId session B already has
  const mainRel = `${SLUG}/${SA}.jsonl`;
  await fsp.appendFile(path.join(store, ...mainRel.split('/')),
    asst({ sid: SA, uuid: 'r3-a-3', at: ts('10:10:00'), msgId: SHARED, model: 'claude-fable-5', text: 'shared line' }) + '\n', 'utf8');
  await rescan();

  // exactly what the worker sends when it notices a changed session: rows and
  // detail are dropped, the CARD is deliberately kept until a later `card` push
  idx._test.handleWorkerMessage({ type: 'stale', sessionIds: [SA] });
  const stale = idx.cards().get(SA);
  assert.ok(stale, 'the card of a session still on disk is retained');
  assert.ok(!(stale.mainMsgIds ?? []).includes(SHARED), 'and it predates the appended line');
  assert.ok(!idx._test.state.rowsStore.has(SA), 'while the rows are gone — the next request reparses');

  // the request's own detail()/rows() reparse replaces that card mid-handler
  r = await getJson(`${url}/api/session/${SLUG}/${SA}`);
  assert.equal(r.status, 200);
  assert.ok(idx.cards().get(SA).mainMsgIds.includes(SHARED), 'the request reparsed the session');
  assert.ok((r.body.badges ?? []).includes('forked'),
    'the badge is derived from the card as it stands AFTER the reparse, not from the pre-reparse snapshot');
  assert.equal(r.body.agg.inheritedPending, true,
    'and so is the R2-pending chip — a stale msgId list under-discloses both');

  // …and the two routes that compute this badge still agree (api.mjs\'s
  // card-first precedence is what keeps L1\'s table and L2\'s page in step)
  const index = await getJson(`${url}/api/index`);
  assert.equal(index.status, 200);
  const cardOut = index.body.sessions.find((c) => c.id === SA);
  assert.ok(cardOut.badges.includes('forked'), '/api/index tags it from the same card');
});
