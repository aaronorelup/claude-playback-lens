// tests/fixes-round2.test.mjs — round-2 small-queue regressions:
//   F37  server half: resumed workflow runs ship flagged with their OWNING
//        turnIdx, and the RESUMING turn's workflowRunIds carry the run so the
//        client's link-only reference row can render (SPEC §7).
//   F48  /api/session ships forkPartners — the canonicalOf reverse map for the
//        session's duplicated msgIds — so the CANONICAL side of a fork pair
//        gets banner data too (its own CostAgg has no `inherited` channel).
//   F58  find's done event carries the cap the client prints ("capped at N").
//   favicon — /favicon.ico (and .svg) 200 with an inline SVG, never a 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { scanStore, groupSessions } from '../server/scan.mjs';
import { parseSession } from '../server/parse.mjs';
import { summarise } from '../server/summary.mjs';
import { runFind } from '../server/find.mjs';
import { createStaticHandler } from '../server/static.mjs';
import { createRouter, createHttpServer, listen } from '../server/http.mjs';
import { buildCtx, startServer, getJson, SLUG, S1, S2, RUN } from './fixtures/api/helpers.mjs';

const READER_STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reader', 'store');
const READER_SID = '11111111-1111-4111-8111-111111111111';
const READER_RUN = 'wf_00000001-aaa';

let ctx, srv;
before(async () => { ctx = await buildCtx(); srv = await startServer(ctx); });
after(async () => { await srv.close(); });

// ---------------------------------------------------------------- F37 (parse)

test('F37 — parse: a resumed run records resumedInTurns; ownership stays with the FIRST call', async () => {
  const grouped = groupSessions(await scanStore(READER_STORE));
  const entry = grouped.sessions.find((x) => x.id === READER_SID);
  const model = await parseSession(entry, { projectsDir: READER_STORE });
  const wf = model.workflows.find((w) => w.runId === READER_RUN);
  assert.ok(wf, 'the fixture run exists');
  assert.equal(wf.turnIdx, 1, 'owning turn = turn of the FIRST spawning call (SPEC §7)');
  assert.deepEqual(wf.resumedInTurns, [2], 'the resumeFromRunId call at L8 lands in turn 2');
  assert.equal(wf.resumed, true);
  // the orphan-dir run has no spawn edge at all — nothing fabricated
  const other = model.workflows.find((w) => w.runId !== READER_RUN);
  assert.deepEqual(other.resumedInTurns, [], 'no recorded resume edge -> empty, never inferred');

  // summarise: the RESUMING turn's workflowRunIds now carry the run (that is
  // what /api/turn filters on), while the owning turn keeps it too.
  const { detail } = summarise(model, null, 'fp');
  assert.deepEqual(detail.turns[1].workflowRunIds, [READER_RUN], 'owning turn unchanged');
  assert.ok(detail.turns[2].workflowRunIds.includes(READER_RUN), 'resuming turn lists the run');
  // the served workflow object satisfies the client predicate (l3 classifyRun
  // reads run.turnIdx): owning 1 !== resuming 2 -> link-only reference row.
  const served = detail.workflows.find((w) => w.runId === READER_RUN);
  assert.equal(served.turnIdx, 1);
  assert.deepEqual(served.resumedInTurns, [2]);
});

test('F37 — /api/turn for the RESUMING turn ships the run flagged with its owning turnIdx', async () => {
  // extend the stub detail: S1 gains turn 2, which RESUMES the run owned by turn 1
  const details = ctx._internals.details;
  const key = `${SLUG}/${S1}`;
  const orig = details.get(key);
  const patched = {
    ...orig,
    turns: [
      ...orig.turns,
      { idx: 2, preamble: false, at: Date.parse('2026-08-01T10:06:00.000Z'), endedAt: Date.parse('2026-08-01T10:07:00.000Z'), promptHead: 'resume it', agentIds: [], workflowRunIds: [RUN], lineRange: [9, 9] },
    ],
    workflows: [{ runId: RUN, turnIdx: 1, resumedInTurns: [2] }],
  };
  details.set(key, patched);
  try {
    const r = await getJson(`${srv.url}/api/turn/${SLUG}/${S1}/2`);
    assert.equal(r.status, 200);
    const wf = (r.body.workflows ?? []).find((w) => w.runId === RUN);
    assert.ok(wf, 'the resuming turn payload carries the resumed run');
    assert.equal(wf.turnIdx, 1, 'flagged with the OWNING turn — the client predicate reads run.turnIdx');
    assert.notEqual(wf.turnIdx, 2, 'owning !== resuming -> the client renders the link-only reference row');
    assert.deepEqual(wf.resumedInTurns, [2]);
    // the owning turn still ships it as an OWNED run
    const r1 = await getJson(`${srv.url}/api/turn/${SLUG}/${S1}/1`);
    const wf1 = (r1.body.workflows ?? []).find((w) => w.runId === RUN);
    assert.ok(wf1);
    assert.equal(wf1.turnIdx, 1);
  } finally {
    details.set(key, orig);
  }
});

// ---------------------------------------------------------------- F48

test('F48 — /api/session ships forkPartners on BOTH sides of a fork pair, with exact billed counts', async () => {
  // msg_AAA lives in S1 (canonical — earlier first ts) and S2 (copy)
  const a = await getJson(`${srv.url}/api/session/${SLUG}/${S1}`);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.forkPartners, {
    [S2]: { slug: SLUG, sharedMsgIds: 1, billedHere: 1, billedThere: 0, billedElsewhere: 0 },
  }, 'the CANONICAL side names its partner — this is the banner data agg.inherited cannot provide');

  const b = await getJson(`${srv.url}/api/session/${SLUG}/${S2}`);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.forkPartners, {
    [S1]: { slug: SLUG, sharedMsgIds: 1, billedHere: 0, billedThere: 1, billedElsewhere: 0 },
  }, 'the inherited side agrees, mirrored');
});

test('F48 — forkPartners is null (unknown) while the index is building, never a false {}', async () => {
  const building = await buildCtx({
    status: { state: 'building', sessionsDone: 1, sessionsTotal: 2, bytesIndexed: 10, bytesTotal: 1000 },
  });
  const s = await startServer(building);
  try {
    const r = await getJson(`${s.url}/api/session/${SLUG}/${S1}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.forkPartners, null, 'canonicality is undefined against an incomplete index (R2)');
    assert.equal(r.body.r2, 'pending');
  } finally {
    await s.close();
  }
});

// ------------------------------------------------- F48 (round-2 corrections)

// A DUPLICATED SYNTHETIC msgId: priced $0 by R4 in both files, so it is billed
// in NEITHER — the raw id count and the billed counts must diverge by it.
const SYN = 'msg_SYNDUP';
async function buildDupSyntheticCtx() {
  const c = await buildCtx();
  const cards = c._internals.cards;
  const rowsBySession = c._internals.rowsBySession;
  for (const id of [S1, S2]) {
    const card = cards.get(id);
    cards.set(id, { ...card, mainMsgIds: [...card.mainMsgIds, SYN] });
  }
  const synRow = (sid, line) => ({
    msgId: SYN, model: '<synthetic>', input: 0, output: 0,
    cacheRead: 0, cache5m: 0, cache1h: 0, cacheFlat: 0,
    thinkingTokens: null, webSearch: 0, webFetch: 0, speed: null, serviceTier: null,
    ttl: 'recorded', finalized: false, synthetic: true, billedElsewhere: null, iterIndex: null,
    stopReason: 'stop_sequence', at: Date.parse('2026-08-01T10:04:00.000Z'),
    file: `${sid}.jsonl`, line,
  });
  rowsBySession.set(`${SLUG}/${S1}`, [...rowsBySession.get(`${SLUG}/${S1}`), synRow(S1, 9)]);
  rowsBySession.set(`${SLUG}/${S2}`, [...rowsBySession.get(`${SLUG}/${S2}`), synRow(S2, 9)]);
  return c;
}

test('F48 — a duplicated SYNTHETIC msgId is shared but billed nowhere: forkPartners agrees with the CostAgg', async () => {
  const dctx = await buildDupSyntheticCtx();
  const s = await startServer(dctx);
  try {
    const a = await getJson(`${s.url}/api/session/${SLUG}/${S1}`);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.forkPartners, {
      [S2]: { slug: SLUG, sharedMsgIds: 2, billedHere: 1, billedThere: 0, billedElsewhere: 0 },
    }, 'the synthetic id counts as SHARED (raw superset) and as billed by nobody (R4)');

    const b = await getJson(`${s.url}/api/session/${SLUG}/${S2}`);
    assert.equal(b.status, 200);
    const partner = b.body.forkPartners[S1];
    assert.deepEqual(partner, { slug: SLUG, sharedMsgIds: 2, billedHere: 0, billedThere: 1, billedElsewhere: 0 });
    // THE defect this test pins: billedThere used to be 2 while the CostAgg's
    // own inherited channel (and the rendered banner) said 1.
    assert.equal(partner.billedThere, b.body.agg.inherited[S1].requests,
      'billedThere === the inherited channel — one number on both sides of the pair');
    assert.equal(partner.sharedMsgIds - partner.billedHere - partner.billedThere - partner.billedElsewhere, 1,
      'the shortfall is exactly this file\'s $0 copies (R4 / SPEC §3)');
  } finally { await s.close(); }
});

test('F48 — /api/index and /api/session agree on the `forked` badge for BOTH sides of a pair', async () => {
  const idx = await getJson(`${srv.url}/api/index`);
  assert.equal(idx.status, 200);
  for (const id of [S1, S2]) {
    const card = idx.body.sessions.find((c) => c.id === id);
    assert.ok(card.badges.includes('forked'), `/api/index tags ${id.slice(0, 8)}`);
    const detail = await getJson(`${srv.url}/api/session/${SLUG}/${id}`);
    assert.equal(detail.status, 200);
    assert.ok((detail.body.badges ?? []).includes('forked'),
      'L2 must not be silent about a session L1 tags forked (same contested-msgId source, one helper)');
  }
});

// ---------------------------------------------------------------- ACC-2

test('ACC-2 — /api/session flags inheritedPending while the index builds, on the agg the chips actually read', async () => {
  const building = await buildCtx({
    status: { state: 'building', sessionsDone: 1, sessionsTotal: 2, bytesIndexed: 10, bytesTotal: 1000 },
  });
  const s = await startServer(building);
  try {
    const r = await getJson(`${s.url}/api/session/${SLUG}/${S1}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.r2, 'pending');
    assert.equal(r.body.forkPartners, null, 'canonicality is still undefined — withheld, not guessed');
    assert.equal(r.body.agg.inheritedPending, true,
      'the session payload itself carries the flag: buildChips is fed session aggs, never /api/index card aggs');
  } finally { await s.close(); }
});

test('ACC-2 — a resolved index carries no pending flag (the chip is not permanent)', async () => {
  const r = await getJson(`${srv.url}/api/session/${SLUG}/${S1}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.r2, 'resolved');
  assert.equal(r.body.agg.inheritedPending, undefined);
});

test('ACC-2 — addCostAgg OR\'s inheritedPending through a fold instead of dropping it', async () => {
  const { aggregate, addCostAgg } = await import('../server/ledger.mjs');
  const a = aggregate([], {});
  const b = aggregate([], {});
  b.inheritedPending = true;
  assert.equal(addCostAgg(a, b).inheritedPending, true, 'a parent scope still discloses the unresolved group under it');
  assert.equal(addCostAgg(b, a).inheritedPending, true, 'and it is symmetric');
  assert.equal(addCostAgg(a, a).inheritedPending, undefined, 'clean children stay clean — the flag is never invented');
  // the money invariants are untouched: the flag is OR'd, never summed
  assert.equal(addCostAgg(a, b).usd.total, 0);
  assert.equal(addCostAgg(a, b).requests, 0);
});

// ---------------------------------------------------------------- UI-6

test('UI-6 — /api/workflow ships a real cost aggregate and rowsSumToHeader on the PARTIAL envelope', async () => {
  const r = await getJson(`${srv.url}/api/workflow/${SLUG}/${S1}/${RUN}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, false);
  assert.ok(r.body.cost, 'the key the client reads is `cost` (workflow.mjs payload.cost), not `agg`');
  assert.equal(r.body.cost.requests, 1, 'the run\'s one agent transcript row');
  assert.ok(r.body.cost.usd.total > 0, 'a real figure, so the headline is not a permanent —');
  assert.equal(r.body.rowsSumToHeader, true, 'header (Σ per-agent aggregates) vs the independent priceRow row sum');
});

test('UI-6 — the COMPLETE envelope ships the same cost fields', async () => {
  const rel = `${SLUG}/${S1}/workflows/${RUN}.json`;
  // R7-1: the private store root, not the committed fixture store (see
  // tests/fixtures/api/helpers.mjs privateStoreRoot) — this transient write
  // broke the same file-census invariants COR-7's did.
  const abs = path.join(ctx.projectsDir, ...rel.split('/'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, JSON.stringify({ runId: RUN, workflowName: 'fixture', state: 'completed' }));
  const st = await fsp.stat(abs);
  ctx._internals.fileTable.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
  try {
    const r = await getJson(`${srv.url}/api/workflow/${SLUG}/${S1}/${RUN}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, true);
    assert.equal(r.body.record.workflowName, 'fixture');
    assert.equal(r.body.cost.requests, 1, 'the completed run reports its cost too');
    assert.equal(r.body.rowsSumToHeader, true);
  } finally {
    ctx._internals.fileTable.delete(rel);
    await fsp.rm(abs, { force: true });
  }
});

// ---------------------------------------------------------------- F58

test('F58 — the capped done event carries cap (the N the client prints), and so does a clean done', async () => {
  const root = path.join(os.tmpdir(), `lens-fix-r2-find-${process.pid.toString(36)}`);
  const slug = 'C--findcap';
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const id = 'ffffffff-ffff-4fff-8fff-fffffffffff5';
  const rel = `${slug}/${id}.jsonl`;
  const line = '{"type":"user","message":{"content":"hay"}}\n';
  await fsp.writeFile(path.join(root, slug, `${id}.jsonl`), line + line + line);
  const sessions = [{ slug, id, mainRel: rel, files: [rel] }];
  const fileTable = new Map([[rel, { size: line.length * 3, mtimeMs: 5 }]]);

  const capped = [];
  await runFind({
    projectsDir: root, sessions, fileTable, q: 'hay', re: false, caseSensitive: false,
    scope: { kind: 'store' }, cap: 2,
    emit: (ev, d) => capped.push({ ev, d }),
  });
  const doneCapped = capped.find((e) => e.ev === 'done');
  assert.equal(doneCapped.d.capped, true);
  assert.equal(doneCapped.d.cap, 2, 'the done event names the server\'s own cap');
  assert.ok(doneCapped.d.cursor, 'still resumable');

  const clean = [];
  await runFind({
    projectsDir: root, sessions, fileTable, q: 'hay', re: false, caseSensitive: false,
    scope: { kind: 'store' },
    emit: (ev, d) => clean.push({ ev, d }),
  });
  const doneClean = clean.find((e) => e.ev === 'done');
  assert.equal(doneClean.d.matches, 3);
  assert.equal(doneClean.d.cap, 500, 'the default cap rides every done — one field, one meaning');
  assert.ok(!doneClean.d.capped, 'not capped');

  await fsp.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- favicon

function rawFetch(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('favicon — /favicon.ico and /favicon.svg answer 200 with an inline SVG (the 404-per-page-load nit)', async () => {
  const router = createRouter();
  const fallback = createStaticHandler({
    webDir: path.join(os.tmpdir(), 'lens-fix-r2-no-web'),   // no favicon file on disk
    sharedDir: path.join(os.tmpdir(), 'lens-fix-r2-no-shared'),
  });
  const server = createHttpServer({ router, fallback });
  const addr = await listen(server, { port: 0, host: '127.0.0.1' });
  try {
    for (const p of ['/favicon.ico', '/favicon.svg']) {
      const r = await rawFetch(addr.port, p);
      assert.equal(r.status, 200, `${p} must not 404`);
      assert.equal(r.contentType, 'image/svg+xml');
      assert.ok(r.body.startsWith('<svg'), 'a real image body, dependency-free');
    }
    // the guard still 404s everything else
    const miss = await rawFetch(addr.port, '/favicon.png');
    assert.equal(miss.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
