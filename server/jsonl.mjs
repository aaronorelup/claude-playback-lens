// server/jsonl.mjs — the \n-only JSONL reader (SPEC §1).
//
// Format facts this module encodes (all measured, docs/research/_digest.md):
// - Lines split on \n (0x0A) ONLY. node:readline also splits on raw U+2028/U+2029,
//   which are legal inside JSON strings and present in this corpus (12+ occurrences);
//   readline manufactures parse failures in a corpus with ZERO genuinely torn lines.
// - Bytes after the final \n are held back (live files append whole lines; a prefix
//   is a valid transcript).
// - Trailing \r is stripped from the decoded text if present (none observed).
// - Lines up to ~2 MB must be routine (max observed 1.37 MB).
// - Files start with '{' (no BOM observed); a UTF-8 BOM is tolerated and flagged.
// - Line numbers are 1-BASED at every exported boundary. The single 0-based
//   conversion in the whole app lives inside this module.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { OFFSET_TABLE_CAP as TABLE_CAP, RANGE_BYTE_BUDGET } from './limits.mjs';

const NL = 0x0a;
const CR = 0x0d;
const CHUNK = 1 << 20; // 1 MiB read granularity

// ---------------------------------------------------------------------------
// stripHeavy — replace base64 payloads (>=500 chars, keys "data"/"base64") and
// thinking "signature" values (>=100 chars) with "" BEFORE JSON.parse, recording
// each removed blob's kind and length. Images are 61.7% of corpus bytes and
// signatures another 4.5% (SPEC §1); stripping is what makes the corpus parseable.
//
// blobs[] entries additionally carry { key, head, bytes } (additive to the
// contract shape): `key` is which JSON key held the payload
// ('data'|'base64'|'signature'), `head` is the first 24 base64 chars (18 decoded
// bytes) so callers can sniff magic bytes for the media_type-less
// toolUseResult.file.base64 shape (SPEC §8) without re-reading the file, and
// `bytes` is the DECODED byte count of a base64 payload (null on signatures,
// which are opaque tokens, not an encoding of anything we can size).
//
// `length` and `bytes` are different facts and both are kept: 44,128 base64
// chars decode to 33,095 bytes, so reporting chars where a byte count is
// labelled overstates by ~33%. The conversion is exact arithmetic on the
// recorded string (4 chars -> 3 bytes, minus the '=' padding actually present),
// computed here because the padding is only visible before the value is
// replaced with "".
// ---------------------------------------------------------------------------
// Char class is base64 + base64url ONLY (`_-`); dots are not base64 in any
// alphabet and admitting them stripped long dotted "data" values the audit's
// independent stripper (audit.mjs stripHeavyB) keeps. The two strippers stay
// separately written (SPEC §10 independence) but encode the same classes.
const HEAVY_RE = /"(data|base64|signature)":\s*"([A-Za-z0-9+/=_-]{100,})"/g;

/** Decoded byte count of a base64 string — exact, padding-aware (SPEC §1). */
export function b64Bytes(value) {
  if (typeof value !== 'string') return null;
  let n = value.length;
  while (n > 0 && value.charCodeAt(n - 1) === 0x3d /* '=' */) n -= 1;
  return Math.floor((n * 3) / 4);
}

export function stripHeavy(lineText) {
  const blobs = [];
  if (lineText.length < 120 || (!lineText.includes('"data"') && !lineText.includes('"base64"') && !lineText.includes('"signature"'))) {
    return { text: lineText, blobs };
  }
  const text = lineText.replace(HEAVY_RE, (match, key, value) => {
    const isSig = key === 'signature';
    const min = isSig ? 100 : 500;
    if (value.length < min) return match; // below threshold — leave untouched
    blobs.push({
      kind: isSig ? 'signature' : 'base64',
      key,
      length: value.length,
      bytes: isSig ? null : b64Bytes(value),
      head: isSig ? null : value.slice(0, 24),
    });
    return `"${key}":""`;
  });
  return { text, blobs };
}

// ---------------------------------------------------------------------------
// readLines — async generator over complete lines of a file.
// Yields { text, line (1-based), byteOffset, bytes, bom? }.
//   byteOffset = byte position of the line's first byte in the file.
//   bytes      = raw byte length of the line content EXCLUDING the \n terminator
//                (a trailing \r, if any, is counted in bytes but stripped from text).
//   bom        = true on line 1 only, when a UTF-8 BOM was found (stripped from text).
// The unterminated tail (bytes after the final \n) is NEVER yielded.
// ---------------------------------------------------------------------------
export async function* readLines(absPath) {
  const stream = fs.createReadStream(absPath, { highWaterMark: CHUNK });
  let buf = Buffer.alloc(0);
  let fileOffset = 0; // byte offset of buf[0] in the file
  let lineNo = 0;
  let first = true;
  try {
    for await (const chunk of stream) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let start = 0;
      let nl;
      while ((nl = buf.indexOf(NL, start)) !== -1) {
        let end = nl;
        const rawBytes = end - start;
        if (end > start && buf[end - 1] === CR) end -= 1;
        let text = buf.toString('utf8', start, end);
        lineNo += 1;
        let bom = false;
        if (first) {
          first = false;
          if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); bom = true; }
        }
        const out = { text, line: lineNo, byteOffset: fileOffset + start, bytes: rawBytes };
        if (bom) out.bom = true;
        yield out;
        start = nl + 1;
      }
      if (start > 0) {
        fileOffset += start;
        buf = buf.subarray(start);
      }
    }
  } finally {
    stream.destroy();
  }
  // whatever remains in buf is the unterminated tail — held back by design
}

// ---------------------------------------------------------------------------
// Offset tables. offsets is a number[] of length total+1:
//   offsets[k]     = byte offset of the START of 1-based line k+1   (k in 0..total-1)
//   offsets[total] = byte offset just past the final \n (start of any held-back tail)
// total = number of COMPLETE (\n-terminated) lines. bytes = file size at scan time.
// Tables are cached per absPath and extended incrementally when a live file grows
// (append-only); a shrunk/replaced file triggers a full rebuild.
// Measured: ~14 KB table per 38 MB file, <1 ms seek-read afterwards.
// ---------------------------------------------------------------------------
// Bounded: offset tables are cheap (~14 KB / 38 MB file) but the map must not
// grow without limit across a large corpus's lifetime — oldest entries are
// dropped once TABLE_CAP (limits.mjs) is reached (rebuild cost on a re-visit
// is one newline scan). Map iteration order is insertion order; touch()
// refreshes recency.
const tables = new Map(); // absPath -> { offsets:number[], total, bytes, mtimeMs }

function rememberTable(absPath, table) {
  if (tables.has(absPath)) tables.delete(absPath);
  tables.set(absPath, table);
  while (tables.size > TABLE_CAP) {
    const oldest = tables.keys().next().value;
    tables.delete(oldest);
  }
  return table;
}

async function scanNewlines(absPath, fromByte, toByte, offsets) {
  // appends line-start offsets found in [fromByte, toByte) to offsets
  const fh = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = fromByte;
    while (pos < toByte) {
      const want = Math.min(CHUNK, toByte - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      let i = -1;
      while ((i = buf.indexOf(NL, i + 1)) !== -1 && i < bytesRead) {
        offsets.push(pos + i + 1);
      }
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return offsets;
}

export async function buildOffsetTable(absPath) {
  const st = await fsp.stat(absPath);
  const offsets = [0];
  await scanNewlines(absPath, 0, st.size, offsets);
  const table = { offsets, total: offsets.length - 1, bytes: st.size, mtimeMs: st.mtimeMs };
  return rememberTable(absPath, table);
}

async function getTable(absPath) {
  const st = await fsp.stat(absPath);
  const cached = tables.get(absPath);
  // size AND mtime must both match: a same-size in-place rewrite changes
  // mtime, and serving the old offsets would seek into the wrong lines.
  if (cached && cached.bytes === st.size && cached.mtimeMs === st.mtimeMs) {
    return rememberTable(absPath, cached); // recency touch
  }
  if (cached && st.size > cached.bytes) {
    // live append: extend from the previous tail start
    const offsets = cached.offsets;
    await scanNewlines(absPath, offsets[offsets.length - 1], st.size, offsets);
    const table = { offsets, total: offsets.length - 1, bytes: st.size, mtimeMs: st.mtimeMs };
    return rememberTable(absPath, table);
  }
  return buildOffsetTable(absPath);
}

/** Forget a cached offset table (for LRU eviction by the index layer). */
export function dropOffsetTable(absPath) {
  tables.delete(absPath);
}

/** Test seam: how many offset tables are cached (bounded by TABLE_CAP). */
export function offsetTableCount() {
  return tables.size;
}

// A BOM is a FILE prefix, so only line 1 can legitimately carry one — and
// every reader in this module must agree about identical bytes: readLines()
// strips inside `if (first)` and flags bom:true, and decodeLine applies the
// same rule, or the indexer and /api/line|/api/lines would classify the same
// line differently (a BOM-prefixed line 2 is corrupt data, returned exactly
// as recorded). `isFirstLine` must be computed PER LINE by the caller (in a
// window starting at line 1, only k === 1 qualifies), not per call.
function decodeLine(buf, isFirstLine) {
  let end = buf.length;
  if (end > 0 && buf[end - 1] === CR) end -= 1;
  let text = buf.toString('utf8', 0, end);
  if (isFirstLine && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

// readFull — loop fh.read until the buffer is filled or EOF; a single read()
// call may legally return fewer bytes than asked. Returns bytes actually read.
async function readFull(fh, buf, start) {
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, start + done);
    if (bytesRead <= 0) break; // early EOF (file shrank under us)
    done += bytesRead;
  }
  return done;
}

// readLineAt — raw text of 1-based line `line1`, or null when out of range
// (the API layer maps null to 404). Builds/extends the offset table as needed.
export async function readLineAt(absPath, line1) {
  const r = await readLineAtWithBom(absPath, line1);
  return r === null ? null : r.text;
}

// readLineAtWithBom — the same read, plus the one fact readLineAt has to
// swallow to keep its string return: `bom` is true when line 1 carried a UTF-8
// BOM that was stripped (readLines() reports the same fact as `bom: true`).
// ADDITIVE export: the BOM strip is the single remaining transform this reader
// performs on the recorded bytes, so it is a fact the reader is owed rather
// than something to do silently. Never true for line > 1 — a BOM there is not
// a BOM, it is corrupt data, and the line is returned exactly as recorded.
export async function readLineAtWithBom(absPath, line1) {
  const t = await getTable(absPath);
  if (!Number.isInteger(line1) || line1 < 1 || line1 > t.total) return null;
  const start = t.offsets[line1 - 1];
  const end = t.offsets[line1] - 1; // strip the \n terminator
  const fh = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const got = await readFull(fh, buf, start);
    if (got < buf.length) return null; // early EOF: treat as out of range, never a torn decode
    const first = line1 === 1;
    const text = decodeLine(buf, first);
    const bom = first && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    return { text, bom };
  } finally {
    await fh.close();
  }
}

// readLineRange — { from, count, total, lines:[raw], bom }; `total` is re-derived from a
// fresh stat on every call (live files grow, SPEC §9 /api/lines). The window is
// clamped to [1, total]; an unsatisfiable window returns count 0 with the current
// total so the caller can 416.
//
// `bom` is the same fact readLineAtWithBom reports — true when the window
// ACTUALLY RETURNED line 1 and line 1's recorded bytes began with a UTF-8
// BOM that decodeLine stripped. It is a fact about the window, not the file:
// a window starting at line 2 reports false even on a BOM'd file, and a
// from===1 window that returned no lines (the file shrank under the read)
// reports false too — announcing a strip the caller never received is the same
// lie inverted. Sniffed from the RAW BYTES, because by the time the text
// exists the byte is already gone.
// RANGE_BYTE_BUDGET (limits.mjs) bounds one window read: routine ~2 MB lines
// must pass (SPEC §1), but a crafted/grown corpus must not coerce a single
// ~1 GB allocation (500 × 2 MB). At least one line is always returned; the
// caller sees the smaller `count` and pages on.

export async function readLineRange(absPath, from1, count) {
  const t = await getTable(absPath);
  const from = Math.max(1, Math.trunc(from1) || 1);
  const n = Math.max(0, Math.trunc(count) || 0);
  let last = Math.min(t.total, from + n - 1);
  const lines = [];
  let bom = false;
  if (t.total > 0 && from <= t.total && n > 0) {
    const start = t.offsets[from - 1];
    // shrink the window tail until it fits the byte budget (min one line)
    while (last > from && t.offsets[last] - start > RANGE_BYTE_BUDGET) last -= 1;
    const end = t.offsets[last]; // includes final \n; per-line slices strip it
    const fh = await fsp.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      const got = await readFull(fh, buf, start);
      const usable = start + got;
      for (let k = from; k <= last; k++) {
        if (t.offsets[k] > usable) break; // early EOF: stop at the last complete line
        const a = t.offsets[k - 1] - start;
        const b = t.offsets[k] - 1 - start;
        // AFTER the early-EOF break, so the flag only ever describes a line the
        // caller was actually handed.
        if (k === 1 && b - a >= 3 && buf[a] === 0xef && buf[a + 1] === 0xbb && buf[a + 2] === 0xbf) bom = true;
        lines.push(decodeLine(buf.subarray(a, b), k === 1));
      }
    } finally {
      await fh.close();
    }
  }
  return { from, count: lines.length, total: t.total, lines, bom };
}
