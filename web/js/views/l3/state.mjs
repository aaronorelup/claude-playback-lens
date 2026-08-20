// web/js/views/l3/state.mjs — recorded-state signatures for agents: glyph
// selection (SPEC §7 "named by fact not diagnosis"), lane tags, the ONE phase
// reader, and normalizeAgent — the single projection of a raw agent payload
// the lanes, tree and L4 header all read. Pure.

import { toMs } from '../../lib/fmt.mjs';

export const STATE_GLYPHS = {
  done: { glyph: '✓', label: 'done' },
  error: { glyph: '✗', label: 'error' },
  running: { glyph: '⋯', label: 'running — journal records a start, no result yet' },
  superseded: { glyph: '•', label: 'superseded attempt — journal records a start and a result; the manifest does not list it' },
  'no-result': { glyph: '∅', label: 'no-result — a recorded result that is genuinely empty' },
  unrecorded: { glyph: '—', label: 'no state recorded' },
};

/** Normalise the recorded state fields of one agent (defensive over payload
 *  shape). The server flattens the journal/manifest facts into `stateFacts`
 *  on detailAgents — read them as the recorded fallbacks. */
export function stateSignature(agent) {
  const f = agent?.stateFacts ?? {};
  const manifestState = agent?.state ?? agent?.progress?.state ?? f.manifestState ?? null;
  const inManifest = agent?.inManifest ?? f.inManifest ?? (manifestState !== null ? true : agent?.progress ? true : false);
  const j = agent?.journal ?? {};
  const journalStarted = j.started ?? agent?.journalStarted ?? (f.journalStarted > 0 ? f.journalStarted : null);
  const hasResult = j.result !== undefined && j.result !== null
    ? true
    : (agent?.journalResult !== undefined && agent?.journalResult !== null ? true
      : (j.hasResult ?? (f.journalResult === true ? true : null)));
  const resultEmpty = j.resultEmpty ?? agent?.resultEmpty ?? f.resultEmpty ?? (
    hasResult === true ? isEmptyResult(j.result ?? agent?.journalResult) : null
  );
  return {
    manifestState, inManifest: !!inManifest, journalStarted, hasResult, resultEmpty,
    cached: agent?.cached === true || f.cached === true,
  };
}

function isEmptyResult(result) {
  if (result === null || result === undefined) return null;   // not recorded ≠ empty
  if (typeof result === 'string') return result.trim() === '';
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === 'object') return Object.keys(result).length === 0;
  return false;
}

/**
 * agentGlyph(agent) -> { code, glyph, label, source }
 * Order is the recorded-precedence order of SPEC §7: a manifest error is an
 * error; a recorded-but-empty result is ∅; otherwise done/running/superseded;
 * nothing recorded renders `—` with the reason, never a ✓.
 */
export function agentGlyph(agent) {
  const sig = stateSignature(agent);

  if (sig.manifestState === 'error') {
    return { code: 'error', ...STATE_GLYPHS.error, source: 'workflowProgress[].state' };
  }
  if (sig.resultEmpty === true) {
    return { code: 'no-result', ...STATE_GLYPHS['no-result'], source: 'journal result' };
  }
  if (sig.manifestState === 'done') {
    return { code: 'done', ...STATE_GLYPHS.done, source: 'workflowProgress[].state' };
  }
  // The server pre-computes two RECORDED signatures that are not manifest
  // states — their source is the journal-vs-manifest arithmetic, and
  // `superseded` lands in its own named split group (DESIGN §3).
  if (sig.manifestState === 'superseded') {
    return { code: 'superseded', ...STATE_GLYPHS.superseded, source: 'journal started+result recorded; absent from the manifest (SPEC §7)' };
  }
  if (sig.manifestState === 'running') {
    return { code: 'running', ...STATE_GLYPHS.running, source: 'journal (no manifest entry for this agent)' };
  }
  if (sig.manifestState) {
    // A recorded state outside the observed {done,error} pair — show it as-is.
    return { code: 'other', glyph: '•', label: sig.manifestState, source: 'workflowProgress[].state' };
  }
  if (sig.journalStarted && sig.hasResult !== true) {
    return { code: 'running', ...STATE_GLYPHS.running, source: 'journal (no manifest entry for this agent)' };
  }
  if (sig.journalStarted && sig.hasResult === true) {
    return { code: 'done', glyph: '✓', label: 'done — journal records a result', source: 'journal (no manifest entry for this agent)' };
  }
  return { code: 'unrecorded', ...STATE_GLYPHS.unrecorded, source: null };
}

/** Lane tags — recorded facts only (DESIGN §3 L3). */
export function agentTags(agent) {
  const tags = [];
  if (agent?.cached === true || agent?.stateFacts?.cached === true) {
    tags.push({
      key: 'cached', text: '— cached',
      title: 'replayed from an earlier attempt of this run',
      note: 'listed in the manifest without tokens/toolCalls/durationMs; billed from its transcript in the run\'s first turn (SPEC §7)',
    });
  }
  const wt = agent?.worktreePath ?? agent?.meta?.worktreePath ?? null;
  const flag = agent?.spawnedWithWorktree ?? agent?.meta?.spawnedWithWorktree ?? null;
  if (wt || flag === true || agent?.isolation === 'worktree') {
    tags.push({ key: 'worktree', text: '⌂ worktree', title: wt ? `worktreePath: ${wt}` : 'spawnedWithWorktree recorded; no path recorded' });
  }
  return tags;
}

/* ================================================ agent normalisation == */

/**
 * The ONE phase reader. A workflow phase is recorded under `phaseTitle`
 * (+ `phaseIndex`) and NEVER under `phase`: 696 of 696 workflow_agent entries
 * in the corpus carry phaseTitle, 0 carry phase. Every reader in the app goes
 * through this alias so no view can spell it differently.
 *
 * `||` on the two string fields deliberately, so a recorded empty string
 * normalises to null (an unknown) rather than becoming a "known" blank group
 * key; `!= null` on phaseIndex deliberately, so a recorded phaseIndex 0
 * survives.
 */
export function phaseLabelOf(src) {
  if (!src || typeof src !== 'object') return null;
  // workflowProgress carries TWO recorded entry shapes. The phase MARKER
  // records its own name as `title` (+ `index`). Keyed on the recorded `type`
  // discriminator, so it cannot reach an agent record that happens to carry a
  // title.
  if (src.type === 'workflow_phase') {
    return src.title || (src.index != null ? `phase ${src.index}` : null);
  }
  const prog = src.progress ?? src.workflowProgress ?? {};
  const named = src.phase || src.phaseTitle || prog.phase || prog.phaseTitle;
  if (named) return named;
  const idx = src.phaseIndex != null ? src.phaseIndex : (prog.phaseIndex != null ? prog.phaseIndex : null);
  return idx != null ? `phase ${idx}` : null;
}

/** One agent as the lanes/tree need it. Reads only recorded fields — the
 *  detailAgents payload names (spawnDepth/depth, phaseTitle/phaseIndex,
 *  stateFacts, startedAtRecorded) read as-is. */
export function normalizeAgent(raw) {
  const lineage = raw?.lineage ?? {};
  const meta = raw?.meta ?? {};
  const prog = raw?.progress ?? raw?.workflowProgress ?? {};
  const facts = raw?.stateFacts ?? {};
  const firstAt = toMs(raw?.firstAt ?? raw?.startedAt ?? null);
  const lastAt = toMs(raw?.lastAt ?? raw?.endedAt ?? null);
  // The model ladder mirrors the shipped server ladder in server/api.mjs, so
  // the workflow-run page, L3 and L4 cannot disagree. The [1m] long-context
  // suffix that SPEC requires be displayed as a recorded fact lives ONLY in
  // workflowProgress[].model / toolUseResult.resolvedModel, so those outrank
  // the coarse meta.json alias (one of only four values corpus-wide, never a
  // full id). The truthiness test (not ??) keeps a recorded empty string an
  // unknown, the same discipline phaseLabelOf uses. modelSource is derived
  // HERE rather than hard-coded at the render site, so a fact can never name
  // a source that did not supply it.
  const modelCand = [
    [raw?.model, 'recorded model (server-resolved ladder)'],
    [raw?.resolvedModel, 'toolUseResult.resolvedModel'],
    [raw?.progressModel ?? prog.model, 'workflowProgress[].model'],
    [Array.isArray(raw?.models) ? raw.models[0] : null, 'message.model on this agent’s own events'],
    [raw?.metaModel ?? meta.model, 'meta.json model (a bare alias, never a full id)'],
  ].find(([v]) => typeof v === 'string' && v) ?? [null, null];
  return {
    agentId: raw?.agentId ?? raw?.id ?? null,
    label: raw?.label?.text ?? (typeof raw?.label === 'string' ? raw.label : null) ?? prog.label ?? meta.description ?? null,
    labelSource: raw?.label?.source ?? (prog.label ? 'workflowProgress[].label' : meta.description ? 'meta.description' : null),
    agentType: raw?.agentType ?? meta.agentType ?? null,
    model: modelCand[0], modelSource: modelCand[1],
    state: raw?.state ?? prog.state ?? null,
    stateFacts: raw?.stateFacts ?? null,
    // The recorded manifest membership — stateFacts is the server's flattened
    // source; only when nothing records it does it stay undefined.
    inManifest: raw?.inManifest ?? facts.inManifest ?? (prog.state !== undefined ? true : undefined),
    phase: phaseLabelOf(raw),
    attempt: raw?.attempt ?? prog.attempt ?? facts.attempt ?? null,
    // Recorded depth, under BOTH shipped names (spawnDepth is the canonical
    // payload name; `depth` its documented alias) — a lane with no recorded
    // depth stays unindented, never defaulted to a depth it lacks.
    spawnDepth: raw?.spawnDepth ?? raw?.depth ?? meta.spawnDepth ?? null,
    parentAgentId: raw?.parentAgentId ?? meta.parentAgentId ?? lineage.parentAgentId ?? null,
    runId: raw?.runId ?? lineage.runId ?? null,
    lineageKind: lineage.kind ?? raw?.kind ?? null,
    toolUseId: raw?.toolUseId ?? meta.toolUseId ?? lineage.toolUseId ?? null,
    spawnLine: raw?.spawnLine ?? lineage.spawnLine ?? null,
    // Bar bounds — SPEC §4: an agent bar is its OWN transcript's first/last ts.
    firstAt, lastAt,
    // Queued segment — drawn only when workflowProgress recorded it.
    queuedAt: toMs(raw?.queuedAt ?? prog.queuedAt ?? null),
    progStartedAt: toMs(raw?.progStartedAt ?? raw?.startedAtRecorded ?? prog.startedAt ?? null),
    durationMs: raw?.durationMs ?? prog.durationMs ?? null,
    cached: (raw?.cached ?? prog.cached ?? facts.cached) === true,
    worktreePath: raw?.worktreePath ?? meta.worktreePath ?? null,
    spawnedWithWorktree: raw?.spawnedWithWorktree ?? meta.spawnedWithWorktree ?? null,
    isolation: raw?.isolation ?? prog.isolation ?? null,
    journal: raw?.journal ?? null,
    cost: raw?.cost ?? raw?.agg ?? null,
    tokens: raw?.tokens ?? raw?.usage ?? raw?.cost?.tokens ?? raw?.agg?.tokens ?? null,
    toolCalls: raw?.toolCalls ?? raw?.counts?.toolCalls ?? prog.toolCalls ?? null,
    raw,
  };
}
