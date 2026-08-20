// server/parse.mjs — events -> session model (SPEC §3, §4, §7, §8).
//
// House rules: recorded facts only, no inference; unknown = null, never 0.
// Rows keep a head (<=220 chars) + locator, never long text. 1-based lines at
// every boundary (jsonl.mjs owns the conversion).
//
// CONTRACT-DEVIATION: parseSession additionally requires the projects dir to
// resolve rel paths to absolute ones — accepted as opts.projectsDir or
// sessionEntry.projectsDir. The BUILD-CONTRACTS signature lists neither, but
// sessionEntry carries only projectsDir-relative rels, so without it no file
// can be opened. The integrator wires opts.projectsDir from config.
//
// CONTRACT-DEVIATION (disclosed, deliberate): assistantLines entries are
// group A's preferred wrapper { file, line, tier, event } where `event` is the
// raw parsed assistant event MINUS message.content and other bulk — it keeps
// every field the ledger reads (type, timestamp, message.id/model/stop_reason/
// usage incl. iterations, uuid, requestId, isSidechain). Retaining content
// would blow the ~10 MB parsed-session budget (SPEC §11) for zero ledger value.
// INTEGRATION-NOTE: this is the report-2 seam fix — buildSessionLedger reads
// el.event directly, so the bridge that lens.mjs carried is deleted and the
// worker's direct buildSessionLedger(model.assistantLines) call now yields
// real rows (it previously received the un-wrapped slim shape and produced an
// empty ledger, which zeroed worker-built cards' usageByModel).

import path from 'node:path';
import fsp from 'node:fs/promises';
import { readLines as defaultReadLines, stripHeavy as defaultStripHeavy } from './jsonl.mjs';

const HEAD_MAX = 220;
const WF_ID_RE = /wf_[0-9a-f]{8}-[0-9a-f]{3}/;
const WF_ID_RE_G = /wf_[0-9a-f]{8}-[0-9a-f]{3}/g;
const AGENT_FILE_RE = /(?:^|\/)subagents\/(?:workflows\/(wf_[0-9a-f]{8}-[0-9a-f]{3})\/)?agent-([A-Za-z0-9]+)\.jsonl$/;
const AGENT_META_RE = /(?:^|\/)subagents\/(?:workflows\/(wf_[0-9a-f]{8}-[0-9a-f]{3})\/)?agent-([A-Za-z0-9]+)\.meta\.json$/;
const JOURNAL_RE = /(?:^|\/)subagents\/workflows\/(wf_[0-9a-f]{8}-[0-9a-f]{3})\/journal\.jsonl$/;
const MANIFEST_RE = /(?:^|\/)workflows\/(wf_[0-9a-f]{8}-[0-9a-f]{3})\.json$/;
const SCRIPT_RE = /(?:^|\/)workflows\/scripts\/[^/]+\.js$/;
const TOOL_RESULTS_RE = /(?:^|\/)tool-results\/[^/]+$/;
// Files-view path sources are keyed BY TOOL NAME (SPEC §8) — free-form
// path-shaped keys inside StructuredOutput/MCP inputs are payload, not file ops.
const PATH_TOOLS = {
  Read: { key: 'file_path', op: 'read' },
  Write: { key: 'file_path', op: 'write' },
  Edit: { key: 'file_path', op: 'edit' },
  NotebookEdit: { key: 'notebook_path', op: 'edit' },
  Glob: { key: 'path', op: 'search' },
  Grep: { key: 'path', op: 'search' },
};
// Turn-bound exclusions (SPEC §4 time-bounds ledger): a turn ends at the max
// timestamp over its CONVERSATION rows only.
const METADATA_TYPES = new Set(['last-prompt', 'ai-title', 'custom-title', 'mode', 'pr-link', 'frame-link']);

// A raw slice() cuts UTF-16 code UNITS, so a 4-byte character (emoji, astral
// CJK) straddling the boundary would leave a lone surrogate in the head,
// which a browser paints as U+FFFD (find.mjs contextAround() guards the same
// hazard). One charCodeAt on the truncating branch only — NOT Array.from,
// which is too slow for a function that runs per block over the whole corpus.
// Checking the last KEPT unit is sufficient: there is no left edge, and the
// `> HEAD_MAX` branch guarantees the string continues, so a high surrogate at
// HEAD_MAX-1 is necessarily a split pair.
function head(s) {
  if (s == null) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= HEAD_MAX) return t;
  const c = t.charCodeAt(HEAD_MAX - 1);
  const end = (c >= 0xd800 && c <= 0xdbff) ? HEAD_MAX - 1 : HEAD_MAX;
  return t.slice(0, end);
}

/** A recorded string that CARRIES SOMETHING, else null. Used where the
 *  alternatives in the chain are themselves known to be strings (the SDK
 *  error object's `formatted`/`message`). */
function strOrNull(v) {
  return (typeof v === 'string' && v.trim()) ? v : null;
}

/** The `??`-chain gate, hoisted into ONE helper so the head() sites that need
 *  it cannot drift apart. `??` falls through on null/undefined ONLY, so a
 *  recorded `''` — or a whitespace-only string, which head() renders blank
 *  anyway — would otherwise WIN its chain and blank the preview while a real
 *  recorded fact sat behind it in the same chain.
 *
 *  The narrowness is the point: this rejects a BLANK STRING and nothing else.
 *  A recorded `0`, `false`, or object still passes through untouched and still
 *  wins its chain, exactly as today — because those are recorded facts, and
 *  swallowing one to fix a blank would just trade this blackout for another.
 *  That is also why the outer `??` at each site stays `??` and must never
 *  become `||`. */
function nonBlank(v) {
  if (v === null || v === undefined) return null;
  return (typeof v === 'string' && !v.trim()) ? null : v;
}

function tsMs(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * The MANIFEST timestamp rule, and only the manifest's.
 *
 * wf_*.json records its own clock as bare epoch-millisecond NUMBERS
 * (`"queuedAt": 1786090380798`) while transcript events record ISO-8601
 * strings — the strict tsMs() above would drop every numeric one on the
 * floor, reporting `queuedAt`/`startedAt` as "not recorded" for every
 * workflow agent in the corpus (686 of 696 workflow_agent entries carry a
 * numeric queuedAt; 0 carry a string).
 *
 * Deliberately NOT applied to tsMs(ev.timestamp) — the transcript event
 * timestamps that bound SPEC §4's ledger are ISO strings corpus-wide, and
 * widening that reader would let an unrelated number in as a turn bound.
 */
function tsMsLoose(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return tsMs(v);
}

function sniffMedia(b64head) {
  // magic bytes from the first base64 chars (SPEC §8: toolUseResult.file.base64
  // carries NO media_type — sniff, never guess).
  if (!b64head) return null;
  if (b64head.startsWith('iVBOR')) return 'image/png';
  if (b64head.startsWith('/9j/')) return 'image/jpeg';
  if (b64head.startsWith('UklGR')) return 'image/webp';
  if (b64head.startsWith('R0lGOD')) return 'image/gif';
  if (b64head.startsWith('JVBER')) return 'application/pdf';
  return null;
}

/**
 * Attribute the base64 blobs stripHeavy() removed from ONE line back to the
 * image blocks they were stripped out of (SPEC §1 + §8).
 *
 * The reader records each removed payload's exact length, but replaces the
 * value with "" before JSON.parse — so the parsed node no longer carries it.
 * Without this join every image on the four content paths reports its size as
 * "not recorded", which is an assertion of absence about a fact the same read
 * measured.
 *
 * Matching rule, in this order:
 *   1. BY KEY. `toolUseResult.file.base64` is the only shape holding its payload
 *      under the key `base64`; every other image path holds it under
 *      `source.data`. Keying first keeps the sidecar shape from consuming a
 *      content block's blob.
 *   2. BY ORDER WITHIN THE KEY GROUP. HEAVY_RE scans the raw line left to right,
 *      so blobs of one key arrive in serialization order. Enumeration here
 *      follows the recorded top-level key order (Object.keys of the parsed
 *      event preserves it), so `toolUseResult` images come first on a line that
 *      serializes toolUseResult before message.
 *   3. ONLY WHEN THE COUNTS MATCH. If a key group's block count differs from its
 *      blob count (an image below SPEC §1's 500-char strip threshold, a
 *      url-source image, a `data` key on some non-image shape), nothing is
 *      attributed for that group — the caller reports what is true instead of
 *      guessing which blob belongs where.
 *
 * @returns Map<bi, blob> — only the entries it can attribute.
 */
export function imageBlobsByBi(ev, blobs) {
  const out = new Map();
  if (!ev || typeof ev !== 'object') return out;
  const b64 = Array.isArray(blobs) ? blobs.filter((b) => b && b.kind === 'base64') : [];
  if (!b64.length) return out;

  const dataBis = [];   // bi of every image block whose source.data was emptied
  const b64Bis = [];    // bi of the toolUseResult.file.base64 sidecar, if emptied

  const noteData = (bi, node) => {
    const d = node && node.source && typeof node.source.data === 'string' ? node.source.data : null;
    if (d === '') dataBis.push(bi);
  };

  const walkMessage = () => {
    const c = ev.message && ev.message.content;
    if (!Array.isArray(c)) return;
    for (let i = 0; i < c.length; i++) {
      const b = c[i] || {};
      if (b.type === 'image') noteData(String(i), b);
      if (Array.isArray(b.content)) {
        for (let j = 0; j < b.content.length; j++) {
          const nb = b.content[j] || {};
          if (nb.type === 'image') noteData(`${i}.${j}`, nb);
        }
      }
    }
  };
  const walkSidecar = () => {
    const tur = ev.toolUseResult;
    if (Array.isArray(tur)) {
      for (let j = 0; j < tur.length; j++) {
        const el = tur[j] || {};
        if (el.source || el.type === 'image') noteData(`r.${j}`, el);
      }
    } else if (tur && typeof tur === 'object' && tur.file && typeof tur.file === 'object'
      && typeof tur.file.base64 === 'string' && tur.file.base64 === '') {
      b64Bis.push('r');
    }
  };

  const keys = Object.keys(ev);
  const mi = keys.indexOf('message');
  const ti = keys.indexOf('toolUseResult');
  if (ti !== -1 && (mi === -1 || ti < mi)) { walkSidecar(); walkMessage(); }
  else { walkMessage(); walkSidecar(); }

  const assign = (bis, key) => {
    const group = b64.filter((b) => b.key === key);
    if (!bis.length || group.length !== bis.length) return;
    for (let k = 0; k < bis.length; k++) out.set(bis[k], group[k]);
  };
  assign(dataBis, 'data');
  assign(b64Bis, 'base64');
  return out;
}

// Generic "saved to <abspath>" capture: win32 drive-letter paths AND POSIX
// absolute paths (a foreign corpus's banner/binary wordings are path-agnostic;
// only this generic form needed the widening).
const SAVED_TO_RE = /\bsaved to:?\s+((?:[A-Za-z]:\\|\/)[^\n"]+)/g;

export function spillRefsFromText(text, sink, file, line) {
  if (typeof text !== 'string' || !text.includes('saved to')) return;
  const seen = new Set();
  const push = (form, p) => {
    const clean = p.trim().replace(/;.*$/, '').replace(/[.,)\]'"]+$/, '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    sink.push({ file, line, form, path: clean });
  };
  if (text.includes('<persisted-output>')) {
    const m = /saved to:\s*([^\n]+)/.exec(text);
    if (m) push('banner', m[1]);
  }
  if (text.includes('[Binary content')) {
    const m = /\[Binary content \([^)]*\) also saved to ([^\]]+)\]/.exec(text);
    if (m) push('binary', m[1]);
  }
  // generic recorded wordings observed in the corpus beyond the two above:
  // "Output has been saved to <abspath>" (oversize MCP results) and
  // "full HTML saved to <abspath>" (artifact fetches) — same "saved to <path>" stem
  let m;
  SAVED_TO_RE.lastIndex = 0;
  while ((m = SAVED_TO_RE.exec(text)) !== null) push('saved-to', m[1]);
}

// ---------------------------------------------------------------------------
// parseTranscript — one .jsonl transcript (main or agent tier) -> rows + facts.
// ---------------------------------------------------------------------------
async function parseTranscript(absPath, rel, tier, tools) {
  const { readLines, stripHeavy, onBytes, sessionId } = tools;
  const T = {
    rel,
    tier,
    rows: [],
    turns: null, // main only
    events: 0,
    lines: 0,
    perType: {},
    attachmentKinds: {},
    unknownTypes: {},
    toolCalls: 0,
    textChars: 0,
    thinkingChars: 0,
    images: [], // {file, line, bi, mediaType, b64Length /*base64 chars*/, bytes /*decoded*/, twin}
    spillRefs: [],
    filesLedger: [],
    assistantLines: [],
    problems: [],
    sessionIds: new Map(), // sessionId -> count
    models: new Map(), // message.model -> count
    firstAt: null,
    lastAt: null,
    // R2(ii) evidence: the ts of the FIRST record IN FILE ORDER that CARRIES a
    // timestamp (untimestamped metadata types are skipped, never 0/NaN). This
    // is deliberately NOT firstAt (the file minimum), which inherits and ties
    // on forks/resumes — SPEC §5 R2.
    r2FirstTsMs: null,
    // R2(i) evidence (main tier): message.ids recorded with a per-event
    // sessionId that differs from the filename id (185 corpus-wide, one pair).
    foreignMsgIds: tier === 'main' ? new Set() : null,
    firstPrompt: null, // first non-meta real user prompt {line, text}
    consumedBytes: 0, // end of the last complete line (byte after its \n)
    resultsNoSidecar: 0, // tool_result user events without toolUseResult
    msgIds: tier === 'main' ? [] : null,
    meta: tier === 'main' ? {
      aiTitle: { value: null, count: 0 },
      customTitle: { value: null, count: 0 },
      lastPrompt: { value: null, leafUuid: null, leafLine: null, count: 0 },
      mode: { value: null, count: 0 },
      prLinks: { items: [], count: 0 },
      frameLinks: { items: [], count: 0 },
      queueOps: { enqueue: 0, dequeue: 0, remove: 0, other: 0 },
      cwds: [],
      versions: [],
      gitBranch: null,
      gitBranchCount: 0,
      entrypoint: null,
      bom: false,
    } : null,
    // joins (main only)
    toolUseIndex: tier === 'main' ? new Map() : null, // toolUseId -> {line, name}
    runIdEdges: tier === 'main' ? [] : null, // {runId, line, via}
    agentResultInfo: tier === 'main' ? new Map() : null, // agentId -> {line, resolvedModel, description}
    embeddedSidechainRows: 0,
    uuidLine: tier === 'main' ? new Map() : null,
  };
  // description enrichment for depth-2 agents: tool_use inside AGENT transcripts
  const agentToolUseDesc = tools.agentToolUseDesc; // shared Map across transcripts

  const seenBranches = new Set();
  const seenCwds = new Set();
  const seenVersions = new Set();
  const msgIdSeen = tier === 'main' ? new Set() : null;

  let turns = null;
  let openers = null;
  if (tier === 'main') {
    turns = [{ idx: 0, preamble: true, openerLine: null, at: null, endAt: null, rowRange: null }];
    openers = [];
    T.turns = turns;
    T.openers = openers;
  }
  let cur = 0; // current turn idx (main)

  const noteRow = (row, ev, conversational) => {
    T.rows.push(row);
    if (tier === 'main') {
      const t = turns[cur];
      const ri = T.rows.length - 1;
      if (t.rowRange === null) t.rowRange = [ri, ri]; else t.rowRange[1] = ri;
      if (conversational && row.at != null && ev.isSidechain !== true) {
        if (t.endAt === null || row.at > t.endAt) t.endAt = row.at;
      }
    }
  };

  let bytesDone = 0;
  for await (const L of readLines(absPath)) {
    T.lines = L.line;
    bytesDone = L.byteOffset + L.bytes + 1;
    T.consumedBytes = bytesDone;
    if (onBytes && (L.line & 0x3ff) === 0) onBytes(rel, bytesDone);
    if (L.bom && T.meta) T.meta.bom = true;

    const { text, blobs } = stripHeavy(L.text);
    let ev;
    try {
      ev = JSON.parse(text);
    } catch {
      T.problems.push({
        code: 'torn-line', severity: 'error', scope: 'line', file: rel,
        line: L.line, byteOffset: L.byteOffset, bytes: L.bytes,
        message: 'line failed JSON.parse; skipped (expected 0 on this corpus)',
        affects: 'aggregates', count: 1,
      });
      continue;
    }
    T.events += 1;
    // The lengths stripHeavy just measured, joined back to the block
    // addresses they came from, so the image census never reports `null`
    // for a payload the reader sized on the way past.
    const imgBlobs = imageBlobsByBi(ev, blobs);
    const imgLen = (bi) => imgBlobs.get(bi) ?? null;
    const type = typeof ev.type === 'string' ? ev.type : '(none)';
    T.perType[type] = (T.perType[type] || 0) + 1;
    const at = tsMs(ev.timestamp);
    if (at != null) {
      if (T.r2FirstTsMs === null) T.r2FirstTsMs = at; // first in FILE ORDER carrying a timestamp
      if (T.firstAt === null || at < T.firstAt) T.firstAt = at;
      if (T.lastAt === null || at > T.lastAt) T.lastAt = at;
    }
    if (typeof ev.sessionId === 'string') T.sessionIds.set(ev.sessionId, (T.sessionIds.get(ev.sessionId) || 0) + 1);
    if (T.uuidLine && typeof ev.uuid === 'string') T.uuidLine.set(ev.uuid, L.line);
    if (T.meta) {
      if (typeof ev.cwd === 'string' && !seenCwds.has(ev.cwd)) { seenCwds.add(ev.cwd); T.meta.cwds.push(ev.cwd); }
      if (typeof ev.version === 'string' && !seenVersions.has(ev.version)) { seenVersions.add(ev.version); T.meta.versions.push(ev.version); }
      if (typeof ev.gitBranch === 'string') {
        T.meta.gitBranch = ev.gitBranch;
        if (!seenBranches.has(ev.gitBranch)) { seenBranches.add(ev.gitBranch); T.meta.gitBranchCount += 1; }
      }
      if (typeof ev.entrypoint === 'string') T.meta.entrypoint = ev.entrypoint;
    }

    switch (type) {
      case 'assistant': {
        const msg = ev.message || {};
        if (typeof msg.model === 'string') T.models.set(msg.model, (T.models.get(msg.model) || 0) + 1);
        if (msgIdSeen && typeof msg.id === 'string' && !msgIdSeen.has(msg.id)) { msgIdSeen.add(msg.id); T.msgIds.push(msg.id); }
        if (T.foreignMsgIds && typeof msg.id === 'string' && typeof sessionId === 'string'
          && typeof ev.sessionId === 'string' && ev.sessionId !== sessionId) {
          T.foreignMsgIds.add(msg.id); // R2 clause (i): copy keeps its original sessionId
        }
        if (ev.isSidechain === true && tier === 'main') T.embeddedSidechainRows += 1;
        const content = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
        for (let i = 0; i < content.length; i++) {
          const b = content[i] || {};
          const bi = String(i);
          switch (b.type) {
            case 'text': {
              T.textChars += (b.text || '').length;
              noteRow({ line: L.line, bi, kind: 'text', at, head: head(b.text), extra: { msgId: msg.id ?? null } }, ev, true);
              break;
            }
            case 'thinking': {
              const th = b.thinking || '';
              T.thinkingChars += th.length;
              noteRow({ line: L.line, bi, kind: 'thinking', at, head: head(th), extra: { empty: th.length === 0, msgId: msg.id ?? null } }, ev, true);
              break;
            }
            case 'tool_use': {
              T.toolCalls += 1;
              const name = typeof b.name === 'string' ? b.name : '(unnamed)';
              const input = b.input && typeof b.input === 'object' ? b.input : {};
              // nonBlank throughout: a recorded `description: ''` must not
              // short-circuit this chain, or the row reads bare "Edit" while
              // the recorded file_path/command it would have named sits behind
              // the empty string. The tail `?? ''` is the honest end of the
              // chain — a tool_use that records none of these six inputs has
              // nothing more to preview than its own name.
              noteRow({
                line: L.line, bi, kind: 'tool_use', at,
                head: head(`${name} ${nonBlank(input.description) ?? nonBlank(input.file_path) ?? nonBlank(input.path) ?? nonBlank(input.pattern) ?? nonBlank(input.command) ?? nonBlank(input.prompt) ?? ''}`),
                extra: { tool: name, toolUseId: b.id ?? null, msgId: msg.id ?? null },
              }, ev, true);
              const pt = PATH_TOOLS[name];
              if (pt && typeof input[pt.key] === 'string' && input[pt.key]) {
                T.filesLedger.push({ path: input[pt.key], tool: name, op: pt.op, file: rel, line: L.line, tier });
              }
              if (T.toolUseIndex && typeof b.id === 'string') T.toolUseIndex.set(b.id, { line: L.line, name });
              if (typeof b.id === 'string' && (typeof input.description === 'string' || typeof input.model === 'string')) {
                agentToolUseDesc.set(b.id, {
                  description: input.description ?? null,
                  model: input.model ?? null,
                  subagentType: input.subagent_type ?? null,
                });
              }
              if (T.runIdEdges && name === 'Workflow' && typeof input.resumeFromRunId === 'string' && WF_ID_RE.test(input.resumeFromRunId)) {
                T.runIdEdges.push({ runId: input.resumeFromRunId, line: L.line, via: 'resumeFromRunId', resume: true });
              }
              break;
            }
            case 'fallback': {
              noteRow({
                line: L.line, bi, kind: 'fallback', at,
                head: head(`fallback ${b.from?.model ?? '?'} -> ${b.to?.model ?? '?'}`),
                extra: { from: b.from?.model ?? null, to: b.to?.model ?? null, msgId: msg.id ?? null },
              }, ev, true);
              break;
            }
            case 'image': {
              const mediaType = b.source?.media_type ?? null;
              const blob = imgLen(bi);
              T.images.push({ file: rel, line: L.line, bi, mediaType, b64Length: blob?.length ?? null, bytes: blob?.bytes ?? null, twin: false });
              noteRow({ line: L.line, bi, kind: 'image', at, head: head(`image ${mediaType ?? ''}`), extra: { mediaType, base64Length: blob?.length ?? null, bytes: blob?.bytes ?? null } }, ev, true);
              break;
            }
            default: {
              noteRow({ line: L.line, bi, kind: `unknown:${b.type ?? 'block'}`, at, head: head(JSON.stringify(b)), extra: {} }, ev, true);
            }
          }
        }
        // slim assistant line for the ledger (group A) — the {file, line,
        // event} wrapper shape; see CONTRACT-DEVIATION above
        T.assistantLines.push({
          file: rel, line: L.line, tier,
          event: {
            type: 'assistant',
            timestamp: typeof ev.timestamp === 'string' ? ev.timestamp : null,
            uuid: ev.uuid ?? null, requestId: ev.requestId ?? null,
            isSidechain: ev.isSidechain === true,
            message: {
              id: msg.id ?? null,
              model: msg.model ?? null,
              stop_reason: msg.stop_reason ?? null,
              usage: msg.usage ?? null,
            },
          },
        });
        break;
      }

      case 'user': {
        const msg = ev.message || {};
        const c = msg.content;
        const isMeta = ev.isMeta === true;

        // R-T (SPEC §4): opener iff origin.kind === 'human', OR origin absent AND
        // string content starting '<command-message>'. NOT `typeof content ===
        // 'string'` (20 human turns are arrays); NOT "absent origin = turn"
        // (all 73 such string events are slash scaffolding).
        if (tier === 'main') {
          const opener = ev.origin?.kind === 'human'
            || (ev.origin === undefined && typeof c === 'string' && c.startsWith('<command-message>'));
          if (opener) {
            openers.push({ line: L.line, at });
            turns.push({ idx: turns.length, preamble: false, openerLine: L.line, at, endAt: null, rowRange: null });
            cur = turns.length - 1;
          }
        }

        if (typeof c === 'string') {
          noteRow({
            line: L.line, bi: null, kind: 'prompt', at, head: head(c),
            extra: { origin: ev.origin?.kind ?? null, isMeta },
          }, ev, !isMeta);
          if (!isMeta && !T.firstPrompt) T.firstPrompt = { line: L.line, text: c.slice(0, 600) };
          if (!isMeta) T.textChars += c.length;
        } else if (Array.isArray(c)) {
          const textParts = [];
          let hasToolResult = false;
          for (let i = 0; i < c.length; i++) {
            const b = c[i] || {};
            if (b.type === 'text') {
              textParts.push(b.text || '');
            } else if (b.type === 'image') {
              const mediaType = b.source?.media_type ?? null;
              const blob = imgLen(String(i));
              T.images.push({ file: rel, line: L.line, bi: String(i), mediaType, b64Length: blob?.length ?? null, bytes: blob?.bytes ?? null, twin: false });
              noteRow({ line: L.line, bi: String(i), kind: 'image', at, head: head(`image ${mediaType ?? ''}`), extra: { mediaType, base64Length: blob?.length ?? null, bytes: blob?.bytes ?? null } }, ev, !isMeta);
            } else if (b.type === 'tool_result') {
              hasToolResult = true;
              let resultText = '';
              if (typeof b.content === 'string') {
                resultText = b.content;
              } else if (Array.isArray(b.content)) {
                for (let j = 0; j < b.content.length; j++) {
                  const nb = b.content[j] || {};
                  if (nb.type === 'text') resultText += (resultText ? '\n' : '') + (nb.text || '');
                  else if (nb.type === 'image') {
                    const mediaType = nb.source?.media_type ?? null;
                    const blob = imgLen(`${i}.${j}`);
                    T.images.push({ file: rel, line: L.line, bi: `${i}.${j}`, mediaType, b64Length: blob?.length ?? null, bytes: blob?.bytes ?? null, twin: false });
                    noteRow({ line: L.line, bi: `${i}.${j}`, kind: 'image', at, head: head(`image ${mediaType ?? ''}`), extra: { mediaType, base64Length: blob?.length ?? null, bytes: blob?.bytes ?? null } }, ev, !isMeta);
                  }
                }
              }
              spillRefsFromText(resultText, T.spillRefs, rel, L.line);
              noteRow({
                line: L.line, bi: String(i), kind: 'tool_result', at, head: head(resultText),
                extra: {
                  toolUseId: b.tool_use_id ?? null,
                  // tri-state: only === true is an error (absent 71% / false 25% / true 3.7%)
                  isError: b.is_error === true,
                  ...(ev.toolDenialKind ? { denial: ev.toolDenialKind } : {}),
                },
              }, ev, !isMeta);
              // Workflow runId join via tool_result text (main tier)
              if (T.runIdEdges && typeof b.tool_use_id === 'string') {
                const tu = T.toolUseIndex.get(b.tool_use_id);
                if (tu && tu.name === 'Workflow') {
                  const ids = resultText.match(WF_ID_RE_G);
                  if (ids) for (const runId of new Set(ids)) T.runIdEdges.push({ runId, line: tu.line, via: 'tool_result-text' });
                }
              }
            } else {
              noteRow({ line: L.line, bi: String(i), kind: `unknown:${b.type ?? 'block'}`, at, head: head(JSON.stringify(b)), extra: {} }, ev, !isMeta);
            }
          }
          if (textParts.length > 0) {
            const joined = textParts.join('\n');
            noteRow({
              line: L.line, bi: null, kind: 'prompt', at, head: head(joined),
              extra: { origin: ev.origin?.kind ?? null, isMeta },
            }, ev, !isMeta);
            if (!isMeta && !hasToolResult && !T.firstPrompt) T.firstPrompt = { line: L.line, text: joined.slice(0, 600) };
            if (!isMeta) T.textChars += joined.length;
          }
          if (hasToolResult && tier === 'agent' && ev.toolUseResult === undefined) T.resultsNoSidecar += 1;
        }

        // toolUseResult sidecar (polymorphic: object / array / bare string)
        const tur = ev.toolUseResult;
        if (tur != null) {
          if (typeof tur === 'string') {
            spillRefsFromText(tur, T.spillRefs, rel, L.line);
          } else if (Array.isArray(tur)) {
            for (let j = 0; j < tur.length; j++) {
              const el = tur[j] || {};
              if (el.source || el.type === 'image') {
                const mediaType = el.source?.media_type ?? null;
                const blob = imgLen(`r.${j}`);
                T.images.push({ file: rel, line: L.line, bi: `r.${j}`, mediaType, b64Length: blob?.length ?? null, bytes: blob?.bytes ?? null, twin: false });
              }
            }
          } else if (typeof tur === 'object') {
            if (typeof tur.persistedOutputPath === 'string') {
              T.spillRefs.push({ file: rel, line: L.line, form: 'structured', path: tur.persistedOutputPath });
            }
            if (typeof tur.stdout === 'string') spillRefsFromText(tur.stdout, T.spillRefs, rel, L.line);
            if (tier === 'main' && typeof tur.filePath === 'string' && tur.filePath) {
              T.filesLedger.push({ path: tur.filePath, tool: null, op: 'sidecar', file: rel, line: L.line, tier });
            }
            if (tur.file && typeof tur.file === 'object' && 'base64' in tur.file) {
              // media_type is NOT recorded on this shape — sniffed from blob head below
              const b64 = imgLen('r') ?? blobs.find((x) => x.key === 'base64');
              T.images.push({
                file: rel, line: L.line, bi: 'r',
                mediaType: sniffMedia(b64?.head) ?? null,
                b64Length: b64?.length ?? null, bytes: b64?.bytes ?? null, twin: false,
              });
            }
            if (T.runIdEdges && typeof tur.runId === 'string' && WF_ID_RE.test(tur.runId)) {
              // map back to the SPAWNING tool_use line (file order is topological —
              // the tool_use precedes its result in every observed file)
              let line = L.line;
              const firstResult = Array.isArray(c) ? c.find((b) => b && b.type === 'tool_result') : null;
              const tu = firstResult && typeof firstResult.tool_use_id === 'string' ? T.toolUseIndex.get(firstResult.tool_use_id) : null;
              if (tu) line = tu.line;
              T.runIdEdges.push({ runId: tur.runId, line, via: 'toolUseResult.runId' });
            }
            if (T.agentResultInfo && typeof tur.agentId === 'string') {
              T.agentResultInfo.set(tur.agentId, {
                line: L.line,
                resolvedModel: tur.resolvedModel ?? null,
                description: tur.description ?? null,
                status: tur.status ?? null,
              });
            }
          }
        }
        break;
      }

      case 'attachment': {
        const kind = ev.attachment?.type ?? 'unknown';
        T.attachmentKinds[kind] = (T.attachmentKinds[kind] || 0) + 1;
        // nonBlank: a recorded `banner: ''` must not win this chain and blank
        // the preview while a real recorded displayPath sits behind it — the
        // same class as the api_error blank, one site over.
        noteRow({
          line: L.line, bi: null, kind: `attachment:${kind}`, at,
          head: head(nonBlank(ev.attachment?.banner) ?? nonBlank(ev.attachment?.displayPath) ?? JSON.stringify(ev.attachment ?? {})),
          extra: {},
        }, ev, false);
        break;
      }

      case 'system': {
        const sub = ev.subtype ?? 'unknown';
        // On subtype:'api_error' events (126 corpus-wide) ev.error is the SDK
        // error OBJECT — {message, formatted, connection, …} — and head()
        // String()s its argument, so without this the row preview reads the
        // literal "[object Object]" instead of the recorded "Unable to
        // connect to API (ECONNRESET)". Prefer the first recorded string that
        // CARRIES SOMETHING; stringify rather than fall silent if a future
        // error shape carries neither, since an empty preview would trade a
        // wrong string for silence about a recorded fact.
        //
        // The preference is for a NON-EMPTY (post-trim) recorded string, not
        // merely for a string: a bare `typeof` gate would accept a recorded
        // `formatted: ''` as the chosen value, beating a recorded non-empty
        // `error.message` AND the row's own `ev.content` — the exact
        // silent-blank preview this code exists to prevent. `.trim()` (not
        // `!== ''`) because head() collapses and trims whitespace, so a
        // whitespace-only `formatted` renders blank too. The outer `??` on
        // head(errHead ?? …) stays `??` and must NEVER become `||`: a
        // PRIMITIVE `error: 0` / `error: false` is a recorded fact and has to
        // survive to the preview.
        //
        // strOrNull on the STRING branch below covers ev.error being ITSELF
        // the empty string (`'' ?? ev.content` is '' — ?? falls through on
        // null/undefined only, so an unguarded '' would blank the preview
        // over a real recorded ev.content). The gate is TYPE-SCOPED on
        // purpose: typeof 0 and typeof false are not 'string', so `error: 0`
        // and `error: false` cannot reach it and still render '0' / 'false'.
        const errHead = (ev.error !== null && typeof ev.error === 'object')
          ? (strOrNull(ev.error.formatted) ?? strOrNull(ev.error.message) ?? JSON.stringify(ev.error))
          : typeof ev.error === 'string' ? strOrNull(ev.error)
            : ev.error;
        noteRow({
          line: L.line, bi: null, kind: `system:${sub}`, at,
          head: head(errHead ?? ev.content ?? sub),
          extra: { level: ev.level ?? null },
        }, ev, false);
        break;
      }

      case 'queue-operation': {
        const op = ev.operation ?? 'other';
        if (T.meta) {
          if (op === 'enqueue' || op === 'dequeue' || op === 'remove') T.meta.queueOps[op] += 1;
          else T.meta.queueOps.other += 1;
        }
        noteRow({
          line: L.line, bi: null, kind: 'queue-operation', at,
          head: head(ev.content ?? ''), extra: { operation: op },
        }, ev, false);
        break;
      }

      // Metadata snapshots: latest value + count, NEVER a timeline row (SPEC §3).
      case 'last-prompt': {
        if (T.meta) {
          const m = T.meta.lastPrompt;
          m.count += 1;
          if ('lastPrompt' in ev) m.value = ev.lastPrompt;
          m.leafUuid = ev.leafUuid ?? m.leafUuid;
        }
        break;
      }
      case 'ai-title': {
        if (T.meta) { T.meta.aiTitle.count += 1; T.meta.aiTitle.value = ev.aiTitle ?? T.meta.aiTitle.value; }
        break;
      }
      case 'custom-title': {
        if (T.meta) { T.meta.customTitle.count += 1; T.meta.customTitle.value = ev.customTitle ?? T.meta.customTitle.value; }
        break;
      }
      case 'mode': {
        if (T.meta) { T.meta.mode.count += 1; T.meta.mode.value = ev.mode ?? T.meta.mode.value; }
        break;
      }
      case 'pr-link': {
        if (T.meta) {
          const m = T.meta.prLinks;
          m.count += 1;
          const key = `${ev.prRepository ?? ''}#${ev.prNumber ?? ''}`;
          if (!m.items.some((x) => `${x.prRepository ?? ''}#${x.prNumber ?? ''}` === key)) {
            m.items.push({ prNumber: ev.prNumber ?? null, prRepository: ev.prRepository ?? null, prUrl: ev.prUrl ?? null });
          }
        }
        break;
      }
      case 'frame-link': {
        if (T.meta) {
          const m = T.meta.frameLinks;
          m.count += 1;
          if (!m.items.some((x) => x.frameUrl === ev.frameUrl)) {
            m.items.push({ frameUrl: ev.frameUrl ?? null, path: ev.path ?? null, title: ev.title ?? null });
          }
        }
        break;
      }

      default: {
        // Unknown future types must surface (inventory + raw view), never crash.
        T.unknownTypes[type] = (T.unknownTypes[type] || 0) + 1;
        noteRow({ line: L.line, bi: null, kind: `unknown:${type}`, at, head: head(JSON.stringify(ev)), extra: {} }, ev, false);
      }
    }
  }
  if (onBytes) onBytes(rel, bytesDone, true);

  // collapse unknown-event-type problems (identical code+scope -> one row w/ count)
  for (const [type, count] of Object.entries(T.unknownTypes)) {
    T.problems.push({
      code: 'unknown-event-type', severity: 'warning', scope: 'file', file: rel,
      message: `unknown event type "${type}"`, affects: 'display', count,
    });
  }

  // resolve last-prompt leafUuid AFTER the full pass (53 forward references exist)
  if (T.meta && T.meta.lastPrompt.leafUuid && T.uuidLine) {
    T.meta.lastPrompt.leafLine = T.uuidLine.get(T.meta.lastPrompt.leafUuid) ?? null;
  }

  // twin detection (SPEC §8): 859 lines carry the same image twice — the
  // tool_result block copy and the toolUseResult sidecar. Recorded basis: both
  // shapes present on one line, SHA-verified identical corpus-wide. Render the
  // block copy; the sidecar is the noted twin.
  const byLine = new Map();
  for (const im of T.images) {
    let list = byLine.get(im.line);
    if (!list) { list = []; byLine.set(im.line, list); }
    list.push(im);
  }
  for (const list of byLine.values()) {
    const sidecar = list.filter((im) => im.bi === 'r' || im.bi.startsWith('r.'));
    const block = list.filter((im) => !(im.bi === 'r' || im.bi.startsWith('r.')));
    if (sidecar.length > 0 && block.length > 0) {
      for (const s of sidecar) {
        s.twin = true;
        if (s.mediaType === null && block[0].mediaType != null) s.mediaType = block[0].mediaType;
      }
    }
  }

  return T;
}

// ---------------------------------------------------------------------------
// parseSession(sessionEntry, { projectsDir, readLines, stripHeavy, onProgress })
// -> SessionModel (BUILD-CONTRACTS group B).
// ---------------------------------------------------------------------------
export async function parseSession(sessionEntry, opts = {}) {
  const readLinesFn = opts.readLines ?? defaultReadLines;
  const stripHeavyFn = opts.stripHeavy ?? defaultStripHeavy;
  const onProgress = opts.onProgress ?? null;
  const projectsDir = opts.projectsDir ?? sessionEntry.projectsDir;
  if (!projectsDir) throw new Error('parseSession: projectsDir is required (opts.projectsDir or sessionEntry.projectsDir)');
  const abs = (rel) => path.join(projectsDir, rel);

  const problems = [];
  const files = sessionEntry.files ?? [];

  // classify the session's file tree (SPEC §2 — 10 patterns, verified exhaustive;
  // anything else is tolerated and disclosed)
  const agentFiles = []; // {rel, runId|null, agentId}
  const metaByAgent = new Map(); // agentId -> rel
  const journals = []; // {rel, runId}
  const manifests = new Map(); // runId -> rel  (session-dir workflows/<wf>.json, NOT under subagents/)
  const scripts = []; // {rel, runId|null}
  const spillFiles = []; // rel under tool-results/
  for (const rel of files) {
    if (sessionEntry.mainRel && rel === sessionEntry.mainRel) continue;
    let m;
    if ((m = AGENT_FILE_RE.exec(rel))) { agentFiles.push({ rel, runId: m[1] ?? null, agentId: m[2] }); continue; }
    if ((m = AGENT_META_RE.exec(rel))) { metaByAgent.set(m[2], rel); continue; }
    if ((m = JOURNAL_RE.exec(rel))) { journals.push({ rel, runId: m[1] }); continue; }
    if (!rel.includes('/subagents/') && (m = MANIFEST_RE.exec(rel))) { manifests.set(m[1], rel); continue; }
    if (SCRIPT_RE.test(rel)) {
      const idm = WF_ID_RE.exec(rel.slice(rel.lastIndexOf('/') + 1));
      scripts.push({ rel, runId: idm ? idm[0] : null });
      continue;
    }
    if (TOOL_RESULTS_RE.test(rel)) { spillFiles.push(rel); continue; }
    problems.push({
      code: 'unclassified-file', severity: 'note', scope: 'session', slug: sessionEntry.slug, id: sessionEntry.id,
      file: rel, message: 'file does not match any of the 10 store patterns', affects: 'display', count: 1,
    });
  }
  agentFiles.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  // progress accounting is in BYTES consumed (SPEC §1), never lines
  const bytesTotal = sessionEntry.bytes ?? null;
  let bytesBase = 0;
  let lastFileBytes = 0;
  const emitProgress = (file, fileBytes, fileDone, agentIndex, agentCount) => {
    if (!onProgress) return;
    lastFileBytes = fileBytes;
    onProgress({
      file, bytesDone: bytesBase + fileBytes, bytesTotal,
      agentIndex: agentIndex ?? null, agentCount: agentCount ?? null,
    });
    if (fileDone) { bytesBase += fileBytes; lastFileBytes = 0; }
  };

  const agentToolUseDesc = new Map();
  const toolsFor = (agentIndex, agentCount) => ({
    readLines: readLinesFn,
    stripHeavy: stripHeavyFn,
    agentToolUseDesc,
    sessionId: sessionEntry.id, // R2 clause (i) harvest (main tier only)
    onBytes: (file, b, done) => emitProgress(file, b, done, agentIndex, agentCount),
  });

  // ---- main transcript --------------------------------------------------
  let mainT = null;
  if (sessionEntry.mainRel) {
    try {
      mainT = await parseTranscript(abs(sessionEntry.mainRel), sessionEntry.mainRel, 'main', toolsFor(null, agentFiles.length));
    } catch (err) {
      problems.push({
        code: 'file-unreadable', severity: 'error', scope: 'file', slug: sessionEntry.slug, id: sessionEntry.id,
        file: sessionEntry.mainRel, message: `main transcript unreadable: ${err.code || err.message}`,
        affects: 'aggregates', count: 1,
      });
    }
  }

  // ---- journals (started/result only, no timestamps, no uuids; join on agentId
  //      ONLY — the v2:<64hex> key is NOT unique) ---------------------------
  const journalByRun = new Map(); // runId -> { startedByAgent: Map, resultByAgent: Map, startedCount, resultCount }
  const journalOnly = [];
  for (const j of journals) {
    const J = { rel: j.rel, startedByAgent: new Map(), resultByAgent: new Map(), startedCount: 0, resultCount: 0 };
    journalByRun.set(j.runId, J);
    try {
      for await (const L of readLinesFn(abs(j.rel))) {
        let ev;
        try { ev = JSON.parse(stripHeavyFn(L.text).text); } catch {
          problems.push({
            code: 'torn-line', severity: 'error', scope: 'line', file: j.rel,
            line: L.line, byteOffset: L.byteOffset, bytes: L.bytes,
            message: 'journal line failed JSON.parse; skipped', affects: 'display', count: 1,
          });
          continue;
        }
        const aid = ev.agentId;
        if (ev.type === 'started') {
          J.startedCount += 1;
          if (typeof aid === 'string') J.startedByAgent.set(aid, (J.startedByAgent.get(aid) || 0) + 1);
        } else if (ev.type === 'result') {
          J.resultCount += 1;
          if (typeof aid === 'string') {
            const r = ev.result;
            const empty = r == null || r === '';
            J.resultByAgent.set(aid, { count: (J.resultByAgent.get(aid)?.count || 0) + 1, empty });
          }
        }
      }
    } catch (err) {
      problems.push({
        code: 'file-unreadable', severity: 'warning', scope: 'file', file: j.rel,
        message: `journal unreadable: ${err.code || err.message}`, affects: 'display', count: 1,
      });
    }
  }

  // ---- workflow manifests (written at COMPLETION only — a running workflow has
  //      agents + journal but no wf_*.json) --------------------------------
  const manifestByRun = new Map(); // runId -> slim record
  for (const [runId, rel] of manifests) {
    try {
      const raw = JSON.parse(await fsp.readFile(abs(rel), 'utf8'));
      const progressByAgent = new Map();
      let progressAgentCount = 0;
      const phases = [];
      if (Array.isArray(raw.workflowProgress)) {
        for (const e of raw.workflowProgress) {
          if (!e || typeof e !== 'object') continue;
          if (e.type === 'workflow_phase') { phases.push({ index: e.index ?? null, title: e.title ?? null }); continue; }
          if (e.type !== 'workflow_agent') continue;
          progressAgentCount += 1;
          if (typeof e.agentId === 'string') {
            progressByAgent.set(e.agentId, {
              label: e.label ?? null, phaseIndex: e.phaseIndex ?? null, phaseTitle: e.phaseTitle ?? null,
              model: e.model ?? null, state: e.state ?? null,
              queuedAt: tsMsLoose(e.queuedAt), startedAt: tsMsLoose(e.startedAt),
              durationMs: e.durationMs ?? null,
              tokens: e.tokens ?? null, toolCalls: e.toolCalls ?? null,
              cached: e.cached === true, attempt: e.attempt ?? null,
              isolation: e.isolation ?? null, error: e.error ?? null,
              lastToolName: e.lastToolName ?? null,
            });
          }
        }
      }
      manifestByRun.set(runId, {
        rel,
        status: raw.status ?? null, workflowName: raw.workflowName ?? null, taskId: raw.taskId ?? null,
        startTime: tsMsLoose(raw.startTime),
        durationMs: raw.durationMs ?? null,
        endTime: tsMsLoose(raw.timestamp),
        defaultModel: raw.defaultModel ?? null,
        agentCount: raw.agentCount ?? null,
        // recorded gauges, NOT usage (5.6x real output — SPEC §7); toolCalls IS exact
        totalTokens: raw.totalTokens ?? null, totalToolCalls: raw.totalToolCalls ?? null,
        hasArgs: raw.args !== undefined, hasScript: typeof raw.script === 'string',
        scriptPath: raw.scriptPath ?? null,
        phases, progressByAgent, progressAgentCount,
      });
    } catch (err) {
      problems.push({
        code: 'file-unreadable', severity: 'warning', scope: 'file', file: rel,
        message: `workflow manifest unreadable/unparseable: ${err.code || err.message}`,
        affects: 'display', count: 1,
      });
    }
  }

  // ---- agent transcripts -------------------------------------------------
  const agentTs = new Map(); // agentId -> parsed transcript T
  const agentEntries = new Map(); // agentId -> {rel, runId}
  for (let i = 0; i < agentFiles.length; i++) {
    const a = agentFiles[i];
    agentEntries.set(a.agentId, a);
    try {
      agentTs.set(a.agentId, await parseTranscript(abs(a.rel), a.rel, 'agent', toolsFor(i + 1, agentFiles.length)));
    } catch (err) {
      problems.push({
        code: 'file-unreadable', severity: 'error', scope: 'file', agentId: a.agentId, file: a.rel,
        message: `agent transcript unreadable: ${err.code || err.message}`, affects: 'aggregates', count: 1,
      });
    }
  }

  // ---- agent meta sidecars (100% coverage measured; absence tolerated) ----
  const metaOf = new Map();
  for (const [agentId, rel] of metaByAgent) {
    try {
      metaOf.set(agentId, JSON.parse(await fsp.readFile(abs(rel), 'utf8')));
    } catch (err) {
      problems.push({
        code: 'file-unreadable', severity: 'warning', scope: 'file', agentId, file: rel,
        message: `agent meta unreadable/unparseable: ${err.code || err.message}`, affects: 'display', count: 1,
      });
    }
  }

  // ---- turn scaffolding for attribution ----------------------------------
  const turns = mainT?.turns ?? null;
  const openers = mainT?.openers ?? [];
  const turnOfLine = (line) => {
    if (!turns) return null;
    let idx = 0;
    for (let i = 0; i < openers.length; i++) {
      if (openers[i].line <= line) idx = i + 1; else break;
    }
    return idx;
  };
  // total time windows (SPEC §4): [opener ts, next opener ts), last -> +inf,
  // before first -> turn 0; starts clamped to the running max of prior openers.
  const windows = [];
  {
    let runMax = -Infinity;
    for (let i = 0; i < openers.length; i++) {
      let start = openers[i].at;
      if (start != null && start < runMax) {
        problems.push({
          // custom code — SPEC §9: unknown Problem codes render as the raw string
          code: 'opener-order-clamped', severity: 'note', scope: 'session', slug: sessionEntry.slug, id: sessionEntry.id,
          message: `opener at line ${openers[i].line} is earlier than a prior opener; window start clamped (SPEC §4)`,
          affects: 'display', count: 1,
        });
        start = runMax;
      }
      if (start != null) runMax = Math.max(runMax, start);
      windows.push(start);
    }
  }
  const turnOfTs = (ts) => {
    if (!turns || ts == null) return null;
    let idx = 0;
    for (let i = 0; i < windows.length; i++) {
      if (windows[i] != null && windows[i] <= ts) idx = i + 1; else if (windows[i] != null) break;
    }
    return idx;
  };

  // ---- workflow runId -> first spawning call (resumed runs belong to the turn
  //      of the FIRST spawning call — SPEC §7) ------------------------------
  const runSpawns = new Map(); // runId -> {lines:[...], resumeLines:[...], firstLine, resume:bool}
  if (mainT?.runIdEdges) {
    for (const e of mainT.runIdEdges) {
      let r = runSpawns.get(e.runId);
      if (!r) { r = { lines: [], resumeLines: [], firstLine: null, resume: false }; runSpawns.set(e.runId, r); }
      if (!r.lines.includes(e.line)) r.lines.push(e.line);
      if (e.resume) { r.resume = true; if (!r.resumeLines.includes(e.line)) r.resumeLines.push(e.line); }
    }
    for (const r of runSpawns.values()) {
      r.lines.sort((a, b) => a - b);
      r.firstLine = r.lines[0] ?? null;
      // every spawn line past the FIRST is a resume reference, whether it was
      // recorded via input.resumeFromRunId or only via tool_result text — the
      // run's transcript already existed when that call named it (SPEC §7)
      for (const l of r.lines) if (l !== r.firstLine && !r.resumeLines.includes(l)) r.resumeLines.push(l);
      r.resumeLines.sort((a, b) => a - b);
    }
  }

  // ---- run dirs from disk (enumeration source) ----------------------------
  const runIds = new Set([
    ...agentFiles.filter((a) => a.runId).map((a) => a.runId),
    ...journals.map((j) => j.runId),
    ...manifests.keys(),
  ]);

  // ---- assemble AgentModels ----------------------------------------------
  const agents = [];
  const agentById = new Map();
  // resolve depth-1 first so children can attribute transitively
  const order = [...agentFiles].sort((a, b) => {
    const da = metaOf.get(a.agentId)?.spawnDepth ?? 1;
    const db = metaOf.get(b.agentId)?.spawnDepth ?? 1;
    return da - db || (a.rel < b.rel ? -1 : 1);
  });
  for (const a of order) {
    const T = agentTs.get(a.agentId);
    const meta = metaOf.get(a.agentId) ?? null;
    const runId = a.runId;
    const progress = runId ? (manifestByRun.get(runId)?.progressByAgent.get(a.agentId) ?? null) : null;
    const journal = runId ? journalByRun.get(runId) ?? null : null;
    const jStarted = journal ? (journal.startedByAgent.get(a.agentId) || 0) : 0;
    const jResult = journal ? journal.resultByAgent.get(a.agentId) ?? null : null;
    const resultInfo = mainT?.agentResultInfo?.get(a.agentId) ?? null;

    // lineage + turn attribution (SPEC §7: recorded edges only; time-window
    // fallback ONLY for agents with no recorded spawn edge, and it prints)
    let lineage;
    let turnIdx = null;
    let attributedBy = null;
    if (runId) {
      const spawn = runSpawns.get(runId);
      if (spawn && spawn.firstLine != null && turns) {
        lineage = { kind: 'workflow', runId, spawnLine: spawn.firstLine };
        turnIdx = turnOfLine(spawn.firstLine);
        attributedBy = 'runId';
      } else {
        lineage = { kind: 'orphan', runId };
        turnIdx = turnOfTs(T?.firstAt ?? null);
        attributedBy = turnIdx == null ? null : 'time-window';
      }
    } else if (meta?.parentAgentId) {
      const parent = agentById.get(meta.parentAgentId);
      lineage = { kind: 'child', parentAgentId: meta.parentAgentId, toolUseId: meta.toolUseId ?? null };
      if (parent) {
        turnIdx = parent.turnIdx;
        attributedBy = 'parentAgentId';
      } else {
        turnIdx = turnOfTs(T?.firstAt ?? null);
        attributedBy = turnIdx == null ? null : 'time-window';
        lineage.kind = 'orphan';
      }
    } else if (meta?.toolUseId && mainT?.toolUseIndex?.has(meta.toolUseId)) {
      const tu = mainT.toolUseIndex.get(meta.toolUseId);
      lineage = { kind: 'plain', toolUseId: meta.toolUseId, spawnLine: tu.line };
      turnIdx = turnOfLine(tu.line);
      attributedBy = 'toolUseId';
    } else {
      lineage = { kind: 'orphan', toolUseId: meta?.toolUseId ?? null };
      turnIdx = turnOfTs(T?.firstAt ?? null);
      attributedBy = turnIdx == null ? null : 'time-window';
    }

    // label ladder (SPEC §7 — all recorded, source shown):
    // workflowProgress.label > [AGENT: x] prompt tag > Agent input.description >
    // meta.description > "<agentType> <id>"
    let tag = null;
    if (T?.firstPrompt?.text) {
      const m = /\[AGENT:\s*([^\]]+)\]/.exec(T.firstPrompt.text.slice(0, 500));
      if (m) tag = m[1].trim();
    }
    let label;
    const spawnDesc = (meta?.toolUseId ? agentToolUseDesc.get(meta.toolUseId)?.description : null)
      ?? resultInfo?.description ?? null;
    if (progress?.label) label = { text: progress.label, source: 'workflowProgress' };
    else if (tag) label = { text: tag, source: 'prompt-tag' };
    else if (spawnDesc) label = { text: spawnDesc, source: 'input.description' };
    else if (meta?.description) label = { text: meta.description, source: 'meta.description' };
    else label = { text: `${meta?.agentType ?? 'agent'} ${a.agentId}`, source: 'fallback' };

    // recorded state signature (SPEC §7 — named by fact, not diagnosis)
    let state = null;
    const manifestExists = runId ? manifestByRun.has(runId) : false;
    if (progress) {
      state = progress.state; // 'done' | 'error' (only observed values)
    } else if (runId && manifestExists && jStarted > 0) {
      // a COMPLETED manifest that omits this agent supersedes it — whether or
      // not a journal result was recorded (measured: one run's 5 retry
      // orphans are started-without-result AND absent from the manifest)
      state = 'superseded';
    } else if (runId && !manifestExists && jStarted > 0 && !jResult) {
      state = 'running'; // journal records a start, no result yet (glyph source: journal)
    }
    // (no manifest + journal result = completed-but-unmanifested in-flight run:
    // state stays null — unknown, disclosed via stateFacts, never guessed)

    const model = {
      agentId: a.agentId,
      rel: a.rel,
      runId,
      meta,
      rows: T?.rows ?? [],
      firstAt: T?.firstAt ?? null,
      lastAt: T?.lastAt ?? null,
      lineage,
      turnIdx,
      attributedBy,
      label,
      tag,
      state,
      stateFacts: {
        manifestState: progress?.state ?? null,
        cached: progress?.cached === true,
        attempt: progress?.attempt ?? null,
        inManifest: !!progress,
        manifestExists,
        journalStarted: jStarted,
        journalResult: !!jResult,
        resultEmpty: jResult ? jResult.empty === true : null,
        spawnStatus: resultInfo?.status ?? null,
      },
      progress,
      resolvedModel: resultInfo?.resolvedModel ?? null,
      models: T ? [...T.models.keys()] : [],
      counts: {
        events: T?.events ?? 0, rows: T?.rows.length ?? 0, lines: T?.lines ?? 0,
        toolCalls: T?.toolCalls ?? 0,
        images: T ? T.images.filter((im) => !im.twin).length : 0,
        textChars: T?.textChars ?? 0, thinkingChars: T?.thinkingChars ?? 0,
      },
    };
    agents.push(model);
    agentById.set(a.agentId, model);
  }
  agents.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // `meta.parentAgentId` is read verbatim from an untrusted .meta.json
  // sidecar and passed straight through (the lookup above is a single Map.get,
  // never a walk). If two sidecars name each other — or a chain returns to its
  // own start — every member has a resolvable recorded parent and none is a
  // lineage root, which is a shape the L3 tree can only render by breaking the
  // cycle. Nothing is repaired here; the recorded fields ship unchanged. The
  // condition is DISCLOSED so the repair the client performs is a stated fact
  // rather than a silent one. Corpus-wide this fires on nothing (0 of 814
  // sidecars record a parent that itself records a parent) — it is the
  // malformed/hostile-sidecar case, said out loud instead of dropped.
  const lineageCycles = [];
  for (const ag of agents) {
    const seen = new Set();
    let cur = ag;
    while (cur?.meta?.parentAgentId && agentById.has(cur.meta.parentAgentId)) {
      if (seen.has(cur.agentId)) break;
      seen.add(cur.agentId);
      cur = agentById.get(cur.meta.parentAgentId);
      if (cur === ag) { lineageCycles.push(ag.agentId); break; }
    }
  }
  if (lineageCycles.length) {
    const ids = [...lineageCycles].sort();
    problems.push({
      // custom code — SPEC §9: unknown Problem codes render as the raw string
      code: 'agent-lineage-cycle', severity: 'warning', scope: 'session',
      slug: sessionEntry.slug, id: sessionEntry.id,
      message: `${ids.length} agents' recorded parentAgentId chains form a cycle: ${ids.join(', ')} — each named agent's .meta.json sidecar records a parent whose own chain leads back to it, so none of them is a lineage root. The recorded fields are passed through unchanged; the orchestration tree shows these agents unnested.`,
      affects: 'display', count: ids.length,
    });
  }

  // journal entries whose agentId has NO transcript on disk (expected 0)
  for (const [runId, J] of journalByRun) {
    for (const [aid, n] of J.startedByAgent) {
      if (!agentEntries.has(aid)) {
        journalOnly.push({ runId, agentId: aid, startedCount: n, hasResult: J.resultByAgent.has(aid) });
      }
    }
  }

  // ---- WorkflowModels -----------------------------------------------------
  const workflows = [];
  for (const runId of [...runIds].sort()) {
    const man = manifestByRun.get(runId) ?? null;
    const J = journalByRun.get(runId) ?? null;
    const spawn = runSpawns.get(runId) ?? null;
    const wfAgents = agents.filter((ag) => ag.runId === runId).map((ag) => ag.agentId);
    workflows.push({
      runId,
      manifestRel: man?.rel ?? null,
      journalRel: J?.rel ?? null,
      scriptRels: scripts.filter((s) => s.runId === runId).map((s) => s.rel),
      agentIds: wfAgents,
      spawnLines: spawn?.lines ?? [],
      firstSpawnLine: spawn?.firstLine ?? null,
      turnIdx: spawn?.firstLine != null && turns ? turnOfLine(spawn.firstLine) : null,
      resumed: (spawn?.resume === true) || (spawn?.lines.length ?? 0) > 1,
      // The turns whose calls RESUME this run (recorded resume edges only).
      // The run stays counted in turnIdx; each turn listed here renders the
      // link-only reference row (SPEC §7).
      resumedInTurns: spawn && turns
        ? [...new Set(spawn.resumeLines.map((l) => turnOfLine(l)))].sort((a, b) => a - b)
        : [],
      running: !man && !!J && [...J.startedByAgent.keys()].some((aid) => !J.resultByAgent.has(aid)),
      journal: J ? { startedCount: J.startedCount, resultCount: J.resultCount } : null,
      record: man ? {
        status: man.status, workflowName: man.workflowName, taskId: man.taskId,
        startTime: man.startTime, durationMs: man.durationMs, endTime: man.endTime,
        defaultModel: man.defaultModel, agentCount: man.agentCount,
        totalTokens: man.totalTokens, totalToolCalls: man.totalToolCalls,
        hasArgs: man.hasArgs, hasScript: man.hasScript, scriptPath: man.scriptPath,
        phases: man.phases, progressAgentCount: man.progressAgentCount,
      } : null,
    });
  }
  // spawn edges that name a run with no dir here (fork-copied spawn lines from a
  // session that does not own the run — SPEC §7 attribution scoping): disclosed.
  for (const [runId, spawn] of runSpawns) {
    if (!runIds.has(runId)) {
      problems.push({
        // custom code — SPEC §9: unknown Problem codes render as the raw string
        code: 'workflow-call-unresolved', severity: 'note', scope: 'session', slug: sessionEntry.slug, id: sessionEntry.id,
        message: `Workflow call at line ${spawn.firstLine} names ${runId}, but no run dir exists in this session (failed launch or fork-copied spawn line — never claims agents)`,
        affects: 'nothing', count: 1,
      });
    }
  }

  // ---- inventory ---------------------------------------------------------
  const perType = {};
  const attachmentKinds = {};
  const images = [];
  const spillRefs = [];
  const filesLedger = [];
  const allProblems = [...problems];
  const sessionIdsSeen = new Map();
  let totalLines = 0;
  let totalEvents = 0;
  let toolCalls = 0;
  let textChars = 0;
  let thinkingChars = 0;
  let mainToolCallsWithPath = 0;
  let agentToolCallsWithPath = 0;
  let agentResultsNoSidecar = 0;
  const assistantLines = [];

  const fold = (T) => {
    if (!T) return;
    totalLines += T.lines;
    totalEvents += T.events;
    toolCalls += T.toolCalls;
    textChars += T.textChars;
    thinkingChars += T.thinkingChars;
    for (const [k, v] of Object.entries(T.perType)) perType[k] = (perType[k] || 0) + v;
    for (const [k, v] of Object.entries(T.attachmentKinds)) attachmentKinds[k] = (attachmentKinds[k] || 0) + v;
    for (const im of T.images) images.push(im);
    for (const s of T.spillRefs) spillRefs.push(s);
    for (const f of T.filesLedger) {
      filesLedger.push(f);
      if (f.op !== 'sidecar') {
        if (f.tier === 'main') mainToolCallsWithPath += 1; else agentToolCallsWithPath += 1;
      }
    }
    for (const p of T.problems) allProblems.push(p);
    for (const [sid, n] of T.sessionIds) sessionIdsSeen.set(sid, (sessionIdsSeen.get(sid) || 0) + n);
    for (const al of T.assistantLines) assistantLines.push(al);
    agentResultsNoSidecar += T.resultsNoSidecar;
  };
  fold(mainT);
  for (const a of agentFiles) fold(agentTs.get(a.agentId));
  for (const J of journalByRun.values()) {
    totalEvents += J.startedCount + J.resultCount;
    perType.started = (perType.started || 0) + J.startedCount;
    perType.result = (perType.result || 0) + J.resultCount;
  }

  // spill link rule is EXACT-MATCH only (SPEC §8); unreferenced spills disclosed
  const refPaths = new Set(spillRefs.map((s) => s.path.replace(/\\\\/g, '\\').toLowerCase()));
  const spillFilesOut = spillFiles.map((rel) => {
    const absPath = path.resolve(projectsDir, rel).toLowerCase();
    return { rel, referenced: refPaths.has(absPath) };
  });
  for (const sf of spillFilesOut) {
    if (!sf.referenced) {
      allProblems.push({
        code: 'unreferenced-spill', severity: 'note', scope: 'file', file: sf.rel,
        message: 'spill file not referenced from any transcript (still viewable)',
        affects: 'nothing', count: 1,
      });
    }
  }

  // live evidence: an unterminated tail (bytes past the final \n) means the
  // writer is mid-append. Recorded per transcript by comparing the bytes the
  // reader consumed (whole lines only — SPEC §1 holdback) against a fresh stat.
  let tailBytes = 0;
  const tailCheck = [];
  if (sessionEntry.mainRel && mainT) tailCheck.push({ rel: sessionEntry.mainRel, T: mainT });
  for (const a of agentFiles) {
    const T = agentTs.get(a.agentId);
    if (T) tailCheck.push({ rel: a.rel, T });
  }
  for (const { rel, T } of tailCheck) {
    try {
      const st = await fsp.stat(abs(rel));
      if (st.size > T.consumedBytes) tailBytes += st.size - T.consumedBytes;
    } catch { /* transient; stat failures on transcripts surface elsewhere */ }
  }

  const model = {
    id: sessionEntry.id,
    slug: sessionEntry.slug,
    fragmentDirs: sessionEntry.fragmentDirs ?? [],
    bytes: sessionEntry.bytes ?? null,
    files: files.length,
    lines: totalLines,
    main: mainT ? {
      rel: sessionEntry.mainRel,
      rows: mainT.rows,
      turns: mainT.turns,
      meta: {
        ...mainT.meta,
        cwd: mainT.meta.cwds.find((c) => c.replace(/[\\/:. ]/g, '-') === sessionEntry.slug) ?? null,
        version: mainT.meta.versions.length ? mainT.meta.versions[mainT.meta.versions.length - 1] : null,
        firstAt: mainT.firstAt,
        lastAt: mainT.lastAt,
        r2FirstTsMs: mainT.r2FirstTsMs, // R2(ii): first file-ordered record CARRYING a ts
        foreignMsgIds: [...(mainT.foreignMsgIds ?? [])], // R2(i) evidence
        msgIds: mainT.msgIds,
        embeddedSidechainRows: mainT.embeddedSidechainRows,
        models: [...mainT.models.keys()],
      },
    } : null,
    agents,
    workflows,
    journalOnly,
    inventory: {
      perType,
      attachmentKinds,
      images,
      spills: spillRefs,
      spillFiles: spillFilesOut,
      filesLedger,
      filesLedgerDenominators: {
        mainToolCallsWithPath,
        agentToolCallsWithPath,
        agentResultsNoSidecar,
      },
      sessionIdsSeen: [...sessionIdsSeen.keys()],
      counts: {
        events: totalEvents, lines: totalLines, toolCalls, textChars, thinkingChars,
        images: images.filter((im) => !im.twin).length,
        imageBlocks: images.length,
        agents: agents.length,
        workflows: workflows.length,
        tornLines: allProblems.filter((p) => p.code === 'torn-line').reduce((n, p) => n + p.count, 0),
      },
      problems: allProblems,
    },
    assistantLines,
    live: tailBytes > 0,
  };
  return model;
}
