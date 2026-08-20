// tests/fixes-round10.test.mjs — named regressions for the round-10 fix pass.
// One group per validated finding id:
//
//   R10-S1 (server/summary.mjs, web/js/views/l2.mjs — BLOCKER)
//       parse.mjs fully parses SPEC §3's seven metadata types, but the
//       summariser copied only four of them onto its payloads: meta.mode,
//       meta.prLinks and meta.frameLinks never left the parser, and no route
//       emitted them. l2.mjs's facts strip, finding the fields absent,
//       rendered the POSITIVE DENIAL "no mode event recorded" / "no pr-link
//       event recorded" / "no frame-link event recorded" — on a corpus that
//       records 1,532 mode, 241 pr-link and 14 frame-link events, i.e. on
//       roughly three of every four sessions. Worse, the SAME payload carried
//       inventory.perType {"pr-link":36,"mode":2}, which inv.mjs prints as
//       "events by type" — the app contradicting itself inside one response.
//       The fields ride the DETAIL (rebuilt every read), never the card
//       (serialised into index.json), and the COUNT ships beside the list
//       because the parser dedupes items and counts events: the reproducing
//       session is 36 pr-link events over 1 unique PR.
//
//   R10-F1 (lens.mjs — main())
//       With `--port 0` the server bound a real OS-assigned ephemeral port but
//       `port` was never updated from server.address(), so the printed line and
//       `openBrowser(url)` both named http://127.0.0.1:0/ — an address nothing
//       is listening on — while the app was up somewhere else.
//
//   R10-F2 (server/api.mjs config routes, web/js/views/settings.mjs)
//       PUT /api/config wrote config.json and returned {saved:true}; the page
//       then said "the indexer is re-reading the store." It is not: nothing
//       re-points the running indexer, and POST /api/reindex does not rescue
//       it either — only a restart does, and only when --projects /
//       CLAUDE_PROJECTS is not outranking config.json. GET /api/config also
//       shipped top-level `projectsDir` (active) and `config.projectsDir`
//       (saved) with no labels, so after a save it stated two different
//       directories in one payload while claiming projectsDirSource:'config'.
//
//   R10-S2 (server/parse.mjs — case 'system')
//       `head(ev.error ?? ev.content ?? sub)` String()s its argument, and on
//       every subtype:'api_error' event ev.error is the SDK error OBJECT, so
//       126 corpus-wide turn-row previews read the literal "[object Object]"
//       instead of the recorded "Unable to connect to API (ECONNRESET)".

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createIndexState } from '../lens.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import { buildCtx, startServer, getJson } from './fixtures/api/helpers.mjs';
import * as L2 from '../web/js/views/l2.mjs';
// The browser half of R10-S1/R10-F2 (l2.sessionFacts' three states, the
// settings copy) lives in tests/web-fixes-round10.test.mjs — server-side
// findings in fixes-round*, browser-side in web-fixes-round*.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const J = JSON.stringify;
const MODS = { pricing, ledger, jsonl, parse, scan, summary };

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage, makeUser, asstStd as asst } from './fixtures/api/make-store.mjs';
const user = makeUser("C:\\r10\\proj");

/** A real createIndexState wired to the real group A/B modules (round-8 harness). */
async function realIndexOver(storeDir) {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r10-cache-'));
  const idx = createIndexState({ projectsDir: storeDir, cacheDir, mods: MODS, restartDebounceMs: 30 });
  const table = await scan.scanStore(storeDir);
  const groups = scan.groupSessions(table);
  const S = idx._test.state;
  S.fileTable = table;
  S.projects = groups.projects;
  S.sessions = groups.sessions;
  S.bytesTotal = groups.sessions.reduce((a, s) => a + (s.bytes ?? 0), 0);
  S.state = 'ready';
  S.version += 1;
  return { idx, cacheDir };
}

function serveIndex(storeDir, idx) {
  return startServer({
    appName: 'lens-r10', appVersion: 'test',
    projectsDir: storeDir, projectsDirSource: 'fixture',
    webDir: path.join(storeDir, 'no-web'), sharedDir: path.join(storeDir, 'no-shared'),
    pricing, ledger, jsonl, config: null, index: idx,
  });
}

/* ==================================================================== R10-S1 */

describe('R10-S1 — mode / pr-link / frame-link are recorded facts and must reach the client', () => {
  // The reproducing session, reproduced byte-for-byte in its recorded shape:
  // C--Users-userx/0000000a-0000-4000-8000-000000000008 carries 36 `pr-link`
  // lines (all naming PR #1 of octocat/demo-repo — first at
  // file line 167, last at 912) and 2 `mode` lines (mode:"normal"). frame-link
  // is added here from the corpus's own recorded shape (14 events, 2 files).
  const SLUG = 'C--r10-meta';
  const SID = '0000000a-0000-4000-8000-000000000008';
  const FRAG = 'ffffffff-0000-4000-8000-00000000000f'; // session with no main tier
  const PR_URL = 'https://github.com/octocat/demo-repo/pull/1';
  const PR_REPO = 'octocat/demo-repo';
  const PR_EVENTS = 36;
  const MODE_EVENTS = 2;

  let storeDir, srv, idx, detail, card, payload;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r10-meta-'));
    await fsp.mkdir(path.join(storeDir, SLUG), { recursive: true });
    const lines = [
      user({ sid: SID, uuid: 'u1', at: '2026-08-11T22:00:00.000Z', text: 'open a PR for the rebuild' }),
      asst({ sid: SID, uuid: 'a1', at: '2026-08-11T22:01:00.000Z', msgId: 'msg_R10A', text: 'on it' }),
      J({ type: 'ai-title', sessionId: SID, aiTitle: 'Rebuilding the lens' }),
      J({ type: 'ai-title', sessionId: SID, aiTitle: 'Rebuilding the lens, again' }),
      J({ type: 'custom-title', sessionId: SID, customTitle: 'the rebuild' }),
    ];
    // 36 pr-link events, ONE unique PR — the exact recorded ratio.
    for (let i = 0; i < PR_EVENTS; i++) {
      lines.push(J({ type: 'pr-link', sessionId: SID, prNumber: 1, prUrl: PR_URL, prRepository: PR_REPO, timestamp: '2026-08-11T22:22:32.727Z' }));
    }
    for (let i = 0; i < MODE_EVENTS; i++) lines.push(J({ type: 'mode', sessionId: SID, mode: 'normal' }));
    // 3 frame-link events, 2 unique frames — same dedupe-vs-count shape.
    lines.push(J({ type: 'frame-link', sessionId: SID, frameUrl: 'https://x/y', path: '/y', title: 'a frame' }));
    lines.push(J({ type: 'frame-link', sessionId: SID, frameUrl: 'https://x/y', path: '/y', title: 'a frame' }));
    lines.push(J({ type: 'frame-link', sessionId: SID, frameUrl: 'https://x/z', path: '/z', title: 'another frame' }));
    await fsp.writeFile(path.join(storeDir, SLUG, `${SID}.jsonl`), lines.join('\n') + '\n', 'utf8');

    // A fragment session: a session directory with no `<id>.jsonl` main tier.
    await fsp.mkdir(path.join(storeDir, SLUG, FRAG), { recursive: true });
    await fsp.writeFile(path.join(storeDir, SLUG, FRAG, 'notes.md'), 'no main tier here\n', 'utf8');

    ({ idx } = await realIndexOver(storeDir));
    srv = await serveIndex(storeDir, idx);
    detail = await idx.detail(SLUG, SID);
    card = idx.cards().get(SID);
    payload = (await getJson(`${srv.url}/api/session/${SLUG}/${SID}`)).body;
  });
  after(async () => {
    await srv?.close();
    await idx?.close?.();
    try { await fsp.rm(storeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('summarise() puts all three metadata types on the DETAIL, each with its count', () => {
    assert.equal(detail.mode, 'normal', 'the recorded mode value, not silence');
    assert.equal(detail.modeCount, MODE_EVENTS);
    assert.deepEqual(detail.prLinks, [{ prNumber: 1, prRepository: PR_REPO, prUrl: PR_URL }]);
    assert.equal(detail.prLinkCount, PR_EVENTS);
    assert.equal(detail.frameLinks.length, 2, 'items are deduped by frameUrl');
    assert.equal(detail.frameLinkCount, 3, 'the count is every event');
    // collateral in the same six lines: both title counts were dropped too
    assert.equal(detail.aiTitleCount, 2);
    assert.equal(detail.customTitleCount, 1);
    for (const [items, count] of [['prLinks', 'prLinkCount'], ['frameLinks', 'frameLinkCount']]) {
      assert.ok(detail[count] >= detail[items].length, `${count} >= ${items}.length`);
    }
  });

  test('the count is the EVENT count, never the deduped item count (36 events, 1 PR)', () => {
    assert.equal(detail.prLinks.length, 1);
    assert.equal(detail.prLinkCount, 36);
    const pr = L2.sessionFacts(detail).find((f) => f.key === 'pr');
    assert.equal(pr.counts[0].n, 36, 'shipping items alone would have printed 1 where 36 were recorded');
  });

  test('/api/session ships them to the WIRE — the payload was the failure, not the renderer', () => {
    for (const k of ['mode', 'modeCount', 'prLinks', 'prLinkCount', 'frameLinks', 'frameLinkCount', 'aiTitleCount', 'customTitleCount']) {
      assert.ok(k in payload, `/api/session must carry ${k}`);
    }
    assert.equal(payload.mode, 'normal');
    assert.equal(payload.prLinkCount, PR_EVENTS);
    assert.equal(payload.prLinks[0].prUrl, PR_URL);
    // the self-contradiction the finding named: the census and the facts strip
    // are now two views of one fact, not two answers to one question
    assert.equal(payload.inventory.perType['pr-link'], PR_EVENTS);
    assert.equal(payload.inventory.perType.mode, MODE_EVENTS);
  });

  test('the recorded PR link reaches the client shape as a real link', () => {
    const facts = L2.sessionFacts(payload);
    const pr = facts.find((f) => f.key === 'pr');
    assert.deepEqual(pr.links, [{ href: PR_URL, label: `${PR_REPO}#1`, title: PR_URL }]);
    assert.equal(pr.source, 'pr-link events');
    assert.equal(pr.reason, null);
    const mode = facts.find((f) => f.key === 'mode');
    assert.equal(mode.display, 'normal');
    assert.equal(mode.source, 'mode (latest in file order)');
    const frame = facts.find((f) => f.key === 'frame');
    assert.equal(frame.links.length, 2);
    assert.equal(frame.counts[0].n, 3);
    // the exact strings the live browser printed before the fix
    for (const f of [pr, mode, frame]) {
      assert.doesNotMatch(String(f.source), /no (pr-link|mode|frame-link) event recorded/);
    }
  });

  test('a fragment session ships null — unknown, never a recorded zero', async () => {
    const fdetail = await idx.detail(SLUG, FRAG);
    assert.ok(fdetail, 'the fragment session summarises');
    assert.equal(fdetail.state, 'fragment');
    for (const k of ['mode', 'modeCount', 'prLinks', 'prLinkCount', 'frameLinks', 'frameLinkCount', 'aiTitleCount', 'customTitleCount']) {
      assert.equal(fdetail[k], null, `${k} must be null on a session with no main tier, not 0/[]`);
    }
    // and the client must not turn that unknown into a denial
    const facts = L2.sessionFacts(fdetail);
    for (const key of ['mode', 'pr', 'frame']) {
      const f = facts.find((x) => x.key === key);
      assert.match(f.source, /not recorded in this payload/, `${key} source`);
      assert.doesNotMatch(f.source, /event recorded$/, `${key} must not deny an unparsed fact`);
    }
  });

  test('the CARD is untouched, so no INDEX_VERSION bump is owed', () => {
    // Cards are serialised into index.json and restored verbatim
    // (index-store.mjs serialize/loadIndexVerbose). A new field there would be
    // present on freshly-parsed sessions and absent on cache-restored ones
    // inside one /api/index response. detail is rebuilt on every read.
    for (const k of ['mode', 'modeCount', 'prLinks', 'prLinkCount', 'frameLinks', 'frameLinkCount', 'aiTitleCount', 'customTitleCount']) {
      assert.equal(k in card, false, `the persisted card must NOT carry ${k}`);
    }
    assert.equal(card.v, 4, 'CARD_V unchanged — the card shape did not change');
  });
});

/* ==================================================================== R10-S2 */

describe('R10-S2 — an api_error preview is the recorded error text, never "[object Object]"', () => {
  const SLUG = 'C--r10-syserr';
  const SID = 'ee000000-0000-4000-8000-000000000001';
  let storeDir, model;

  before(async () => {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r10-sys-'));
    await fsp.mkdir(path.join(storeDir, SLUG), { recursive: true });
    const lines = [
      user({ sid: SID, uuid: 'u1', at: '2026-08-01T10:00:00.000Z', text: 'go' }),
      // the real recorded shape, off the reproducing session's line 137
      J({
        type: 'system', subtype: 'api_error', level: 'error', sessionId: SID,
        timestamp: '2026-08-01T10:00:01.000Z', uuid: 's1',
        error: {
          message: 'Connection error.',
          formatted: 'Unable to connect to API (ECONNRESET)',
          connection: { code: 'ECONNRESET' }, isNetworkDown: false, rateLimits: null,
        },
        retryInMs: 516,
      }),
      // formatted absent -> message is the next recorded string
      J({
        type: 'system', subtype: 'api_error', level: 'error', sessionId: SID,
        timestamp: '2026-08-01T10:00:02.000Z', uuid: 's2',
        error: { message: 'Overloaded.', connection: { code: 'ETIMEDOUT' } },
      }),
      // neither -> stringify, never fall silent about a recorded fact
      J({
        type: 'system', subtype: 'api_error', level: 'error', sessionId: SID,
        timestamp: '2026-08-01T10:00:03.000Z', uuid: 's3', error: {},
      }),
      // the unaffected siblings, kept so the change is provably scoped
      J({ type: 'system', subtype: 'stop_hook_summary', level: 'info', sessionId: SID, timestamp: '2026-08-01T10:00:04.000Z', uuid: 's4' }),
      J({ type: 'system', subtype: 'model_refusal_fallback', level: 'warning', sessionId: SID, timestamp: '2026-08-01T10:00:05.000Z', uuid: 's5', content: 'fell back to sonnet' }),
      asst({ sid: SID, uuid: 'a1', at: '2026-08-01T10:00:06.000Z', msgId: 'msg_R10S2', text: 'done' }),
    ];
    await fsp.writeFile(path.join(storeDir, SLUG, `${SID}.jsonl`), lines.join('\n') + '\n', 'utf8');
    const groups = scan.groupSessions(await scan.scanStore(storeDir));
    const entry = groups.sessions.find((s) => s.id === SID);
    model = await parse.parseSession(entry, { projectsDir: storeDir });
  });
  after(async () => { try { await fsp.rm(storeDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const rowAt = (line) => model.main.rows.find((r) => r.line === line);

  test('error.formatted is the preview — not "[object Object]"', () => {
    const r = rowAt(2);
    assert.equal(r.kind, 'system:api_error');
    assert.equal(r.head, 'Unable to connect to API (ECONNRESET)');
    assert.notEqual(r.head, '[object Object]');
  });

  test('error.message is used when formatted is not recorded', () => {
    assert.equal(rowAt(3).head, 'Overloaded.');
  });

  test('an error object with neither formatted nor message is stringified, never silenced', () => {
    // the guard the validator added: undefined would make head() return '',
    // trading a wrong preview for silence about a recorded fact
    assert.equal(rowAt(4).head, '{}');
    assert.notEqual(rowAt(4).head, '');
  });

  test('the unaffected system subtypes are untouched (the fix is scoped to api_error)', () => {
    assert.equal(rowAt(5).kind, 'system:stop_hook_summary');
    assert.equal(rowAt(5).head, 'stop_hook_summary', 'no error and no content still falls back to the subtype name');
    assert.equal(rowAt(6).head, 'fell back to sonnet', 'a string content is still used verbatim');
  });

  test('no row in the parsed session reads "[object Object]"', () => {
    for (const r of model.main.rows) assert.notEqual(r.head, '[object Object]');
  });
});

/* ==================================================================== R10-F1 */

describe('R10-F1 — --port 0 prints the port it actually bound', () => {
  test('the URL the launcher prints answers /api/hello from the same process', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r10-port0-'));
    const projects = path.join(tmp, 'projects');
    await fsp.mkdir(projects, { recursive: true });
    const child = spawn(process.execPath, [path.join(REPO, 'lens.mjs'), '--serve', '--port', '0', '--projects', projects], {
      env: { ...process.env, LENS_CACHE_DIR: path.join(tmp, 'cache'), LENS_CONFIG_DIR: path.join(tmp, 'cfg') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    try {
      const line = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`lens never printed its URL; stdout was:\n${out}`)), 20000);
        const tick = setInterval(() => {
          const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
          if (m) { clearInterval(tick); clearTimeout(timer); resolve(m); }
          if (child.exitCode !== null) { clearInterval(tick); clearTimeout(timer); reject(new Error(`lens exited ${child.exitCode}: ${out}`)); }
        }, 25);
      });
      const printedPort = Number(line[1]);
      assert.notEqual(printedPort, 0, 'the printed URL must not name port 0 — nothing listens there');
      const r = await getJson(`http://127.0.0.1:${printedPort}/api/hello`);
      assert.equal(r.status, 200, 'the printed URL is the live server');
      assert.equal(r.body.app, 'Claude Playback Lens');
      assert.equal(r.body.pid, child.pid, 'and it is THIS process, not some other listener');
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
      try { await fsp.rm(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

/* ==================================================================== R10-F2 */

describe('R10-F2 — a config save is honest about not having been applied', () => {
  const ACTIVE = path.resolve(os.tmpdir(), 'lens-r10-active-projects');
  const SAVED = path.resolve(os.tmpdir(), 'lens-r10-saved-projects');
  let ctx, srv, written;

  const configStub = () => ({
    loadConfig: async () => ({ projectsDir: written ?? SAVED }),
    saveConfig: async (obj) => { written = obj.projectsDir; return { ok: true, path: 'config.json', config: obj, problem: null }; },
    validateDir: async (dir) => ({ ok: true, dir: path.resolve(dir), projects: 1, sessions: 1, bytes: 571, files: 1, truncated: false, tookMs: 1, problems: [] }),
    expandPath: (p) => (typeof p === 'string' && p.trim() ? path.resolve(p.trim()) : null),
  });

  before(async () => {
    ctx = await buildCtx({ config: configStub() });
    ctx.projectsDir = ACTIVE;
    ctx.projectsDirSource = 'config';
    ctx.cacheDir = path.resolve(os.tmpdir(), 'lens-r10-cache');
    srv = await startServer(ctx);
  });
  after(async () => { await srv?.close(); });

  test('PUT /api/config reports applied:false and names ACTIVE vs SAVED', async () => {
    written = undefined;
    const r = await getJson(`${srv.url}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectsDir: SAVED }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.saved, true);
    assert.equal(r.body.applied, false, 'the save did NOT take effect on this process');
    assert.equal(r.body.activeProjectsDir, ACTIVE);
    assert.equal(r.body.savedProjectsDir, SAVED);
    assert.equal(r.body.pendingRestart, true);
    assert.equal(r.body.preview.sessions, 1, 'the counts are nested under preview — the page reads them there');
  });

  test('GET /api/config no longer ships two contradicting projects directories', async () => {
    written = SAVED;
    const r = await getJson(`${srv.url}/api/config`);
    assert.equal(r.status, 200);
    const b = r.body;
    assert.equal(b.activeProjectsDir, ACTIVE, 'what this process serves');
    assert.equal(b.savedProjectsDir, SAVED, 'what config.json holds');
    assert.equal(b.pendingRestart, true);
    assert.equal(b.projectsDir, ACTIVE, 'the legacy alias is the ACTIVE dir, never the saved one');
    assert.equal(b.cacheDir, ctx.cacheDir, 'a value the server has always held is now reported');
    assert.equal(b.activeSource, 'config');
  });

  test('a saved value equal to the active one is not a pending restart', async () => {
    written = ACTIVE;
    const b = (await getJson(`${srv.url}/api/config`)).body;
    assert.equal(b.pendingRestart, false);
    // win32-aware, never a raw string compare
    written = process.platform === 'win32' ? ACTIVE.toUpperCase() : ACTIVE;
    assert.equal((await getJson(`${srv.url}/api/config`)).body.pendingRestart, false);
    written = SAVED;
  });

  test('when --projects / CLAUDE_PROJECTS outranks config.json, the payload says so', async () => {
    for (const [src, flag] of [['arg', '--projects'], ['env', 'CLAUDE_PROJECTS']]) {
      ctx.projectsDirSource = src;
      const b = (await getJson(`${srv.url}/api/config`)).body;
      assert.equal(b.savedOutrankedBy, flag, `activeSource ${src}`);
      assert.equal(b.activeSource, src);
    }
    ctx.projectsDirSource = 'config';
    assert.equal((await getJson(`${srv.url}/api/config`)).body.savedOutrankedBy, null);
  });
});
