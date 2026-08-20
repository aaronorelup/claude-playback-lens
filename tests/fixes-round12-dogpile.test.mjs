// tests/fixes-round12-dogpile.test.mjs — the R12-F1 named regression.
//
//   R12-F1 (lens.mjs — ensureParsed() / ensureModel())
//       Neither had an in-flight promise cache. ensureParsed's
//       `if (S.rowsStore.has(id)) return` and parseOne's fingerprint
//       early-return are both POST-write guards, so the
//       `await parseSession(...)` window itself was unguarded — and nothing
//       upstream serialises, since createHttpServer awaits each handler
//       independently. N requests reaching a never-yet-parsed session each ran
//       a full parse of the same file. The cold window is the NORMAL case, not
//       an edge: the worker never ships rows, so every session is row-cold on
//       first open even while /api/index reports state:"ready". Reached by
//       ordinary use — two browser tabs, a refresh mid-load (aborting the
//       fetch does not cancel the server-side parse), or two of the several
//       per-session routes racing.
//
// This file lives apart from tests/fixes-round12.test.mjs because it needs a
// process-level fixture: a REAL createIndexState over REAL mods and a REAL
// listening server, so the race is the shipped one rather than a model of it.
// The only instrumentation is a counting wrapper around parse.parseSession —
// no logic is changed, and the count is the assertion.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createIndexState } from '../lens.mjs';
import { createRouter, createHttpServer, listen } from '../server/http.mjs';
import { createApi } from '../server/api.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import * as config from '../server/config.mjs';
import * as store from '../server/index-store.mjs';
import * as lru from '../server/lru.mjs';

const SLUG = 'C--r12-dogpile';
const SID = 'b1210000-0000-4000-8000-000000000001';
// A SECOND cold session, so the /api/agent race can be run against a session
// nothing has warmed — the first one is warm the moment test 1 finishes.
const SID2 = 'b1210000-0000-4000-8000-000000000002';
const J = JSON.stringify;

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage } from './fixtures/api/make-store.mjs';

/** A session big enough that a parse is not instantaneous — the race window
 *  has to be real, not a lucky single tick. */
function sessionLines(sid, turns) {
  const lines = [];
  const pad = 'x'.repeat(400);
  for (let i = 0; i < turns; i++) {
    const at = new Date(Date.UTC(2026, 7, 1, 10, 0, i)).toISOString();
    lines.push(J({
      parentUuid: null, isSidechain: false, type: 'user', uuid: `u${i}`,
      timestamp: at, sessionId: sid, origin: { kind: 'human' }, cwd: 'C:\\r12\\proj',
      message: { role: 'user', content: `request ${i} ${pad}` },
    }));
    lines.push(J({
      parentUuid: null, isSidechain: false, type: 'assistant', uuid: `a${i}`,
      timestamp: at, sessionId: sid,
      message: {
        id: `msg_${sid.slice(0, 4)}${i}`, model: 'claude-fable-5', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: `answer ${i} ${pad}` }],
        stop_reason: 'end_turn', usage: usage(100, 50),
      },
    }));
  }
  return lines.join('\n') + '\n';
}

/** N genuinely concurrent GETs — all sockets opened before any is awaited. */
function raceGet(port, pathname, n) {
  const one = () => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  return Promise.all(Array.from({ length: n }, one));
}

describe('R12-F1 — concurrent requests to a COLD session run exactly one parse', () => {
  const N = 5;
  let projectsDir, cacheDir, index, server, port;
  let parseCount = 0;
  let peakConcurrent = 0;
  let live = 0;

  before(async () => {
    projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r12-dog-proj-'));
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r12-dog-cache-'));
    await fsp.mkdir(path.join(projectsDir, SLUG), { recursive: true });
    await fsp.writeFile(path.join(projectsDir, SLUG, `${SID}.jsonl`), sessionLines(SID, 400), 'utf8');
    await fsp.writeFile(path.join(projectsDir, SLUG, `${SID2}.jsonl`), sessionLines(SID2, 400), 'utf8');

    // The ONLY instrumentation: count parses and watch how many overlap.
    const countingParse = {
      ...parse,
      parseSession: async (...args) => {
        parseCount += 1;
        live += 1;
        if (live > peakConcurrent) peakConcurrent = live;
        try { return await parse.parseSession(...args); } finally { live -= 1; }
      },
    };

    index = createIndexState({
      projectsDir, cacheDir,
      mods: { pricing, ledger, jsonl, parse: countingParse, scan, summary, config, store, lru },
    });
    await index.start();

    const ctx = {
      appName: 'lens-test', appVersion: '0', projectsDir, projectsDirSource: 'arg',
      cacheDir, webDir: projectsDir, sharedDir: projectsDir,
      pricing, ledger, jsonl, config, index,
    };
    const router = createRouter();
    createApi(router, ctx);
    server = createHttpServer({ router });
    port = (await listen(server, { port: 0, host: '127.0.0.1' })).port;

    // Wait for the WORKER to publish this session's card. This is the precise
    // state the finding is about, and it is the state every ordinary first
    // open is in: /api/index says ready and findSession is satisfied, while
    // the main process holds NO rows for the session, because the worker never
    // ships rows. Everything from here is genuinely row-cold.
    const deadline = Date.now() + 60000;
    while (!index.cards().has(SID) || !index.cards().has(SID2)) {
      if (Date.now() > deadline) throw new Error('the indexer never produced cards for the fixture sessions');
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(parseCount, 0, 'the worker parses in its own thread — the main process has parsed nothing yet');
  });

  after(async () => {
    try { await new Promise((r) => server.close(r)); } catch { /* best effort */ }
    try { await index.close(); } catch { /* best effort */ }
    try { await fsp.rm(projectsDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { await fsp.rm(cacheDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test(`R12-F1: ${N} concurrent cold requests run ONE parse, not ${N}`, async () => {
    const before = parseCount;
    const results = await raceGet(port, `/api/session/${SLUG}/${SID}/`, N);

    // every caller is served — the fix must not turn a race into a 409/500
    for (const r of results) {
      assert.equal(r.status, 200, `every concurrent caller is served: got ${r.status} ${r.body.slice(0, 200)}`);
    }
    const ran = parseCount - before;
    assert.equal(ran, 1,
      `exactly one parse may run for ${N} concurrent cold requests — ${ran} ran, one full parse of the same file per caller`);
    assert.equal(peakConcurrent, 1,
      'and no two parses of this session may ever overlap — peak concurrency is the direct measure of the dogpile');
  });

  test('R12-F1: every racer gets the SAME answer, byte for byte', async () => {
    const results = await raceGet(port, `/api/session/${SLUG}/${SID}/`, N);
    const first = results[0].body;
    assert.ok(first.length > 0);
    for (const r of results) assert.equal(r.body, first, 'a joiner must receive the real parse result, not an empty shell');
  });

  test('R12-F1: the map does not wedge the session — a WARM request is still served, and parses zero times', async () => {
    // The map holds a .finally()-chained promise precisely so it cannot leak a
    // settled entry and strand the id. Once rows exist, ensureParsed's
    // post-write guard short-circuits before the map is ever consulted.
    const before = parseCount;
    const r = await raceGet(port, `/api/session/${SLUG}/${SID}`, 1);
    assert.equal(r[0].status, 200);
    assert.equal(parseCount, before,
      'a WARM session parses zero times — the post-write guards still do their job');
  });

  test(`R12-F1: ${N} concurrent /api/agent requests at a cold session also run ONE parse`, async () => {
    // /api/agent walks BOTH guarded paths — ensureParsed, then ensureModel's
    // parseOne(force:true), which carries the identical dogpile on an LRU miss
    // and gets its own map so the force semantics are never blurred. This runs
    // against the SECOND fixture session precisely because the first one is
    // warm by now; a warm session cannot demonstrate a cold-window race.
    const before = parseCount;
    peakConcurrent = 0;
    const results = await raceGet(port, `/api/agent/${SLUG}/${SID2}/main?from=0&count=5`, N);
    for (const r of results) assert.equal(r.status, 200, r.body.slice(0, 200));
    const ran = parseCount - before;
    assert.equal(ran, 1, `exactly one parse for ${N} concurrent cold agent requests — ${ran} ran`);
    assert.equal(peakConcurrent, 1, 'and no two overlapped');
  });
});
