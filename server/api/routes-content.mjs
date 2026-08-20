// server/api/routes-content.mjs — raw content routes: /api/line, /api/lines,
// /api/image, /api/file. Everything here serves recorded bytes; the only
// transforms are the disclosed BOM strip and the image media-type allowlist.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { httpError, problem } from '../errors.mjs';
import { sendJson } from '../http.mjs';
import { LINES_WINDOW_MAX } from '../limits.mjs';
import { intParam, strParam } from './params.mjs';
import { resolveFileRef } from './fileref.mjs';
import { requireIndex, findSession } from './session-lookup.mjs';

// /api/image is the ONE place in this tree where a byte read out of a
// transcript could become a response Content-Type. A transcript is UNTRUSTED
// INPUT (an imported/shared session is the stated use case), and a declared
// `text/html` or `image/svg+xml` served under this origin executes on a
// top-level "open image in new tab" navigation — which http.mjs
// originAllowed() permits, and no CSP is emitted anywhere. So the declared
// media_type is never used verbatim: it must name one of the four types the
// magic-byte sniffer itself recognises, or it is discarded and the bytes
// decide. SVG is deliberately absent — it is script-bearing.
// The allowlist is the fix; nosniff/Content-Disposition are defence in depth
// (nosniff does NOT stop a declared text/html on a navigation).
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function registerContentRoutes({ G }, ctx) {
  G('/api/line', async (_req, res, { query }) => {
    requireIndex(ctx);
    const slug = strParam(query, 'slug', { required: true });
    const id = strParam(query, 'id', { required: true });
    const file = strParam(query, 'file', { required: true });
    const line = intParam(query, 'line', { required: true, min: 1 }); // 1-based everywhere
    findSession(ctx, slug, id);
    const { abs } = resolveFileRef(ctx, { slug, id, rel: file });
    // readLineAtWithBom reports the one BOM strip this reader is allowed to
    // make (line 1 only), so the transform is DISCLOSED instead of silent. A
    // ctx.jsonl without it (test stubs) falls back to the plain read and
    // simply has no bom fact to report.
    let raw, bom = false;
    try {
      if (typeof ctx.jsonl.readLineAtWithBom === 'function') {
        const r = await ctx.jsonl.readLineAtWithBom(abs, line);
        raw = r === null || r === undefined ? null : r.text;
        bom = !!(r && r.bom);
      } else {
        raw = await ctx.jsonl.readLineAt(abs, line);
      }
    } catch { raw = null; }
    if (raw === null || raw === undefined) throw httpError(404, 'unknown-line', `no line ${line} in ${file}`);
    const stripped = ctx.jsonl.stripHeavy(raw);
    let event = null;
    try { event = JSON.parse(stripped.text); } catch { /* torn line ships as raw text */ }
    const problems = [];
    if (event === null) {
      problems.push(problem('torn-line', { severity: 'error', scope: 'line', slug, id, file, line, message: 'line failed JSON.parse', affects: 'aggregates' }));
    }
    if (bom) {
      problems.push(problem('bom-stripped', { severity: 'note', scope: 'line', slug, id, file, line, message: 'line 1 begins with a UTF-8 BOM (EF BB BF); it was stripped before JSON.parse, exactly as the indexer strips it', affects: 'nothing' }));
    }
    sendJson(res, 200, {
      slug, id, file, line, bom,
      event, raw: event === null ? stripped.text : undefined,
      blobs: stripped.blobs ?? [],
      problems,
    });
  });

  G('/api/lines', async (_req, res, { query }) => {
    requireIndex(ctx);
    const slug = strParam(query, 'slug', { required: true });
    const id = strParam(query, 'id', { required: true });
    const file = strParam(query, 'file', { required: true });
    const from = intParam(query, 'from', { required: true, min: 1 });
    const count = intParam(query, 'count', { def: LINES_WINDOW_MAX, min: 1, max: LINES_WINDOW_MAX });
    findSession(ctx, slug, id);
    const { abs } = resolveFileRef(ctx, { slug, id, rel: file });
    const win = await ctx.jsonl.readLineRange(abs, from, count); // total re-stat'd per request
    if (!win || from > win.total) {
      throw httpError(416, 'window-unsatisfiable', `from=${from} is past the end (total ${win ? win.total : 0})`);
    }
    // /api/lines reads the identical bytes through the identical
    // decodeLine(buf, k===1) strip that /api/line discloses, and this
    // endpoint's product is billed to the reader as raw JSONL — so it
    // discloses the same fact, in the same shape. `bom` is emitted
    // UNCONDITIONALLY (false when the window excludes line 1, or line 1
    // carries no BOM) so the response shape does not move with the data. A
    // ctx.jsonl without the field (test stubs) simply reports false — there
    // is no fact to report.
    const bom = !!(win && win.bom);
    const problems = [];
    if (bom) {
      problems.push(problem('bom-stripped', {
        severity: 'note', scope: 'line', slug, id, file, line: 1,
        message: 'line 1 begins with a UTF-8 BOM (EF BB BF); it was stripped before JSON.parse, exactly as the indexer strips it',
        affects: 'nothing',
      }));
    }
    sendJson(res, 200, { slug, id, file, from: win.from, count: win.count, total: win.total, lines: win.lines, bom, problems });
  });

  G('/api/image', async (_req, res, { query }) => {
    requireIndex(ctx);
    const slug = strParam(query, 'slug', { required: true });
    const id = strParam(query, 'id', { required: true });
    const file = strParam(query, 'file', { required: true });
    const line = intParam(query, 'line', { required: true, min: 1 });
    const block = strParam(query, 'block', { required: true }); // dotted bi STRING (SPEC §8)
    findSession(ctx, slug, id);
    const { abs } = resolveFileRef(ctx, { slug, id, rel: file });
    let raw;
    try { raw = await ctx.jsonl.readLineAt(abs, line); } catch { raw = null; }
    if (raw === null || raw === undefined) throw httpError(404, 'unknown-line', `no line ${line} in ${file}`);
    let obj;
    try { obj = JSON.parse(raw); } catch { throw httpError(404, 'no-image', 'line is not parseable JSON'); }

    let source = null;
    const parts = block.split('.');
    if (parts[0] === 'r') {
      const tur = obj.toolUseResult;
      if (parts.length === 1) {
        if (tur && tur.file && typeof tur.file.base64 === 'string') source = { data: tur.file.base64, mediaType: null };
        else if (tur && tur.source && typeof tur.source.data === 'string') source = { data: tur.source.data, mediaType: tur.source.media_type ?? null };
      } else if (parts.length === 2 && Array.isArray(tur)) {
        const el = tur[Number(parts[1])];
        if (el && el.source && typeof el.source.data === 'string') source = { data: el.source.data, mediaType: el.source.media_type ?? null };
      }
    } else {
      const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : null;
      const i = Number(parts[0]);
      if (content && Number.isInteger(i)) {
        let b = content[i];
        if (parts.length === 2 && b && Array.isArray(b.content)) b = b.content[Number(parts[1])];
        if (b && b.source && typeof b.source.data === 'string') source = { data: b.source.data, mediaType: b.source.media_type ?? null };
      }
    }
    if (!source) throw httpError(404, 'no-image', `no image block at ${block}`);
    const buf = Buffer.from(source.data, 'base64');
    // The transcript's own media_type is a CLAIM, not a header. Strip
    // parameters, lowercase, reject non-strings, and require the allowlist —
    // which also disposes of a numeric media_type, a 20k-char one, and one
    // carrying CRLF, none of which can reach writeHead.
    const declared = typeof source.mediaType === 'string' ? source.mediaType.split(';')[0].trim().toLowerCase() : null;
    let mime = declared && IMAGE_MIME.has(declared) ? declared : null;
    if (!mime) { // no usable media_type — sniff magic bytes (SPEC §8). Runs
      // whenever the declared type is absent OR not allowlisted, so a
      // mislabelled-but-real PNG still renders: the app never hides a payload
      // it holds, it only refuses to be told what to call it.
      if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
      else if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
      else if (buf.length > 6 && buf.toString('latin1', 0, 4) === 'GIF8') mime = 'image/gif';
      else if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') mime = 'image/webp';
      else mime = 'application/octet-stream';
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': buf.length,
      'Content-Disposition': `inline; filename="image-${line}-${String(block).replace(/[^\w.]/g, '_')}.bin"`,
      'X-Content-Type-Options': 'nosniff', // SPEC §9: every response carries it
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(buf);
  });

  G('/api/file', async (req, res, { query }) => {
    requireIndex(ctx);
    const slug = strParam(query, 'slug', { required: true });
    const id = strParam(query, 'id'); // optional — absent resolves rel against the project dir
    const rel = strParam(query, 'rel', { required: true });
    const { abs } = resolveFileRef(ctx, { slug, id, rel });
    const st = await fsp.stat(abs);
    const range = req.headers.range;
    let start = 0, end = st.size - 1, status = 200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) throw httpError(416, 'bad-range', `unsatisfiable Range: ${range}`);
      if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); }
      else { start = Number(m[1]); end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1); }
      if (start > end || start >= st.size) throw httpError(416, 'bad-range', `unsatisfiable Range: ${range}`);
      status = 206;
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = { '.json': 'application/json; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8' }[ext] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff', // SPEC §9: every response carries it
      'Cache-Control': 'no-cache',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(status, headers);
    // stream with backpressure: pipe() honours res.write's return value and a
    // client that disconnects mid-download destroys the read stream — a 240 MB
    // transcript never accumulates in heap behind a slow/gone socket
    await new Promise((resolve) => {
      const s = fs.createReadStream(abs, { start, end });
      s.pipe(res);
      s.on('error', () => { try { res.destroy(); } catch { /* gone */ } resolve(); });
      s.on('end', resolve);
      res.on('close', () => { s.destroy(); resolve(); });
    });
  });
}
