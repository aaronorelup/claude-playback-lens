// tests/fixes-round12.test.mjs — named regressions for the round-12 fix pass.
// The browser-render halves live in tests/web-fixes-round12.test.mjs.
//
//   R12-D1 (web/js/views/l3.mjs — cyclicAgentIds / buildTree / attachAgents)
//       R11-F2 added the cycleRoot disclosure inside attachAgents, which
//       builds its byId Map from the list it is HANDED — and buildTree hands
//       it one lane group at a time, and inside a run one PHASE at a time. So
//       a parentAgentId cycle whose two members landed in different groups
//       (one carrying a runId, one not) or in different phases of the same run
//       failed byId.has() before the cycle logic could run, and neither member
//       was ever marked. The server's session-wide walk had already emitted an
//       agent-lineage-cycle Problem naming exactly those agents, and
//       /api/turn ships problems: [] — so on L3 the row note is the ONLY
//       cycle disclosure there is, and its absence is a total blackout.
//       The walk now runs once at TURN scope and is UNIONed with (never
//       substituted for) the group-local walk.
//
//   R12-S1 (web/js/views/l3.mjs — normalizeAgent model ladder)
//       normalizeAgent's `model:` line was the one field the 2026-08-17
//       flattening rename missed: it read raw.model / raw.progress.model,
//       neither of which any payload L4 merges ever carries. So L4's
//       "model (raw)" fact ALWAYS fell through to the coarse 4-value meta.json
//       alias while labelling itself 'workflowProgress[].model / meta.model' —
//       a source that was never consulted. The precise [1m]-bearing value
//       (268 workflowProgress entries carry it corpus-wide, and SPEC §
//       long-context requires it be displayed as a recorded fact) reached the
//       page in zero cases.
//
//   R12-D2 (server/parse.mjs — case 'system' errHead)
//       R11-D1 fixed the nested error.formatted === '' blank. A PRIMITIVE
//       ev.error === '' reproduced the identical bug class: the object guard
//       is false, errHead = '', and '' ?? ev.content is '' (?? falls through
//       on null/undefined only), so a blank preview rendered over a real
//       recorded ev.content. Type-scoping the gate to typeof === 'string'
//       leaves error: 0 and error: false untouched.
//
//   R12-F2 (server/config.mjs expandPath / server/api.mjs PUT /api/config)
//       expandPath ended in a bare path.resolve(s), so on Windows the bare
//       drive spec "C:" resolved against the SERVER PROCESS's cwd, not the
//       drive root — and PUT /api/config persisted the raw string verbatim,
//       so the saved directory silently re-resolved per boot.
//
//   R12-F3 (server/http.mjs — method dispatch)
//       HEAD and OPTIONS 404'd against every resource including the app's own
//       index page. HEAD now serves GET's headers with no body; an API path
//       that exists under another method answers 405 with an Allow header
//       instead of a misleading 404.
//
//   R12-F1's regression (the parse dogpile) is tests/fixes-round12-dogpile
//       .test.mjs — it races real concurrent HTTP requests at a cold session
//       on an isolated instance and needs its own process-level fixture.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import http from 'node:http';
import { expandPath, resolveProjectsDir } from '../server/config.mjs';
import { createRouter, createHttpServer, listen, sendJson } from '../server/http.mjs';
import { createStaticHandler } from '../server/static.mjs';
import { buildCtx, startServer, getJson } from './fixtures/api/helpers.mjs';
import { buildLanes, buildTree, cyclicAgentIds, normalizeAgent } from '../web/js/views/l3.mjs';

/* ==================================================================== R12-D1 */

const RUN = 'wf_r1200001-abc';

/** Every node in the tree, flattened — the tree is nested, cycleRoot is not. */
function allNodes(nodes) {
  const out = [];
  const walk = (list) => { for (const n of list) { out.push(n); walk(n.children ?? []); } };
  walk(nodes);
  return out;
}
const nodeFor = (nodes, agentId) => allNodes(nodes).find((n) => n.key === `a:${agentId}`);

const A = (agentId, over = {}) => ({
  agentId,
  label: { text: agentId, source: 'fallback' },
  meta: { agentType: 'general-purpose', toolUseId: `toolu_${agentId}` },
  lineage: { kind: 'plain', toolUseId: `toolu_${agentId}` },
  firstAt: 1755400000000, lastAt: 1755400600000, spawnDepth: 1,
  ...over,
});

/** The shape the finder reproduced end-to-end: one cycle member has a runId
 *  and goes to the workflow-run group, the other has none and goes to
 *  'plain'. The server's session-wide walk names both; the client's used to
 *  name neither. */
const CROSS_GROUP = () => ({
  turnIdx: 2,
  workflows: [{ runId: RUN, turnIdx: 2, workflowName: 'build' }],
  agents: [
    A('xcross', { runId: RUN, parentAgentId: 'ycross', lineage: { kind: 'workflow', runId: RUN, parentAgentId: 'ycross' } }),
    A('ycross', { parentAgentId: 'xcross', lineage: { kind: 'child', parentAgentId: 'xcross' } }),
  ],
});

/** Same run, two recorded phases — the narrower shape the validator found:
 *  buildTree splits a run by phase BEFORE attachAgents ever sees it. */
const CROSS_PHASE = () => ({
  turnIdx: 2,
  workflows: [{ runId: RUN, turnIdx: 2, workflowName: 'build' }],
  agents: [
    A('pph1', { runId: RUN, phase: 'one', parentAgentId: 'qph2', lineage: { kind: 'workflow', runId: RUN } }),
    A('qph2', { runId: RUN, phase: 'two', parentAgentId: 'pph1', lineage: { kind: 'workflow', runId: RUN } }),
  ],
});

test('R12-D1: a cycle split across two lane groups marks BOTH members cycleRoot', () => {
  const model = buildLanes(CROSS_GROUP());
  // the precondition that made this invisible: the two members are in
  // different groups, so neither group's byId can resolve the other's parent
  const groupOf = (id) => model.groups.find((g) => g.agents.some((ag) => ag.agentId === id));
  assert.notEqual(groupOf('xcross').key, groupOf('ycross').key,
    'precondition: the two cycle members must land in different lane groups');

  const nodes = buildTree(model);
  assert.equal(nodeFor(nodes, 'xcross').cycleRoot, true,
    'the run-group member used to render cycleRoot:false — a total blackout on L3');
  assert.equal(nodeFor(nodes, 'ycross').cycleRoot, true,
    'the plain-group member used to render cycleRoot:false');
});

test('R12-D1: a cycle split across two PHASES of one run marks both members', () => {
  const model = buildLanes(CROSS_PHASE());
  const nodes = buildTree(model);
  // precondition: buildTree really did split them into two phase hosts
  const phases = allNodes(nodes).filter((n) => n.kind === 'phase');
  assert.equal(phases.length, 2, 'precondition: the run splits into two phase hosts');

  assert.equal(nodeFor(nodes, 'pph1').cycleRoot, true);
  assert.equal(nodeFor(nodes, 'qph2').cycleRoot, true);
});

test('R12-D1: both members are still DRAWN, unnested, and nothing is dropped', () => {
  for (const build of [CROSS_GROUP, CROSS_PHASE]) {
    const model = buildLanes(build());
    const nodes = buildTree(model);
    const leaves = allNodes(nodes).filter((n) => n.kind === 'agent');
    assert.equal(leaves.length, model.agentCount,
      'the R11 invariant: one agent leaf per counted agent, never fewer');
    for (const l of leaves) {
      assert.equal(l.children.length, 0, 'a cycle member is drawn unnested — never re-parented into the cycle');
    }
  }
});

test('R12-D1: the group-local walk survives — a model with no `agents` still detects its own cycles', () => {
  // The union, not the substitution. A caller that hands buildTree a hand-made
  // model (the shape several tests and any future embedder use) has no
  // turn-wide list to walk; today's within-group detection must not be lost.
  const model = buildLanes({
    turnIdx: 2,
    agents: [
      A('same1', { parentAgentId: 'same2', lineage: { kind: 'child', parentAgentId: 'same2' } }),
      A('same2', { parentAgentId: 'same1', lineage: { kind: 'child', parentAgentId: 'same1' } }),
    ],
  });
  const nodes = buildTree({ groups: model.groups, referenceRows: model.referenceRows });
  assert.equal(nodeFor(nodes, 'same1').cycleRoot, true);
  assert.equal(nodeFor(nodes, 'same2').cycleRoot, true);
});

test('R12-D1: an acyclic turn marks nothing, and real nesting is untouched', () => {
  const model = buildLanes({
    turnIdx: 2,
    agents: [
      A('parent0'),
      A('kid0', { parentAgentId: 'parent0', lineage: { kind: 'child', parentAgentId: 'parent0' } }),
    ],
  });
  const nodes = buildTree(model);
  assert.equal(nodeFor(nodes, 'parent0').cycleRoot, false);
  assert.equal(nodeFor(nodes, 'kid0').cycleRoot, false);
  assert.equal(nodeFor(nodes, 'parent0').children.length, 1, 'a real recorded parent still nests its child');
});

test('R12-D1: cyclicAgentIds is exported, pure, and finds only genuine cycle MEMBERS', () => {
  const norm = [
    { agentId: 'c1', parentAgentId: 'c2' },
    { agentId: 'c2', parentAgentId: 'c1' },
    // an innocent descendant hanging off a cycle member is NOT itself cyclic
    { agentId: 'kid', parentAgentId: 'c1' },
    // a chain that terminates is not a cycle
    { agentId: 'r', parentAgentId: null },
    { agentId: 'r2', parentAgentId: 'r' },
    // a parent nothing records is not a cycle either
    { agentId: 'dangling', parentAgentId: 'nobody' },
  ];
  const got = cyclicAgentIds(norm);
  assert.deepEqual([...got].sort(), ['c1', 'c2']);
  assert.equal(cyclicAgentIds([]).size, 0);
  // self-parent is the degenerate cycle and must be caught
  assert.deepEqual([...cyclicAgentIds([{ agentId: 'self', parentAgentId: 'self' }])], ['self']);
});

/* ==================================================================== R12-S1 */

test('R12-S1: the precise workflowProgress model wins over the coarse meta.json alias', () => {
  // the exact live shape: detailAgents ships these FLATTENED, with no `model`
  // and no `progress` object at all — which is why the old ladder never
  // reached past meta.model
  const ag = normalizeAgent({
    agentId: 'aea965dfbf584734c',
    metaModel: 'opus', progressModel: 'claude-opus-5[1m]',
    models: ['claude-opus-5'], resolvedModel: null,
    meta: { model: 'opus' },
  });
  assert.equal(ag.model, 'claude-opus-5[1m]',
    'L4 printed the 4-value alias "opus" for 136 of 139 agents in one live session');
  assert.equal(ag.modelSource, 'workflowProgress[].model');
});

test('R12-S1: every rung of the ladder names the source that actually supplied the value', () => {
  const cases = [
    [{ model: 'claude-fable-5', progressModel: 'x', metaModel: 'opus' }, 'claude-fable-5', 'recorded model (server-resolved ladder)'],
    [{ resolvedModel: 'claude-opus-5[1m]', metaModel: 'opus' }, 'claude-opus-5[1m]', 'toolUseResult.resolvedModel'],
    [{ progressModel: 'claude-sonnet-5', metaModel: 'sonnet' }, 'claude-sonnet-5', 'workflowProgress[].model'],
    [{ models: ['claude-haiku-5'], metaModel: 'haiku' }, 'claude-haiku-5', 'message.model on this agent’s own events'],
    [{ metaModel: 'opus' }, 'opus', 'meta.json model (a bare alias, never a full id)'],
    [{ meta: { model: 'opus' } }, 'opus', 'meta.json model (a bare alias, never a full id)'],
  ];
  for (const [raw, model, source] of cases) {
    const ag = normalizeAgent(raw);
    assert.equal(ag.model, model, `model for ${JSON.stringify(raw)}`);
    assert.equal(ag.modelSource, source, `source for ${JSON.stringify(raw)}`);
  }
});

test('R12-S1: the workflow-run envelope is unchanged — a server-resolved raw.model still wins', () => {
  // server/api.mjs builds exactly this ladder for the run page and hands it
  // over as `model`. Reordering it would make the run page and L4 disagree.
  const ag = normalizeAgent({ model: 'claude-fable-5', progressModel: 'claude-opus-5[1m]' });
  assert.equal(ag.model, 'claude-fable-5');
});

test('R12-S1: the legacy nested shapes still resolve, and modelSource is non-null exactly when model is', () => {
  assert.equal(normalizeAgent({ progress: { model: 'claude-opus-5[1m]' } }).model, 'claude-opus-5[1m]');
  assert.equal(normalizeAgent({ workflowProgress: { model: 'claude-opus-5[1m]' } }).modelSource, 'workflowProgress[].model');

  // no model recorded anywhere -> BOTH null, so no fact can ever name a source
  // that was not consulted (the mislabel half of the finding)
  for (const raw of [{}, { agentId: 'x' }, null, undefined]) {
    const ag = normalizeAgent(raw);
    assert.equal(ag.model, null, `model for ${JSON.stringify(raw)}`);
    assert.equal(ag.modelSource, null, `modelSource for ${JSON.stringify(raw)}`);
  }
});

test('R12-S1: a recorded EMPTY model string is an unknown, not a value — matching phaseLabelOf', () => {
  const ag = normalizeAgent({ model: '', progressModel: 'claude-opus-5[1m]' });
  assert.equal(ag.model, 'claude-opus-5[1m]', 'an empty string is not a recorded model');
  assert.equal(ag.modelSource, 'workflowProgress[].model');
  assert.equal(normalizeAgent({ model: '' }).model, null);
  assert.equal(normalizeAgent({ model: '' }).modelSource, null);
});

/* ==================================================================== R12-D2 */

const J = JSON.stringify;
// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage12 } from './fixtures/api/make-store.mjs';

describe('R12-D2 — a recorded empty string never blanks a ??-chained row preview', () => {
  const SLUG = 'C--r12-blank';
  const SID = 'b1200000-0000-4000-8000-000000000001';
  let storeDir, model;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r12-blank-'));
    await fsp.mkdir(path.join(storeDir, SLUG), { recursive: true });
    const sys = (uuid, at, extra) => J({
      type: 'system', subtype: 'api_error', level: 'error', sessionId: SID,
      timestamp: at, uuid, ...extra,
    });
    const att = (uuid, at, attachment) => J({
      type: 'attachment', sessionId: SID, timestamp: at, uuid, attachment,
    });
    const toolUse = (uuid, at, msgId, name, input) => J({
      parentUuid: null, isSidechain: false, type: 'assistant', uuid, timestamp: at, sessionId: SID,
      message: {
        id: msgId, model: 'claude-fable-5', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_${uuid}`, name, input }],
        stop_reason: 'tool_use', usage: usage12(100, 50),
      },
    });
    const lines = [
      // 1
      J({
        parentUuid: null, isSidechain: false, type: 'user', uuid: 'u1',
        timestamp: '2026-08-01T10:00:00.000Z', sessionId: SID,
        origin: { kind: 'human' }, cwd: 'C:\\r12\\proj',
        message: { role: 'user', content: 'go' },
      }),
      // 2 — THE FINDING: a PRIMITIVE empty error over a real recorded content
      sys('s1', '2026-08-01T10:00:01.000Z', {
        error: '', content: 'a real recorded detail that should have been the preview',
      }),
      // 3 — whitespace-only primitive: head() would trim it to nothing anyway
      sys('s2', '2026-08-01T10:00:02.000Z', { error: '   ', content: 'the recorded content' }),
      // 4 — primitive '' with NOTHING behind it: the subtype, not a blank
      sys('s3', '2026-08-01T10:00:03.000Z', { error: '' }),
      // 5/6 — the falsy primitives the type-scoping may never touch
      sys('s4', '2026-08-01T10:00:04.000Z', { error: 0, content: 'never reached' }),
      sys('s5', '2026-08-01T10:00:05.000Z', { error: false, content: 'never reached' }),
      // 7 — a real primitive string is still the preview
      sys('s6', '2026-08-01T10:00:06.000Z', { error: 'Overloaded.', content: 'never reached' }),
      // 8 — collateral: banner:'' over a real recorded displayPath
      att('t1', '2026-08-01T10:00:07.000Z', { type: 'file', banner: '', displayPath: 'C:\\r12\\proj\\notes.md' }),
      // 9 — collateral: a real banner still wins
      att('t2', '2026-08-01T10:00:08.000Z', { type: 'file', banner: 'Read 3 lines', displayPath: 'C:\\r12\\proj\\notes.md' }),
      // 10 — collateral: description:'' over a real recorded file_path
      toolUse('v1', '2026-08-01T10:00:09.000Z', 'msg_R12D2a', 'Edit', { description: '', file_path: 'C:\\r12\\proj\\app.mjs' }),
      // 11 — collateral: a real description still wins
      toolUse('v2', '2026-08-01T10:00:10.000Z', 'msg_R12D2b', 'Bash', { description: 'List files', command: 'ls -la' }),
      // 12 — collateral: description:'' with only a command behind it
      toolUse('v3', '2026-08-01T10:00:11.000Z', 'msg_R12D2c', 'Bash', { description: '', command: 'git status' }),
      // 13 — a tool_use recording NONE of the six inputs is still just its name
      toolUse('v4', '2026-08-01T10:00:12.000Z', 'msg_R12D2d', 'TodoWrite', { todos: [] }),
    ];
    await fsp.writeFile(path.join(storeDir, SLUG, `${SID}.jsonl`), lines.join('\n') + '\n', 'utf8');
    const groups = scan.groupSessions(await scan.scanStore(storeDir));
    const entry = groups.sessions.find((s) => s.id === SID);
    model = await parse.parseSession(entry, { projectsDir: storeDir });
  });
  after(async () => { try { await fsp.rm(storeDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const rowAt = (line) => model.main.rows.find((r) => r.line === line);

  // ONE rule across five call sites: a recorded empty string must fall
  // through the ?? chain to the next recorded fact, never render as a blank.
  // Table-driven — one test() per case, so every case keeps its own name in
  // the runner output. Each expectation is {line, head} plus an optional
  // {kind} pin and an optional assertion message.
  const D2_CASES = [
    ['R12-D2: a PRIMITIVE error:\'\' falls through to the recorded content, never a blank preview', [
      { line: 2, kind: 'system:api_error', head: 'a real recorded detail that should have been the preview',
        notBlank: 'the blank preview is the bug — silence about a recorded fact' },
    ]],
    ['R12-D2: a whitespace-only primitive error falls through too', [
      { line: 3, head: 'the recorded content' },
    ]],
    ['R12-D2: error:\'\' with nothing behind it names the subtype, not nothing', [
      { line: 4, head: 'api_error' },
    ]],
    ['R12-D2: the type-scoping cannot be widened — error:0 and error:false still reach the preview', [
      { line: 5, head: '0', note: 'typeof 0 is not "string", so the new branch cannot reach it; a || would swallow it' },
      { line: 6, head: 'false', note: 'typeof false is not "string" either — this is what pins the scoping' },
    ]],
    ['R12-D2: a real primitive string error is still the preview', [
      { line: 7, head: 'Overloaded.' },
    ]],
    ['R12-D2 (collateral): an attachment banner:\'\' falls through to the recorded displayPath', [
      { line: 8, kind: 'attachment:file', head: 'C:\\r12\\proj\\notes.md',
        note: 'the recorded displayPath sat behind an empty banner and never rendered' },
    ]],
    ['R12-D2 (collateral): a recorded attachment banner still wins', [
      { line: 9, head: 'Read 3 lines' },
    ]],
    ['R12-D2 (collateral): a tool_use description:\'\' no longer drops the recorded file_path', [
      { line: 10, kind: 'tool_use', head: 'Edit C:\\r12\\proj\\app.mjs',
        note: 'the row used to read a bare "Edit" while the recorded path sat behind the empty string' },
    ]],
    ['R12-D2 (collateral): a recorded description still wins, and a command behind an empty one is reached', [
      { line: 11, head: 'Bash List files' },
      { line: 12, head: 'Bash git status' },
    ]],
    ['R12-D2 (collateral): a tool_use recording none of the six inputs is still just its name', [
      { line: 13, head: 'TodoWrite', note: 'the tail ?? \'\' is honest — there is nothing more recorded to preview' },
    ]],
  ];

  for (const [name, expectations] of D2_CASES) {
    test(name, () => {
      for (const e of expectations) {
        const r = rowAt(e.line);
        if (e.kind !== undefined) assert.equal(r.kind, e.kind);
        if (e.notBlank !== undefined) assert.notEqual(r.head, '', e.notBlank);
        assert.equal(r.head, e.head, e.note);
      }
    });
  }
});

/* ==================================================================== R12-F2 */

const WIN = path.sep === '\\';

test('R12-F2: a bare drive spec resolves to the DRIVE ROOT, never the server\'s launch cwd', { skip: WIN ? false : 'Windows drive specs' }, () => {
  // The whole finding in one line: "C:" is one missing backslash away from
  // "C:\", and path.resolve treats the difference as "the cwd on that drive".
  assert.equal(expandPath('C:'), path.resolve('C:\\'));
  assert.equal(expandPath('C:'), expandPath('C:\\'),
    'the two spellings the user cannot tell apart must not name different directories');
  assert.equal(expandPath('c:'), path.resolve('c:\\'), 'lowercase too');
  // and it must not depend on where the process happens to be running
  assert.notEqual(expandPath('C:'), path.resolve('.'),
    'this used to be the process cwd — a different directory per launch');
});

test('R12-F2: the drive-spec case is separator-guarded — a POSIX relative name is untouched', { skip: WIN ? 'POSIX relative names' : false }, () => {
  // On POSIX `C:` is a perfectly legal RELATIVE directory name; an unguarded
  // /^[a-zA-Z]:$/ would have turned it into a nonexistent absolute path.
  assert.equal(expandPath('C:'), path.resolve('C:'));
});

test('R12-F2: the paths the suite already pins are unchanged', () => {
  assert.equal(expandPath('plain'), path.resolve('plain'), 'pinned by fixes-lens-liveness (--projects ./corpus is legitimate)');
  assert.equal(expandPath('  ' + path.resolve('x') + '  '), path.resolve('x'), 'trim, unchanged');
  assert.equal(expandPath(''), null);
  assert.equal(expandPath(null), null);
  if (WIN) {
    assert.equal(expandPath('C:\\Users\\x\\projects'), path.resolve('C:\\Users\\x\\projects'));
    assert.equal(expandPath('"C:"'), path.resolve('C:\\'), 'a quoted bare drive spec resolves after the quotes come off');
  }
});

test('R12-F2: a bare drive spec stored in config.json no longer re-resolves per boot', { skip: WIN ? false : 'Windows drive specs' }, () => {
  const r = resolveProjectsDir([], {}, { projectsDir: 'C:' });
  assert.equal(r.dir, path.resolve('C:\\'),
    'the saved value used to name a different directory for every launch cwd');
});

describe('R12-F2 — PUT /api/config persists the RESOLVED path, never the raw string', () => {
  const ACTIVE = path.resolve(os.tmpdir(), 'lens-r12-active-projects');
  let ctx, srv, written;

  // Deliberately the REAL expandPath, so the stub cannot paper over the bug.
  const configStub = () => ({
    loadConfig: async () => ({ projectsDir: written ?? ACTIVE }),
    saveConfig: async (obj) => { written = obj.projectsDir; return { ok: true, path: 'config.json', config: obj, problem: null }; },
    validateDir: async (dir) => ({ ok: true, dir: expandPath(dir), projects: 1, sessions: 1, bytes: 571, files: 1, truncated: false, tookMs: 1, problems: [] }),
    expandPath,
  });

  before(async () => {
    ctx = await buildCtx({ config: configStub() });
    ctx.projectsDir = ACTIVE;
    ctx.projectsDirSource = 'config';
    srv = await startServer(ctx);
  });
  after(async () => { await srv?.close(); });

  const put = (projectsDir) => getJson(`${srv.url}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectsDir }),
  });

  test('a RELATIVE projectsDir is stored resolved, so config.json is cwd-independent', async () => {
    written = undefined;
    const r = await put('corpus');
    assert.equal(r.status, 200);
    assert.equal(r.body.saved, true);
    assert.equal(written, path.resolve('corpus'),
      'the raw string used to be written verbatim and re-expanded against a possibly different cwd every boot');
    assert.ok(path.isAbsolute(written), 'whatever is persisted must be absolute');
    assert.equal(r.body.savedProjectsDir, written,
      'the page is told exactly what landed on disk');
  });

  test('a bare drive spec is stored as the drive root', { skip: WIN ? false : 'Windows drive specs' }, async () => {
    written = undefined;
    const r = await put('C:');
    assert.equal(r.status, 200);
    assert.equal(written, path.resolve('C:\\'));
    assert.equal(r.body.savedProjectsDir, path.resolve('C:\\'));
  });

  test('an already-absolute projectsDir round-trips unchanged (the round-10 contract)', async () => {
    written = undefined;
    const SAVED = path.resolve(os.tmpdir(), 'lens-r12-saved-projects');
    const r = await put(SAVED);
    assert.equal(r.status, 200);
    assert.equal(written, SAVED);
    assert.equal(r.body.savedProjectsDir, SAVED);
    assert.equal(r.body.applied, false, 'R10-F2 is unchanged: the save did NOT take effect here');
    assert.equal(r.body.activeProjectsDir, ACTIVE);
  });

  test('the validate preview still carries the resolved dir the settings page now shows', async () => {
    const r = await put(path.resolve(os.tmpdir(), 'lens-r12-saved-projects'));
    assert.equal(typeof r.body.preview.dir, 'string');
    assert.ok(path.isAbsolute(r.body.preview.dir),
      'settings.mjs renders this as the "resolved to" row — it is the only disclosure of WHICH directory the counts describe');
  });
});

/* ==================================================================== R12-F3 */

/** One raw request, any method, headers and body reported separately so a
 *  HEAD response can be checked for "GET's headers, and no body". */
function rawReq(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('R12-F3 — HEAD and OPTIONS no longer 404 across every resource', () => {
  let server, port, webDir;

  before(async () => {
    webDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r12-web-'));
    await fsp.writeFile(path.join(webDir, 'index.html'), '<!doctype html>\n<title>lens</title>\n', 'utf8');
    await fsp.writeFile(path.join(webDir, 'styles.css'), ':root { --x: 1 }\n', 'utf8');

    const router = createRouter();
    router.add('GET', '/api/hello', (req, res) => sendJson(res, 200, { app: 'Claude Playback Lens' }));
    router.add('POST', '/api/reindex', (req, res) => sendJson(res, 200, { ok: true }));
    router.add('GET', '/api/config', (req, res) => sendJson(res, 200, { ok: true }));
    router.add('PUT', '/api/config', (req, res) => sendJson(res, 200, { ok: true }));
    const fallback = createStaticHandler({ webDir, sharedDir: path.join(webDir, 'shared') });
    server = createHttpServer({ router, fallback });
    port = (await listen(server, { port: 0, host: '127.0.0.1' })).port;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    try { await fsp.rm(webDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('R12-F3: HEAD on a static asset returns GET\'s headers and no body', async () => {
    for (const p of ['/', '/index.html', '/styles.css']) {
      const get = await rawReq(port, p, 'GET');
      const head = await rawReq(port, p, 'HEAD');
      assert.equal(head.status, 200, `HEAD ${p} used to 404 — including the app's own index page`);
      assert.equal(head.status, get.status);
      assert.equal(head.body, '', 'HEAD carries no body');
      for (const k of ['content-type', 'content-length', 'cache-control', 'x-content-type-options']) {
        assert.equal(head.headers[k], get.headers[k], `HEAD ${p}: ${k} must match GET's`);
      }
      assert.ok(get.body.length > 0, 'and GET still has its body');
    }
  });

  test('R12-F3: HEAD on a genuinely missing static path is still 404', async () => {
    const r = await rawReq(port, '/no-such-file.css', 'HEAD');
    assert.equal(r.status, 404, 'HEAD must not invent a resource that does not exist');
  });

  test('R12-F3: HEAD on an /api/ path answers 405 + Allow — not 404, and not the GET handler', async () => {
    const r = await rawReq(port, '/api/hello', 'HEAD');
    assert.equal(r.status, 405, 'a path that exists under GET is not "no such route"');
    assert.equal(r.headers.allow, 'GET');
    assert.equal(r.body, '', 'HEAD carries no body even for the error');
    // the reason 405 beats aliasing HEAD to GET: a headers-only probe of an
    // expensive route must not run the handler behind it
    const get = await rawReq(port, '/api/hello', 'GET');
    assert.equal(get.status, 200, 'and GET is untouched');
  });

  test('R12-F3: OPTIONS answers 405 + Allow, and grants a foreign origin NOTHING', async () => {
    const r = await rawReq(port, '/api/hello', 'OPTIONS');
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET');
    // OPTIONS is not HEAD: it does carry the ordinary error envelope, and
    // saying which methods exist is the honest answer to "what can I do here".
    assert.equal(JSON.parse(r.body).error.code, 'method-not-allowed');
    for (const k of Object.keys(r.headers)) {
      assert.ok(!/^access-control-/i.test(k),
        `this is deliberately NOT CORS preflight handling — ${k} would open the cross-site boundary`);
    }
  });

  test('R12-F3: Allow names EVERY method the path really has, de-duplicated', async () => {
    const r = await rawReq(port, '/api/config', 'DELETE');
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, PUT', 'both registrations, in registration order');
    const one = await rawReq(port, '/api/reindex', 'GET');
    assert.equal(one.status, 405);
    assert.equal(one.headers.allow, 'POST');
  });

  test('R12-F3: an /api/ path that exists under NO method is still an honest 404', async () => {
    const r = await rawReq(port, '/api/nothing-here', 'GET');
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.body).error.code, 'unknown-route');
    assert.equal(r.headers.allow, undefined, 'a 404 must not claim the resource has methods');
    const opt = await rawReq(port, '/api/nothing-here', 'OPTIONS');
    assert.equal(opt.status, 404, 'OPTIONS on a nonexistent route is not-found, not method-not-allowed');
  });

  test('R12-F3: the 405 body is the app\'s ordinary error envelope, naming the methods', async () => {
    const r = await rawReq(port, '/api/hello', 'POST');
    assert.equal(r.status, 405);
    const b = JSON.parse(r.body);
    assert.equal(b.error.code, 'method-not-allowed');
    assert.match(b.error.message, /POST is not supported for \/api\/hello; this route answers GET/);
  });

  test('R12-F3: router.methodsFor is exact — path shape, not prefix, and malformed encoding is empty', () => {
    const router = createRouter();
    router.add('GET', '/api/turn/:slug/:id/:idx', () => {});
    router.add('POST', '/api/turn/:slug/:id/:idx', () => {});
    router.add('GET', '/api/turn/:slug', () => {});
    assert.deepEqual(router.methodsFor('/api/turn/a/b/2'), ['GET', 'POST']);
    assert.deepEqual(router.methodsFor('/api/turn/a'), ['GET']);
    assert.deepEqual(router.methodsFor('/api/turn/a/b'), [], 'segment count must match exactly');
    assert.deepEqual(router.methodsFor('/api/turn/%zz/b/2'), [],
      'malformed percent-encoding stays a 404, never an uncaught URIError');
  });
});
