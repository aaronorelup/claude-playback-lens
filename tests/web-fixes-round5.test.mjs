// tests/web-fixes-round5.test.mjs — named regression tests for the round-5 fix
// pass. One test per fix id; the fake DOM mirrors tests/web-fixes-round1.test.mjs
// (no dependencies allowed).
//
// R5-1: every image block on the four content paths printed "recorded base64
// length: length not recorded by the reader for this block" while the SAME PAGE
// printed "1 heavy span(s) replaced by the reader before parsing: base64 44,128
// chars" fifteen lines lower. The reader measures the payload on the way past
// (server/jsonl.mjs stripHeavy) and /api/line ships it on `blobs[]`; renderBlock
// was never handed the payload, so it structurally could not look the value up
// and read three keys (source.dataLength / source.length / file.base64Length)
// that nothing in the codebase ever writes.

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * fake document (same shape as web-fixes-round1.test.mjs)
 * ------------------------------------------------------------------ */

// The fake DOM itself lives in tests/helpers/fake-dom.mjs (shared by every
// web test file); it is installed here, BEFORE the web modules are imported.
import { doc } from './helpers/fake-dom.mjs';

globalThis.document = doc;

/* ------------------------------------------------------------------ *
 * imports AFTER the fake document exists
 * ------------------------------------------------------------------ */

const L5 = await import('../web/js/views/l5.mjs');
const WF = await import('../web/js/views/workflow.mjs');
const { stripHeavy, b64Bytes } = await import('../server/jsonl.mjs');
const { imageBlobsByBi } = await import('../server/parse.mjs');

const el = () => doc.createElement('div');
const text = (n) => n.textContent;

/** Every unknown() reason on the page — they live in the title attribute. */
const reasonsOn = (root) => root.querySelectorAll('.lens-unknown').map((n) => n.getAttribute('title'));

/** Render-ctx stub: the same Proxy trick round 1 uses (never a thenable). */
function evCtx(params) {
  const stats = [];
  const base = {
    el: el(), stats, stale: false,
    params, query: new URLSearchParams(),
    banner: () => {},
    statbar: (props) => stats.push(props),
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (k === 'then' || typeof k === 'symbol' ? undefined : () => {})),
  });
}

const SLUG = 'C--Users-x-Round5';
const SID = '0000000a-0000-4000-8000-000000000009';
const REL = 'subagents/agent-a0000000000000002.jsonl';

/**
 * Drives the REAL renderEvent over stubbed /api/agent + /api/line responses.
 * A fresh agentId per call keeps l5's module-level rel cache from crossing
 * tests.
 */
async function renderEventPage(linePayload, { agentId, line = 24, bi = '0.0' }) {
  const ctx = evCtx({ slug: SLUG, sid: SID, agentId, line, bi });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.startsWith('/api/agent')
      ? { agentId, rel: REL, rows: [], total: 0, from: 0, count: 0, agg: null, problems: [] }
      : { slug: SLUG, id: SID, file: REL, line, ...linePayload };
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
  };
  try { await L5.renderEvent(ctx); } finally { globalThis.fetch = realFetch; }
  return ctx;
}

/* ================================================================== *
 * R5-1 — the L5 image block prints the length the reader recorded
 * ================================================================== */

// The live shape at
// /#/p/C--…-Claude-Playback-Lens/s/0000000a-…/a/a0000000000000002/e/24.0.0:
// one tool_result whose nested content[0] is a JPEG whose 44,128-char payload
// the reader stripped. `data: ""` is what JSON.parse sees; the length lives on
// blobs[].
const STRIPPED_IMAGE_LINE = {
  event: {
    parentUuid: 'p-1', isSidechain: true, type: 'user',
    message: {
      role: 'user',
      content: [{
        tool_use_id: 'toolu_01A000000000000000000001', type: 'tool_result',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '' } },
          { type: 'text', text: 'Screenshot size: 490x415' },
        ],
      }],
    },
    uuid: 'u-1', timestamp: '2026-08-17T07:07:59.000Z',
  },
  blobs: [{ kind: 'base64', key: 'data', length: 44128, bytes: 33095, head: '/9j/4AAQSkZJRgABAQAAAQAB' }],
  problems: [],
};

test('R5-1: the image block prints the recorded base64 length instead of claiming none was recorded', async () => {
  const ctx = await renderEventPage(STRIPPED_IMAGE_LINE, { agentId: 'a5100000000000001' });
  const pageText = text(ctx.el);

  assert.match(pageText, /recorded base64 length/, 'the fact is still on the page');
  assert.match(pageText, /44,128 chars/,
    'the exact length /api/line ships on blobs[] — the same number the raw-JSON note prints below it');
  assert.doesNotMatch(pageText, /length not recorded by the reader for this block/,
    'the false claim of absence that fired on 100% of image blocks');
  assert.ok(!reasonsOn(ctx.el).includes('length not recorded by the reader for this block'),
    'and not tucked into an unknown() reason either');

  // the raw-JSON note that contradicted it is still there — same page, same number
  assert.match(pageText, /1 heavy span\(s\) replaced by the reader before parsing: base64 44,128 chars/,
    'the note whose presence made the claim of absence self-refuting');
});

test('R5-1: the decoded byte count rides along and is NOT the char count', async () => {
  const ctx = await renderEventPage(STRIPPED_IMAGE_LINE, { agentId: 'a5100000000000002' });
  const pageText = text(ctx.el);
  assert.match(pageText, /32\.3 KB decoded/,
    '44,128 base64 chars decode to 33,095 bytes — printing chars where bytes are labelled overstates by ~33%');
});

test('R5-1: a payload with NO blobs still renders unknown, with a reason that is true', async () => {
  const ctx = await renderEventPage({ ...STRIPPED_IMAGE_LINE, blobs: [] }, { agentId: 'a5100000000000003' });
  const why = reasonsOn(ctx.el);
  assert.ok(why.includes('no base64 span was stripped on this line'),
    'an unattributable length is unknown WITH a reason, never a number and never a bare "not recorded"');
  assert.doesNotMatch(text(ctx.el), /chars/, 'and no length is invented');
});

test('R5-1: blobs the reader cannot attribute to this block address say exactly that', async () => {
  // two stripped spans, one addressable image block: the counts do not match,
  // so nothing is attributed — and the reason states the recorded situation.
  const twoSpans = {
    ...STRIPPED_IMAGE_LINE,
    blobs: [
      { kind: 'base64', key: 'data', length: 44128, bytes: 33095, head: '/9j/4AAQ' },
      { kind: 'base64', key: 'data', length: 9000, bytes: 6750, head: 'iVBORw0K' },
    ],
  };
  const ctx = await renderEventPage(twoSpans, { agentId: 'a5100000000000004' });
  const why = reasonsOn(ctx.el);
  assert.ok(why.some((r) => /stripped 2 base64 span\(s\) on this line but cannot attribute one to this block address/.test(r)),
    'the honest middle case: spans exist, this address is not resolvable to one of them');
  assert.ok(!why.includes('length not recorded by the reader for this block'),
    'still never the claim that the reader recorded nothing');
});

test('R5-1: an UNSTRIPPED payload (under the 500-char threshold) reports its own length from the block', async () => {
  const small = 'A'.repeat(120);
  const ctx = await renderEventPage({
    event: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: small } }] },
      uuid: 'u-2', timestamp: '2026-08-17T07:07:59.000Z',
    },
    blobs: [],
    problems: [],
  }, { agentId: 'a5100000000000005', bi: '0' });
  assert.match(text(ctx.el), /120 chars/, 'SPEC §1 never strips a payload this small — the length is on the node');
});

/* ------------------------------------------ the server side of the join */

test('R5-1: imageBlobsByBi attributes by KEY first, then by serialization order', () => {
  const ev = {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '' } },
        ],
      }],
    },
    toolUseResult: { file: { base64: '' } },
  };
  const blobs = [
    { kind: 'base64', key: 'data', length: 100, bytes: 75, head: 'iVBORw0K' },
    { kind: 'base64', key: 'data', length: 200, bytes: 150, head: '/9j/4AAQ' },
    { kind: 'base64', key: 'base64', length: 300, bytes: 225, head: 'iVBORw0K' },
    { kind: 'signature', key: 'signature', length: 999, bytes: null, head: null },
  ];
  const got = imageBlobsByBi(ev, blobs);
  assert.equal(got.get('0.0').length, 100);
  assert.equal(got.get('0.1').length, 200);
  assert.equal(got.get('r').length, 300,
    'the sidecar takes the `base64`-keyed blob, never a content block\'s `data` blob');
  assert.equal(got.size, 3, 'and the signature span is not an image payload');
});

test('R5-1: imageBlobsByBi attributes nothing when a key group\'s counts disagree', () => {
  const ev = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'image', source: { data: '' } }, { type: 'image', source: { data: '' } }] },
  };
  const one = imageBlobsByBi(ev, [{ kind: 'base64', key: 'data', length: 100, bytes: 75, head: 'x' }]);
  assert.equal(one.size, 0, 'two blocks, one span — guessing which is which would be inference');
});

test('R5-1: imageBlobsByBi follows the RECORDED top-level key order, not enumeration order', () => {
  const content = [{ type: 'image', source: { data: '' } }];
  const tur = [{ type: 'image', source: { data: '' } }];
  const blobs = [
    { kind: 'base64', key: 'data', length: 11, bytes: 8, head: 'a' },
    { kind: 'base64', key: 'data', length: 22, bytes: 16, head: 'b' },
  ];
  // message first on the wire
  const a = imageBlobsByBi({ type: 'user', message: { content }, toolUseResult: tur }, blobs);
  assert.equal(a.get('0').length, 11);
  assert.equal(a.get('r.0').length, 22);
  // toolUseResult first on the wire — stripHeavy scanned it first, so it owns
  // the first span
  const b = imageBlobsByBi({ type: 'user', toolUseResult: tur, message: { content } }, blobs);
  assert.equal(b.get('r.0').length, 11);
  assert.equal(b.get('0').length, 22);
});

/* ================================================================== *
 * R5-DOCS-4 — the workflow envelope's discriminator is `complete`
 * ================================================================== */

const WF_RUN = 'wf_r5000001-abc';

async function renderRun(payload) {
  const stats = [];
  const base = {
    el: el(), stats, stale: false,
    params: { slug: SLUG, sid: SID, runId: WF_RUN }, query: new URLSearchParams(),
    banner: () => {}, statbar: (p) => stats.push(p),
  };
  const ctx = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (k === 'then' || typeof k === 'symbol' ? undefined : () => {})),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) });
  try { await WF.renderWorkflow(ctx); } finally { globalThis.fetch = realFetch; }
  return ctx;
}

test('R5-DOCS-4: `complete` decides the envelope — a run the server calls in-flight renders in-flight', async () => {
  // The old test was `payload.partial === true || !manifest`. `payload.partial`
  // is a key the server has never sent, so the only live half was the
  // `!manifest` fallback — meaning an envelope carrying a record but flagged
  // complete: false rendered as a finished run. The discriminator is now the
  // field the server actually sends.
  const ctx = await renderRun({
    slug: SLUG, id: SID, runId: WF_RUN, complete: false,
    record: { runId: WF_RUN, workflowName: 'build', status: 'running', workflowProgress: [] },
    agents: [], journal: [], cost: null, rowsSumToHeader: null, problems: [],
  });
  assert.match(text(ctx.el), /Partial envelope/,
    'complete: false is the server saying the manifest was not read — the page says so too');
});

test('R5-DOCS-4: complete === false still renders the in-flight envelope', async () => {
  const ctx = await renderRun({
    slug: SLUG, id: SID, runId: WF_RUN, complete: false,
    journal: [], script: null, agents: [], cost: null, rowsSumToHeader: null,
    note: 'in-flight run: no workflow record yet; envelope from journal + script + transcripts',
    problems: [],
  });
  assert.match(text(ctx.el), /no wf_\*\.json yet/, 'the partial branch is unchanged');
});

test('R5-DOCS-4: the client reads no envelope key the server does not send', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../web/js/views/workflow.mjs', import.meta.url), 'utf8');
  for (const dead of ['payload.partial', 'payload.manifest', 'payload.wf']) {
    assert.ok(!src.includes(dead), `${dead} is never sent by /api/workflow (SPEC §9)`);
  }
});

test('R5-1: stripHeavy records the decoded byte count alongside the char count', () => {
  // 44,128 base64 chars with one '=' of padding is a 33,095-byte JPEG — the
  // figure /api/image serves as Content-Length.
  const payload = '/9j/4AAQSkZJRgABAQAAAQAB' + 'A'.repeat(44128 - 24 - 1) + '=';
  const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { data: payload } }] } });
  const { blobs } = stripHeavy(line);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].length, 44128, 'the recorded base64 length is unchanged');
  assert.equal(blobs[0].bytes, 33095, 'and the decoded size is exact arithmetic on it, padding included');
  assert.equal(b64Bytes('QQ=='), 1);
  assert.equal(b64Bytes('QUJD'), 3);
  assert.equal(b64Bytes('QUJDRA'), 4, 'unpadded base64url decodes the same way');
});
