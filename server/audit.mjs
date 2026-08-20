// server/audit.mjs — the audit's independent Path B (SPEC §10).
//
// INDEPENDENCE CONTRACT: this module must NOT import server/jsonl.mjs,
// server/parse.mjs, or server/ledger.mjs. It contains its own recursive
// directory walk, its own \n-only line splitter (U+2028/U+2029 inside JSON
// strings are legal — never node:readline), its own base64/signature
// stripper, its own R1–R4 application + R7 unpriced partition, and its own
// summation per file → session → total. The ONE shared import is
// shared/pricing.mjs (disclosed on the audit page); it is injectable so
// tests can run before group A lands, and dynamically imported otherwise.
//
// Path A (the hierarchy the app displays) is handed in by the caller as
// plain data; Path B never reads the cache, the LRU, or shared offset
// tables. What A === B proves — and does not prove — is printed by the
// audit page per SPEC §10.

import fsp from 'node:fs/promises';
import path from 'node:path';

// Path B's OWN copy of the session-id predicate (independence contract), kept
// textually identical in rule to scan.mjs's: strict 8-4-4-4-12, matched
// case-insensitively, id normalised to lowercase. A fixture test pins that the
// two modules classify identically.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_FILE_RE = /^agent-(a[0-9a-f]{16})\.jsonl$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// ------------------------------------------------------------ line splitter
// Own \n-only splitter over a Buffer. Splits on 0x0A only (raw U+2028/U+2029
// are multi-byte in UTF-8 and never contain 0x0A, so they cannot tear a
// line), strips a trailing \r, holds back bytes after the final \n
// (unterminated tail of a live file — a prefix is a valid transcript).
export function* splitLinesB(buf) {
  let start = 0;
  let line = 0;
  // tolerate a BOM (SPEC §1: none observed; count if present)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  const bomBytes = start;
  while (start <= buf.length - 1) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) {
      // unterminated tail — held back, reported via return value
      return { heldBackBytes: buf.length - start, bomBytes };
    }
    let end = nl;
    if (end > start && buf[end - 1] === 0x0d) end -= 1; // strip \r
    line += 1;
    yield { text: buf.toString('utf8', start, end), line, byteOffset: start, bytes: nl - start + 1 };
    start = nl + 1;
  }
  return { heldBackBytes: 0, bomBytes };
}

// ------------------------------------------------------------ heavy strip
// Own stripper (SPEC §1): "data"/"base64" values of 500+ base64 chars and
// thinking "signature" values are replaced with "" before JSON.parse.
const B64_RE = /("(?:data|base64)"\s*:\s*")([A-Za-z0-9+/=]{500,})(")/g;
const SIG_RE = /("signature"\s*:\s*")([A-Za-z0-9+/=_-]{100,})(")/g;

export function stripHeavyB(text, tally) {
  let out = text;
  if (text.length > 600) {
    out = out.replace(B64_RE, (_m, a, mid, z) => {
      if (tally) { tally.base64 += 1; tally.base64Bytes += mid.length; }
      return a + z;
    });
    out = out.replace(SIG_RE, (_m, a, mid, z) => {
      if (tally) { tally.signature += 1; tally.signatureBytes += mid.length; }
      return a + z;
    });
  }
  return out;
}

// ------------------------------------------------------------ walk
// Own recursive walk. Classifies exactly what Path B needs; every file is
// counted (count + bytes) in the census regardless of class.
async function walkDir(absDir, relDir, out, problems) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (e) {
    problems.push({ code: 'dir-unreadable', dir: relDir, message: String(e && e.message) });
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    const abs = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      await walkDir(abs, rel, out, problems);
    } else if (ent.isFile()) {
      let size = 0;
      try { size = (await fsp.stat(abs)).size; } catch { /* raced deletion; live corpus */ }
      out.push({ rel, abs, size });
    }
  }
}

function classify(rel) {
  // rel is POSIX, relative to projectsDir: <slug>/...
  const parts = rel.split('/');
  const slug = parts[0];
  if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
    const stem = parts[1].slice(0, -6);
    if (UUID_RE.test(stem)) return { kind: 'main', slug, sessionId: stem.toLowerCase() };
  }
  if (parts.length >= 3 && UUID_RE.test(parts[1])) {
    const sessionId = parts[1].toLowerCase();
    const name = parts[parts.length - 1];
    const m = AGENT_FILE_RE.exec(name);
    if (m && parts[2] === 'subagents') return { kind: 'agent', slug, sessionId, agentId: m[1] };
    if (name === 'journal.jsonl') return { kind: 'journal', slug, sessionId };
    return { kind: 'other-session-file', slug, sessionId };
  }
  if (parts.length === 3 && parts[1] === 'memory') return { kind: 'memory', slug };
  return { kind: 'other', slug };
}

// ------------------------------------------------------------ token math
function zeroTokens() {
  return { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };
}
function addTokens(t, r) {
  t.input += r.input; t.output += r.output; t.cache5m += r.cache5m;
  t.cache1h += r.cache1h; t.cacheFlat += r.cacheFlat; t.cacheRead += r.cacheRead;
}
function zeroUsd() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 };
}
function addUsd(a, b) {
  a.input += b.input; a.output += b.output; a.cacheWrite += b.cacheWrite;
  a.cacheRead += b.cacheRead; a.webSearch += b.webSearch; a.total += b.total;
}

function newBucket() {
  return {
    requests: 0,
    tokens: zeroTokens(),          // priced canonical rows only (R7 keeps unpriced parallel)
    usd: zeroUsd(),                // integer tcu
    unpriced: {},                  // modelKey -> { requests, tokens }
    inherited: {},                 // canonical sessionId -> { requests, tokens }
    synthetic: 0,
    neverFinalized: 0,
    neverFinalizedOutputRecorded: 0,
    ttlAssumed: 0,
    embeddedSidechain: { requests: 0, tokens: zeroTokens() },
    files: 0,
    bytes: 0,
  };
}

function addBucket(a, b) {
  a.requests += b.requests;
  addTokens(a.tokens, b.tokens);
  addUsd(a.usd, b.usd);
  for (const [k, v] of Object.entries(b.unpriced)) {
    const t = a.unpriced[k] ?? (a.unpriced[k] = { requests: 0, tokens: zeroTokens() });
    t.requests += v.requests; addTokens(t.tokens, v.tokens);
  }
  for (const [k, v] of Object.entries(b.inherited)) {
    const t = a.inherited[k] ?? (a.inherited[k] = { requests: 0, tokens: zeroTokens() });
    t.requests += v.requests; addTokens(t.tokens, v.tokens);
  }
  a.synthetic += b.synthetic;
  a.neverFinalized += b.neverFinalized;
  a.neverFinalizedOutputRecorded += b.neverFinalizedOutputRecorded;
  a.ttlAssumed += b.ttlAssumed;
  a.embeddedSidechain.requests += b.embeddedSidechain.requests;
  addTokens(a.embeddedSidechain.tokens, b.embeddedSidechain.tokens);
  a.files += b.files;
  a.bytes += b.bytes;
}

// ------------------------------------------------------------ R1/R3/R4 rows
// Token counters must be integers; a PRESENT non-integer bills 0 and is
// COUNTED (usage-integers census) — Path B's own copy of the gate, no `| 0`
// truncation/wrap.
function intB(v, tally) {
  if (v === undefined || v === null) return 0;
  if (Number.isInteger(v)) return v;
  if (tally) tally.usageIntViolations += 1;
  return 0;
}

// Turns one R1-kept assistant line into billed row(s) per SPEC §5.
function rowsFromKept(kept, rel, tally) {
  const it = (v) => intB(v, tally);
  const u = kept.usage || {};
  const iters = u.iterations;
  const synthetic = iters === null;                                    // R4 exact discriminator
  const finalized = Array.isArray(iters) && iters.length > 0;          // R6 single predicate
  const stu = u.server_tool_use || {};
  const webSearch = it(stu.web_search_requests);
  const webFetch = it(stu.web_fetch_requests);
  const thinking = u.output_tokens_details && typeof u.output_tokens_details.thinking_tokens === 'number'
    ? u.output_tokens_details.thinking_tokens : null;
  const base = {
    msgId: kept.msgId,
    at: kept.atMs,
    file: rel,
    line: kept.line,
    stopReason: kept.stopReason,
    speed: (Object.prototype.hasOwnProperty.call(u, 'speed') ? u.speed : null),
    speedAbsent: !Object.prototype.hasOwnProperty.call(u, 'speed'),
    serviceTier: (Object.prototype.hasOwnProperty.call(u, 'service_tier') ? u.service_tier : null),
    synthetic,
    finalized,
    billedElsewhere: null,
    isSidechain: kept.isSidechain === true,
  };

  if (synthetic) {
    return [{
      ...base, model: kept.model, input: 0, output: 0, cacheRead: 0,
      cache5m: 0, cache1h: 0, cacheFlat: 0, ttl: 'recorded',
      thinkingTokens: null, webSearch: 0, webFetch: 0, iterIndex: null,
      cacheIdentityBreak: false,
    }];
  }

  const rows = [];
  if (finalized) {
    // R3 — one row per element; scalars attach to the FINAL element's row.
    for (let i = 0; i < iters.length; i++) {
      const el = iters[i] || {};
      const cc = el.cache_creation;
      const flat = it(el.cache_creation_input_tokens);
      let c5 = 0, c1 = 0, cf = 0, ttl = 'recorded', identityBreak = false;
      if (cc && typeof cc === 'object') {
        c5 = it(cc.ephemeral_5m_input_tokens);
        c1 = it(cc.ephemeral_1h_input_tokens);
        if (Object.prototype.hasOwnProperty.call(el, 'cache_creation_input_tokens') && c5 + c1 !== flat) {
          identityBreak = true; // R3 repaired identity 5m+1h === flat; count breaks
        }
      } else if (flat > 0) {
        cf = flat; ttl = 'unrecorded'; // R5 flat-only channel
      }
      const last = i === iters.length - 1;
      rows.push({
        ...base,
        model: el.model ?? kept.model,
        input: it(el.input_tokens),
        output: it(el.output_tokens),
        cacheRead: it(el.cache_read_input_tokens),
        cache5m: c5, cache1h: c1, cacheFlat: cf, ttl,
        thinkingTokens: last ? thinking : null,       // not recorded per iteration
        webSearch: last ? webSearch : 0,              // real zero on non-final rows
        webFetch: last ? webFetch : 0,
        iterIndex: i,
        cacheIdentityBreak: identityBreak,
      });
    }
    return rows;
  }

  // iterations absent (streaming-only) or empty array — bill top-level usage.
  // !finalized && !synthetic ≙ neverFinalized (R6): recorded stubs, billed as
  // recorded, never estimated.
  const cc = u.cache_creation;
  const flat = it(u.cache_creation_input_tokens);
  let c5 = 0, c1 = 0, cf = 0, ttl = 'recorded', identityBreak = false;
  if (cc && typeof cc === 'object') {
    c5 = it(cc.ephemeral_5m_input_tokens);
    c1 = it(cc.ephemeral_1h_input_tokens);
    if (Object.prototype.hasOwnProperty.call(u, 'cache_creation_input_tokens') && c5 + c1 !== flat) identityBreak = true;
  } else if (flat > 0) {
    cf = flat; ttl = 'unrecorded';
  }
  rows.push({
    ...base,
    model: kept.model,
    input: it(u.input_tokens),
    output: it(u.output_tokens),
    cacheRead: it(u.cache_read_input_tokens),
    cache5m: c5, cache1h: c1, cacheFlat: cf, ttl,
    thinkingTokens: thinking,
    webSearch, webFetch,
    iterIndex: null,
    cacheIdentityBreak: identityBreak,
  });
  return rows;
}

// ------------------------------------------------------------ file scan
async function scanTranscript(fileEnt, state) {
  let buf;
  try {
    buf = await fsp.readFile(fileEnt.abs);
  } catch (e) {
    state.problems.push({ code: 'file-unreadable', file: fileEnt.rel, message: String(e && e.message) });
    return null;
  }
  const groups = new Map(); // key -> kept info (last line in file order wins — R1)
  const torn = [];
  let firstTsMs = null;     // first record IN FILE ORDER that CARRIES a timestamp (R2 ii)
  let lineCount = 0;
  const resumedRunIds = new Set(); // workflow resume references (census)
  const strips = state.strips;

  const it = splitLinesB(buf);
  let step = it.next();
  while (!step.done) {
    const { text, line, byteOffset, bytes } = step.value;
    lineCount = line;
    // Yield the event loop periodically: this loop is otherwise fully
    // synchronous after the readFile, and a whole-file stall starves SSE
    // heartbeats and every other request on the single thread.
    if ((line & 0x7ff) === 0) await new Promise((r) => setImmediate(r));
    const stripped = stripHeavyB(text, strips);
    if (stripped.includes('"resumeFromRunId"')) {
      const m = /"resumeFromRunId"\s*:\s*"(wf_[0-9a-f]{8}-[0-9a-f]{3})"/.exec(stripped);
      if (m) resumedRunIds.add(m[1]);
    }
    let obj = null;
    try { obj = JSON.parse(stripped); } catch {
      torn.push({ file: fileEnt.rel, line, byteOffset, bytes });
      step = it.next();
      continue;
    }
    if (obj && typeof obj === 'object') {
      if (firstTsMs === null && typeof obj.timestamp === 'string') {
        const t = Date.parse(obj.timestamp);
        if (Number.isFinite(t)) firstTsMs = t; // untimestamped metadata types are skipped, never 0/NaN
      }
      if (obj.type === 'assistant' && obj.message && obj.message.usage) {
        const m = obj.message;
        // R1: fallback uuid occurs only for <synthetic>; a line with NEITHER
        // id nor uuid keys per line (matching the ledger's per-line fallback)
        // instead of collapsing every such line into one undefined-keyed slot.
        const key = m.id ?? obj.uuid ?? `line-${line}`;
        groups.set(key, {
          msgId: m.id ?? obj.uuid ?? `line-${line}`,
          model: m.model,
          usage: m.usage,
          stopReason: m.stop_reason ?? null,
          atMs: typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : null,
          line,
          sessionIdField: obj.sessionId ?? null,
          isSidechain: obj.isSidechain === true,
          lineCountInGroup: (groups.get(key)?.lineCountInGroup ?? 0) + 1,
        });
      }
    }
    step = it.next();
  }
  const tail = step.value || { heldBackBytes: 0, bomBytes: 0 };
  return { groups, torn, firstTsMs, lineCount, resumedRunIds, heldBackBytes: tail.heldBackBytes, bomBytes: tail.bomBytes, bytes: buf.length };
}

// ------------------------------------------------------------ main entry
// opts:
//   projectsDir  absolute path (READ-ONLY corpus)
//   scope        parsed scope {kind, slug?, id?, idx?, agentId?} (default store)
//   pricing      shared/pricing.mjs module (injected; else dynamic import)
//   pathA        plain data from the displayed hierarchy (or null):
//                { fileCensus:{files,bytes}, agentCount, turnAgentSum,
//                  sessions:{ 'slug/id': {requests, usdTotal, tokens} },
//                  totals:{requests, usdTotal, tokens},
//                  sessionSum:{pass, failures},
//                  expectations:{ neverFinalized, synthetic, pairCensus },
//                  r2Inherited?: {msgIds:[...]} }
//   emit         (eventName, data) => void   SSE vocabulary events
//   signal       optional AbortSignal
export async function runAudit(opts) {
  const t0 = Date.now();
  const { projectsDir, emit = () => {}, signal } = opts;
  const scope = opts.scope ?? { kind: 'store' };
  let pricing = opts.pricing;
  if (!pricing) {
    // the one shared import, disclosed (SPEC §10)
    pricing = await import(new URL('../shared/pricing.mjs', import.meta.url));
  }

  const state = {
    problems: [],
    strips: { base64: 0, base64Bytes: 0, signature: 0, signatureBytes: 0 },
    usageIntViolations: 0,
  };

  // Own top-level readdir helpers (independence: no FileTable reuse).
  const topSlugs = async () => {
    try {
      return (await fsp.readdir(projectsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch { return []; }
  };

  // -------- scope → walk roots
  // CONTRACT-DEVIATION: turn:/agent: scopes audit at session granularity
  // (Path B applies R1–R4+R7, not R-T turn attribution); the narrowing is
  // disclosed via a problem event. agent scope narrows billing to that
  // agent's own transcript.
  //
  // A session is keyed by sessionId ALONE (SPEC §2): its fragment dirs can
  // live under OTHER project dirs, so session scope walks every `*/<id>/`
  // across the store, and project scope routes cross-project fragments by the
  // store-wide main map — both with their own readdirs, both disclosed.
  const walkAll = [];
  let storeMains = null; // sessionId -> owning slug (lexicographically smallest main holder)
  if (scope.kind === 'store') {
    await walkDir(projectsDir, '', walkAll, state.problems);
  } else if (scope.kind === 'project') {
    await walkDir(path.join(projectsDir, scope.slug), scope.slug, walkAll, state.problems);
    // store-wide main map: which slug OWNS each session id (first = smallest slug wins,
    // mirroring the grouping rule for duplicate main ids)
    storeMains = new Map();
    const slugs = await topSlugs();
    for (const slug of slugs) {
      let ents = [];
      try { ents = await fsp.readdir(path.join(projectsDir, slug), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const stem = e.name.slice(0, -6);
        if (UUID_RE.test(stem)) {
          const id = stem.toLowerCase();
          if (!storeMains.has(id)) storeMains.set(id, slug);
        }
      }
    }
    // union IN: fragment dirs under other slugs whose id is owned by this project
    let unionedRoots = 0;
    for (const slug of slugs) {
      if (slug === scope.slug) continue;
      let ents = [];
      try { ents = await fsp.readdir(path.join(projectsDir, slug), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isDirectory() || !UUID_RE.test(e.name)) continue;
        if (storeMains.get(e.name.toLowerCase()) === scope.slug) {
          unionedRoots += 1;
          await walkDir(path.join(projectsDir, slug, e.name), `${slug}/${e.name}`, walkAll, state.problems);
        }
      }
    }
    if (unionedRoots > 0) {
      emit('problem', { code: 'session-fragment', severity: 'note', scope: 'project',
        message: `${unionedRoots} fragment root(s) under other project dirs belong to this project's sessions and are unioned into the walk (SPEC §2 case a)`,
        affects: 'aggregates', count: unionedRoots });
    }
  } else {
    // session / turn / agent: that session's tree — main + <slug>/<id>/ +
    // every fragment dir `*/<id>/` elsewhere in the store
    const mainRel = `${scope.slug}/${scope.id}.jsonl`;
    const mainAbs = path.join(projectsDir, scope.slug, `${scope.id}.jsonl`);
    try {
      const st = await fsp.stat(mainAbs);
      if (st.isFile()) walkAll.push({ rel: mainRel, abs: mainAbs, size: st.size });
    } catch { /* fragment-only session */ }
    await walkDir(path.join(projectsDir, scope.slug, scope.id), `${scope.slug}/${scope.id}`, walkAll, state.problems);
    let extraRoots = 0;
    for (const slug of await topSlugs()) {
      if (slug === scope.slug) continue;
      const fragAbs = path.join(projectsDir, slug, scope.id);
      try {
        const st = await fsp.stat(fragAbs);
        if (st.isDirectory()) {
          extraRoots += 1;
          await walkDir(fragAbs, `${slug}/${scope.id}`, walkAll, state.problems);
        }
      } catch { /* no fragment dir under this slug */ }
    }
    if (extraRoots > 0) {
      emit('problem', { code: 'session-fragment', severity: 'note', scope: 'session',
        message: `${extraRoots} fragment root(s) outside the owning project unioned into this session's walk (SPEC §2 case a)`,
        affects: 'aggregates', count: extraRoots });
    }
    if (scope.kind === 'turn') {
      emit('problem', { code: 'audit-scope-note', severity: 'note', scope: 'session',
        message: 'Path B audits turn scopes at session granularity (turn attribution is Path A parse territory)',
        affects: 'display', count: 1 });
    }
  }
  if (signal?.aborted) return null;

  // -------- classify
  let files = walkAll.map((f) => ({ ...f, cls: classify(f.rel) }));
  if (scope.kind === 'project' && storeMains) {
    // route OUT: local files of sessions whose main lives in another project
    // (billing them here would split one session across two projects)
    const foreign = files.filter((f) => f.cls.sessionId
      && (storeMains.get(f.cls.sessionId) ?? scope.slug) !== scope.slug);
    if (foreign.length) {
      const foreignSet = new Set(foreign);
      files = files.filter((f) => !foreignSet.has(f));
      emit('problem', { code: 'session-fragment', severity: 'note', scope: 'project',
        message: `${foreign.length} local file(s) belong to session(s) owned by another project and are routed out of this project's audit (SPEC §2 case a)`,
        affects: 'aggregates', count: foreign.length });
    }
  }
  const fileCensus = { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) };
  const mains = files.filter((f) => f.cls.kind === 'main');
  let agents = files.filter((f) => f.cls.kind === 'agent');
  const journals = files.filter((f) => f.cls.kind === 'journal');
  if (scope.kind === 'agent') {
    if (scope.agentId === 'main') agents = [];
    else agents = agents.filter((f) => f.cls.agentId === scope.agentId);
  }

  // session ownership: id → slug of the dir holding the main .jsonl; a
  // fragment dir whose id has a main elsewhere in the walked set unions into
  // that session (SPEC §2 case a); a truly orphaned fragment stays at the
  // holding dir, disclosed (case b).
  const mainSlugById = new Map();
  for (const f of mains) mainSlugById.set(f.cls.sessionId, f.cls.slug);
  const fragmentCensus = { unioned: 0, orphaned: 0 };
  const seenSessionDirs = new Set();
  for (const f of files) {
    if (f.cls.sessionId && f.cls.kind !== 'main') {
      const key = `${f.cls.slug}/${f.cls.sessionId}`;
      if (!seenSessionDirs.has(key)) {
        seenSessionDirs.add(key);
        const owner = mainSlugById.get(f.cls.sessionId);
        if (owner === undefined) fragmentCensus.orphaned += 1;
        else if (owner !== f.cls.slug) fragmentCensus.unioned += 1;
      }
    }
  }
  const sessionSlugFor = (cls) => mainSlugById.get(cls.sessionId) ?? cls.slug;

  // -------- scan transcripts
  const toScan = [...mains, ...agents];
  if (scope.kind === 'agent' && scope.agentId !== 'main') {
    // billing narrows to the agent transcript, but the session's mains are
    // still scanned for the R2/copy context of nothing — agent files never
    // duplicate msgIds (0 among 868 non-main files); scan only the agent.
    toScan.length = 0;
    toScan.push(...agents);
  }
  const bytesTotal = toScan.reduce((a, f) => a + f.size, 0);
  let bytesDone = 0;
  let lastProgress = 0;
  const scanned = []; // { fileEnt, scan }
  const tornAll = [];
  const pairCensus = new Map(); // "speed|tier" over R1-kept lines
  let sessionsDone = 0;

  for (const f of toScan) {
    if (signal?.aborted) return null;
    const scan = await scanTranscript(f, state);
    bytesDone += f.size;
    if (scan) {
      scanned.push({ fileEnt: f, scan });
      for (const t of scan.torn) tornAll.push(t);
      for (const kept of scan.groups.values()) {
        const u = kept.usage || {};
        const sp = Object.prototype.hasOwnProperty.call(u, 'speed')
          ? (u.speed === null ? 'null' : String(u.speed)) : 'ABSENT';
        const st = Object.prototype.hasOwnProperty.call(u, 'service_tier')
          ? (u.service_tier === null ? 'null' : String(u.service_tier)) : 'ABSENT';
        const k = `${sp}|${st}`;
        pairCensus.set(k, (pairCensus.get(k) ?? 0) + 1);
      }
    }
    if (f.cls.kind === 'main') sessionsDone += 1;
    const now = Date.now();
    if (now - lastProgress > 200) {
      lastProgress = now;
      emit('progress', { sessionsDone, of: mains.length, bytesDone, ofBytes: bytesTotal, elapsedMs: now - t0 });
    }
  }
  for (const t of tornAll.slice(0, 50)) {
    emit('problem', { code: 'torn-line', severity: 'error', scope: 'line',
      file: t.file, line: t.line, byteOffset: t.byteOffset, bytes: t.bytes,
      message: 'line failed JSON.parse; counted, contributes zero', affects: 'aggregates', count: 1 });
  }

  // -------- R2 — canonical copy across MAIN files (store/project scope).
  // Duplication exists only between main files (SPEC R2).
  const copiesByMsgId = new Map(); // msgId -> [{sessionId, rel, recSid, firstTs}]
  for (const { fileEnt, scan } of scanned) {
    if (fileEnt.cls.kind !== 'main') continue;
    for (const [msgId, kept] of scan.groups) {
      let list = copiesByMsgId.get(msgId);
      if (!list) copiesByMsgId.set(msgId, list = []);
      list.push({
        sessionId: fileEnt.cls.sessionId,
        rel: fileEnt.rel,
        recSid: kept.sessionIdField,
        firstTs: scan.firstTsMs,
      });
    }
  }
  const canonicalSession = new Map(); // msgId -> canonical sessionId
  let duplicateGroups = 0, tieBreaks = 0, ambiguous = 0;
  for (const [msgId, copies] of copiesByMsgId) {
    if (copies.length < 2) continue;
    duplicateGroups += 1;
    // (i) the copy whose main filename equals the copy's own sessionId, when only one does
    const matches = copies.filter((c) => c.recSid === c.sessionId);
    let canon;
    if (matches.length === 1) {
      canon = matches[0];
    } else {
      // (ii) earliest first-timestamped-record; untimestamped files sort last
      const sorted = [...copies].sort((a, b) => {
        const ta = a.firstTs ?? Infinity, tb = b.firstTs ?? Infinity;
        if (ta !== tb) return ta - tb;
        return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0; // (iii) lexicographic backstop
      });
      canon = sorted[0];
      const ta = sorted[0].firstTs ?? Infinity, tb = sorted[1].firstTs ?? Infinity;
      if (ta === tb) tieBreaks += 1; // counted in the R2 ambiguity census (expected 0)
    }
    if (!canon) { ambiguous += 1; continue; } // unreachable: (iii) is total
    canonicalSession.set(msgId, canon.sessionId);
  }
  // Session-scoped runs cannot see fork partners; if Path A discloses
  // inherited msgIds for this session, honour them (disclosed input).
  if (scope.kind !== 'store' && scope.kind !== 'project' && opts.pathA?.r2Inherited?.msgIds) {
    for (const msgId of opts.pathA.r2Inherited.msgIds) {
      if (!canonicalSession.has(msgId)) canonicalSession.set(msgId, opts.pathA.r2Inherited.canonicalSessionId ?? '(other session)');
    }
    emit('problem', { code: 'audit-scope-note', severity: 'note', scope: 'session',
      message: 'R2 fork partners are outside a session scope; inherited msgIds taken from Path A, disclosed',
      affects: 'aggregates', count: opts.pathA.r2Inherited.msgIds.length });
  }

  // -------- rows, pricing, summation per file → session → total
  const perSession = new Map(); // 'slug/id' -> bucket
  const total = newBucket();
  total.files = fileCensus.files;
  total.bytes = fileCensus.bytes;
  let syntheticEvents = 0;
  let neverFinalizedRows = 0;
  let r3SplitGroups = 0, r3SplitSumBreaks = 0;
  let cacheIdentityBreaks = 0;
  let pricedRows = 0, intervalMisses = 0;
  let overflow = false;
  let evidence = null; // deterministic sample: billed row with max output
  // long-context disclosure (SPEC §5 last bullet): the VERIFIED set comes from
  // pricing.LONG_CONTEXT_COVERED — pricing is the audit's one disclosed shared
  // import, so the two paths stay in lockstep (mythos-5 is NOT verified until
  // measured). The textual fallback mirrors SPEC §5 for stubs without the export.
  const LONG_CTX_VERIFIED = new Set(
    Array.isArray(pricing.LONG_CONTEXT_COVERED) && pricing.LONG_CONTEXT_COVERED.length
      ? pricing.LONG_CONTEXT_COVERED
      : ['fable-5', 'opus-5', 'sonnet-5', 'opus-4-8'],
  );
  let over200k = 0, premiumUnknown = 0;
  const forkPairs = new Set(); // 'sidA↔sidB' per duplicated msgId (fork-pair listing)
  const resumedRuns = new Set();

  for (const [, copies] of copiesByMsgId) {
    if (copies.length < 2) continue;
    const sids = copies.map((c) => c.sessionId).sort();
    for (let i = 1; i < sids.length; i++) forkPairs.add(`${sids[0]}↔${sids[i]}`);
  }

  for (const { fileEnt, scan } of scanned) {
    const cls = fileEnt.cls;
    for (const r of scan.resumedRunIds) resumedRuns.add(r);
    const sSlug = cls.kind === 'main' ? cls.slug : sessionSlugFor(cls);
    const sKey = `${sSlug}/${cls.sessionId}`;
    let bucket = perSession.get(sKey);
    if (!bucket) perSession.set(sKey, bucket = newBucket());

    for (const [msgId, kept] of scan.groups) {
      const rows = rowsFromKept(kept, fileEnt.rel, state);
      // R3 split-group sum assertion: Σ per-row webSearch/webFetch === group top-level
      if (rows.length > 1) {
        r3SplitGroups += 1;
        const stu = (kept.usage && kept.usage.server_tool_use) || {};
        const ws = rows.reduce((a, r) => a + r.webSearch, 0);
        const wf = rows.reduce((a, r) => a + r.webFetch, 0);
        if (ws !== intB(stu.web_search_requests, null) || wf !== intB(stu.web_fetch_requests, null)) r3SplitSumBreaks += 1;
      }
      const canonicalSid = cls.kind === 'main' ? canonicalSession.get(msgId) : undefined;
      const isInherited = canonicalSid !== undefined && canonicalSid !== cls.sessionId;

      for (const row of rows) {
        if (row.cacheIdentityBreak) cacheIdentityBreaks += 1;
        if (row.synthetic) {
          syntheticEvents += kept.lineCountInGroup;
          bucket.synthetic += 1;
          continue; // R4: bills nothing, excluded from requests
        }
        if (row.isSidechain && cls.kind === 'main') {
          // §3 old-style embedded sidechain: foreign rows, excluded from
          // turn billing, disclosed channel (0 in this corpus)
          bucket.embeddedSidechain.requests += 1;
          addTokens(bucket.embeddedSidechain.tokens, row);
          continue;
        }
        if (isInherited) {
          row.billedElsewhere = { sessionId: canonicalSid };
          const inh = bucket.inherited[canonicalSid] ?? (bucket.inherited[canonicalSid] = { requests: 0, tokens: zeroTokens() });
          inh.requests += 1;
          addTokens(inh.tokens, row);
          continue; // contributes to the disclosed inherited channel, not billed totals
        }
        // billed row (canonical, non-synthetic)
        bucket.requests += 1;
        const ctxTokens = row.input + row.cache5m + row.cache1h + row.cacheFlat + row.cacheRead;
        if (ctxTokens > 200000) {
          over200k += 1;
          if (!LONG_CTX_VERIFIED.has(pricing.modelKey(String(row.model ?? '')))) premiumUnknown += 1;
        }
        if (!row.finalized) {
          neverFinalizedRows += 1;
          bucket.neverFinalized += 1;
          bucket.neverFinalizedOutputRecorded += row.output;
        }
        if (row.ttl === 'unrecorded') bucket.ttlAssumed += 1;

        const priced = pricing.priceRow(row);
        if (priced && priced.unpriced !== true && priced.usd) {
          pricedRows += 1;
          addTokens(bucket.tokens, row);
          addUsd(bucket.usd, priced.usd);
          if (bucket.usd.total > MAX_SAFE) overflow = true;
          if (priced.interval === null) intervalMisses += 1;
          if (!evidence || row.output > evidence.output) {
            evidence = { file: fileEnt.rel, abs: fileEnt.abs, line: row.line, msgId: row.msgId, output: row.output };
          }
        } else {
          // R7 — parallel unpriced channel, never $0, never blended. Keyed by
          // the RAW model string with the '(unrecorded)' sentinel — the same
          // key rule as the ledger's unpriced channel (SPEC §6/§9: the raw
          // string is preserved and shown in breakdowns).
          const key = typeof row.model === 'string' ? row.model : '(unrecorded)';
          const up = bucket.unpriced[key] ?? (bucket.unpriced[key] = { requests: 0, tokens: zeroTokens() });
          up.requests += 1;
          addTokens(up.tokens, row);
        }
      }
    }
  }
  for (const bucket of perSession.values()) addBucket(total, bucket);
  total.files = fileCensus.files; // addBucket double-counts the seed; restore census
  total.bytes = fileCensus.bytes;

  // -------- evidence re-read: same file, same 1-based line, same message.id
  let evidencePass = null;
  if (evidence) {
    try {
      const buf = await fsp.readFile(evidence.abs);
      let found = null;
      for (const { text, line } of splitLinesB(buf)) {
        if (line === evidence.line) { found = text; break; }
      }
      if (found !== null) {
        const obj = JSON.parse(stripHeavyB(found, null));
        evidencePass = (obj?.message?.id ?? obj?.uuid) === evidence.msgId;
      } else evidencePass = false;
    } catch { evidencePass = false; }
  }

  // -------- invariants (SPEC §10)
  const pathA = opts.pathA ?? null;
  const inv = (name, pass, expected, actual) => emit('invariant', { name, pass, expected, actual });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  inv('file-census', pathA?.fileCensus ? eq(pathA.fileCensus, fileCensus) : true,
    pathA?.fileCensus ?? null, fileCensus);
  inv('torn-lines', tornAll.length === 0, 0, tornAll.length);
  // SPEC R2(iii): a tie-break IS the ambiguity census — a nonzero tieBreaks
  // count fails the invariant (the `ambiguous` branch is a defensive
  // unreachable; asserted 0 all the same).
  inv('r2-census', ambiguous === 0 && tieBreaks === 0,
    { ambiguous: 0, tieBreaks: 0 }, { duplicateGroups, tieBreaks, ambiguous });
  // pair census: a REAL A-vs-B comparison when Path A supplies its expectation
  // (computed from billed-row speedAbsent/serviceTierAbsent flags); report-only
  // (pass true, expected null) when it cannot.
  {
    const pcExpected = pathA?.expectations?.pairCensus ?? null;
    const pcActual = Object.fromEntries([...pairCensus.entries()].sort());
    inv('pair-census', pcExpected ? eq(pcExpected, pcActual) : true, pcExpected, pcActual);
  }
  inv('usage-integers', state.usageIntViolations === 0, 0, state.usageIntViolations);
  inv('never-finalized',
    pathA?.expectations?.neverFinalized != null ? neverFinalizedRows === pathA.expectations.neverFinalized : true,
    pathA?.expectations?.neverFinalized ?? null,
    { rows: neverFinalizedRows, outputRecorded: total.neverFinalizedOutputRecorded });
  inv('synthetic-census',
    pathA?.expectations?.synthetic != null ? total.synthetic === pathA.expectations.synthetic : true,
    pathA?.expectations?.synthetic ?? null, { rows: total.synthetic, lines: syntheticEvents });
  inv('ttl-assumed', true, 0, total.ttlAssumed);
  inv('cache-identity-after-r3', cacheIdentityBreaks === 0, 0, cacheIdentityBreaks);
  inv('r3-split-sums', r3SplitSumBreaks === 0, { breaks: 0 }, { groups: r3SplitGroups, breaks: r3SplitSumBreaks });
  inv('interval-coverage', intervalMisses === 0, 0, { pricedRows, intervalMisses });
  inv('tcu-non-overflow', !overflow, true, { totalTcu: total.usd.total, maxSafe: MAX_SAFE });
  inv('agents-enumerated', pathA?.agentCount != null ? agents.length === pathA.agentCount : true,
    pathA?.agentCount ?? null, agents.length);
  if (pathA?.turnAgentSum != null) {
    inv('agents-attribution', pathA.turnAgentSum === agents.length, agents.length, pathA.turnAgentSum);
  }
  if (pathA?.sessionSum) {
    inv('session-sum-channels', pathA.sessionSum.pass === true, true, pathA.sessionSum);
  }
  inv('fragment-census', true, null, fragmentCensus);
  inv('journal-files', true, null, journals.length);
  inv('over-200k', premiumUnknown === 0, { premiumUnknown: 0 }, { over200k, premiumUnknown });
  inv('fork-pairs', true, null, [...forkPairs].sort());
  inv('resumed-runs', true, null, [...resumedRuns].sort());
  if (evidence) {
    inv('evidence-reread', evidencePass === true,
      { msgId: evidence.msgId }, { file: evidence.file, line: evidence.line, pass: evidencePass });
  }

  // per-session A/B diff table (all zeros expected) + one `session:<key>`
  // invariant row per session so the audit page's per-session table populates
  // (rows named `session:…` are separated from global invariants client-side).
  if (pathA?.sessions) {
    const mismatches = [];
    for (const [key, b] of perSession) {
      const a = pathA.sessions[key];
      if (!a) { mismatches.push({ session: key, missing: 'pathA' }); continue; }
      if (a.requests !== b.requests || a.usdTotal !== b.usd.total || (a.tokens && !eq(a.tokens, b.tokens))) {
        mismatches.push({
          session: key,
          a: { requests: a.requests, usdTotal: a.usdTotal },
          b: { requests: b.requests, usdTotal: b.usd.total },
        });
      }
    }
    for (const key of Object.keys(pathA.sessions)) {
      if (!perSession.has(key)) mismatches.push({ session: key, missing: 'pathB' });
    }
    inv('ab-session-diff', mismatches.length === 0, 0, { mismatches: mismatches.length, sample: mismatches.slice(0, 5) });
    for (const [key, b] of perSession) {
      const a = pathA.sessions[key] ?? null;
      inv(`session:${key}`,
        a ? (a.requests === b.requests && a.usdTotal === b.usd.total) : null,
        a ? { requests: a.requests, usdTotal: a.usdTotal } : null,
        { requests: b.requests, usdTotal: b.usd.total });
    }
  }
  if (pathA?.totals) {
    inv('ab-total', pathA.totals.requests === total.requests && pathA.totals.usdTotal === total.usd.total,
      { requests: pathA.totals.requests, usdTotal: pathA.totals.usdTotal },
      { requests: total.requests, usdTotal: total.usd.total });
  }

  const elapsedMs = Date.now() - t0;
  emit('progress', { sessionsDone, of: mains.length, bytesDone, ofBytes: bytesTotal, elapsedMs });
  const summary = {
    scope,
    fileCensus,
    strips: state.strips,
    sessions: Object.fromEntries([...perSession].map(([k, v]) => [k, v])),
    totals: total,
    counts: {
      duplicateGroups, tieBreaks, ambiguous,
      neverFinalized: neverFinalizedRows,
      synthetic: total.synthetic,
      ttlAssumed: total.ttlAssumed,
      torn: tornAll.length,
      agents: agents.length,
      mains: mains.length,
      journals: journals.length,
      fragments: fragmentCensus,
      over200k, premiumUnknown,
      forkPairs: [...forkPairs].sort(),
      resumedRuns: [...resumedRuns].sort(),
      r3SplitGroups, r3SplitSumBreaks, cacheIdentityBreaks,
      pricedRows,
      usageIntViolations: state.usageIntViolations,
    },
    problems: state.problems,
    elapsedMs,
  };
  emit('done', {
    sessions: perSession.size, files: fileCensus.files, bytes: fileCensus.bytes,
    requests: total.requests, usdTotal: total.usd.total, elapsedMs,
    // both paths' file censuses, side by side (SPEC §10) — the audit page's
    // census table reads them off the done event
    pathA: pathA?.fileCensus ?? null,
    pathB: fileCensus,
  });
  return summary;
}
