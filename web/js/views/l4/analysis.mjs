// web/js/views/l4/analysis.mjs — L4's pure data shaping: tool-span pairing by
// recorded id, tool/stop-reason censuses, the file-path harvest (SPEC §8),
// the header-facts descriptors with their sources named, the explicit
// agent-fact key pick, the journal-result fact, and the raw-view windowing
// arithmetic. No DOM, no fetches.

import { fmtInt, fmtDur, fmtLocalTime, toMs, truncate } from '../../lib/fmt.mjs';
import { safeStringify } from '../../lib/text.mjs';

/* ==================================================== tool span pairing ==
 * DESIGN §3: "tool spans (tool_use→tool_result by id; unmatched = tick+∅ with
 * toolDenialKind when present)". Pure: rows in, spans out. Pairing is BY
 * RECORDED ID only — never by adjacency, never by name.
 */

// The parse rows record the id as `extra.toolUseId` on BOTH sides of the
// pair, and the tool name as `extra.tool` — those shipped names come first;
// the legacy aliases stay as fallbacks for older fixtures.
export function toolUseIdOf(row) {
  const e = row?.extra ?? {};
  return e.toolUseId ?? e.id ?? e.tool_use_id ?? row?.id ?? null;
}

export function toolResultIdOf(row) {
  const e = row?.extra ?? {};
  return e.toolUseId ?? e.tool_use_id ?? e.id ?? row?.toolUseId ?? null;
}

export function toolNameOf(row) {
  const e = row?.extra ?? {};
  return e.tool ?? e.name ?? e.toolName ?? row?.name ?? null;
}

/**
 * pairToolSpans(rows) -> { spans, unmatchedUses, unmatchedResults }
 * A span exists only when a tool_use and a tool_result carry the SAME recorded
 * id. Repeated ids pair first-open-first (file order).
 */
export function pairToolSpans(rows = []) {
  const spans = [];
  const open = new Map();
  const unmatchedResults = [];

  for (const r of rows) {
    if (r?.kind === 'tool_use') {
      const id = toolUseIdOf(r);
      const span = {
        id, name: toolNameOf(r),
        startLine: r.line ?? null, startBi: r.bi ?? null, startAt: toMs(r.at),
        endLine: null, endBi: null, endAt: null, matched: false, isError: null,
        denialKind: r.extra?.denial ?? r.extra?.toolDenialKind ?? null,
      };
      spans.push(span);
      if (id) {
        if (!open.has(id)) open.set(id, []);
        open.get(id).push(span);
      }
    } else if (r?.kind === 'tool_result') {
      const id = toolResultIdOf(r);
      const queue = id ? open.get(id) : null;
      const span = queue && queue.length ? queue.shift() : null;
      if (span) {
        span.matched = true;
        span.endLine = r.line ?? null;
        span.endBi = r.bi ?? null;
        span.endAt = toMs(r.at);
        // parse rows ship `extra.isError` (tri-state collapsed: only === true
        // is an error — SPEC §3); is_error kept as a fixture fallback.
        const ie = r.extra?.isError ?? r.extra?.is_error;
        span.isError = ie === true ? true : (ie === false ? false : null);
        const dk = r.extra?.denial ?? r.extra?.toolDenialKind;
        if (dk) span.denialKind = dk;
      } else {
        unmatchedResults.push({ id, line: r.line ?? null, at: toMs(r.at), head: r.head ?? '' });
      }
    }
  }
  return { spans, unmatchedUses: spans.filter((sp) => !sp.matched), unmatchedResults };
}

/* ============================================================ censuses == */

/** Census of recorded tool names. */
export function toolHistogram(rows = []) {
  const counts = new Map();
  for (const r of rows) {
    if (r?.kind !== 'tool_use') continue;
    const name = toolNameOf(r) ?? '(no name recorded)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])));
}

/** MCP servers and Skills, read off the recorded tool names (SPEC §7). */
export function attributionCensus(histogram) {
  const mcp = new Map(), skills = new Map();
  for (const [name, n] of histogram) {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
    if (m) mcp.set(m[1], (mcp.get(m[1]) ?? 0) + n);
    else if (name === 'Skill') skills.set('Skill', (skills.get('Skill') ?? 0) + n);
  }
  return { mcp: [...mcp.entries()], skills: [...skills.entries()] };
}

/** Census of a recorded scalar across rows (stop_reason, effort, …). */
export function census(rows, pick) {
  const counts = new Map();
  let notRecorded = 0;
  for (const r of rows) {
    const v = pick(r);
    if (v === null || v === undefined || v === '') { notRecorded++; continue; }
    counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  }
  return { entries: [...counts.entries()].sort((x, y) => y[1] - x[1]), notRecorded, of: rows.length };
}

export function censusText(c) {
  if (!c.entries.length) return null;
  return c.entries.map(([k, n]) => `${k} ${fmtInt(n)}`).join(' · ');
}

/* =================================================== file-path harvest ==
 * SPEC §8: paths come from tool_use.input keyed BY TOOL NAME. Free-form
 * path-shaped keys inside StructuredOutput/MCP inputs are payload fields, NOT
 * file operations, and are excluded. The view prints its denominator.
 */

const PATH_KEY_BY_TOOL = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path',
  NotebookEdit: 'notebook_path', Glob: 'path', Grep: 'path',
};

export function harvestPaths(rows = []) {
  const byPath = new Map();
  let toolCalls = 0, withPath = 0, resultsWithoutSidecar = 0;
  for (const r of rows) {
    if (r?.kind === 'tool_use') {
      toolCalls++;
      const name = toolNameOf(r);
      const key = PATH_KEY_BY_TOOL[name];
      const input = r.extra?.input ?? r.extra ?? {};
      const p = key ? (input[key] ?? r.extra?.[key] ?? null) : null;
      if (!p) continue;
      withPath++;
      if (!byPath.has(p)) byPath.set(p, { path: p, read: 0, write: 0, edit: 0, search: 0, lines: [] });
      const rec = byPath.get(p);
      if (name === 'Read') rec.read++;
      else if (name === 'Write') rec.write++;
      else if (name === 'Edit' || name === 'NotebookEdit') rec.edit++;
      else rec.search++;
      if (r.line !== undefined) rec.lines.push(r.line);
    } else if (r?.kind === 'tool_result') {
      const fp = r.extra?.filePath ?? null;
      if (fp) {
        if (!byPath.has(fp)) byPath.set(fp, { path: fp, read: 0, write: 0, edit: 0, search: 0, lines: [] });
      } else resultsWithoutSidecar++;
    }
  }
  return {
    paths: [...byPath.values()].sort((x, y) => String(x.path).localeCompare(String(y.path))),
    toolCalls, withPath, resultsWithoutSidecar,
  };
}

/* ======================================================== header facts ==
 * Plain descriptors {label, value, source, reason, note} so the wording and
 * the source-naming are testable without a DOM.
 */

export function headerFacts(ag, { worktreeOnDisk = null } = {}) {
  const facts = [];
  const F = (label, value, source, reason, note) => facts.push({ label, value: value ?? null, source: value === null || value === undefined ? null : source, reason, note });

  F('label', ag.label, ag.labelSource ?? 'recorded label', 'no label recorded on any of the five recorded sources (SPEC §7)');
  if (ag.promptTag && ag.promptTag !== ag.label) {
    F('[AGENT] tag', ag.promptTag, '[AGENT: x] tag in the agent prompt', null,
      'label and tag legitimately differ — per-item vs per-role (SPEC §7)');
  }
  F('agentId', ag.agentId, 'the transcript filename stem (= the recorded agentId)', 'not recorded');
  F('agentType', ag.agentType, 'meta.json agentType', 'not recorded in the sidecar');
  // The source is DERIVED by normalizeAgent's ladder, never a static string
  // here: normalizeAgent guarantees modelSource is non-null exactly when
  // model is, so no fact can name a source it did not use.
  F('model (raw)', ag.model, ag.modelSource, 'no model recorded for this agent');
  if (ag.resolvedModel) {
    F('resolvedModel', ag.resolvedModel, 'toolUseResult.resolvedModel', null,
      String(ag.resolvedModel).includes('[1m]') ? 'the [1m] suffix appears only here and in workflowProgress[].model; it is a recorded fact and prices identically (SPEC §5)' : null);
  }
  F('effort', ag.effortCensus ?? null, 'recorded effort values across this agent\'s rows', 'no effort value is recorded on any row of this transcript');
  F('state', ag.state, 'workflowProgress[].state', 'no manifest entry lists this agent — see the glyph source below');
  // The provenance line names the key the manifest actually records.
  F('phase', ag.phase, 'workflowProgress[].phaseTitle / phaseIndex', 'no phase recorded');
  F('attempt', ag.attempt, 'workflowProgress[].attempt', 'no attempt recorded');
  F('spawnDepth', ag.spawnDepth, 'meta.json spawnDepth', 'not recorded');
  F('parentAgentId', ag.parentAgentId, 'meta.json parentAgentId', 'parent not recorded');
  F('spawn tool_use', ag.toolUseId, 'meta.json toolUseId', 'no spawning tool_use recorded (workflow agents are linked through their run dir instead)');
  F('runId', ag.runId, 'the run directory holding this transcript', 'not a workflow agent');
  F('queuedAt', ag.queuedAt === null ? null : fmtLocalTime(ag.queuedAt), 'workflowProgress[].queuedAt', 'not recorded — the hatched queued segment is drawn only when it is');
  F('startedAt (manifest)', ag.progStartedAt === null ? null : fmtLocalTime(ag.progStartedAt), 'workflowProgress[].startedAt', 'not recorded');
  F('first timestamp', ag.firstAt === null ? null : fmtLocalTime(ag.firstAt, { ms: true }), 'first event of its own transcript (SPEC §4 bounds ledger)', 'this transcript records no timestamp');
  F('last timestamp', ag.lastAt === null ? null : fmtLocalTime(ag.lastAt, { ms: true }), 'last event of its own transcript (SPEC §4 bounds ledger)', 'this transcript records no timestamp');
  F('wall', (ag.firstAt !== null && ag.lastAt !== null) ? fmtDur(ag.lastAt - ag.firstAt) : null,
    'arithmetic on the two recorded transcript timestamps', 'a wall figure needs two recorded timestamps');
  F('durationMs (manifest)', ag.durationMs === null || ag.durationMs === undefined ? null : fmtDur(ag.durationMs), 'workflowProgress[].durationMs', 'not recorded (cached replays carry no counters — SPEC §7)');
  if (ag.cached) {
    F('cached', 'true', 'workflowProgress[].cached', null,
      'replayed from an earlier attempt of this run; listed in the manifest without tokens/toolCalls/durationMs and billed from its transcript in the run\'s first turn (SPEC §7)');
  }
  const wt = ag.worktreePath;
  if (wt || ag.spawnedWithWorktree === true || ag.isolation === 'worktree') {
    F('isolation', ag.isolation ?? (ag.spawnedWithWorktree === true ? 'worktree (spawnedWithWorktree)' : null), 'workflowProgress[].isolation', 'not recorded');
    F('worktreePath', wt, 'meta.json worktreePath', 'not recorded',
      wt ? (worktreeOnDisk === false ? 'path not on disk' : worktreeOnDisk === true ? 'path resolves on disk' : 'whether the path still resolves is not reported by this payload') : null);
    F('spawnedWithWorktree', ag.spawnedWithWorktree === undefined || ag.spawnedWithWorktree === null ? null : String(ag.spawnedWithWorktree), 'meta.json spawnedWithWorktree', 'not recorded');
  }
  return facts;
}

/* ==================================================== agent-fact pick == */

/** The agent-fact keys picked EXPLICITLY off the /api/agent envelope — a
 *  future envelope-level field outside this list can never leak into the
 *  agent's state signature. */
const AGENT_FACT_KEYS = [
  'agentId', 'rel', 'runId', 'kind', 'toolUseId', 'parentAgentId', 'depth', 'spawnDepth',
  'agentType', 'metaModel', 'models', 'resolvedModel', 'progressModel', 'label', 'tag',
  'state', 'stateFacts', 'cached', 'worktreePath', 'spawnedWithWorktree', 'isolation',
  'attempt', 'phaseIndex', 'phaseTitle', 'phase', 'turnIdx', 'attributedBy', 'spawnLine',
  'firstAt', 'lastAt', 'queuedAt', 'startedAtRecorded', 'durationMs', 'counts', 'usage',
  'meta', 'lineage', 'progress', 'journal', 'toolCalls', 'inManifest',
];
export function pickAgentFacts(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of AGENT_FACT_KEYS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/* ==================================================== journal result == */

function journalResultText(j) {
  if (!j) return null;
  const r = j.result ?? (j.hasResult ? '(recorded)' : null);
  if (r === null || r === undefined) return null;
  if (typeof r === 'string') return r === '' ? '(recorded, and genuinely empty)' : truncate(r, 300);
  return truncate(safeStringify(r), 300);
}

/**
 * The 'journal result' fact, derived from what is actually on the wire.
 *
 * Neither /api/agent nor /api/session's agents[] carries a bare `journal`
 * object; the server flattens the recorded facts onto `stateFacts`
 * (journalStarted / journalResult / resultEmpty) — read exactly as
 * stateSignature (l3) does for the state glyph. "The journal records no
 * result" is claimed only when stateFacts prove it; a payload that carries no
 * journal facts at all yields an UNKNOWN, never a claim about the journal.
 *
 * Deliberately NOT solved by synthesising a fake `journal` object inside
 * normalizeAgent: that structure feeds the L3 lanes too, and an inferred
 * shape has no business in it.
 */
export function journalResultFact(journal, stateFacts) {
  // A real journal object beats every derivation — it carries the result TEXT.
  if (journal) {
    return {
      label: 'journal result', value: journalResultText(journal),
      source: 'journal.jsonl result entry',
      reason: 'the journal records no result for this agent',
    };
  }
  const f = stateFacts ?? null;
  if (f === null) {
    // `main` has no stateFacts by construction, and neither does an agent this
    // envelope never projected — UNKNOWN, never a claim about the journal.
    return {
      label: 'journal result', value: null, source: null,
      reason: 'this envelope carries no journal facts for this agent',
    };
  }
  const source = 'journal.jsonl result entry, via the flattened stateFacts';
  if (f.journalResult === true) {
    return {
      label: 'journal result', source,
      value: f.resultEmpty === true
        ? '(recorded, and genuinely empty)'
        : '(recorded — the result text is not carried in this envelope)',
    };
  }
  // stateFacts exist and say there is no result: now the claim is provable.
  return {
    label: 'journal result', value: null, source,
    reason: 'the journal records no result for this agent',
  };
}

/* ==================================================== raw-view windows ==
 * Virtualized raw JSONL over /api/lines windows. A 33 MB transcript is never
 * fetched whole (DESIGN §3 L4, SPEC §9).
 */

export const RAW_WINDOW = 500;

/**
 * Row height of the virtualised raw list, in px. This is not decoration: the
 * raw view's scroll arithmetic (first-visible line, jump-to-line, spacer
 * height, window top) assumes every painted row is exactly this tall. It MUST
 * equal the height declared by `.lens-raw__line--virt` in web/styles.css,
 * which is what actually sizes the rows; a drift between the two would
 * silently misalign jump-to-line. tests/fixes-round16.test.mjs pins the two
 * together.
 */
export const RAW_LINE_H = 18;

/** Which RAW_WINDOW-line window covers a 1-based line. Pure. */
export function windowFor(line1, size = RAW_WINDOW) {
  const n = Math.max(1, Math.floor(Number(line1) || 1));
  const from = Math.floor((n - 1) / size) * size + 1;
  return { from, count: size };
}
