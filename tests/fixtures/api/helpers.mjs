// Shared test harness for group D tests: stub ctx wiring (per the ctx
// contract documented in server/api.mjs), a real HTTP server on an
// ephemeral port, and an SSE stream collector.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRouter, createHttpServer, listen } from '../../../server/http.mjs';
import { createApi } from '../../../server/api.mjs';
import * as pricing from './stubs/pricing.mjs';
import * as ledger from './stubs/ledger.mjs';
import * as jsonl from './stubs/jsonl.mjs';
import { makeStore, STORE, SLUG, S1, S2, A1, A2, RUN } from './make-store.mjs';

export { pricing, ledger, jsonl, STORE, SLUG, S1, S2, A1, A2, RUN };

export async function walkStore(root) {
  const table = new Map();
  async function walk(abs, rel) {
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(abs, e.name), r);
      else {
        // R7-1: guard the stat exactly as server/audit.mjs:94 does. A file can
        // vanish between readdir and stat (a raced deletion); without this the
        // ENOENT escapes buildCtx() and takes down the before() hook of every
        // test file that imports this helper — the third symptom round 6 saw.
        let st;
        try { st = await fsp.stat(path.join(abs, e.name)); } catch { continue; }
        table.set(r, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(root, '');
  return table;
}

// R7-1 — a PRIVATE store root per test-file process.
//
// The committed tests/fixtures/api/store is a BASELINE, and audit-pathb's and
// fixes-audit's file-census self-checks walk it twice and assert the two
// censuses agree. Any test that wrote a transient file into that shared
// directory (COR-7's 16 MB big-download.bin, UI-6's workflow manifest) could
// land between those two walks under node --test's file-level parallelism and
// make the invariant correctly report disagreement — the documented "2 of 5
// runs drop one test" flake.
//
// Moving only the FILE does not work: resolveFileRef (server/api.mjs) 403s any
// path outside ctx.projectsDir, so the CTX ROOT is what has to move. Every
// server-backed test now gets its own copy (9 small files, once per process),
// which makes the committed store read-only for them and makes this class of
// bug unreachable rather than merely absent.
let storeRootPromise = null;
export function privateStoreRoot() {
  if (!storeRootPromise) {
    storeRootPromise = (async () => {
      await makeStore();
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-api-'));
      await fsp.cp(STORE, root, { recursive: true });
      process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
      return root;
    })();
  }
  return storeRootPromise;
}

const T = (s) => Date.parse(`2026-08-01T${s}.000Z`);

export function fixtureRows() {
  const base = {
    thinkingTokens: null, webSearch: 0, webFetch: 0, speed: 'standard', serviceTier: 'standard',
    ttl: 'recorded', finalized: true, synthetic: false, billedElsewhere: null, iterIndex: 0,
    cacheRead: 0, cache5m: 0, cache1h: 0, cacheFlat: 0,
  };
  const s1 = [
    { ...base, msgId: 'msg_AAA', model: 'claude-fable-5', input: 100, output: 50, cacheRead: 2000, cache1h: 1000, stopReason: 'end_turn', at: T('10:00:10'), file: `${S1}.jsonl`, line: 4 },
    { ...base, msgId: 'e3b0c442-98fc-4111-8111-aaaaaaaaaaaa', model: '<synthetic>', input: 0, output: 0, stopReason: 'stop_sequence', at: T('10:01:00'), file: `${S1}.jsonl`, line: 5, synthetic: true, finalized: false, iterIndex: null, speed: null, serviceTier: null },
    { ...base, msgId: 'msg_CCC', model: 'claude-fable-5', input: 10, output: 3, stopReason: 'end_turn', at: T('10:02:00'), file: `${S1}.jsonl`, line: 6, finalized: false, iterIndex: null, speed: null },
    { ...base, msgId: 'msg_DDD', model: 'claude-3-opus-20240229', input: 1000, output: 2000, stopReason: 'end_turn', at: T('10:03:00'), file: `${S1}.jsonl`, line: 8 },
    { ...base, msgId: 'msg_FFF', model: 'claude-fable-5', input: 10, output: 20, cacheRead: 500, cache5m: 100, stopReason: 'end_turn', at: T('10:00:30'), file: `subagents/agent-${A1}.jsonl`, line: 2 },
    { ...base, msgId: 'msg_GGG', model: 'claude-fable-5', input: 10, output: 10, stopReason: 'end_turn', at: T('10:05:00'), file: `subagents/workflows/${RUN}/agent-${A2}.jsonl`, line: 1 },
  ];
  const s2 = [
    { ...base, msgId: 'msg_AAA', model: 'claude-fable-5', input: 100, output: 50, cacheRead: 2000, cache1h: 1000, stopReason: 'end_turn', at: T('10:00:10'), file: `${S2}.jsonl`, line: 3 },
    { ...base, msgId: 'msg_EEE', model: 'claude-fable-5', input: 100, output: 100, webSearch: 1, stopReason: 'end_turn', at: T('12:00:30'), file: `${S2}.jsonl`, line: 5 },
    { ...base, msgId: 'msg_HHH', model: 'claude-fable-5', input: 10, output: 10, cacheFlat: 100, ttl: 'unrecorded', stopReason: 'end_turn', at: T('12:01:00'), file: `${S2}.jsonl`, line: 6 },
    { ...base, msgId: 'msg_III', model: 'claude-haiku-4-5-20251001', input: 5, output: 7, stopReason: 'end_turn', at: T('12:02:00'), file: `${S2}.jsonl`, line: 7, iterIndex: 0 },
    { ...base, msgId: 'msg_III', model: 'claude-fable-5', input: 6, output: 8, webSearch: 3, stopReason: 'end_turn', at: T('12:02:00'), file: `${S2}.jsonl`, line: 7, iterIndex: 1 },
  ];
  return { s1, s2 };
}

export async function buildCtx(overrides = {}) {
  const storeRoot = overrides.storeRoot ?? await privateStoreRoot();
  const fileTable = await walkStore(storeRoot);
  const allKeys = [...fileTable.keys()];
  const bytesOf = (keys) => keys.reduce((a, k) => a + fileTable.get(k).size, 0);
  const s1Files = allKeys.filter((k) => k === `${SLUG}/${S1}.jsonl` || k.startsWith(`${SLUG}/${S1}/`));
  const s2Files = allKeys.filter((k) => k === `${SLUG}/${S2}.jsonl`);
  const sessions = [
    { id: S1, slug: SLUG, mainRel: `${SLUG}/${S1}.jsonl`, files: s1Files, bytes: bytesOf(s1Files), fragmentDirs: [] },
    { id: S2, slug: SLUG, mainRel: `${SLUG}/${S2}.jsonl`, files: s2Files, bytes: bytesOf(s2Files), fragmentDirs: [] },
  ];
  if (overrides.extraPendingSession) {
    sessions.push({ id: '33333333-3333-4333-8333-333333333333', slug: SLUG, mainRel: null, files: [], bytes: 0, fragmentDirs: [] });
  }
  const card = (id, msgIds, startedAt) => ({
    v: 1, slug: SLUG, id, fingerprint: `fp-${id.slice(0, 4)}`, state: 'ok',
    title: `fixture ${id.slice(0, 4)}`, mainMsgIds: msgIds, startedAt,
    mainRel: `${SLUG}/${id}.jsonl`, bytes: 0, turnCount: 1, agentCount: id === S1 ? 2 : 0,
  });
  // cards are keyed by BARE sessionId — the one keying convention (SPEC §2)
  const cards = new Map([
    [S1, card(S1, ['msg_AAA', 'msg_CCC', 'msg_DDD'], T('10:00:00'))],
    [S2, card(S2, ['msg_AAA', 'msg_EEE', 'msg_HHH', 'msg_III'], T('11:59:00'))],
  ]);
  const rows = fixtureRows();
  const rowsBySession = new Map([
    [`${SLUG}/${S1}`, rows.s1],
    [`${SLUG}/${S2}`, rows.s2],
  ]);
  const details = new Map([
    [`${SLUG}/${S1}`, {
      slug: SLUG, id: S1,
      turns: [
        { idx: 0, preamble: true, at: null, endedAt: null },
        { idx: 1, preamble: false, at: T('10:00:00'), endedAt: T('10:05:00'), promptHead: 'NEEDLE_ALPHA please build the thing', agentIds: [A1, A2], workflowRunIds: [RUN], lineRange: [1, 8] },
      ],
      agents: [
        { agentId: A1, turnIdx: 1, meta: { agentType: 'claude' }, rows: [{ line: 1, kind: 'prompt', head: 'agent fixture prompt' }, { line: 2, kind: 'text', head: 'agent answer' }] },
        { agentId: A2, turnIdx: 1, meta: { agentType: 'claude' }, rows: [{ line: 1, kind: 'text', head: 'workflow agent answer' }] },
      ],
      workflows: [{ runId: RUN }],
      mainRows: [{ line: 2, kind: 'prompt', head: 'NEEDLE_ALPHA please build the thing' }, { line: 4, kind: 'text', head: 'the NEEDLE_ALPHA result is ready' }],
      problems: [],
    }],
    [`${SLUG}/${S2}`, {
      slug: SLUG, id: S2,
      turns: [
        { idx: 0, preamble: true, at: null, endedAt: null },
        { idx: 1, preamble: false, at: T('10:00:00'), endedAt: T('12:02:00'), promptHead: 'NEEDLE_ALPHA please build the thing', agentIds: [], workflowRunIds: [] },
      ],
      agents: [], workflows: [], mainRows: [], problems: [],
    }],
  ]);

  let version = overrides.version ?? 7;
  const status = overrides.status ?? {
    state: 'ready', sessionsDone: 2, sessionsTotal: sessions.length, bytesIndexed: 1000, bytesTotal: 1000,
  };
  const { PendingError } = await import('../../../server/errors.mjs');
  const need = (key) => {
    if (!rowsBySession.has(key)) {
      throw new PendingError({ retryAfterMs: 1000, bytesIndexed: status.bytesIndexed, bytesTotal: status.bytesTotal });
    }
  };
  const index = {
    version: () => version,
    status: () => status,
    workerAlive: overrides.workerAlive ?? (() => true),
    fileTable: () => fileTable,
    projects: () => [{ slug: SLUG, sessionIds: [S1, S2], memoryFiles: ['notes.md'], bytes: bytesOf(allKeys) }],
    sessions: () => sessions,
    cards: () => cards,
    pending: () => sessions.filter((s) => !cards.has(s.id)).map((s) => ({ slug: s.slug, id: s.id })),
    detail: async (slug, id) => { const k = `${slug}/${id}`; need(k); return details.get(k) ?? null; },
    rows: async (slug, id) => { const k = `${slug}/${id}`; need(k); return rowsBySession.get(k); },
    agentRows: async (slug, id, agentId, { from = 0, count = 300 } = {}) => {
      const k = `${slug}/${id}`; need(k);
      const d = details.get(k);
      if (!d) return null;
      if (agentId === 'main') {
        return { agentId: 'main', rows: d.mainRows.slice(from, from + count), total: d.mainRows.length, from, count };
      }
      const a = d.agents.find((x) => x.agentId === agentId);
      if (!a) return null;
      return { agentId, meta: a.meta, rows: a.rows.slice(from, from + count), total: a.rows.length, from, count };
    },
    turnBars: () => [
      { slug: SLUG, id: S1, idx: 1, at: T('10:00:00'), endedAt: T('10:05:00') },
      { slug: SLUG, id: S2, idx: 1, at: T('10:00:00'), endedAt: T('12:02:00') },
    ],
    reindex: async () => { version += 1; },
    ...(overrides.index ?? {}),
  };

  return {
    appName: 'Claude Playback Lens',
    appVersion: 'test',
    projectsDir: storeRoot, // R7-1: the private copy, never the committed store
    projectsDirSource: 'fixture',
    webDir: path.join(storeRoot, '..', 'no-web'),
    sharedDir: path.join(storeRoot, '..', 'no-shared'),
    pricing, ledger, jsonl,
    config: overrides.config ?? null,
    heartbeatMs: overrides.heartbeatMs ?? 15000,
    index,
    _internals: { rowsBySession, cards, sessions, details, fileTable, bumpVersion: () => { version += 1; } },
  };
}

export async function startServer(ctx) {
  const router = createRouter();
  createApi(router, ctx);
  const server = createHttpServer({ router });
  const addr = await listen(server, { port: 0, host: '127.0.0.1' });
  return {
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

export async function getJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { unparseable: text }; }
  return { status: r.status, body, headers: r.headers };
}

// raw request with a forged Host header (fetch forbids setting Host)
export function rawGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Collects a whole SSE stream: returns { events: [{event, data}], comments: [str], raw }
export function sseCollect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, events: [], comments: [], raw: Buffer.concat(chunks).toString('utf8') }));
        return;
      }
      let raw = '';
      res.on('data', (c) => { raw += c.toString('utf8'); });
      res.on('end', () => {
        const events = [];
        const comments = [];
        for (const frame of raw.split('\n\n')) {
          if (!frame.trim()) continue;
          let ev = null, data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) comments.push(line.slice(1).trim());
            else if (line.startsWith('event: ')) ev = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (ev !== null) {
            let parsed = null;
            try { parsed = JSON.parse(data); } catch { parsed = data; }
            events.push({ event: ev, data: parsed });
          }
        }
        resolve({ status: 200, events, comments, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
