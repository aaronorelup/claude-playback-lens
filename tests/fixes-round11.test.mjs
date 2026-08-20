// tests/fixes-round11.test.mjs — named regressions for the round-11 fix pass,
// SERVER side. The browser halves live in tests/web-fixes-round11.test.mjs.
//
//   R11-D1 (server/parse.mjs — case 'system')
//       R10-S2 replaced the "[object Object]" api_error preview with the
//       recorded error strings, but gated on `typeof … === 'string'`, which
//       accepts '' as a chosen value. A recorded `formatted: ''` therefore beat
//       a recorded non-empty `error.message` AND the row's own `ev.content`,
//       and head became '' — the blank preview whose own comment says it exists
//       to prevent exactly that. The gate is now non-empty-after-trim, because
//       head() collapses and trims whitespace anyway. The outer `??` stays
//       `??`: a PRIMITIVE `error: 0` / `error: false` is a recorded fact and
//       must still reach the preview. A primitive `error: ''` was filed
//       deliberately out of scope here — "every widening of it risks eating a
//       recorded falsy primitive". SUPERSEDED by R12-D2: that reasoning is
//       sound against widening the outer `??` to `||`, but not against
//       TYPE-SCOPING the inner gate, which cannot reach `error: 0` or
//       `error: false` at all (`typeof` is not 'string'). The primitive '' is
//       now fixed; the falsy-primitive assertions below are unchanged and are
//       what pin the scoping. See tests/fixes-round12.test.mjs.
//
//   R11-F2 (server/parse.mjs — lineage, disclosure half)
//       `meta.parentAgentId` is read from an untrusted .meta.json sidecar and
//       passed through verbatim (the parent lookup is one Map.get, never a
//       walk). Two sidecars naming each other produced a lineage cycle that the
//       payload delivered end-to-end with agentCount counting both and
//       problems[] empty, while the L3 tree silently dropped both agents. The
//       client half (attachAgents roots them and marks the row) is in
//       tests/web-fixes-round11.test.mjs; this half is the DISCLOSURE — the
//       condition is knowable here, so it is stated here.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';

const J = JSON.stringify;

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage, makeUser, asstStd as asst } from './fixtures/api/make-store.mjs';
const user = makeUser("C:\\r11\\proj");

/* ==================================================================== R11-D1 */

describe('R11-D1 — a recorded empty string never wins the api_error preview', () => {
  const SLUG = 'C--r11-syserr';
  const SID = 'b1100000-0000-4000-8000-000000000001';
  let storeDir, model;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r11-sys-'));
    await fsp.mkdir(path.join(storeDir, SLUG), { recursive: true });
    const sys = (uuid, at, extra) => J({
      type: 'system', subtype: 'api_error', level: 'error', sessionId: SID,
      timestamp: at, uuid, ...extra,
    });
    const lines = [
      user({ sid: SID, uuid: 'u1', at: '2026-08-01T10:00:00.000Z', text: 'go' }),
      // line 2 — the finding: formatted is recorded EMPTY, message is recorded
      // and non-empty, and the row even carries its own content fallback
      sys('s1', '2026-08-01T10:00:01.000Z', {
        error: { message: 'Connection error.', formatted: '', connection: { code: 'ECONNRESET' } },
        content: 'a content fallback that also exists on this row',
      }),
      // line 3 — BOTH recorded strings empty: stringify, never fall silent
      sys('s2', '2026-08-01T10:00:02.000Z', { error: { formatted: '', message: '' } }),
      // line 4 — whitespace-only formatted; head() would trim it to '' anyway
      sys('s3', '2026-08-01T10:00:03.000Z', { error: { formatted: '   ', message: 'Overloaded.' } }),
      // line 5 — a PRIMITIVE falsy error: the `??`-not-`||` case
      sys('s4', '2026-08-01T10:00:04.000Z', { error: 0, content: 'never reached' }),
      // line 6 — the R10 happy path, unchanged
      sys('s5', '2026-08-01T10:00:05.000Z', {
        error: { message: 'Connection error.', formatted: 'Unable to connect to API (ECONNRESET)', connection: { code: 'ECONNRESET' } },
        retryInMs: 516,
      }),
      asst({ sid: SID, uuid: 'a1', at: '2026-08-01T10:00:06.000Z', msgId: 'msg_R11D1', text: 'done' }),
    ];
    await fsp.writeFile(path.join(storeDir, SLUG, `${SID}.jsonl`), lines.join('\n') + '\n', 'utf8');
    const groups = scan.groupSessions(await scan.scanStore(storeDir));
    const entry = groups.sessions.find((s) => s.id === SID);
    model = await parse.parseSession(entry, { projectsDir: storeDir });
  });
  after(async () => { try { await fsp.rm(storeDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const rowAt = (line) => model.main.rows.find((r) => r.line === line);

  test('formatted:\'\' + a recorded message -> the message, never a blank preview', () => {
    const r = rowAt(2);
    assert.equal(r.kind, 'system:api_error');
    assert.equal(r.head, 'Connection error.');
    assert.notEqual(r.head, '', 'the whole point: a recorded empty string is not a preview');
  });

  test('formatted:\'\' + message:\'\' -> the stringify backstop, never \'\'', () => {
    const r = rowAt(3);
    assert.notEqual(r.head, '', 'silence about a recorded fact is the one thing this row may not do');
    assert.equal(r.head, '{"formatted":"","message":""}',
      'the recorded object itself is shown, empty strings and all');
  });

  test('a whitespace-only formatted falls through too — head() would trim it to nothing', () => {
    assert.equal(rowAt(4).head, 'Overloaded.');
  });

  test('a PRIMITIVE falsy error still reaches the preview — `??`, never `||`', () => {
    assert.equal(rowAt(5).head, '0',
      'switching the outer coalesce to || would swallow a recorded error: 0 and print the content instead');
  });

  test('the R10-S2 happy path is unchanged', () => {
    assert.equal(rowAt(6).head, 'Unable to connect to API (ECONNRESET)');
  });

  test('no row in the parsed session has an empty head where a fact was recorded', () => {
    for (const r of model.main.rows) {
      if (!String(r.kind).startsWith('system:')) continue;
      assert.notEqual(r.head, '', `line ${r.line} (${r.kind}) rendered a blank preview`);
      assert.notEqual(r.head, '[object Object]', `line ${r.line} regressed to R10-S2`);
    }
  });
});

/* ==================================================================== R11-F2 */

describe('R11-F2 — a parentAgentId cycle between two sidecars is disclosed, not passed silently', () => {
  const SLUG = 'C--r11-cycle';
  const SID = 'b1100000-0000-4000-8000-000000000002';
  const A = 'acycle0000000001';
  const B = 'acycle0000000002';
  let storeDir, model, cleanModel;

  const agentTranscript = (agentId) => [
    J({
      type: 'user', uuid: `u-${agentId}`, parentUuid: null, timestamp: '2026-08-01T10:00:08.000Z',
      sessionId: SID, isSidechain: true, cwd: 'C:\\r11\\proj',
      message: { role: 'user', content: `[AGENT: ${agentId}] work` }, agentId,
    }),
    asst({ sid: SID, uuid: `a-${agentId}`, at: '2026-08-01T10:00:20.000Z', msgId: `msg_${agentId}`, text: 'ok', sidechain: true, agentId }),
  ].join('\n') + '\n';

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r11-cyc-'));
    const subs = path.join(storeDir, SLUG, SID, 'subagents');
    await fsp.mkdir(subs, { recursive: true });
    await fsp.writeFile(path.join(storeDir, SLUG, `${SID}.jsonl`), [
      user({ sid: SID, uuid: 'u1', at: '2026-08-01T10:00:00.000Z', text: 'go' }),
      asst({ sid: SID, uuid: 'a1', at: '2026-08-01T10:00:30.000Z', msgId: 'msg_R11F2', text: 'done' }),
    ].join('\n') + '\n', 'utf8');

    // the two sidecars that name each other — a real 2-node lineage cycle
    await fsp.writeFile(path.join(subs, `agent-${A}.jsonl`), agentTranscript(A), 'utf8');
    await fsp.writeFile(path.join(subs, `agent-${B}.jsonl`), agentTranscript(B), 'utf8');
    await fsp.writeFile(path.join(subs, `agent-${A}.meta.json`),
      J({ agentType: 'general-purpose', description: 'A', parentAgentId: B, spawnDepth: 2 }), 'utf8');
    await fsp.writeFile(path.join(subs, `agent-${B}.meta.json`),
      J({ agentType: 'general-purpose', description: 'B', parentAgentId: A, spawnDepth: 2 }), 'utf8');

    const groups = scan.groupSessions(await scan.scanStore(storeDir));
    model = await parse.parseSession(groups.sessions.find((s) => s.id === SID), { projectsDir: storeDir });

    // the same store minus the back-edge: B is a plain root, A is its child
    await fsp.writeFile(path.join(subs, `agent-${B}.meta.json`),
      J({ agentType: 'general-purpose', description: 'B', spawnDepth: 1 }), 'utf8');
    const g2 = scan.groupSessions(await scan.scanStore(storeDir));
    cleanModel = await parse.parseSession(g2.sessions.find((s) => s.id === SID), { projectsDir: storeDir });
  });
  after(async () => { try { await fsp.rm(storeDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const cycleProblems = (m) => (m.inventory?.problems ?? []).filter((p) => p.code === 'agent-lineage-cycle');

  test('the cycle raises exactly one problem, naming both sidecars', () => {
    const ps = cycleProblems(model);
    assert.equal(ps.length, 1, 'one collapsed record, not one per agent');
    const p = ps[0];
    assert.equal(p.severity, 'warning');
    assert.equal(p.scope, 'session');
    assert.equal(p.slug, SLUG);
    assert.equal(p.id, SID);
    assert.equal(p.count, 2);
    assert.equal(p.affects, 'display', 'SPEC §9 closed enum — the totals are untouched, the tree is not');
    assert.match(p.message, new RegExp(A), 'the first sidecar is named');
    assert.match(p.message, new RegExp(B), 'the second sidecar is named');
    assert.match(p.message, /\.meta\.json/, 'and the message says where the recorded parent came from');
  });

  test('the recorded parentAgentId is passed through UNCHANGED — the disclosure repairs nothing', () => {
    const byId = new Map(model.agents.map((a) => [a.agentId, a]));
    assert.equal(byId.get(A).meta.parentAgentId, B);
    assert.equal(byId.get(B).meta.parentAgentId, A);
    assert.equal(model.agents.length, 2, 'and both agents are still delivered');
  });

  test('the problem reaches the SessionDetail and the persisted card the client reads', () => {
    const { card, detail } = summary.summarise(model, [], 'fp-r11-f2');
    assert.ok((detail.problems ?? []).some((p) => p.code === 'agent-lineage-cycle'),
      'a session-scope problem that never leaves the parser discloses nothing');
    assert.ok((card.problems ?? []).some((p) => p.code === 'agent-lineage-cycle'),
      'R8-PROB-1: the card carries the session\'s own problems so a WARM boot still reports it');
    // and the card SHAPE is unchanged — no INDEX_VERSION bump is owed. The
    // `problems` key already existed (CARD_V 4 / INDEX_VERSION 5, R8-PROB-1);
    // this fix only lets an existing list gain an entry, for a condition that
    // holds on 0 of the 814 sidecars in the corpus, so no cached card on disk
    // is now missing a disclosure it should have.
    assert.equal(card.v, 4, 'CARD_V unchanged');
    assert.ok(Array.isArray(card.problems));
  });

  test('an ACYCLIC lineage raises nothing — the check does not cry wolf on ordinary nesting', () => {
    assert.deepEqual(cycleProblems(cleanModel), []);
    const byId = new Map(cleanModel.agents.map((a) => [a.agentId, a]));
    assert.equal(byId.get(A).meta.parentAgentId, B, 'A still records B as its parent');
    assert.equal(byId.get(A).lineage.kind, 'child', 'and that edge still resolves normally');
  });
});
