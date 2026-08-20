// tests/fixes-round7.test.mjs — named regressions for the round-7 fix pass.
// One group per validated finding id:
//
//   R7-SEC-IMAGE-MEDIATYPE
//       /api/image passed a transcript's own `media_type` string straight into
//       res.writeHead as the Content-Type, with no allowlist — the sniffer only
//       ran when the field was absent. A transcript is UNTRUSTED INPUT (reading
//       a colleague's exported session is the app's stated use case), so a
//       crafted image block declaring text/html served executable HTML under
//       the app's own origin on the browser's "open image in new tab"
//       navigation, with no CSP and no nosniff anywhere on the response.
//
//   R7-HEAD-SURROGATE-TRUNCATION
//       parse.mjs head() sliced at 220 UTF-16 code UNITS, so an astral
//       character straddling the cut left a LONE surrogate in every row preview
//       /api/turn and /api/agent serve. Round 6 fixed the identical hazard in
//       find.mjs contextAround() and knowingly deferred this one.
//
//   R7-BOM-DECODELINE-ASYMMETRY
//       jsonl.mjs decodeLine() stripped a leading U+FEFF on EVERY line, while
//       readLines() (which every cost figure is built from) strips it on line 1
//       only. So a BOM-prefixed line 2/3 was excluded from the census as a torn
//       line while /api/line showed it cleanly parsed and /api/lines hid the
//       very byte that explained the exclusion — the reader's evidence deleted
//       behind their back, in an app whose one rule is disclose everything.
//
//   R7-1 (store-worker sub-item)
//       index-store.mjs createIndexWriter.pump() awaited the in-flight write
//       but never re-checked, so pumps queued behind one write all resumed
//       together and wrote the same fixed index.json.tmp concurrently; the
//       first rename won and the rest got ENOENT, reported as a spurious
//       `cache-write-failed`.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createIndexState } from '../lens.mjs';
import { createIndexWriter } from '../server/index-store.mjs';
import { readLineAt, readLineAtWithBom, readLineRange } from '../server/jsonl.mjs';
import * as pricing from '../shared/pricing.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import { startServer, getJson } from './fixtures/api/helpers.mjs';

const J = JSON.stringify;
const ts = (s) => `2026-08-01T${s}.000Z`;

// Shared JSONL row builders (bytes identical to the per-file copies they
// replaced) live in tests/fixtures/api/make-store.mjs.
import { usageStd as usage, makeUser } from './fixtures/api/make-store.mjs';
const user = makeUser("C:\\r7\\proj");

const asstBlocks = ({ sid, uuid, at, msgId, content }) => J({
  parentUuid: null, isSidechain: false, type: 'assistant', uuid, timestamp: at, sessionId: sid,
  message: {
    id: msgId, model: 'claude-fable-5', type: 'message', role: 'assistant',
    content, stop_reason: 'end_turn', usage: usage(100, 50),
  },
});
const imageBlock = (mediaType, data) => ({
  type: 'image',
  source: mediaType === undefined
    ? { type: 'base64', data }
    : { type: 'base64', media_type: mediaType, data },
});

/** A real 20-byte PNG prefix — enough for the magic-byte sniffer. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(12, 0x00),
]);
const PNG_B64 = PNG.toString('base64');
const HTML = '<html><body><script>document.title="R7-OWNED"</script>R7-XSS</body></html>';
const HTML_B64 = Buffer.from(HTML, 'utf8').toString('base64');

/** Boot a REAL index (real parse/ledger/summary/scan) over a crafted store. */
async function realIndexOver(store) {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r7-cache-'));
  const idx = createIndexState({
    projectsDir: store, cacheDir,
    mods: { pricing, ledger, jsonl, parse, scan, summary },
    restartDebounceMs: 30,
  });
  const table = await scan.scanStore(store);
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

/* ============================================ R7-SEC-IMAGE-MEDIATYPE */

describe('R7-SEC-IMAGE-MEDIATYPE — a transcript never names the response Content-Type', () => {
  const SLUG = 'C--r7-img';
  const SID = '77000000-0000-4000-8000-0000000000a1';
  let store, cacheDir, idx, srv, url;

  // line 2 blocks, by index (= the dotted `block` param /api/image takes)
  const B_HTML_DECLARED = 0;  // text/html declared, HTML bytes
  const B_PNG_DECLARED = 1;   // image/png declared, PNG bytes
  const B_PNG_MISLABELLED = 2; // text/html declared, REAL PNG bytes
  const B_SVG_DECLARED = 3;   // image/svg+xml declared (an image type, still refused)
  const B_NUMERIC = 4;        // media_type is the NUMBER 123
  const B_CRLF = 5;           // media_type carries a CRLF header-injection attempt

  before(async () => {
    store = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r7-img-'));
    const abs = path.join(store, SLUG, `${SID}.jsonl`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, [
      user({ sid: SID, uuid: 'r7-img-1', at: ts('10:00:00'), text: 'here is a screenshot' }),
      asstBlocks({
        sid: SID, uuid: 'r7-img-2', at: ts('10:00:10'), msgId: 'msg_R7IMG',
        content: [
          imageBlock('text/html; charset=utf-8', HTML_B64),
          imageBlock('image/png', PNG_B64),
          imageBlock('text/html', PNG_B64),
          imageBlock('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8').toString('base64')),
          imageBlock(123, PNG_B64),
          imageBlock('image/png\r\nX-Injected: yes', PNG_B64),
        ],
      }),
    ].join('\n') + '\n', 'utf8');

    ({ idx, cacheDir } = await realIndexOver(store));
    await idx.detail(SLUG, SID);
    srv = await startServer({
      appName: 'lens-r7', appVersion: 'test',
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

  const image = (block) =>
    fetch(`${url}/api/image?slug=${SLUG}&id=${SID}&file=${SID}.jsonl&line=2&block=${block}`);

  test('R7-SEC-IMAGE-MEDIATYPE — a transcript-declared text/html image serves with a SAFE type', async () => {
    const r = await image(B_HTML_DECLARED);
    assert.equal(r.status, 200, 'the payload is still served — the app never hides bytes it holds');
    const ct = r.headers.get('content-type');
    assert.equal(ct, 'application/octet-stream',
      'HTML bytes sniff as nothing, so the fallback is the inert type — NEVER the declared text/html');
    assert.ok(!/text\/html/.test(ct), 'a top-level "open image in new tab" must not execute in this origin');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', 'SPEC §9: every response carries it');
    assert.match(r.headers.get('content-disposition') ?? '', /^inline; filename="image-2-\d+\.bin"$/);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.toString('utf8'), HTML,
      'the bytes are unchanged — this fix relabels the response, it does not censor the transcript');
  });

  test('R7-SEC-IMAGE-MEDIATYPE — an allowlisted declared type is still honoured verbatim', async () => {
    const r = await image(B_PNG_DECLARED);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await r.arrayBuffer()).equals(PNG), true, 'byte-identical to the recorded payload');
  });

  test('R7-SEC-IMAGE-MEDIATYPE — a MISLABELLED but real PNG still renders (the sniffer is the fallback)', async () => {
    const r = await image(B_PNG_MISLABELLED);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png',
      'the sniffer runs whenever the declared type is not allowlisted, not only when it is absent');
  });

  test('R7-SEC-IMAGE-MEDIATYPE — image/svg+xml is refused even though it IS an image type', async () => {
    const r = await image(B_SVG_DECLARED);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream',
      'SVG is script-bearing on navigation, so it is deliberately outside the allowlist');
  });

  test('R7-SEC-IMAGE-MEDIATYPE — a non-string media_type cannot reach writeHead', async () => {
    const r = await image(B_NUMERIC);
    assert.equal(r.status, 200, 'no 500: a transcript data problem is not a server fault');
    assert.equal(r.headers.get('content-type'), 'image/png', 'the number is discarded and the bytes decide');
  });

  test('R7-SEC-IMAGE-MEDIATYPE — a CRLF media_type no longer reaches the header layer at all', async () => {
    const r = await image(B_CRLF);
    assert.equal(r.status, 200, 'this used to be an opaque 500 from Node rejecting the header char');
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-injected'), null, 'no header injection, and now no 500 either');
  });

  test('R7-SEC-IMAGE-MEDIATYPE — /api/file carries nosniff too (SPEC §9, the other omission)', async () => {
    const r = await fetch(`${url}/api/file?slug=${SLUG}&id=${SID}&rel=${SID}.jsonl`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    await r.arrayBuffer();
  });
});

/* ======================================= R7-HEAD-SURROGATE-TRUNCATION */

describe('R7-HEAD-SURROGATE-TRUNCATION — head() never cuts a surrogate pair in half', () => {
  const SLUG = 'C--r7-head';
  const SID = '77000000-0000-4000-8000-0000000000b1';
  const EMOJI = '\u{1F680}'; // U+1F680, one astral char = two UTF-16 code units
  let store;

  before(async () => {
    store = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r7-head-'));
    const abs = path.join(store, SLUG, `${SID}.jsonl`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // Offsets chosen so the pair STRADDLES the 220-unit cut: units 0..218 are
    // 'Z', unit 219 is the high surrogate, unit 220 the low one.
    const straddle = 'Z'.repeat(219) + EMOJI + 'Q'.repeat(40);
    const clean = 'Y'.repeat(230); // control: a plain truncation is untouched
    const whole = 'W'.repeat(218) + EMOJI + 'Q'.repeat(40); // pair sits fully INSIDE the head
    assert.equal(straddle.charCodeAt(219) >= 0xd800 && straddle.charCodeAt(219) <= 0xdbff, true,
      'precondition: unit 219 really is a high surrogate');
    await fsp.writeFile(abs, [
      user({ sid: SID, uuid: 'r7-h-1', at: ts('10:00:00'), text: 'go' }),
      asstBlocks({
        sid: SID, uuid: 'r7-h-2', at: ts('10:00:10'), msgId: 'msg_R7H',
        content: [
          { type: 'text', text: straddle },
          { type: 'text', text: clean },
          { type: 'text', text: whole },
        ],
      }),
    ].join('\n') + '\n', 'utf8');
  });

  after(async () => { await fsp.rm(store, { recursive: true, force: true }); });

  test('R7-HEAD-SURROGATE-TRUNCATION — an emoji at the boundary yields no lone surrogate', async () => {
    const table = await scan.scanStore(store);
    const entry = scan.groupSessions(table).sessions.find((s) => s.id === SID);
    const model = await parse.parseSession(entry, { projectsDir: store });
    // model.main.rows is exactly what noteRow() fills and what /api/turn serves.
    const heads = (model.main.rows ?? []).filter((r) => r.kind === 'text').map((r) => r.head);
    assert.equal(heads.length >= 3, true, `expected the three crafted text rows, saw ${heads.length}`);

    for (const h of heads) {
      assert.equal(h.isWellFormed(), true, `a row head must never carry a lone surrogate: ${J(h.slice(-4))}`);
    }
    const straddleHead = heads.find((h) => h.startsWith('Z'));
    assert.equal(straddleHead.length, 219, 'the cut backs off one unit rather than splitting the pair');
    assert.equal(straddleHead.endsWith('Z'), true, 'the half-emoji is dropped, not half-kept');

    const cleanHead = heads.find((h) => h.startsWith('Y'));
    assert.equal(cleanHead.length, 220, 'a plain ASCII truncation still cuts at exactly HEAD_MAX');

    const wholeHead = heads.find((h) => h.startsWith('W'));
    assert.equal(wholeHead.endsWith(EMOJI), true, 'a pair that fits entirely inside the head is kept whole');
    assert.equal(wholeHead.length, 220);
  });
});

/* ====================================== R7-BOM-DECODELINE-ASYMMETRY */

describe('R7-BOM-DECODELINE-ASYMMETRY — the two readers agree about the same bytes', () => {
  const SLUG = 'C--r7-bom';
  const SID = '77000000-0000-4000-8000-0000000000c1';
  const BOM = '\uFEFF';
  const BOM_LINE = 3;
  let store, cacheDir, idx, srv, url, absMain, absFirst;
  const SID1 = '77000000-0000-4000-8000-0000000000c2'; // BOM on line 1 (legitimate)

  before(async () => {
    store = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r7-bom-'));
    absMain = path.join(store, SLUG, `${SID}.jsonl`);
    absFirst = path.join(store, SLUG, `${SID1}.jsonl`);
    await fsp.mkdir(path.dirname(absMain), { recursive: true });
    // A hand-concatenated transcript: PowerShell's `cat a.jsonl b.jsonl > c`
    // writes UTF-8 WITH BOM, which is exactly how a BOM lands mid-file.
    await fsp.writeFile(absMain, [
      user({ sid: SID, uuid: 'r7-b-1', at: ts('10:00:00'), text: 'first' }),
      asstBlocks({ sid: SID, uuid: 'r7-b-2', at: ts('10:00:10'), msgId: 'msg_R7B1', content: [{ type: 'text', text: 'clean line two' }] }),
      BOM + asstBlocks({ sid: SID, uuid: 'r7-b-3', at: ts('10:00:20'), msgId: 'msg_R7B2', content: [{ type: 'text', text: 'BOMMED LINE THREE' }] }),
    ].join('\n') + '\n', 'utf8');
    await fsp.writeFile(absFirst, [
      BOM + user({ sid: SID1, uuid: 'r7-b1-1', at: ts('11:00:00'), text: 'bom on line one' }),
      asstBlocks({ sid: SID1, uuid: 'r7-b1-2', at: ts('11:00:10'), msgId: 'msg_R7B3', content: [{ type: 'text', text: 'ok' }] }),
    ].join('\n') + '\n', 'utf8');

    ({ idx, cacheDir } = await realIndexOver(store));
    await idx.detail(SLUG, SID);
    await idx.detail(SLUG, SID1);
    srv = await startServer({
      appName: 'lens-r7', appVersion: 'test',
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

  test('R7-BOM-DECODELINE-ASYMMETRY — a mid-file BOM line renders as the corrupt data it is', async () => {
    const raw = await readLineAt(absMain, BOM_LINE);
    assert.equal(raw.charCodeAt(0), 0xfeff, 'the recorded byte survives the read — nothing is stripped off line 3');
    assert.throws(() => JSON.parse(raw), 'and it fails JSON.parse exactly as the indexer found it to');

    const win = await readLineRange(absMain, 1, 3);
    assert.equal(win.lines.length, 3);
    assert.equal(win.lines[2].charCodeAt(0), 0xfeff,
      'a window that STARTS at line 1 must not strip lines 2..N — the per-line flag, not a per-call one');
    assert.notEqual(win.lines[0].charCodeAt(0), 0xfeff, 'line 1 of this file has no BOM to strip anyway');
  });

  test('R7-BOM-DECODELINE-ASYMMETRY — the inspector now agrees with the indexer it used to contradict', async () => {
    const detail = await idx.detail(SLUG, SID);
    const torn = (detail.problems ?? []).filter((p) => p.code === 'torn-line');
    assert.equal(torn.length >= 1, true, 'precondition: the indexer excludes the BOM line as torn');
    assert.equal(torn.some((p) => p.line === BOM_LINE), true, 'and names line 3');

    const r = await getJson(`${url}/api/line?slug=${SLUG}&id=${SID}&file=${SID}.jsonl&line=${BOM_LINE}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.event, null, 'the inspector no longer shows a clean parse of a line the census threw away');
    assert.equal(r.body.problems.some((p) => p.code === 'torn-line' && p.line === BOM_LINE), true,
      'the existing torn-line branch fires on its own once the readers agree');
    assert.equal(r.body.raw.charCodeAt(0), 0xfeff, 'and the raw view finally SHOWS the byte that explains it');

    const lines = await getJson(`${url}/api/lines?slug=${SLUG}&id=${SID}&file=${SID}.jsonl&from=${BOM_LINE}&count=1`);
    assert.equal(lines.status, 200);
    assert.equal(lines.body.lines[0].charCodeAt(0), 0xfeff, '/api/lines returns the raw byte too');
  });

  test('R7-BOM-DECODELINE-ASYMMETRY — line 1\'s BOM still strips, and the strip is DISCLOSED', async () => {
    const r1 = await readLineAtWithBom(absFirst, 1);
    assert.equal(r1.bom, true, 'the one legitimate BOM is reported, not swallowed');
    assert.notEqual(r1.text.charCodeAt(0), 0xfeff, 'and stripped, matching readLines()');
    assert.equal(typeof JSON.parse(r1.text), 'object', 'so line 1 still parses');
    assert.equal(await readLineAt(absFirst, 1), r1.text, 'readLineAt stays the same string it always was');

    const r = await getJson(`${url}/api/line?slug=${SLUG}&id=${SID1}&file=${SID1}.jsonl&line=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.bom, true);
    assert.ok(r.body.event, 'line 1 parses cleanly');
    assert.equal(r.body.problems.some((p) => p.code === 'bom-stripped' && p.severity === 'note'), true,
      'the transform the reader cannot see in the output is stated in the output');

    const other = await getJson(`${url}/api/line?slug=${SLUG}&id=${SID1}&file=${SID1}.jsonl&line=2`);
    assert.equal(other.body.bom, false);
    assert.deepEqual(other.body.problems, [], 'no BOM, no note — the flag is a fact, not decoration');
  });
});

/* =============================================== R7-1 (store-worker) */

describe('R7-1 — the index writer really serialises its writes', () => {
  let TMP;
  before(async () => { TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r7-writer-')); });
  after(async () => { await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {}); });

  test('R7-1 — pumps queued behind one in-flight write do not race on index.json.tmp', async () => {
    // Before the fix this printed [true, true, false] with ENOENT/rename on the
    // third: pump() awaited `inFlight` but never re-checked it, so every queued
    // pump resumed in the same microtask drain and they all wrote the ONE fixed
    // temp path. The first rename won; the rest renamed a file already gone,
    // which surfaced in tests/store-worker.test.mjs as a `cache-write-failed`
    // problem on a run where nothing was wrong.
    const problems = [];
    const w = createIndexWriter(path.join(TMP, 'cache'), {
      projectsDir: TMP, minIntervalMs: 10, onProblem: (p) => problems.push(p),
    });
    const card = (i) => ({ id: `card-${i}`, slug: 'p', fingerprint: `f${i}`, pad: 'x'.repeat(4000) });

    w.update(card(1));
    const a = w.flush();          // starts writing immediately (inFlight was null)
    w.update(card(2));
    const b = w.flush();          // queues behind a
    w.update(card(3));
    const c = w.flush();          // queues behind a as well — the collision
    const res = await Promise.all([a, b, c]);

    assert.deepEqual(res.map((r) => r.ok), [true, true, true], 'every flush lands');
    assert.deepEqual(res.map((r) => (r.error ? r.error.code : null)), [null, null, null]);
    assert.deepEqual(problems, [], 'and no spurious cache-write-failed is reported');
    assert.equal(w.stats.failures, 0);
    await w.close();

    const left = await fsp.readdir(path.join(TMP, 'cache'));
    assert.deepEqual(left, ['index.json'], 'no index.json.tmp survives a concurrent flush storm');
  });
});
