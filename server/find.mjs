// server/find.mjs — corpus substring/regex scan, streamed over SSE (group D).
//
// Scans sessions newest-first, file-ordered within (SPEC §9); the corpus is
// each line AFTER the same heavy-payload strip the reader uses, and the skip
// report states what was stripped. Matches resolve through parsed blocks to
// a real e/<line>[.<bi>] address; a match outside any block links to
// e/<line> with no block index — never a fabricated one.
//
// Reader/stripper come from server/jsonl.mjs (group B) per BUILD-CONTRACTS.
// audit.mjs keeps its own independent splitter by SPEC §10 mandate
// (tests/audit-independence.test.mjs).

import path from 'node:path';
import { readLines, stripHeavy } from './jsonl.mjs';
import { REGEX_LINE_CAP, FIND_MATCH_CAP } from './limits.mjs';

export { REGEX_LINE_CAP }; // re-exported: tests and the skip report cite it

function toB64Url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function fromB64Url(s) {
  try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); }
  catch { return null; }
}

// session-relative rel per the /api/file grammar (SPEC §9)
function sessionRel(session, relFromProjects) {
  const mainForm = `${session.slug}/${session.id}.jsonl`;
  if (relFromProjects === mainForm) return `${session.id}.jsonl`;
  const dirPrefix = `${session.slug}/${session.id}/`;
  if (relFromProjects.startsWith(dirPrefix)) return relFromProjects.slice(dirPrefix.length);
  // cross-project fragment file
  return `frag/${relFromProjects}`;
}

// REGEX_LINE_CAP (limits.mjs): rx.exec is synchronous and unabortable — it
// bounds the text a user regex can chew per line (substring search is linear
// and stays uncapped). Lines beyond the cap are matched on their prefix and
// COUNTED, disclosed in the skip report — bounded honesty, never a silent hang.
//
// The truncation tally lives at the CALL SITE, one increment per physical
// line, not one per match1() call — counting here would report a single
// oversized line twice the moment the per-block pass re-searches it. Counting
// outside also covers the block case for free: a block's decoded text can
// never exceed the JSON-encoded line that carries it, so an oversized block
// implies an already-counted oversized line.
//
// Unicode normalization, deliberately NARROW: a query composed in NFC (what a
// keyboard, a browser <input> and an IME all produce) must match text stored
// in NFD — 'café' as caf+U+00E9 vs caf+e+U+0301 are the same word and the
// same glyphs, and a clean `done {matches:0}` over them would be false.
//
// The QUERY is normalized here for the SUBSTRING path only. A regex `q` is
// pattern SYNTAX, not subject text — normalizing it would rewrite the pattern —
// so it is left exactly as typed. Both paths receive an already-NFC haystack
// from runFind (see `hay` there): normalizing at the CALL SITE, once, is what
// keeps `index` and the `ctx` snippet offsets in the same string. Never
// normalize inside this function: the returned index would then address a
// string the caller does not hold.
function makeMatcher({ q, re, caseSensitive }) {
  if (re) {
    const rx = new RegExp(q, caseSensitive ? 'g' : 'gi');
    return (text) => {
      const hay = text.length > REGEX_LINE_CAP ? text.slice(0, REGEX_LINE_CAP) : text;
      rx.lastIndex = 0;
      const m = rx.exec(hay);
      return m ? { index: m.index, length: Math.max(m[0].length, 1) } : null;
    };
  }
  const qn = q.normalize('NFC');
  const needle = caseSensitive ? qn : qn.toLowerCase();
  return (text) => {
    const hay = caseSensitive ? text : text.toLowerCase();
    const i = hay.indexOf(needle);
    // qn.length, not q.length: `index` addresses the NORMALIZED haystack, and an
    // NFD query is one code unit longer per combining mark — a raw q.length here
    // would over-run the match span and shift the emitted context window.
    return i === -1 ? null : { index: i, length: qn.length };
  };
}

// candidate block texts with their dotted bi (SPEC §8 grammar)
function* blockTexts(obj) {
  const msg = obj && obj.message;
  if (msg && Array.isArray(msg.content)) {
    for (let i = 0; i < msg.content.length; i++) {
      const b = msg.content[i];
      if (!b || typeof b !== 'object') continue;
      if (typeof b.text === 'string') yield { bi: `${i}`, text: b.text };
      if (typeof b.thinking === 'string') yield { bi: `${i}`, text: b.thinking };
      if (b.type === 'tool_use' && b.input !== undefined) yield { bi: `${i}`, text: JSON.stringify(b.input) };
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string') yield { bi: `${i}`, text: b.content };
        else if (Array.isArray(b.content)) {
          for (let j = 0; j < b.content.length; j++) {
            const sb = b.content[j];
            if (sb && typeof sb.text === 'string') yield { bi: `${i}.${j}`, text: sb.text };
          }
        }
      }
    }
  }
  const tur = obj && obj.toolUseResult;
  if (tur !== undefined && tur !== null) {
    if (typeof tur === 'string') yield { bi: 'r', text: tur };
    else if (Array.isArray(tur)) {
      for (let j = 0; j < tur.length; j++) yield { bi: `r.${j}`, text: JSON.stringify(tur[j]) };
    } else yield { bi: 'r', text: JSON.stringify(tur) };
  }
}

// The disclosure has to name the RISK, not just the mechanism: the remainder
// was never searched, so matches may exist there that this scan did not find
// ("matched on the first N chars only" alone reads as lower fidelity, which
// is not the claim). Two gaps survive even with the per-block rescue pass,
// and this sentence has to cover both: a match in the truncated remainder of
// the metadata envelope, and a match past the cap inside a single block that
// is itself oversized.
function truncationSkip(n) {
  return {
    file: '*',
    reason:
      `${n} line(s) longer than ${REGEX_LINE_CAP} chars were regex-matched on their first ${REGEX_LINE_CAP} chars only — ` +
      'the unsearched remainder MAY HOLD MATCHES THIS SCAN DID NOT FIND (substring search is uncapped and covers them)',
    bytes: 0,
  };
}

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;

function contextAround(text, index, length, width = 80) {
  const half = Math.max(0, Math.floor((width - length) / 2));
  let a = Math.max(0, index - half);
  let b = Math.min(text.length, index + length + half);
  // `text` is a UTF-16 string and a/b are raw code-unit offsets, so an
  // astral character (emoji) straddling a window edge would be sliced through
  // its surrogate pair and the snippet would carry a LONE surrogate —
  // JSON.stringify emits it as a bare \uD800-\uDFFF escape and the browser
  // paints U+FFFD. Shrink the window by one unit on the offending side (never
  // widen: `width` stays a real bound). O(1) — this runs once per match, and
  // `text` is a whole block body up to REGEX_LINE_CAP.
  if (a > 0 && isLowSurrogate(text.charCodeAt(a))) a += 1;
  if (b < text.length && isHighSurrogate(text.charCodeAt(b - 1))) b -= 1;
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

// opts: { projectsDir, sessions, fileTable, q, re, caseSensitive, after,
//         scope, cap=FIND_MATCH_CAP, emit, signal }
// sessions: [{ slug, id, mainRel|null, files:[relFromProjectsDir] }]
// fileTable: Map<relFromProjectsDir, {size, mtimeMs}>
export async function runFind(opts) {
  const t0 = Date.now();
  const { projectsDir, fileTable, emit = () => {}, signal, cap = FIND_MATCH_CAP } = opts;
  const scope = opts.scope ?? { kind: 'store' };
  const tally = { regexTruncatedLines: 0 };
  const match1 = makeMatcher(opts);

  // ---- scope narrowing
  let sessions = [...(opts.sessions ?? [])];
  if (scope.kind === 'project') sessions = sessions.filter((s) => s.slug === scope.slug);
  else if (scope.kind !== 'store') sessions = sessions.filter((s) => s.slug === scope.slug && s.id === scope.id);

  // ---- newest-first by max mtime over the session's files; file-ordered within
  const mt = (s) => Math.max(0, ...s.files.map((r) => fileTable?.get(r)?.mtimeMs ?? 0));
  sessions.sort((a, b) => mt(b) - mt(a));
  const orderedFiles = (s) => {
    const jsonl = s.files.filter((r) => r.endsWith('.jsonl'));
    const main = s.mainRel ? [s.mainRel] : [];
    const rest = jsonl.filter((r) => r !== s.mainRel).sort();
    let out = [...main, ...rest];
    if (scope.kind === 'agent') {
      out = scope.agentId === 'main'
        ? out.filter((r) => r === s.mainRel)
        : out.filter((r) => r.endsWith(`agent-${scope.agentId}.jsonl`));
    }
    return out;
  };

  const ofBytes = sessions.reduce((a, s) => a + orderedFiles(s).reduce((x, r) => x + (fileTable?.get(r)?.size ?? 0), 0), 0);
  let bytesDone = 0, sessionsDone = 0, matches = 0, lastProgress = 0;
  const strips = { base64: 0, base64Bytes: 0, signature: 0, signatureBytes: 0 };
  const resume = opts.after ? fromB64Url(opts.after) : null;
  let resuming = resume !== null;
  let cursorResolved = false; // set the moment the cursor's session+file are found

  const progress = (force = false) => {
    const now = Date.now();
    if (force || now - lastProgress > 200) {
      lastProgress = now;
      emit('progress', { sessionsDone, of: sessions.length, bytesDone, ofBytes, elapsedMs: now - t0 });
    }
  };

  for (const s of sessions) {
    if (signal?.aborted) return;
    const key = `${s.slug}/${s.id}`;
    if (resuming && resume.k !== key) {
      // Sessions strictly newer than the cursor's recorded mtime snapshot
      // changed (or appeared) AFTER the capped scan — scan them rather than
      // assume they were covered (a re-scan can repeat matches; a skip would
      // silently GAP them). Everything else was already covered — skip.
      const changedSinceCursor = typeof resume.m === 'number' && mt(s) > resume.m;
      if (!changedSinceCursor) {
        sessionsDone += 1;
        bytesDone += orderedFiles(s).reduce((x, r) => x + (fileTable?.get(r)?.size ?? 0), 0);
        continue;
      }
    }
    let fileResume = resuming && resume.k === key;
    for (const rel of orderedFiles(s)) {
      if (signal?.aborted) return;
      if (fileResume && resume.f !== rel) { bytesDone += fileTable?.get(rel)?.size ?? 0; continue; }
      const startLine = fileResume ? resume.l : 0; // skip lines <= l when resuming
      if (fileResume) { fileResume = false; resuming = false; cursorResolved = true; }
      const abs = path.join(projectsDir, ...rel.split('/'));
      try {
        for await (const L of readLines(abs)) {
          if (signal?.aborted) return;
          const { text: rawText, line } = L;
          if (line <= startLine) continue;
          const sh = stripHeavy(rawText);
          for (const blob of sh.blobs) {
            if (blob.kind === 'signature') { strips.signature += 1; strips.signatureBytes += blob.length; }
            else { strips.base64 += 1; strips.base64Bytes += blob.length; }
          }
          const stripped = sh.text;
          // Normalize the corpus string ONCE, HERE, and use that same string
          // for matching AND for the context window, so no offset ever
          // crosses normalization forms. `stripped` (the raw bytes as read) is
          // what still gets JSON.parse'd below, so the address and `at` stay
          // derived from what is actually on disk.
          const hay = stripped.normalize('NFC');
          // An oversized line is counted ONCE, here, whether or not it goes on
          // to match — the count is a fact about the corpus, not about how
          // many times the matcher was called on it. Measured against `hay`,
          // the text the matcher actually sees, so the disclosed cap describes
          // the text that was actually searched.
          const oversized = !!opts.re && hay.length > REGEX_LINE_CAP;
          if (oversized) tally.regexTruncatedLines += 1;
          const hit = match1(hay);
          // The line-level match stays PRIMARY: blockTexts() yields block
          // bodies only, so leading with it would silently stop matching every
          // metadata field the envelope carries — cwd, gitBranch, sessionId,
          // a tool's `name`. Those match today with bi:null and must keep
          // matching. The per-block pass below is a RESCUE for the one case
          // the line-level match cannot answer for.
          if (!hit && !oversized) continue; // an untruncated miss is a true miss
          // ctxText starts as `hay`, the same string `hit.index` indexes.
          let bi = null, ctxText = hay, ctxHit = hit;
          let obj = null;
          try { obj = JSON.parse(stripped); } catch { /* torn line — still a line-level match */ }
          if (!hit) {
            // Truncated line, no line-level hit: match1 only ever saw the first
            // REGEX_LINE_CAP chars, and if an EARLY block is itself oversized
            // that prefix ends inside it — so a real match sitting in a LATER,
            // individually small block was never looked at. (Substring search
            // is uncapped and finds it; only regex missed, and the skip note
            // read as "lower fidelity" rather than "may have missed matches".)
            // Re-run per block: each block is bounded by its own cap, and a
            // normal-sized one is nowhere near it.
            if (!obj) continue; // torn line — no blocks to rescue from
            for (const cand of blockTexts(obj)) {
              // Normalize the block ONCE and carry that same string into
              // ctxText — `h.index` is an offset into it, so handing
              // contextAround the un-normalized original would slide the window
              // left by one unit per combining mark and could emit a snippet
              // that does not contain the match.
              const t = cand.text.normalize('NFC');
              const h = match1(t);
              if (h) { bi = cand.bi; ctxText = t; ctxHit = h; break; }
            }
            if (bi === null) continue;
          } else if (obj) {
            // resolve to a block address; line-only when outside any block
            for (const cand of blockTexts(obj)) {
              const t = cand.text.normalize('NFC');   // same-string rule as above
              const h = match1(t);
              if (h) { bi = cand.bi; ctxText = t; ctxHit = h; break; }
            }
          }
          matches += 1;
          emit('match', {
            slug: s.slug, id: s.id,
            file: sessionRel(s, rel), line, bi,
            at: obj && typeof obj.timestamp === 'string' ? obj.timestamp : null,
            ctx: contextAround(ctxText, ctxHit.index, ctxHit.length),
          });
          if (matches >= cap) {
            const skippedTotal = strips.base64Bytes + strips.signatureBytes;
            emit('skip', { file: '*', reason: `${strips.base64} image payloads and ${strips.signature} signatures skipped`, bytes: skippedTotal });
            if (tally.regexTruncatedLines > 0) emit('skip', truncationSkip(tally.regexTruncatedLines));
            emit('done', {
              matches, capped: true,
              cap, // the client's "capped at N — keep scanning" prints the server's own N
              // cursor carries the session's mtime snapshot (m) so a resume can
              // tell changed-since sessions from already-covered ones
              cursor: toB64Url({ k: key, f: rel, l: line, m: mt(s) }),
              skipped: { imagePayloads: strips.base64, signatures: strips.signature, bytes: skippedTotal },
            });
            return;
          }
        }
      } catch (e) {
        const size = fileTable?.get(rel)?.size ?? 0;
        emit('skip', { file: sessionRel(s, rel), reason: `unreadable: ${e && e.message}`, bytes: size });
        bytesDone += size; // a skipped file is still DONE bytes — progress must reach 100%
        continue;
      }
      bytesDone += fileTable?.get(rel)?.size ?? 0;
      progress();
    }
    sessionsDone += 1;
    progress();
  }
  progress(true);
  const skippedTotal = strips.base64Bytes + strips.signatureBytes;
  emit('skip', { file: '*', reason: `${strips.base64} image payloads and ${strips.signature} signatures skipped`, bytes: skippedTotal });
  if (tally.regexTruncatedLines > 0) emit('skip', truncationSkip(tally.regexTruncatedLines));
  if (resume !== null && !cursorResolved) {
    // The cursor's session/file no longer resolves (deleted/renamed since the
    // capped scan). A clean `done {matches:0}` here would claim a REAL ZERO
    // for a scan that skipped everything — that claim must never be false.
    emit('problem', {
      code: 'find-cursor-stale', severity: 'warning', scope: 'store',
      message: 'the resume cursor no longer resolves (its session or file changed since the capped scan) — re-run the scan from the start',
      affects: 'display', count: 1,
    });
    emit('error', { code: 'find-cursor-stale', message: 'resume cursor no longer resolves — re-run the scan' });
    return;
  }
  emit('done', { matches, cap, skipped: { imagePayloads: strips.base64, signatures: strips.signature, bytes: skippedTotal } });
}
