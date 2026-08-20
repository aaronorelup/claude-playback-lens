// tests/extract-fixtures.mjs — reads a Claude Code projects corpus READ-ONLY
// and writes small fixtures into tests/fixtures/**.
//
//   node tests/extract-fixtures.mjs            (corpus: %USERPROFILE%\.claude\projects,
//                                               override with LENS_CORPUS)
//
// PRIVACY RULE (load-bearing — this repo is public):
//   Committed fixtures must NEVER carry real corpus strings. Every extracted
//   line passes through the redaction stage below before it is written:
//   session/line UUIDs, message ids, tool_use ids, request ids, workflow run
//   ids and agent ids are replaced with synthetic same-length counterparts;
//   cwd and gitBranch are neutralised; and every prose body (user text,
//   assistant text, thinking, tool results, titles, attachments) is replaced
//   with filler of identical UTF-8 byte length. The manifest records
//   "<redacted>" for the corpus root and a neutral slug path for sourceRel.
//   If you extend this script, route every new string through redactEvent().
//
// CONFIG below names the corpus locations the cases come from. The committed
// values are PLACEHOLDERS — the maintainer sets them locally (they describe a
// private corpus) to regenerate; the redaction stage keeps the OUTPUT clean
// either way.
//
// Reader contract (SPEC §1): lines split on \n ONLY — U+2028/U+2029 are legal
// inside JSON strings and present in real corpora; node:readline is forbidden.
// Bytes after the final \n (the unterminated tail of a live file) are held
// back. Base64 payloads (>=500 chars) and long thinking `signature` values are
// stripped so fixtures stay small; the recorded JSON structure is otherwise
// preserved shape-for-shape and byte-length-for-byte-length.
//
// Cases extracted (SPEC §5 rule provenance):
//   r2a-proja-*             a fork pair that KEEPS the original sessionId on
//                           its copies and TIES on the first-timestamped-record
//                           rule (clause (i) evidence)
//   r2b-projb-*             a fork pair whose resumed file opens with an
//                           untimestamped custom-title (clause (ii) evidence:
//                           the skip-untimestamped rule is load-bearing)
//   r3-fallback-*           fallback messages with usage.iterations length 2
//                           (the R3 split + field-provenance fixture)
//   r4-synthetic            a <synthetic> line (usage.iterations === null)
//   r6a-never-finalized     a group whose lines all carry stop_reason null and
//                           whose kept line has NO iterations key
//   r6b-empty-iterations    stop_reason end_turn with an EMPTY iterations
//                           array (both fork copies)
//   r1-agent-multiline      multi-line message.id group with PROGRESSING output
//                           (only agent tiers progress; main groups are uniform)
//
// Every fixture ships with provenance in tests/fixtures/manifest.json.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// =============================================================================
// CONFIG — placeholders in the committed file; set locally to regenerate.
// =============================================================================
const CONFIG = {
  // R2a: store-dir suffix + the two .jsonl basenames of the clause-(i) fork
  // pair, and the preferred duplicated message id.
  r2a: {
    projectSuffix: '<r2a-project-dir-suffix>',
    pair: ['<r2a-original-session-uuid>.jsonl', '<r2a-forked-session-uuid>.jsonl'],
    preferredDupId: '<r2a-dup-msg-id>',
    shortName: 'proja', // used in the fixture/case name
  },
  // R2b: store-dir suffix of the clause-(ii) pair (the pair itself is
  // discovered by scanning for an untimestamped custom-title opener), and the
  // message id whose group carries the EMPTY iterations array (R6b).
  r2b: {
    projectSuffix: '<r2b-project-dir-suffix>',
    emptyIterId: '<r6b-empty-iterations-msg-id>',
    shortName: 'projb',
  },
  // The live project (this app's own sessions) — excluded from generic scans
  // so fixtures stay stable across re-runs.
  liveProjectHint: 'Claude-Playback-Lens',
};

const CORPUS = process.env.LENS_CORPUS ?? path.join(os.homedir(), '.claude', 'projects');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

if (!existsSync(CORPUS)) {
  console.error(`corpus not found: ${CORPUS}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// =============================================================================
// Redaction stage — every string that reaches disk goes through this.
// Substitutions are same-byte-length so recorded offsets/sizes stay honest.
// =============================================================================
const escLen = (s) => Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;

function counterMap(prefix, width) {
  const map = new Map();
  return (real) => {
    if (!map.has(real)) map.set(real, map.size + 1);
    return prefix + String(map.get(real)).padStart(width, '0');
  };
}
const uuidCounter = counterMap('', 12);
const mapUuid = (u) => (/^([0-9a-f])\1{7}-/.test(u) ? u : `0000000a-0000-4000-8000-${uuidCounter(u.toLowerCase())}`);
const msgCounter = counterMap('', 0);
const mapMsg = (m) => (m.startsWith('msg_011A') ? m
  : 'msg_011A' + String(msgCounter(m)).padStart(m.length - 8, '0'));
const touluCounter = counterMap('', 0);
const mapToolu = (t) => (/^toolu_01A0*\d+$/.test(t) ? t
  : 'toolu_01A' + String(touluCounter(t)).padStart(t.length - 9, '0'));
const reqCounter = counterMap('', 0);
const mapReq = (r) => 'req_011A' + String(reqCounter(r)).padStart(r.length - 8, '0');
const wfCounter = counterMap('', 0);
const mapWf = (w) => {
  const n = wfCounter(w);
  return `wf_${String(n).padStart(8, '0')}-a${String(n).padStart(2, '0')}`;
};
const agentCounter = counterMap('', 16);
const mapAgent = (a) => (/^a0{9,}\d+$/.test(a) ? a : 'a' + agentCounter(a));
// store-dir slugs: each distinct real project slug becomes proj-a, proj-b, …
const slugCounter = counterMap('', 0);
const mapSlug = (slug) => `C--Users-userx-projects-proj-${'abcdefghijklmnopqrstuvwxyz'[(slugCounter(slug) - 1) % 26]}`;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MSGTOK_RE = /msg_[A-Za-z0-9]{10,}/g;
const TOOLU_RE = /toolu_[A-Za-z0-9]{10,}/g;
const REQTOK_RE = /req_[A-Za-z0-9]{10,}/g;
const WFTOK_RE = /wf_[0-9a-f]{8}-[0-9a-f]{3}/g;
const AGENTF_RE = /agent-a[0-9a-f]{16}/g;
const subTokens = (s) => s
  .replace(UUID_RE, (m) => mapUuid(m))
  .replace(MSGTOK_RE, (m) => mapMsg(m))
  .replace(TOOLU_RE, (m) => mapToolu(m))
  .replace(REQTOK_RE, (m) => mapReq(m))
  .replace(WFTOK_RE, (m) => mapWf(m))
  .replace(AGENTF_RE, (m) => 'agent-' + mapAgent(m.slice(6)));

// prose filler: preserves <tag> skeletons and total escaped byte length
const TAGTOK_RE = /<\/?[A-Za-z][A-Za-z0-9_-]*>/g;
const FILLER = 'sample redacted fixture text ';
const fillerOf = (n) => (n <= 0 ? '' : FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n));
function proseFiller(s) {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(TAGTOK_RE)) {
    out += fillerOf(escLen(s.slice(last, m.index))) + m[0];
    last = m.index + m[0].length;
  }
  return out + fillerOf(escLen(s.slice(last)));
}

const KEEP_KEYS = new Set([
  'type', 'subtype', 'role', 'model', 'timestamp', 'version', 'userType',
  'entrypoint', 'permissionMode', 'promptSource', 'effort', 'kind',
  'stop_reason', 'stopReason', 'level', 'operation', 'mode', 'speed',
  'service_tier', 'serviceTier', 'media_type', 'mediaType', 'mimeType',
  'signature', 'name', 'state', 'status', 'stop_sequence', 'isoDate',
]);
const PROSE_KEYS = new Set([
  'content', 'text', 'thinking', 'customTitle', 'aiTitle', 'prompt',
  'lastPrompt', 'summary', 'description', 'data', 'base64', 'stdout',
  'stderr', 'title', 'head', 'error',
]);

function redactString(key, s) {
  if (s === '') return s;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return mapUuid(s);
  if (/^msg_[A-Za-z0-9]{10,}$/.test(s)) return mapMsg(s);
  if (/^toolu_[A-Za-z0-9]{10,}$/.test(s)) return mapToolu(s);
  if (/^req_[A-Za-z0-9]{10,}$/.test(s)) return mapReq(s);
  if (/^wf_[0-9a-f]{8}-[0-9a-f]{3}$/.test(s)) return mapWf(s);
  if (key === 'agentId' && /^a[0-9a-f]{16}$/.test(s)) return mapAgent(s);
  if (key === 'cwd') {
    const base = 'C:\\Users\\userx\\projects\\proj-x';
    return base + 'x'.repeat(Math.max(0, escLen(s) - escLen(base)));
  }
  if (key === 'gitBranch') {
    if (s === 'main' || s === 'master' || s === 'HEAD') return s;
    const base = 'feature/sample-branch';
    return (base + 'x'.repeat(Math.max(0, escLen(s) - base.length))).slice(0, Math.max(1, escLen(s)));
  }
  const s2 = subTokens(s);
  if (KEEP_KEYS.has(key)) return s2;
  if (PROSE_KEYS.has(key)) return proseFiller(s2);
  if (escLen(s2) <= 30 && !s2.includes('\\') && !s2.includes('C:')) return s2;
  return proseFiller(s2);
}

function redactEvent(v, key = null) {
  if (typeof v === 'string') return redactString(key, v);
  if (Array.isArray(v)) return v.map((x) => redactEvent(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = redactEvent(val, k);
    return o;
  }
  return v;
}

// sourceRel: real "slug/inner/path" -> neutral slug + id-mapped inner path
function redactRel(relPath) {
  const [slug, ...restParts] = relPath.split('/');
  const rest = restParts.join('/');
  return `${mapSlug(slug)}/${subTokens(rest)}`;
}

// notes objects hold ids and measured figures, never prose bodies — map the
// ids, keep the rest verbatim.
const redactNotes = (notes) => JSON.parse(subTokens(JSON.stringify(notes)));

// --- \n-only reader -----------------------------------------------------------
function readLines(absPath) {
  let text = readFileSync(absPath).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // tolerate a BOM (none observed)
  const parts = text.split('\n'); // \n ONLY — never readline
  // terminated file: last element is ''; unterminated: last element is the
  // held-back tail. Either way the final element is not a complete line.
  const lines = [];
  for (let i = 0; i < parts.length - 1; i++) {
    let t = parts[i];
    if (t.endsWith('\r')) t = t.slice(0, -1);
    lines.push({ line: i + 1, text: t }); // 1-based, as an editor shows it
  }
  return lines;
}

// --- base64 / signature strip (fixture-size control only) ---------------------
const B64_RE = /"(data|base64)":"[A-Za-z0-9+/=]{500,}"/g;
const SIG_RE = /"signature":"[A-Za-z0-9+/=_-]{200,}"/g;
function stripHeavy(text) {
  return text.replace(B64_RE, '"$1":""').replace(SIG_RE, '"signature":""');
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstTimestamped(lines) {
  for (const l of lines) {
    // cheap pre-filter, then parse for the recorded value
    if (!l.text.includes('"timestamp":"')) continue;
    const o = tryParse(stripHeavy(l.text));
    if (o && typeof o.timestamp === 'string') {
      return { line: l.line, iso: o.timestamp, ms: Date.parse(o.timestamp), type: o.type ?? null };
    }
  }
  return null;
}

// first "id":"msg_..." occurrence in an assistant line = message.id (message.id
// precedes content in recorded key order; confirmed by parse where it matters)
const MSGID_RE = /"id":"(msg_[A-Za-z0-9]{10,})"/;
function assistantMsgIds(lines) {
  const ids = new Map(); // msgId -> [lineNo, ...]
  for (const l of lines) {
    if (!l.text.includes('"type":"assistant"')) continue;
    const m = MSGID_RE.exec(l.text);
    if (!m) continue;
    let arr = ids.get(m[1]);
    if (!arr) ids.set(m[1], (arr = []));
    arr.push(l.line);
  }
  return ids;
}

const manifest = { extractedAt: new Date().toISOString(), corpus: '<redacted>', cases: {} };

// REDACTION HAPPENS HERE: every line is parsed, redacted, and re-serialized;
// the redacted line must keep the exact byte length of the stripped original.
function writeFixture(name, sourceRel, picked, notes) {
  const redactedLines = picked.map((p) => {
    const stripped = stripHeavy(p.text);
    const obj = tryParse(stripped);
    if (!obj) throw new Error(`${name}: line ${p.line} does not parse — refusing to write it raw`);
    const red = JSON.stringify(redactEvent(obj));
    if (Buffer.byteLength(red, 'utf8') !== Buffer.byteLength(stripped, 'utf8')) {
      throw new Error(`${name}: line ${p.line} redaction changed the byte length`);
    }
    return red;
  });
  const body = redactedLines.join('\n') + '\n';
  writeFileSync(path.join(OUT, `${name}.jsonl`), body);
  manifest.cases[name] = {
    sourceRel: redactRel(sourceRel), // neutral slug path, ids mapped
    lines: picked.map((p) => p.line), // original 1-based line numbers, in order
    notes: redactNotes(notes),
  };
  console.log(`  ${name}.jsonl  (${picked.length} lines)`);
}

const rel = (abs) => path.relative(CORPUS, abs).split(path.sep).join('/');

function projectDir(suffix) {
  const hit = readdirSync(CORPUS).find((n) => n.endsWith(suffix));
  if (!hit) throw new Error(`project dir ending with '${suffix}' not found under ${CORPUS}`);
  return path.join(CORPUS, hit);
}

// fixture/case names carry REDACTED ids only
const caseTail = (realSid) => mapUuid(realSid).slice(-8);

// =============================================================================
// R2a — fork pair that KEEPS the original sessionId on its copies
// (first-timestamped-record TIES -> clause (i) is the discriminator)
// =============================================================================
console.log('R2a: clause-(i) fork pair');
{
  const dir = projectDir(CONFIG.r2a.projectSuffix);
  const files = readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort();
  const wanted = CONFIG.r2a.pair;
  const pair = wanted.every((w) => files.includes(w)) ? wanted : null;
  if (!pair) throw new Error(`R2a pair not found (have: ${files.length} files) — set CONFIG.r2a`);
  const per = pair.map((name) => {
    const abs = path.join(dir, name);
    const lines = readLines(abs);
    return { name, abs, lines, ids: assistantMsgIds(lines), first: firstTimestamped(lines) };
  });
  const shared = [...per[0].ids.keys()].filter((id) => per[1].ids.has(id));
  if (shared.length === 0) throw new Error('R2a pair shares no message.ids');
  const dupId = shared.includes(CONFIG.r2a.preferredDupId) ? CONFIG.r2a.preferredDupId : shared[0];
  for (const p of per) {
    const sid = p.name.slice(0, -'.jsonl'.length);
    const linesOfDup = p.ids.get(dupId);
    const picked = p.lines.filter((l) => linesOfDup.includes(l.line));
    // verify by parse: message.id and the recorded per-copy sessionId
    const copySessionIds = [...new Set(picked.map((l) => tryParse(stripHeavy(l.text))?.sessionId ?? null))];
    writeFixture(`r2a-${CONFIG.r2a.shortName}-${caseTail(sid)}`, rel(p.abs), picked, {
      sessionId: sid,
      dupMsgId: dupId,
      sharedMsgIds: shared.length,
      firstTimestamped: p.first, // { line, iso, ms, type }
      opensWithType: tryParse(stripHeavy(p.lines[0].text))?.type ?? null,
      copySessionIds, // recorded sessionId on the copies (clause (i) evidence)
    });
  }
}

// =============================================================================
// R2b — fork pair whose RESUMED file opens with an untimestamped custom-title,
// + R6b (the empty-iterations group is one of the shared ids)
// + R4 (the synthetic event that immediately follows it in the canonical file)
// =============================================================================
console.log('R2b/R6b/R4: clause-(ii) fork pair');
{
  const dir = projectDir(CONFIG.r2b.projectSuffix);
  const files = readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort();
  const cache = new Map();
  const load = (name) => {
    if (!cache.has(name)) {
      const abs = path.join(dir, name);
      const lines = readLines(abs);
      cache.set(name, { name, abs, lines, ids: assistantMsgIds(lines), first: firstTimestamped(lines) });
    }
    return cache.get(name);
  };
  // resumed candidates: files whose FIRST record is an untimestamped custom-title
  const resumedCandidates = files.filter((name) => {
    const head = load(name);
    const o = tryParse(stripHeavy(head.lines[0].text));
    return o && o.type === 'custom-title' && !('timestamp' in o);
  });
  let found = null;
  for (const rName of resumedCandidates) {
    const r = load(rName);
    for (const oName of files) {
      if (oName === rName) continue;
      const o = load(oName);
      const shared = [...r.ids.keys()].filter((id) => o.ids.has(id));
      if (shared.length > 0) {
        found = { resumed: r, original: o, shared };
        break;
      }
    }
    if (found) break;
  }
  if (!found) throw new Error('no R2b pair with an untimestamped-custom-title resumed file found');
  const { resumed, original, shared } = found;
  const EMPTY_ITER_ID = CONFIG.r2b.emptyIterId;
  const dupId = shared.includes(EMPTY_ITER_ID) ? EMPTY_ITER_ID : shared[0];

  for (const [tag, p] of [
    ['original', original],
    ['resumed', resumed],
  ]) {
    const sid = p.name.slice(0, -'.jsonl'.length);
    const dupLines = p.ids.get(dupId);
    // resumed file: include the untimestamped opening block as recorded evidence
    const opening = tag === 'resumed' && p.first ? p.lines.filter((l) => l.line < p.first.line) : [];
    const picked = [...opening, ...p.lines.filter((l) => dupLines.includes(l.line))];
    const copySessionIds = [
      ...new Set(p.lines.filter((l) => dupLines.includes(l.line)).map((l) => tryParse(stripHeavy(l.text))?.sessionId ?? null)),
    ];
    writeFixture(`r2b-${CONFIG.r2b.shortName}-${tag}`, rel(p.abs), picked, {
      sessionId: sid,
      dupMsgId: dupId,
      dupLineNos: dupLines,
      openingUntimestampedLines: opening.map((l) => l.line),
      firstTimestamped: p.first,
      opensWithType: tryParse(stripHeavy(p.lines[0].text))?.type ?? null,
      copySessionIds,
    });
  }

  // R6b — the empty-iterations group, extracted from the ORIGINAL (canonical) file
  {
    const dupLines = original.ids.get(EMPTY_ITER_ID);
    if (!dupLines) throw new Error(`CONFIG.r2b.emptyIterId not found in ${original.name}`);
    const picked = original.lines.filter((l) => dupLines.includes(l.line));
    const parsed = picked.map((l) => tryParse(stripHeavy(l.text)));
    if (!parsed.every((o) => Array.isArray(o?.message?.usage?.iterations) && o.message.usage.iterations.length === 0)) {
      throw new Error('r6b: expected an EMPTY iterations array on every line of the group');
    }
    writeFixture('r6b-empty-iterations', rel(original.abs), picked, {
      msgId: EMPTY_ITER_ID,
      stopReason: parsed[0].message.stop_reason,
      outputTokens: parsed[0].message.usage.output_tokens,
      version: parsed[0].version ?? null,
      note: 'stop_reason end_turn with iterations: [] — a non-null stop_reason is NOT sufficient for R6',
    });

    // R4 — the <synthetic> event immediately after the group in the same file
    const after = original.lines.find((l) => l.line === dupLines[dupLines.length - 1] + 1);
    const aObj = after && tryParse(stripHeavy(after.text));
    if (!aObj || aObj.message?.model !== '<synthetic>' || aObj.message?.usage?.iterations !== null) {
      throw new Error('r4: expected the line after the empty-iterations group to be <synthetic> with iterations null');
    }
    writeFixture('r4-synthetic', rel(original.abs), [after], {
      msgId: aObj.message.id,
      model: '<synthetic>',
      stopReason: aObj.message.stop_reason,
      note: 'usage.iterations === null is the exact R4 discriminator; message.id is a UUID, not msg_*',
    });
  }
}

// =============================================================================
// R3 — the fallback messages (usage.iterations length 2). Discovered by
// scanning ALL main transcripts for real fallback_message iteration elements
// (prose mentions parse to events whose OWN usage has no such element).
// =============================================================================
console.log('R3: fallback messages (iterations length 2)');
{
  const hits = []; // { abs, msgId, lines: [{line,text}] }
  for (const proj of readdirSync(CORPUS).sort()) {
    const pDir = path.join(CORPUS, proj);
    if (!statSync(pDir).isDirectory()) continue;
    for (const name of readdirSync(pDir).sort()) {
      if (!name.endsWith('.jsonl')) continue;
      const abs = path.join(pDir, name);
      const buf = readFileSync(abs);
      if (!buf.includes('"fallback_message"')) continue;
      const lines = readLines(abs);
      const byId = new Map();
      for (const l of lines) {
        if (!l.text.includes('"fallback_message"') || !l.text.includes('"type":"assistant"')) continue;
        const o = tryParse(stripHeavy(l.text));
        const iters = o?.message?.usage?.iterations;
        if (Array.isArray(iters) && iters.length > 1 && iters.some((e) => e?.type === 'fallback_message')) {
          let e = byId.get(o.message.id);
          if (!e) byId.set(o.message.id, (e = []));
        }
      }
      for (const msgId of byId.keys()) {
        // collect the WHOLE group (every line carrying this message.id)
        const groupLines = lines.filter(
          (l) => l.text.includes('"type":"assistant"') && MSGID_RE.exec(l.text)?.[1] === msgId,
        );
        hits.push({ abs, msgId, lines: groupLines });
      }
    }
  }
  if (hits.length === 0) throw new Error('no fallback messages found in any main transcript');
  for (const h of hits) {
    const parsed = tryParse(stripHeavy(h.lines[h.lines.length - 1].text));
    const iters = parsed.message.usage.iterations;
    writeFixture(`r3-fallback-${mapMsg(h.msgId).slice(-8)}`, rel(h.abs), h.lines, {
      msgId: h.msgId,
      messageModel: parsed.message.model,
      iterations: iters.map((e) => ({
        type: e.type,
        model: e.model ?? null,
        output_tokens: e.output_tokens,
        cache_read_input_tokens: e.cache_read_input_tokens,
        cache_creation_input_tokens: e.cache_creation_input_tokens,
        cache_creation: e.cache_creation ?? null,
        input_tokens: e.input_tokens,
      })),
      topLevelUsage: {
        input_tokens: parsed.message.usage.input_tokens,
        output_tokens: parsed.message.usage.output_tokens,
        cache_read_input_tokens: parsed.message.usage.cache_read_input_tokens,
        cache_creation_input_tokens: parsed.message.usage.cache_creation_input_tokens,
        cache_creation: parsed.message.usage.cache_creation,
      },
      note: 'top-level usage on a fallback message is a measured inconsistent merge; R3 bills from the elements',
    });
  }
}

// =============================================================================
// R1 — a multi-line group with PROGRESSING output (agent tier), and
// R6a — a never-finalized group (all lines stop_reason null, no iterations key).
// One deterministic scan over agent transcripts, oldest-first project order,
// excluding the live rebuild project.
// =============================================================================
console.log('R1/R6a: agent-tier groups');
{
  let r1 = null;
  let r6a = null;
  const agentFiles = [];
  for (const proj of readdirSync(CORPUS).sort()) {
    if (proj.includes(CONFIG.liveProjectHint)) continue; // live writers — keep fixtures stable
    const pDir = path.join(CORPUS, proj);
    if (!statSync(pDir).isDirectory()) continue;
    for (const sess of readdirSync(pDir).sort()) {
      const sub = path.join(pDir, sess, 'subagents');
      if (!existsSync(sub)) continue;
      const walk = (d) => {
        for (const n of readdirSync(d).sort()) {
          const p = path.join(d, n);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (n.startsWith('agent-') && n.endsWith('.jsonl')) agentFiles.push({ abs: p, size: st.size });
        }
      };
      walk(sub);
    }
  }
  agentFiles.sort((a, b) => (a.abs < b.abs ? -1 : 1));
  for (const { abs, size } of agentFiles) {
    if (r1 && r6a) break;
    if (size > 4_000_000) continue; // fixtures come from small files; plenty qualify
    const lines = readLines(abs);
    const groups = new Map(); // msgId -> [{line,text,obj}]
    for (const l of lines) {
      if (!l.text.includes('"type":"assistant"')) continue;
      const m = MSGID_RE.exec(l.text);
      if (!m) continue;
      let arr = groups.get(m[1]);
      if (!arr) groups.set(m[1], (arr = []));
      arr.push(l);
    }
    for (const [msgId, ls] of groups) {
      if (r1 && r6a) break;
      if (ls.length < 2) continue;
      const objs = ls.map((l) => tryParse(stripHeavy(l.text)));
      if (objs.some((o) => !o?.message?.usage)) continue;
      const outs = objs.map((o) => o.message.usage.output_tokens);
      const stops = objs.map((o) => o.message.stop_reason);
      const last = objs[objs.length - 1];
      if (
        !r1 &&
        ls.length >= 3 &&
        new Set(outs).size > 1 &&
        outs[outs.length - 1] === Math.max(...outs) &&
        Array.isArray(last.message.usage.iterations) &&
        last.message.usage.iterations.length === 1 &&
        stops[stops.length - 1] !== null
      ) {
        r1 = { abs, msgId, ls, outs, stops };
      }
      if (
        !r6a &&
        stops.every((s) => s === null) &&
        !('iterations' in last.message.usage) &&
        ls.length >= 2
      ) {
        r6a = { abs, msgId, ls, outs, stops };
      }
    }
  }
  if (!r1) throw new Error('no progressing multi-line agent group found');
  if (!r6a) throw new Error('no never-finalized agent group found');
  writeFixture('r1-agent-multiline', rel(r1.abs), r1.ls, {
    msgId: r1.msgId,
    outputPerLine: r1.outs,
    stopPerLine: r1.stops,
    note: 'output progresses across lines; the LAST line holds the final values (R1 keep-last)',
  });
  writeFixture('r6a-never-finalized', rel(r6a.abs), r6a.ls, {
    msgId: r6a.msgId,
    outputPerLine: r6a.outs,
    stopPerLine: r6a.stops,
    note: 'every line stop_reason null, kept line has NO iterations key — R6 neverFinalized; output is a stub, billed as recorded',
  });
}

writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nmanifest.json written — ${Object.keys(manifest.cases).length} cases (corpus path redacted)`);
