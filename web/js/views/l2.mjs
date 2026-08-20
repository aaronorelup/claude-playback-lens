// web/js/views/l2.mjs — L2 (one session). Group F.
// DESIGN §3 L2: top strip (turns lane + agent-concurrency strip + marker lane),
// session facts row, turn cards; ?v=agents|timeline|workflows|files|images.
// 0-agent sessions are the MAJORITY case (68 of 85, DESIGN §10): the concurrency
// strip is omitted entirely at 0 agents and the degenerate flip never fires.

import { defineRoute as importedDefineRoute, navigate, showReloadBar } from '../router.mjs';
import { api } from '../api.mjs';
import { scopeString } from '../components/scope.mjs';
import { timeline, occupancy as sharedOccupancy, MARK_CAP } from '../components/timeline.mjs';
import { classifyRel } from './inv.mjs';
import {
  h, val, dash, replaceEl, storeHref, projectHref, sessionHref, turnHref, agentHref,
  eventHref, workflowHref, sessionInvHref, mountBands, buildStatbarProps, mountTable,
  viewTabs, col, tokenCols, tokenValues, tokenCells, resetViewState, schedulePoll, ensurePricing,
  usdCell, fmtInt, fmtBytes, fmtSpan, fmtStamp, fmtClock, withQuery, deriveBadges,
  badgeRow, cardAgg, aggTokens, aggUsd, sessionTitleOf, track, hostCalendar, tzLabel,
  indexStatus, denominatorSentence, firstFinite, pendingOf, NO_AGG_REASON,
} from './l0.mjs';
// ONE phase reader for the whole app (see l3.mjs) — the session
// agents table and its ?group=phase both read the recorded phaseTitle through
// it, instead of the `phase` key /api/session has never shipped.
import { phaseLabelOf } from './l3.mjs';

/* ===========================================================================
   Pure helpers (covered by tests/views-overview-l2.test.mjs)
   =========================================================================== */

export const L2_VIEWS = ['turns', 'agents', 'timeline', 'workflows', 'files', 'images'];

const fin = firstFinite;

export function agentCountOf(detail) {
  return fin(detail && detail.agentCount) ?? ((detail && detail.agents) ? detail.agents.length : 0);
}
export function nonPreambleTurns(detail) {
  return ((detail && detail.turns) || []).filter((t) => !t.preamble).length;
}

/** DESIGN §3 L2 degenerate flip. An explicit `?v=` always wins — the flip only
 *  chooses a DEFAULT. Measured: 21 one-turn sessions, 19 of them agentless, so
 *  the flip must never land an agentless session on an empty agents table. */
export function chooseSessionView(detail, requested) {
  if (requested && L2_VIEWS.includes(requested)) return { view: requested, flipped: false, note: null };
  const turns = nonPreambleTurns(detail);
  const agents = agentCountOf(detail);
  if (turns <= 1 && agents > 0) {
    return {
      view: 'agents', flipped: true,
      note: `${fmtInt(turns)} non-preamble turn${turns === 1 ? '' : 's'}, ${fmtInt(agents)} agent${agents === 1 ? '' : 's'} — showing the agents`,
    };
  }
  if (turns === 1 && agents === 0) return { view: 'turns', flipped: false, note: '1 turn, 0 agents — showing the turn' };
  if (turns === 0 && agents === 0) return { view: 'turns', flipped: false, note: 'no turn opener is recorded in this file — only the preamble' };
  return { view: 'turns', flipped: false, note: null };
}

/** Exact ±1 occupancy over recorded intervals — THE shared implementation
 *  (components/timeline.mjs), re-exported so this module keeps its public
 *  surface. */
export const occupancy = sharedOccupancy;

/** SPEC §4 bounds ledger: turn bar = opener → max over the turn's conversation
 *  rows; hatched extension = turn end → max over its agents' own last timestamps. */
export function turnBarModel(detail) {
  const byId = new Map();
  for (const a of (detail && detail.agents) || []) if (a && a.agentId) byId.set(a.agentId, a);
  return ((detail && detail.turns) || []).map((t) => {
    const at = fin(t.at), end = fin(t.endedAt, t.endAt);
    let agentEnd = null;
    const ids = t.agentIds || [];
    for (const id of ids) {
      const a = byId.get(id);
      const l = a ? fin(a.lastAt, a.endedAt, a.endAt) : null;
      if (l !== null) agentEnd = agentEnd === null ? l : Math.max(agentEnd, l);
    }
    const base = end !== null ? end : at;
    const overhang = (agentEnd !== null && base !== null && agentEnd > base) ? { start: base, end: agentEnd } : null;
    return {
      idx: t.idx, preamble: !!t.preamble, at, end, overhang,
      agentIds: ids, agents: ids.length,
      workflowRunIds: t.workflowRunIds || [],
      promptHead: t.promptHead || '',
      usage: t.usage || null,
      agg: cardAgg(t),
      wall: at !== null && end !== null ? end - at : null,
      raw: t,
    };
  });
}

/** Agent bars: first/last timestamp of the agent's own transcript (SPEC §4). */
export function agentIntervals(detail) {
  return ((detail && detail.agents) || []).map((a) => ({
    agentId: a.agentId,
    start: fin(a.firstAt, a.startedAt),
    end: fin(a.lastAt, a.endedAt),
    label: agentLabelOf(a).text,
  })).filter((x) => x.start !== null);
}

export function agentLabelOf(a) {
  const l = a && a.label;
  if (l && typeof l === 'object' && l.text) return { text: l.text, source: l.source || null };
  if (typeof l === 'string' && l) return { text: l, source: a.labelSource || null };
  if (a && a.description) return { text: a.description, source: 'meta.description' };
  const type = (a && a.agentType) || 'agent';
  return { text: `${type} ${(a && a.agentId) || ''}`.trim(), source: 'agentType + agentId (no label recorded)' };
}

/** Session bar = min over turn/agent bar starts, max over their ends (SPEC §4). */
export function sessionBounds(detail) {
  let lo = null, hi = null;
  const take = (s, e) => {
    if (Number.isFinite(s)) lo = lo === null ? s : Math.min(lo, s);
    const end = Number.isFinite(e) ? e : s;
    if (Number.isFinite(end)) hi = hi === null ? end : Math.max(hi, end);
  };
  for (const t of turnBarModel(detail)) take(t.at, t.overhang ? t.overhang.end : t.end);
  for (const a of agentIntervals(detail)) take(a.start, a.end);
  if (lo === null) take(fin(detail && detail.startedAt), fin(detail && detail.endedAt));
  return { start: lo, end: hi, span: lo !== null && hi !== null ? hi - lo : null };
}

/** DESIGN §3 L2 fork banner, from the CostAgg's R2 `inherited` channel. */
export function forkBanner(agg) {
  const inh = agg && agg.inherited;
  if (!inh || typeof inh !== 'object') return null;
  const sessions = Object.entries(inh)
    .map(([id, v]) => ({ id, requests: fin(v && v.requests), tokens: (v && v.tokens) || null }))
    .filter((s) => s.requests || s.tokens);
  if (!sessions.length) return null;
  const inherited = sessions.reduce((n, s) => n + (s.requests || 0), 0);
  const billedHere = fin(agg.requests);
  const fileRows = billedHere === null ? null : billedHere + inherited;
  return {
    sessions, inherited, billedHere, fileRows,
    text: fileRows === null
      ? `${fmtInt(inherited)} billed rows in this file are inherited from ${sessions.length} other session${sessions.length === 1 ? '' : 's'} (fork); they are billed there, not here · R2`
      : `${fmtInt(inherited)} of ${fmtInt(fileRows)} billed rows in this file are inherited from ${sessions.map((s) => s.id.slice(0, 8)).join(', ')} (fork); billed there, not here · R2`,
    denominatorNote: 'rows in this file = rows billed here + rows inherited from the canonical session',
  };
}

/** The CANONICAL side's fork banner, from /api/session's `forkPartners`
 *  reverse map. The CostAgg cannot supply this: on the canonical side
 *  `inherited` is empty by construction (these rows ARE billed here), so
 *  forkBanner() never fires and that side would otherwise carry no R2
 *  disclosure at all.
 *
 *  Three rules this obeys:
 *   - `null` is UNKNOWN (the index is still building; /api/session withholds
 *     the map rather than claim a false none) → no banner, never "no fork".
 *   - it is INDEPENDENT of forkBanner(agg): in a 3-way duplicate group one
 *     session can inherit some msgIds and be canonical for others, and both
 *     disclosures are true at once.
 *   - it does NOT reuse the inherited side's denominator — these rows are
 *     billed here, so nothing is added to this file's request count. */
export function forkPartnerBanner(detail) {
  const fp = detail && detail.forkPartners;
  if (!fp || typeof fp !== 'object') return null; // null/absent = unknown; {} = a real none
  const partners = Object.entries(fp)
    .map(([id, v]) => ({
      id,
      slug: v && typeof v.slug === 'string' ? v.slug : null,
      shared: fin(v && v.sharedMsgIds),
      billedHere: fin(v && v.billedHere) ?? 0,
      billedThere: fin(v && v.billedThere) ?? 0,
      billedElsewhere: fin(v && v.billedElsewhere) ?? 0,
    }))
    // billedHere > 0 is what makes this the CANONICAL side's banner: where
    // billedHere is 0 the rows are inherited and forkBanner(agg) already says so.
    .filter((p) => p.billedHere > 0);
  if (!partners.length) return null;
  const sentence = (p) => {
    const head = p.shared === null
      ? `${fmtInt(p.billedHere)} msgIds in this file also appear in ${p.id.slice(0, 8)} (fork); they are billed here, not there`
      : `${fmtInt(p.billedHere)} of ${fmtInt(p.shared)} msgIds in this file also appear in ${p.id.slice(0, 8)} (fork); those ${fmtInt(p.billedHere)} are billed here, not there`;
    return p.billedElsewhere > 0
      ? `${head}; ${fmtInt(p.billedElsewhere)} more are billed in a third session`
      : head;
  };
  return {
    partners,
    text: `${partners.map(sentence).join(' · ')} · R2`,
    denominatorNote: 'shared msgIds = ids recorded in both files; a shared id billed in neither is a synthetic or embedded-sidechain row, which bills $0 in every file (R4 / SPEC §3)',
  };
}

/** The session payload's OWN R2 state.
 *
 *  /api/session ships `r2` ('pending' while the index builds, else 'resolved')
 *  and NOTHING of the /api/index `status`/`scope`/`building`/`pending[]` shape
 *  that indexStatus() reads, so `indexStatus(detail).building` is FALSE for
 *  every session payload — L0/L1 self-refresh while the index builds, L2 was
 *  the outlier. While r2 is pending the payload discloses two unresolved
 *  states (agg.inheritedPending lights the R2-pending chip, forkPartners is
 *  null so the canonical-side banner is withheld); once R2 resolves neither is
 *  true any more, and a session that is not itself growing on disk had no
 *  poll of any kind to notice. Reading the payload's own field is the
 *  session-level equivalent of L0's building poll — indexStatus() is left
 *  alone (it is shared with l0/l1, where it drives the real
 *  done-of-total denominator sentence a session payload cannot supply). */
export function r2Pending(detail) {
  return !!detail && typeof detail === 'object' && detail.r2 === 'pending';
}

/** Live badge: `indexed through N of M bytes (93.6%)` (DESIGN §3 L2). */
export function liveProgress(detail) {
  const live = !!detail && (detail.state === 'live' || (Array.isArray(detail.badges) && detail.badges.includes('live')));
  const indexed = fin(detail && detail.bytesIndexed, detail && detail.indexedBytes, detail && detail.prefixBytes);
  const total = fin(detail && detail.bytes);
  const pct = indexed !== null && total ? (indexed / total) * 100 : null;
  return {
    live, indexed, total, pct,
    text: indexed === null || total === null ? null
      : `indexed through ${fmtInt(indexed)} of ${fmtInt(total)} bytes (${pct.toFixed(1)}%)`,
    reason: indexed === null ? 'the payload records no indexed-byte prefix for this file' : null,
  };
}

/** A payload may ship a LIST or only a COUNT for images/files. Saying "none
 *  recorded" when the count is 12 would be a lie; this separates the two. */
export function listOrCount(value, noun) {
  if (Array.isArray(value)) return { list: value, count: value.length, countOnly: false, note: null };
  if (Number.isFinite(value)) {
    return {
      list: [], count: value, countOnly: value > 0,
      note: value > 0
        ? `${fmtInt(value)} ${noun} are recorded for this session, but this payload ships the count only — not the per-${noun.replace(/s$/, '')} locators this view draws.`
        : null,
    };
  }
  return { list: [], count: null, countOnly: false, note: null };
}

/** DESIGN §3 L2 ?v=files: the coverage denominator is printed ON the view.
 *  The shipped denominator names are mainToolCallsWithPath /
 *  agentToolCallsWithPath / agentResultsNoSidecar (/files endpoint); the
 *  older aliases stay as fixture fallbacks. */
export function coverageSentence(cov) {
  const main = fin(cov && cov.mainToolCallsWithPath, cov && cov.mainToolCalls, cov && cov.main);
  const agent = fin(cov && cov.agentToolCallsWithPath, cov && cov.agentToolCalls, cov && cov.agent);
  const noSidecar = fin(cov && cov.agentResultsNoSidecar, cov && cov.agentResultsWithoutSidecar, cov && cov.noSidecar, cov && cov.agentResultsNoPath);
  const parts = [`paths from ${main === null ? '—' : fmtInt(main)} main-thread and ${agent === null ? '—' : fmtInt(agent)} agent tool calls that carry a path key`];
  if (noSidecar !== null) parts.push(`${fmtInt(noSidecar)} agent tool results carry no path sidecar`);
  const known = main !== null || agent !== null || noSidecar !== null;
  return {
    text: parts.join('; ') + '.',
    known,
    reason: known ? null : 'the payload records no tool-call denominators for this session',
  };
}

/** The SEVEN metadata types of SPEC §3 (custom-title, ai-title, mode,
 *  last-prompt, pr-link, frame-link, queue-operation), each as latest value +
 *  count with its source named; the two title types share one cell. FOUR types
 *  carry no timestamp at all (custom-title, ai-title, mode, last-prompt) —
 *  file order only; queue-operation is the one REAL timeline event among them
 *  and its cell says so. */
export function sessionFacts(detail) {
  const d = detail || {};
  const facts = d.facts || d.metadata || {};
  const countOf = (key, ...alts) => {
    const c = d.counts || d.metaCounts || {};
    const f = facts[key];
    return fin(f && f.count, c[key], ...alts.map((a) => d[a]));
  };
  const out = [];
  const custom = (facts.customTitle && facts.customTitle.value) || d.customTitle || null;
  const ai = (facts.aiTitle && facts.aiTitle.value) || d.aiTitle || null;
  out.push({
    key: 'title', label: 'title', untimed: true,
    value: custom || ai || d.title || d.id || null,
    display: custom && ai ? `${custom} ▸ ${ai}` : (custom || ai || d.title || null),
    source: custom ? 'custom-title (latest in file order)' : ai ? 'ai-title (latest in file order)' : 'no title event recorded',
    counts: [
      custom ? { label: 'custom-title events', n: countOf('customTitle', 'customTitleCount') } : null,
      ai ? { label: 'ai-title rewrites', n: countOf('aiTitle', 'aiTitleCount') } : null,
    ].filter(Boolean),
    reason: custom || ai ? null : 'no custom-title or ai-title event in this file',
  });
  // THREE states, never two. "no mode event recorded" is a positive
  // claim about the FILE; a payload that simply does not carry the field has
  // said nothing about the file, and collapsing the two (which `|| []` and
  // `|| null` did) printed that positive denial on every session whose payload
  // was merely silent. A count of 0 shipped by the server IS the recorded
  // absence and still says "no … event recorded".
  const modeVal = (facts.mode && facts.mode.value) || d.mode || null;
  const modeCount = countOf('mode', 'modeCount');
  out.push({
    key: 'mode', label: 'mode', untimed: true, value: modeVal, display: modeVal,
    source: modeVal ? 'mode (latest in file order)'
      : modeCount === null ? 'mode — not recorded in this payload'
      : modeCount > 0 ? 'mode events recorded, none carrying a value'
      : 'no mode event recorded',
    counts: [{ label: 'mode events', n: modeCount }],
    reason: modeVal ? null
      : modeCount === null ? 'this payload carries no mode fact for this session'
      : modeCount > 0 ? 'mode events are recorded in this file but none carried a mode value'
      : 'no mode event in this file',
  });
  const prsRaw = d.prLinks ?? (facts.prLink && facts.prLink.values) ?? null;
  const prs = Array.isArray(prsRaw) ? prsRaw : [];
  // countOf first: the items are DEDUPED by the parser and the count is not —
  // 36 pr-link events over one PR must print 36, never 1. The
  // prs.length fallback is only for a payload that ships the list alone.
  const prCount = countOf('prLink', 'prLinkCount') ?? (prs.length || null);
  out.push({
    key: 'pr', label: 'PR links', untimed: false,
    value: prs.length ? prs : null,
    links: prs.map((p) => ({
      href: p.prUrl || null,
      label: p.prRepository && p.prNumber ? `${p.prRepository}#${p.prNumber}` : (p.prUrl || 'pr-link'),
      title: p.prUrl || '',
    })),
    source: prs.length ? 'pr-link events'
      : !Array.isArray(prsRaw) ? 'PR links — not recorded in this payload'
      : prCount ? 'pr-link events recorded, no link list in this payload'
      : 'no pr-link event recorded',
    counts: [{ label: 'pr-link events', n: prCount }],
    reason: prs.length ? null
      : !Array.isArray(prsRaw) ? 'this payload carries no pr-link list for this session'
      : prCount ? 'this payload counts pr-link events but ships no link for them'
      : 'no pr-link event in this file',
  });
  const framesRaw = d.frameLinks ?? (facts.frameLink && facts.frameLink.values) ?? null;
  const frames = Array.isArray(framesRaw) ? framesRaw : [];
  const frameCount = countOf('frameLink', 'frameLinkCount') ?? (frames.length || null);
  out.push({
    key: 'frame', label: 'frame links', untimed: false,
    value: frames.length ? frames : null,
    links: frames.map((f) => ({ href: f.frameUrl || null, label: f.title || f.path || f.frameUrl || 'frame-link', title: f.frameUrl || '' })),
    source: frames.length ? 'frame-link events'
      : !Array.isArray(framesRaw) ? 'frame links — not recorded in this payload'
      : frameCount ? 'frame-link events recorded, no link list in this payload'
      : 'no frame-link event recorded',
    counts: [{ label: 'frame-link events', n: frameCount }],
    reason: frames.length ? null
      : !Array.isArray(framesRaw) ? 'this payload carries no frame-link list for this session'
      : frameCount ? 'this payload counts frame-link events but ships no link for them'
      : 'no frame-link event in this file',
  });
  const lp = countOf('lastPrompt', 'lastPromptCount');
  out.push({
    key: 'last-prompt', label: 'last-prompt', untimed: true,
    value: lp, display: lp === null ? null : `${fmtInt(lp)} checkpoint${lp === 1 ? '' : 's'}`,
    source: 'last-prompt events (chain-tip checkpoints, not turns)',
    counts: [], reason: lp === null ? 'no last-prompt count recorded on this payload' : null,
  });
  // SPEC §3: queue-operation is the seventh metadata type — the one
  // that IS a real timeline event. Its count comes from the per-type census;
  // the events themselves are drawn on the marker lane.
  const qo = fin(
    d.inventory && d.inventory.perType && d.inventory.perType['queue-operation'],
    facts.queueOperation && facts.queueOperation.count,
    d.queueOperationCount,
  );
  out.push({
    key: 'queue-operation', label: 'queue-ops', untimed: false,
    value: qo, display: qo === null ? null : `${fmtInt(qo)} event${qo === 1 ? '' : 's'}`,
    source: 'queue-operation events — real timeline events, drawn on the marker lane',
    counts: [], reason: qo === null ? 'no queue-operation census recorded on this payload' : null,
  });
  return out;
}

/** ~3 verbatim lines of the recorded prompt head (≤220 chars, SPEC §9). */
export function promptLines(head, n = 3) {
  const src = typeof head === 'string' ? head : '';
  const all = src.split(/\r?\n/);
  let i = 0;
  while (i < all.length && all[i].trim() === '') i++;
  const lines = all.slice(i, i + n);
  return { lines, more: all.length - i > n, empty: lines.every((l) => l.trim() === '') };
}

/** Composition bar: recorded block-kind counts (SPEC §3 closed vocabulary). */
export function compositionOf(turn) {
  const src = turn && (turn.kinds || turn.composition || turn.blockKinds || turn.rowKinds);
  if (!src || typeof src !== 'object') return null;
  const entries = Array.isArray(src) ? src.map((e) => [e.kind, e.count]) : Object.entries(src);
  const out = entries
    .map(([kind, count]) => ({ kind, count: Number(count) }))
    .filter((e) => e.kind && Number.isFinite(e.count) && e.count > 0)
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
  if (!out.length) return null;
  return { entries: out, total: out.reduce((n, e) => n + e.count, 0) };
}

export function kindFamily(kind) { return String(kind).split(':')[0]; }

/** SPEC §7: agent states are RECORDED SIGNATURES, named by fact not diagnosis.
 *  Where no manifest and no journal record a state, this says so rather than
 *  inventing one — `spawnStatus` is reported as the fact it is. */
export function agentStateOf(a) {
  const f = (a && a.stateFacts) || {};
  if (a && typeof a.state === 'string' && a.state) return { text: a.state, source: 'recorded state', reason: null };
  if (f.manifestState) return { text: f.manifestState, source: 'workflowProgress[].state', reason: null };
  if (f.journalStarted > 0 && !f.journalResult) {
    return { text: 'running — journal records a start, no result yet', source: 'journal', reason: null };
  }
  if (f.journalStarted > 0 && f.journalResult && f.manifestExists && f.inManifest === false) {
    return { text: 'superseded attempt', source: 'journal started+result, absent from the manifest', reason: null };
  }
  if (f.resultEmpty === true) return { text: '∅ no-result', source: 'a recorded result that is genuinely empty', reason: null };
  if (f.spawnStatus) return { text: f.spawnStatus, source: 'recorded spawn status — no manifest or journal state exists', reason: null };
  return { text: null, source: null, reason: 'no manifest and no journal record a state for this agent' };
}

/** Raw model strings as recorded, with the source named (SPEC §7 labels rule).
 *  `metaModel` is the sidecar's bare alias, `models` the raw ids on the events. */
export function agentModelOf(a) {
  const models = Array.isArray(a && a.models) ? a.models.filter(Boolean) : [];
  if (models.length) return { text: models.join(', '), source: 'message.model on this agent’s own events', reason: null };
  if (a && typeof a.model === 'string' && a.model) return { text: a.model, source: 'recorded model', reason: null };
  if (a && a.resolvedModel) return { text: a.resolvedModel, source: 'resolvedModel', reason: null };
  if (a && a.metaModel) return { text: a.metaModel, source: 'meta.json model (a bare alias, never a full id)', reason: null };
  if (a && a.progressModel) return { text: a.progressModel, source: 'workflowProgress model', reason: null };
  return { text: null, source: null, reason: 'no model recorded on this agent’s sidecar or events (sidecar coverage is 83% — SPEC §2)' };
}

/** Normalised agent rows for ?v=agents (DESIGN §3 L2). */
export function agentRows(detail) {
  return ((detail && detail.agents) || []).map((a) => {
    const label = agentLabelOf(a);
    const started = fin(a.firstAt, a.startedAt);
    const ended = fin(a.lastAt, a.endedAt);
    const agg = cardAgg(a);
    const lineage = a.lineage || {};
    const st = agentStateOf(a);
    const model = agentModelOf(a);
    const facts = a.stateFacts || {};
    return {
      agentId: a.agentId,
      label: label.text, labelSource: label.source,
      tag: a.tag || a.promptTag || null,
      agentType: a.agentType || null,
      model: model.text, modelSource: model.source, modelReason: model.reason,
      state: st.text, stateSource: st.source, stateReason: st.reason,
      phase: phaseLabelOf(a),
      attempt: fin(a.attempt, facts.attempt),
      depth: fin(a.spawnDepth, a.depth, a.meta && a.meta.spawnDepth),
      spawnSource: lineage.kind || a.kind || a.spawnSource || null,
      attributedBy: a.attributedBy || null,
      spawnLine: fin(a.spawnLine),
      runId: lineage.runId || a.runId || null,
      parentAgentId: lineage.parentAgentId || a.parentAgentId || (a.meta && a.meta.parentAgentId) || null,
      turnIdx: fin(a.turnIdx),
      started, ended, wall: started !== null && ended !== null ? ended - started : null,
      queuedAt: fin(a.queuedAt),
      durationMs: fin(a.durationMs),
      tokens: aggTokens(agg) || a.usage || a.tokens || null,
      usd: aggUsd(agg), usdReason: agg ? null : NO_AGG_REASON,
      cached: a.cached === true || facts.cached === true,
      worktree: !!(a.worktreePath || a.isolation === 'worktree' || a.spawnedWithWorktree),
    };
  });
}

/** Props for components/scope.mjs — band 2 (DESIGN §1). */
export function scopeSentenceL2({ view, detail, choice, agents, turns, st, workflows, images }) {
  const title = sessionTitleOf(detail);
  const rule = {
    turns: 'every turn recorded in this file, in file order — which is a topological order of the uuid DAG (SPEC §3); a turn opens at a user event whose origin.kind is human (R-T) and everything before the first opener is the preamble',
    agents: 'every agent transcript under this session’s directory tree; enumeration is the directory listing, not workflowProgress (SPEC §7)',
    timeline: 'turn bars and agent bars bounded by SPEC §4’s ledger — a turn ends at the max timestamp over its conversation rows, and the hatched extension runs to its agents’ own last timestamps',
    workflows: 'every workflow run directory under this session, with the counts recorded for it',
    files: 'every file path recorded in a tool_use input keyed by tool name, unioned with the main-tier toolUseResult sidecar (SPEC §8)',
    images: 'every image block recorded in this session’s files, addressed by 1-based line and dotted block index',
  }[view] || null;
  const extra = [];
  if (choice && choice.note) extra.push(choice.note);
  if (agents === 0) extra.push('0 agents are recorded for this session, so no agent-concurrency strip is drawn');
  const denom = denominatorSentence(st);
  if (denom) extra.push(`the header ${denom}`);
  return {
    subject: `session ${title.text}`,
    counts: [
      Number.isFinite(turns) ? { n: turns, noun: 'turn' } : null,
      Number.isFinite(agents) ? { n: agents, noun: 'agent' } : null,
      Number.isFinite(workflows) ? { n: workflows, noun: 'workflow run' } : null,
    ].filter(Boolean),
    rule, filters: [], extra,
  };
}

/* ===========================================================================
   Rendering
   =========================================================================== */

const L2_TABS = [
  { v: 'turns', label: 'turns' },
  { v: 'agents', label: 'agents' },
  { v: 'timeline', label: 'timeline' },
  { v: 'workflows', label: 'workflows' },
  { v: 'files', label: 'files' },
  { v: 'images', label: 'images' },
];

async function renderSession(ctx) {
  resetViewState();
  const { slug, sid } = ctx.params;
  const query = ctx.query;

  ctx.setTitle(sid.slice(0, 8));
  ctx.crumbs({
    items: [{ label: 'the store', href: storeHref() }, { label: slug, href: projectHref(slug) }, { label: sid.slice(0, 8), id: sid.slice(8), idTitle: sid }],
    up: { href: projectHref(slug), label: slug },
  });
  ctx.registerUp(projectHref(slug), slug);
  ctx.registerLevels({ 0: storeHref(), 1: projectHref(slug), 2: sessionHref(slug, sid) });
  ctx.registerScope(scopeString('session', { slug, id: sid }));
  ctx.statbar({ pending: true, counts: [] });

  await ensurePricing();
  const detail = await api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}`, null, { signal: ctx.signal });
  if (ctx.stale) return;
  const pending = pendingOf(detail);
  if (pending) {
    ctx.loading({
      label: 'this session has not been summarised yet — no figures are claimed for it',
      bytesDone: pending.bytesIndexed, bytesTotal: pending.bytesTotal,
    });
    schedulePoll(ctx, () => renderSession(ctx), pending.retryAfterMs || 1000);
    return;
  }
  ctx.ready();
  paintSession(ctx, { detail, slug, sid, query });
}

/** The statbar band's props for a session payload — ONE construction, shared
 *  by the first paint and by the R2 chip refresh below, so a refreshed band
 *  can never disagree with the band paintSession drew. */
function sessionStatProps(detail, { slug, sid }) {
  const agg = cardAgg(detail);
  const bounds = sessionBounds(detail);
  return buildStatbarProps({
    agg, tokens: aggTokens(agg) || detail.tokens || null,
    span: bounds.span, active: fin(detail.activeMs),
    at: bounds.start, scope: scopeString('session', { slug, id: sid }), st: indexStatus(detail),
    rowsSumToHeader: detail.rowsSumToHeader,   // server-computed, exact tcu
    counts: [
      { key: 'turns', label: 'turns', value: nonPreambleTurns(detail) },
      { key: 'agents', label: 'agents', value: agentCountOf(detail) },
      { key: 'workflows', label: 'workflows', value: fin(detail.workflowCount) ?? (detail.workflows || []).length },
      { key: 'events', label: 'events', value: fin(detail.events), reason: 'no event count recorded on this payload' },
      // payload split (2026-08-17): the session detail ships imagesTotal —
      // the per-image list lives on /api/session/:slug/:id/images.
      { key: 'images', label: 'images', value: fin(detail.imagesTotal, detail.imageCount), reason: 'no image census recorded on this payload' },
      { key: 'bytes', label: 'bytes', value: fin(detail.bytes), reason: 'no byte total recorded on this payload' },
    ],
  });
}

/** Exported: the fork banners are pinned by a test that drives THIS function
 *  with a real /api/session payload and reads what reaches ctx.banner — the
 *  disclosure must reach the PAGE, not just the raw JSON. */
export function paintSession(ctx, o) {
  const { detail, slug, sid, query } = o;
  const choice = chooseSessionView(detail, query.get('v'));
  const view = choice.view;
  const agents = agentCountOf(detail);
  const turns = nonPreambleTurns(detail);
  const workflows = fin(detail.workflowCount) ?? (detail.workflows || []).length;
  const agg = cardAgg(detail);
  const bounds = sessionBounds(detail);
  const st = indexStatus(detail);

  // The tab that drops `?v=` is the session's REAL default (the
  // degenerate flip's choice with no explicit ?v) — never the view the reader
  // happens to be standing on. Registered in a FIXED order (default first,
  // then L2_TABS order) so `t`-cycling is stable across renders.
  const defaultView = chooseSessionView(detail, null).view;
  const tabs = [{ key: defaultView, label: (L2_TABS.find((t) => t.v === defaultView) || {}).label || defaultView },
    ...L2_TABS.filter((t) => t.v !== defaultView).map((t) => ({ key: t.v, label: t.label }))];
  ctx.registerViews(tabs);

  const fork = forkBanner(agg);
  if (fork) {
    const extra = h('span', { class: 'lens-banner__extra' });
    for (const s of fork.sessions) {
      extra.appendChild(h('a', {
        class: 'lens-banner__link', href: sessionHref(slug, s.id),
        title: `${fmtInt(s.requests)} billed rows inherited from this session`,
      }, s.id.slice(0, 8)));
    }
    extra.appendChild(h('span', { class: 'lens-banner__note', text: fork.denominatorNote }));
    ctx.banner(fork.text, 'note', extra);
  }
  // The canonical side of the same pair, from detail.forkPartners.
  // Rendered independently of the inherited-side banner above: a 3-way group
  // can owe both. Partner ids link with their OWN slug (partners can live in
  // another project dir) — DESIGN §10's "both-files links".
  const partnerFork = forkPartnerBanner(detail);
  if (partnerFork) {
    const extra = h('span', { class: 'lens-banner__extra' });
    for (const p of partnerFork.partners) {
      extra.appendChild(h('a', {
        class: 'lens-banner__link', href: sessionHref(p.slug || slug, p.id),
        title: `${fmtInt(p.billedHere)} of ${p.shared === null ? '—' : fmtInt(p.shared)} shared msgIds are billed in this file, not in ${p.id}`,
      }, p.id.slice(0, 8)));
    }
    extra.appendChild(h('span', { class: 'lens-banner__note', text: partnerFork.denominatorNote }));
    ctx.banner(partnerFork.text, 'note', extra);
  }
  const live = liveProgress(detail);
  if (live.live) ctx.banner(live.text || 'the file is growing on disk', 'note', live.text ? null : dash(live.reason));
  const badges = deriveBadges(detail);
  if (badges.dropped && badges.dropped.length) {
    ctx.banner(`This payload carries ${badges.dropped.length} badge(s) the design does not define (${badges.dropped.join(', ')}); they are not shown as badges — agent enumeration is closed and its zero lives in the inventory census.`, 'warn');
  }

  mountBands(ctx, {
    items: [{ label: 'the store', href: storeHref() }, { label: slug, href: projectHref(slug) }, { label: sessionTitleOf(detail).text, id: sid.slice(0, 8), idTitle: sid }],
    up: { href: projectHref(slug), label: slug },
    scope: scopeSentenceL2({ view, detail, choice, agents, turns, st, workflows }),
    stat: sessionStatProps(detail, { slug, sid }),
  });

  const root = h('div', { class: 'lens-l2' });
  root.appendChild(viewTabs(sessionHref(slug, sid), query, L2_TABS, view, defaultView));
  if (badges.length) root.appendChild(h('div', { class: 'lens-l2__badges' }, badgeRow(badges)));

  // The three-row session strip and the facts row are on every L2 view.
  root.appendChild(sessionStrip(detail, { slug, sid, bounds, agents }));
  root.appendChild(factsRow(detail));
  root.appendChild(h('p', { class: 'lens-l2__links' },
    h('a', { href: sessionInvHref(slug, sid) }, 'inventory — every file, every event, and what became of it')));

  const body = h('div', { class: 'lens-l2__body' });
  root.appendChild(body);
  replaceEl(ctx.el, root);

  if (view === 'agents') paintAgents(body, detail, { slug, sid, query, ctx });
  else if (view === 'timeline') paintSessionTimeline(body, detail, { slug, sid, bounds });
  else if (view === 'workflows') paintWorkflows(body, detail, { slug, sid, ctx });
  else if (view === 'files') paintFiles(body, detail, { slug, sid, ctx });
  else if (view === 'images') paintImages(body, detail, { slug, sid, ctx });
  else paintTurns(body, detail, { slug, sid, ctx });

  // Exactly ONE poll can be outstanding (schedulePoll owns a single timer), so
  // the live watcher — which already refetches this same payload — carries the
  // R2 check for a live session, and the quiet R2 watcher takes the sessions
  // that are not growing on disk.
  //
  // There is deliberately no `st.building` branch here: indexStatus() reads
  // /api/index's status/scope/building/pending[] shape and a session payload
  // ships none of them (it ships `r2`), so st.building is FALSE for every
  // session detail. Reinstating it as a 1 s renderSession loop would break
  // DESIGN §7 ("never re-render under the reader") and collapse the reader's
  // expanded turn rows — the refresh below repaints the disclosure band only.
  if (live.live) {
    // DESIGN §7 "never re-render under the reader" — a live session
    // polls quietly and offers the reload bar when the file actually grew,
    // instead of collapsing expanded rows every 5 s.
    schedulePoll(ctx, () => watchLiveSession(ctx, detail, { slug, sid }), LIVE_POLL_MS);
  } else if (r2Pending(detail)) {
    schedulePoll(ctx, () => watchSessionR2(ctx, detail, { slug, sid }), R2_POLL_MS);
  }
}

/** How often the quiet R2 watcher rechecks. Matches L0's building cadence. */
export const R2_POLL_MS = 1000;

/** How often the live watcher refetches a session that is growing on disk. */
const LIVE_POLL_MS = 5000;

/** A session opened while the index is still building renders
 *  agg.inheritedPending (the R2-pending chip) and a withheld forkPartners; both
 *  are claims about a state that ENDS, and nothing rechecked them for a session
 *  that was not itself growing on disk. This watcher refetches the payload
 *  quietly and, the moment its own `r2` says resolved, repaints the disclosure
 *  BAND from the fresh payload (the chip is derived, so it simply stops being
 *  rendered) and offers the reload bar for the parts that live in the page
 *  itself — the fork banners. It never re-renders under the reader, and it
 *  stops polling once resolved. */
async function watchSessionR2(ctx, prevDetail, { slug, sid }) {
  if (ctx.stale) return;
  const again = (prev) => schedulePoll(ctx, () => watchSessionR2(ctx, prev, { slug, sid }), R2_POLL_MS);
  let next;
  try { next = await api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}`, null, { signal: ctx.signal }); }
  catch { again(prevDetail); return; }
  if (ctx.stale) return;
  if (!next || pendingOf(next)) { again(prevDetail); return; }
  // This watcher owns the page's ONE poll slot while it runs, so it must
  // also check growth: a session that was not live at paint time and then
  // resumed writing has no other data path that could notice. Same
  // derivation the live watcher uses, so the two agree on what "grew" means.
  const grew = fin(next.bytes) !== fin(prevDetail.bytes) || fin(next.events) !== fin(prevDetail.events);
  if (grew) showReloadBar('this session grew on disk', () => { if (!ctx.stale) renderSession(ctx); });
  if (r2Pending(next)) {
    // Deliberately NOT re-checking growth at 1 s: router.mjs un-hides the
    // reload bar on every call, so a dismissed bar would come back five times
    // more often than the live watcher would bring it back. The moment the
    // session is live, the 5 s watcher takes the slot — and `next` goes with
    // it as prevDetail, so the growth just reported is not reported twice.
    if (liveProgress(next).live) schedulePoll(ctx, () => watchLiveSession(ctx, next, { slug, sid }), LIVE_POLL_MS);
    else again(next);
    return;
  }
  // resolved: the chip's claim is no longer true, so it goes now.
  ctx.statbar(sessionStatProps(next, { slug, sid }));
  showReloadBar('R2 resolved — fork attribution is now exact',
    () => { if (!ctx.stale) renderSession(ctx); });
  // …and a session that is still growing keeps a watcher. Stopping dead here
  // left a reader who dismissed the R2 bar with no poll for the rest of the
  // page's life. A non-live session still stops: there is nothing left to see.
  if (liveProgress(next).live) schedulePoll(ctx, () => watchLiveSession(ctx, next, { slug, sid }), LIVE_POLL_MS);
}

async function watchLiveSession(ctx, prevDetail, { slug, sid }) {
  if (ctx.stale) return;
  let next;
  try { next = await api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}`, null, { signal: ctx.signal }); }
  catch { schedulePoll(ctx, () => watchLiveSession(ctx, prevDetail, { slug, sid }), LIVE_POLL_MS); return; }
  if (ctx.stale) return;
  const changed = next && !pendingOf(next)
    && (fin(next.bytes) !== fin(prevDetail.bytes) || fin(next.events) !== fin(prevDetail.events));
  if (changed) {
    showReloadBar('this session grew on disk', () => { if (!ctx.stale) renderSession(ctx); });
  }
  // A LIVE session's R2 pendency resolves on this same payload — repaint
  // the disclosure band the moment it does, without waiting for a reload.
  if (next && !pendingOf(next) && r2Pending(prevDetail) && !r2Pending(next)) {
    ctx.statbar(sessionStatProps(next, { slug, sid }));
  }
  const usable = next && !pendingOf(next) ? next : prevDetail;
  const stillLive = next && !pendingOf(next) ? liveProgress(next).live : true;
  if (stillLive) schedulePoll(ctx, () => watchLiveSession(ctx, usable, { slug, sid }), LIVE_POLL_MS);
  // the file stopped growing before R2 resolved — hand the session over to the
  // quiet R2 watcher rather than dropping the only poll that clears the chip.
  else if (r2Pending(usable)) schedulePoll(ctx, () => watchSessionR2(ctx, usable, { slug, sid }), R2_POLL_MS);
}

/* ---- the three-row session strip ---------------------------------------- */

function stripLedger() {
  return h('div', { class: 'lens-ledger' },
    h('h4', { class: 'lens-ledger__h', text: 'how these bars are bounded (SPEC §4)' }),
    h('ul', { class: 'lens-ledger__list' },
      h('li', { text: 'Turn bar: opener timestamp → max timestamp over the turn’s conversation rows only (assistant and user rows; queue-operation, system, attachment and isMeta rows excluded).' }),
      h('li', { text: 'Hatched extension: turn end → the max last timestamp over the agents attributed to that turn. There are no startedAt/endedAt fields on events; an agent’s span is the first and last timestamp of its own transcript.' }),
      h('li', { text: 'Agent bar: first → last timestamp of that agent’s own transcript. Async agents outlive the parent’s tool_result, so an agent bar is never bounded by its parent.' }),
      h('li', { text: 'Occupancy is exact ±1 arithmetic over those recorded intervals; an agent with a single recorded timestamp has no width and is excluded, and said to be.' })));
}

function sessionStrip(detail, { slug, sid, bounds, agents }) {
  const wrap = h('section', { class: 'lens-strip' });
  if (bounds.start === null) {
    wrap.appendChild(h('p', { class: 'lens-empty', text: 'No timestamps are recorded for this session, so no strip can be drawn.' }));
    return wrap;
  }
  const lanes = [], marks = [];

  // Row 1 — turns lane: solid main span + hatched agent overhang.
  lanes.push({ id: 'turns', label: 'turns', gutter: { value: nonPreambleTurns(detail), label: 'turns' } });
  for (const t of turnBarModel(detail)) {
    if (t.at === null) continue;
    marks.push({
      lane: 'turns', at: t.at, end: t.end,
      color: t.preamble ? 'var(--lens-preamble, #6b7686)' : 'var(--lens-mark, #7aa2f7)',
      href: turnHref(slug, sid, t.idx),
      title: `${t.preamble ? 'preamble' : `turn ${t.idx}`} · ${fmtStamp(t.at)}`
        + (t.end === null ? ' (one timestamp recorded — drawn as a tick)' : ` → ${fmtClock(t.end)}`),
    });
    if (t.overhang) {
      marks.push({
        lane: 'turns', at: t.overhang.start, end: t.overhang.end, tone: 'hatched',
        color: 'var(--lens-overhang, #56b6c2)', href: turnHref(slug, sid, t.idx),
        title: `turn ${t.idx} — its agents’ own transcripts run to ${fmtClock(t.overhang.end)} (SPEC §4 agent overhang)`,
      });
    }
  }

  // Row 2 — agent-concurrency occupancy. DESIGN §3/§10: OMITTED ENTIRELY at 0
  // agents (68 of 85 sessions), consistent with L3's collapse.
  let occ = null;
  if (agents > 0) {
    occ = occupancy(agentIntervals(detail));
    lanes.push({ id: 'concurrency', label: 'agents at once', gutter: { value: occ.max, label: 'max' } });
    for (const s of occ.segments) {
      if (!s.n) continue;
      marks.push({
        lane: 'concurrency', kind: 'bin', at: s.start, end: s.end, count: s.n, label: String(s.n),
        title: `${s.n} agent${s.n === 1 ? '' : 's'} recorded as running between ${fmtClock(s.start)} and ${fmtClock(s.end)}`,
      });
    }
  }

  // Row 3 — marker lane (queue-ops, system events, denials, edited files).
  const markers = detail.markers || detail.queueOps || null;
  if (Array.isArray(markers) && markers.length) {
    lanes.push({ id: 'markers', label: 'markers', gutter: { value: markers.length, label: 'marks' } });
    for (const m of markers) {
      const at = fin(m.at);
      if (at === null) continue;
      marks.push({
        lane: 'markers', at, end: null, color: 'var(--lens-marker, #e0af68)',
        href: m.line ? eventHref(slug, sid, m.agentId || 'main', String(m.line)) : null,
        title: `${m.kind || 'marker'}${m.label ? ' — ' + m.label : ''} · ${fmtStamp(at)}`,
      });
    }
  }

  const host = h('div', { class: 'lens-strip__canvas' });
  wrap.appendChild(host);
  try {
    track(timeline(host, {
      lanes, marks, axis: { from: bounds.start, to: bounds.end },
      binsCap: MARK_CAP, zoom: true, info: stripLedger,
      onMark: (m, ev) => { if (m.href) { ev.preventDefault(); navigate(m.href); } },
    }));
  } catch (e) {
    host.appendChild(h('div', { class: 'lens-card lens-card--error', text: `timeline component unavailable: ${e && e.message}` }));
    for (const t of turnBarModel(detail)) {
      host.appendChild(h('div', { class: 'lens-strip__row' },
        h('a', { href: turnHref(slug, sid, t.idx) }, t.preamble ? 'preamble' : `turn ${t.idx}`),
        val(fmtClock(t.at), 'no opener timestamp recorded'), ' → ',
        val(fmtClock(t.end), 'no conversation-row timestamp recorded for this turn'),
        t.overhang ? h('span', { class: 'lens-strip__oh', text: `agents to ${fmtClock(t.overhang.end)}` }) : null));
    }
  }

  const notes = h('div', { class: 'lens-strip__notes' });
  notes.appendChild(h('span', { class: 'lens-strip__tz', text: tzLabel(hostCalendar.offsetMinutesAt(bounds.start)) }));
  if (agents === 0) {
    notes.appendChild(h('span', {
      class: 'lens-strip__note',
      title: 'no agent transcript exists under this session’s directory tree, so there is no occupancy to draw',
      text: '0 agents — no concurrency strip',
    }));
  } else if (occ && occ.pointOnly) {
    notes.appendChild(h('span', {
      class: 'lens-strip__note',
      title: 'an agent transcript with a single recorded timestamp has no width and cannot occupy an interval',
      text: `${occ.pointOnly} agent${occ.pointOnly === 1 ? '' : 's'} record one timestamp only — excluded from the occupancy arithmetic`,
    }));
  }
  if (!Array.isArray(markers)) {
    notes.appendChild(h('span', {
      class: 'lens-strip__note lens-unknown',
      title: 'this session payload carries no marker list (queue-ops, system events, denials, edited files)',
      text: 'marker lane — not recorded in this payload',
    }));
  }
  wrap.appendChild(notes);
  return wrap;
}

/* ---- session facts row --------------------------------------------------- */

function factsRow(detail) {
  const row = h('section', { class: 'lens-facts' });
  for (const f of sessionFacts(detail)) {
    const cell = h('div', { class: `lens-facts__cell lens-facts__cell--${f.key}` });
    cell.appendChild(h('span', { class: 'lens-facts__label', text: f.label }));
    if (f.links && f.links.length) {
      const box = h('span', { class: 'lens-facts__value' });
      for (const l of f.links) {
        box.appendChild(l.href
          ? h('a', { class: 'lens-facts__link', href: l.href, title: l.title, rel: 'noreferrer noopener', target: '_blank' }, l.label)
          : h('span', { class: 'lens-facts__link', title: l.title }, l.label));
      }
      cell.appendChild(box);
    } else {
      cell.appendChild(h('span', { class: 'lens-facts__value' }, val(f.display, f.reason)));
    }
    const meta = h('span', { class: 'lens-facts__meta' });
    for (const c of f.counts || []) {
      if (c.n === null || c.n === undefined) continue;
      meta.appendChild(h('span', { class: 'lens-facts__count', title: `${c.label} recorded in this file` }, `${fmtInt(c.n)} ${c.label}`));
    }
    meta.appendChild(h('span', { class: 'lens-facts__src', title: 'the recorded source of this value', text: f.source }));
    if (f.untimed) {
      meta.appendChild(h('span', {
        class: 'lens-facts__untimed',
        title: 'this event type carries no timestamp — it is placed by file order only (SPEC §3)',
        text: 'no timestamp — file order only',
      }));
    }
    cell.appendChild(meta);
    row.appendChild(cell);
  }
  return row;
}

/* ---- default: turn cards ------------------------------------------------- */

function paintTurns(body, detail, { slug, sid, ctx }) {
  const turns = turnBarModel(detail);
  if (!turns.length) { body.appendChild(h('p', { class: 'lens-empty', text: 'No turns are recorded in this session.' })); return; }
  const list = h('div', { class: 'lens-turns' });
  for (const t of turns) list.appendChild(turnCard(t, { slug, sid }));
  body.appendChild(list);
  ctx.registerRows(list);
}

function turnCard(t, { slug, sid }) {
  const card = h('article', {
    class: 'lens-turn' + (t.preamble ? ' lens-turn--preamble' : ''),
    'data-lens-row': '', dataset: { href: turnHref(slug, sid, t.idx) },
  });
  card.appendChild(h('header', { class: 'lens-turn__head' },
    h('a', { class: 'lens-turn__idx', href: turnHref(slug, sid, t.idx) }, t.preamble ? 'preamble' : `turn ${t.idx}`),
    h('span', { class: 'lens-turn__time' }, val(fmtClock(t.at), 'no opener timestamp is recorded')),
    h('span', { class: 'lens-turn__wall', title: 'opener → max timestamp over the turn’s conversation rows (SPEC §4)' },
      val(fmtSpan(t.wall), 'no end bound is recorded for this turn')),
    h('span', { class: 'lens-turn__cost' }, usdCell(aggUsd(t.agg), t.agg ? null : 'no CostAgg is recorded on this turn — only its tokens are')),
    h('span', { class: 'lens-turn__tokens', title: 'the tokens recorded for this turn: in · out · cache-w · cache-r' },
      ...tokenCells(t.usage, 'no usage is recorded for this turn')),
    h('span', { class: 'lens-turn__agents', title: 'agents attributed to this turn by their recorded spawn call (SPEC §7)' },
      `${fmtInt(t.agents)} agent${t.agents === 1 ? '' : 's'}`)));

  if (t.preamble) {
    card.appendChild(h('p', { class: 'lens-turn__preamble-note', title: 'everything recorded before the first turn opener (R-T)' },
      'preamble — everything recorded before the first human turn opener.'));
  }

  const p = promptLines(t.promptHead);
  if (!p.empty) {
    card.appendChild(h('pre', { class: 'lens-turn__prompt', text: p.lines.join('\n') }));
    if (p.more) card.appendChild(h('a', { class: 'lens-turn__more', href: turnHref(slug, sid, t.idx) }, 'the prompt card at L3 is verbatim →'));
  } else if (!t.preamble) {
    card.appendChild(h('p', { class: 'lens-turn__prompt' }, dash('the payload records no prompt head for this turn')));
  }

  const comp = compositionOf(t.raw);
  if (comp) {
    const bar = h('div', { class: 'lens-comp', title: `${fmtInt(comp.total)} recorded blocks` });
    for (const e of comp.entries) {
      bar.appendChild(h('span', {
        class: `lens-comp__seg lens-comp__seg--${kindFamily(e.kind)}`,
        style: `flex-grow:${e.count}`, title: `${e.kind} ${fmtInt(e.count)}`,
      }, h('span', { class: 'lens-comp__label', text: `${e.kind} ${e.count}` })));
    }
    card.appendChild(bar);
    if (t.preamble) {
      card.appendChild(h('p', { class: 'lens-turn__census', text: `${fmtInt(comp.total)} recorded blocks: ${comp.entries.map((e) => `${e.kind} ${e.count}`).join(' · ')}` }));
    }
  } else {
    card.appendChild(h('p', { class: 'lens-comp lens-comp--none' }, dash('this payload records no per-turn block-kind counts')));
  }

  if (t.workflowRunIds && t.workflowRunIds.length) {
    const chips = h('div', { class: 'lens-chips' });
    for (const runId of t.workflowRunIds) {
      chips.appendChild(h('a', { class: 'lens-chip lens-chip--workflow', href: workflowHref(slug, sid, runId), title: runId }, runId));
    }
    card.appendChild(chips);
  }
  return card;
}

/* ---- ?v=agents ----------------------------------------------------------- */

function paintAgents(body, detail, { slug, sid, query, ctx }) {
  const rows = agentRows(detail);
  if (!rows.length) {
    body.appendChild(h('p', { class: 'lens-empty', text: '0 agents — no agent transcript exists under this session’s directory tree.' }));
    return;
  }
  const columns = [
    col('label', 'label', {
      render: (v, row) => h('span', {},
        h('a', { href: agentHref(slug, sid, row.agentId), title: `label source: ${row.labelSource}` }, row.label),
        row.cached ? h('span', { class: 'lens-tag', title: 'replayed from an earlier attempt of this run; billed from its transcript in its original turn' }, 'cached') : null,
        row.worktree ? h('span', { class: 'lens-tag', title: 'spawnedWithWorktree is recorded on this agent' }, '⌂ worktree') : null),
    }),
    col('tag', 'tag', { reason: 'no [AGENT] prompt tag recorded' }),
    col('model', 'model (raw)', { type: 'code', reason: (row) => row.modelReason, title: 'the raw recorded model string, never normalised for display' }),
    col('state', 'state', {
      reason: (row) => row.stateReason,
      render: (v, row) => h('span', { title: `source: ${row.stateSource}` }, v),
    }),
    col('phase', 'phase', { reason: 'not a workflow agent, or no phase recorded' }),
    col('attempt', 'attempt', { type: 'num', reason: 'no attempt recorded' }),
    col('depth', 'depth', { type: 'num', reason: 'no spawnDepth recorded' }),
    col('spawnSource', 'spawn source', {
      reason: 'no recorded spawn edge',
      render: (v, row) => h('span', { title: row.attributedBy ? `attributed by ${row.attributedBy}${row.spawnLine === null ? '' : ` at line ${row.spawnLine}`}` : '' }, v),
    }),
    col('turnIdx', 'turn', { type: 'num', href: (row) => (row.turnIdx === null ? null : turnHref(slug, sid, row.turnIdx)), reason: 'no turn attribution recorded' }),
    col('started', 'started', { type: 'time', reason: 'this agent’s transcript records no timestamp' }),
    col('wall', 'wall', { type: 'duration', reason: 'first and last timestamps are not both recorded' }),
    ...tokenCols(),
    col('usd', 'cost', { type: 'money', sum: true, reason: (row) => row.usdReason || NO_AGG_REASON }),
  ];
  const trows = rows.map((a) => ({
    _href: agentHref(slug, sid, a.agentId),
    agentId: a.agentId, label: a.label, labelSource: a.labelSource, tag: a.tag,
    model: a.model, modelReason: a.modelReason,
    state: a.state, stateSource: a.stateSource, stateReason: a.stateReason,
    phase: a.phase, attempt: a.attempt, depth: a.depth,
    spawnSource: a.spawnSource, attributedBy: a.attributedBy, spawnLine: a.spawnLine,
    runId: a.runId, turnIdx: a.turnIdx,
    started: a.started, wall: a.wall, ...tokenValues(a.tokens),
    usd: a.usd, usdReason: a.usdReason, cached: a.cached, worktree: a.worktree,
  }));
  const el = h('div', { class: 'lens-table lens-table--agents' });
  body.appendChild(el);
  const groupKey = query.get('group') || null;
  mountTable(el, {
    columns, rows: trows, sort: [{ key: 'started', dir: 'asc' }],
    group: groupKey ? { key: groupKey } : null,
    footerSums: true, navHref: (row) => row._href,
    onGroup: (key) => navigate(withQuery(sessionHref(slug, sid), query, { v: 'agents', group: key || null })),
    caption: 'Enumeration is the directory listing of subagents/**/agent-*.jsonl — workflowProgress is display metadata and misses in-flight runs, superseded retries and cached replays (SPEC §7).',
    emptyLabel: 'no agents match',
  });
  ctx.registerRows(el);

  const groups = h('div', { class: 'lens-groupby' }, 'group by: ');
  for (const [key, label] of [['', 'none'], ['runId', 'workflow'], ['phase', 'phase'], ['model', 'model'], ['turnIdx', 'turn'], ['depth', 'depth']]) {
    groups.appendChild(h('a', {
      class: 'lens-groupby__opt' + ((groupKey || '') === key ? ' lens-groupby__opt--on' : ''),
      href: withQuery(sessionHref(slug, sid), query, { v: 'agents', group: key || null }),
    }, label));
  }
  body.appendChild(groups);
}

/* ---- ?v=timeline --------------------------------------------------------- */

function paintSessionTimeline(body, detail, { slug, sid, bounds }) {
  if (bounds.start === null) { body.appendChild(h('p', { class: 'lens-empty', text: 'No timestamps are recorded for this session.' })); return; }
  const lanes = [], marks = [];
  for (const t of turnBarModel(detail)) {
    if (t.at === null) continue;
    const id = `t${t.idx}`;
    lanes.push({
      id, label: t.preamble ? 'preamble' : `turn ${t.idx}`, href: turnHref(slug, sid, t.idx),
      gutter: { value: t.agents, label: 'agents' },
    });
    marks.push({
      lane: id, at: t.at, end: t.end, color: 'var(--lens-mark, #7aa2f7)', href: turnHref(slug, sid, t.idx),
      title: `${t.preamble ? 'preamble' : `turn ${t.idx}`} · ${fmtStamp(t.at)}${t.end === null ? ' (one timestamp recorded)' : ` → ${fmtClock(t.end)}`}`,
    });
    if (t.overhang) {
      marks.push({
        lane: id, at: t.overhang.start, end: t.overhang.end, tone: 'hatched',
        color: 'var(--lens-overhang, #56b6c2)',
        title: `agent overhang — its agents’ own transcripts run to ${fmtClock(t.overhang.end)}`,
      });
    }
  }
  for (const a of agentIntervals(detail)) {
    const id = `a${a.agentId}`;
    lanes.push({
      id, label: a.label, sublabel: a.agentId, href: agentHref(slug, sid, a.agentId),
      gutter: { value: a.end === null ? null : a.end - a.start, label: 'wall', format: fmtSpan },
    });
    marks.push({
      lane: id, at: a.start, end: a.end, color: 'var(--lens-agent, #bb9af7)', href: agentHref(slug, sid, a.agentId),
      title: `${a.label} · ${fmtStamp(a.start)}${a.end === null ? ' (one timestamp recorded)' : ` → ${fmtClock(a.end)}`}`,
    });
  }
  const host = h('div', { class: 'lens-l2timeline' });
  body.appendChild(host);
  try {
    track(timeline(host, {
      lanes, marks, axis: { from: bounds.start, to: bounds.end },
      binsCap: MARK_CAP, zoom: true, info: stripLedger,
      onMark: (m, ev) => { if (m.href) { ev.preventDefault(); navigate(m.href); } },
    }));
  } catch (e) {
    host.appendChild(h('div', { class: 'lens-card lens-card--error', text: `timeline component unavailable: ${e && e.message}` }));
  }
}

/* ---- ?v=workflows -------------------------------------------------------- */

function paintWorkflows(body, detail, { slug, sid, ctx }) {
  const wfs = detail.workflows || [];
  if (!wfs.length) { body.appendChild(h('p', { class: 'lens-empty', text: 'No workflow run directories are recorded under this session.' })); return; }
  // DESIGN §4 one table behaviour — the workflows listing is a vtable.
  const rows = wfs.map((w) => {
    const runId = w.runId || w.id;
    const started = fin(w.startedAt, w.firstAt, w.record && w.record.startTime);
    const ended = fin(w.endedAt, w.lastAt, w.record && w.record.endTime);
    return {
      runId,
      name: w.workflowName || w.name || (w.record && w.record.workflowName) || null,
      state: w.state || (w.record && w.record.status) || (w.running ? 'running — journal records a start, no result yet' : null),
      agents: fin(w.agentCount, (w.agentIds || []).length),
      turnIdx: fin(w.turnIdx),
      started,
      wall: started !== null && ended !== null ? ended - started : null,
      _href: workflowHref(slug, sid, runId),
    };
  });
  const el = h('div', { class: 'lens-wftable' });
  mountTable(el, {
    columns: [
      col('runId', 'run', { type: 'code', href: (row) => row._href }),
      col('name', 'name', { reason: 'workflowName is manifest-only; this run has no manifest yet' }),
      col('state', 'state', { reason: 'no manifest state recorded — the journal is the only source' }),
      col('agents', 'agents', { type: 'num', sum: true, reason: 'no agents recorded' }),
      col('turnIdx', 'turn', { type: 'num', href: (row) => (row.turnIdx === null ? null : turnHref(slug, sid, row.turnIdx)), reason: 'no turn attribution recorded' }),
      col('started', 'started', { type: 'time', reason: 'no timestamp recorded' }),
      col('wall', 'wall', { type: 'duration', reason: 'start and end are not both recorded' }),
    ],
    rows,
    sort: [{ key: 'started', dir: 'asc' }],
    footerSums: true,
    navHref: (row) => row._href,
    emptyLabel: 'no workflow runs',
  });
  body.appendChild(el);
  if (ctx) ctx.registerRows(el);
  body.appendChild(h('p', { class: 'lens-note', text: 'A run with agents and a journal but no wf_*.json is in flight — its record page renders a partial envelope, never a 404 (SPEC §7).' }));
}

/* ---- ?v=files ------------------------------------------------------------ */

/** The ledger ships from its own endpoint —
 *  { filesLedger:[{path,tier,reads,writes,edits,searches,sidecar}], total,
 *  denominators } — and renders as a vtable (DESIGN §4 one table behaviour). */
async function paintFiles(body, detail, { slug, sid, ctx }) {
  const holder = h('div', { class: 'lens-l2files' });
  body.appendChild(holder);
  let payload;
  try {
    payload = await api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/files`, null, { signal: ctx && ctx.signal });
  } catch (err) {
    holder.appendChild(h('p', { class: 'lens-empty', text: `the files ledger could not be fetched: ${err && err.message}` }));
    return;
  }
  if (pendingOf(payload)) {
    holder.appendChild(h('p', { class: 'lens-empty', text: 'the index is still building — the files ledger arrives with it' }));
    return;
  }
  const rows = payload.filesLedger || [];
  const cov = coverageSentence(payload.denominators || (detail.inventory && detail.inventory.filesLedgerDenominators));
  holder.appendChild(h('p', { class: 'lens-coverage', title: 'the denominator for this view, printed on it' },
    cov.known ? cov.text : dash(cov.reason)));
  if (!rows.length) {
    holder.appendChild(h('p', { class: 'lens-empty', text: 'No file paths are recorded in this session’s tool_use inputs or main-tier sidecars.' }));
    return;
  }
  const el = h('div', { class: 'lens-filetable' });
  mountTable(el, {
    columns: [
      col('path', 'path', { type: 'code' }),
      col('tier', 'tier', { groupable: true, title: 'main = the session transcript; agent = a subagent transcript' }),
      col('reads', 'reads', { type: 'num', sum: true }),
      col('writes', 'writes', { type: 'num', sum: true }),
      col('edits', 'edits', { type: 'num', sum: true }),
      col('searches', 'searches', { type: 'num', sum: true }),
      col('sidecar', 'sidecar', { type: 'num', sum: true, title: 'main-tier toolUseResult.filePath sightings (SPEC §8)' }),
    ],
    rows,
    sort: [{ key: 'path', dir: 'asc' }],
    footerSums: true,
    caption: `${fmtInt(rows.length)} of ${fmtInt(fin(payload.total, rows.length))} recorded (path, tier) pairs`,
    emptyLabel: 'no recorded file paths',
  });
  holder.appendChild(el);
  if (ctx) ctx.registerRows(el);
  holder.appendChild(h('p', { class: 'lens-note', text: 'Read/Write/Edit → file_path, NotebookEdit → notebook_path, Glob/Grep → path, unioned with the main-tier toolUseResult.filePath. Path-shaped keys inside StructuredOutput/MCP payloads are payload fields, not file operations, and are excluded (SPEC §8).' }));
}

/* ---- ?v=images : virtualized contact sheet -------------------------------- */

const TILE = 132;      // cell box in px; the inner tile is sized by recorded bytes
const OVERSCAN = 3;    // rows rendered beyond the viewport

async function paintImages(body, detail, { slug, sid, ctx }) {
  // payload split (2026-08-17): the per-image list ships from its own
  // endpoint with SESSION-RELATIVE rels that feed /api/image directly.
  let payload;
  try {
    payload = await api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/images`, null, { signal: ctx && ctx.signal });
  } catch (err) {
    body.appendChild(h('p', { class: 'lens-empty', text: `the image list could not be fetched: ${err && err.message}` }));
    body.appendChild(h('p', { class: 'lens-note' },
      'The bytes are on disk either way — ',
      h('a', { href: sessionInvHref(slug, sid) }, 'the session inventory'),
      ' lists every image with its file, line and block locator.'));
    return;
  }
  if (pendingOf(payload)) {
    body.appendChild(h('p', { class: 'lens-empty', text: 'the index is still building — the image list arrives with it' }));
    return;
  }
  const images = (payload.images || []).map((im) => ({
    file: im.file || im.rel || im.path || null,
    line: fin(im.line),
    bi: im.bi ?? im.block ?? null,
    at: fin(im.at),
    source: im.source || im.where || null,
    bytes: fin(im.bytes, im.size),
    twin: !!im.twin,
  }));
  body.appendChild(h('p', { class: 'lens-coverage' },
    `${fmtInt(images.length)} image block${images.length === 1 ? '' : 's'} recorded. Tiles are sized by recorded byte count; pixels load only when a tile scrolls into view. Where the same bytes appear twice on one line (tool_result block + sidecar), the twin is noted rather than drawn again.`));
  if (!images.length) { body.appendChild(h('p', { class: 'lens-empty', text: 'No image blocks are recorded in this session.' })); return; }

  const maxBytes = images.reduce((m, im) => Math.max(m, im.bytes || 0), 0);
  // lens-contact: the contact sheet is its own scroll box; the keyboard
  // overlay's class (scope.mjs) is fixed-inset and must never be reused here.
  const sheet = h('div', { class: 'lens-contact', tabindex: '0' });
  const spacer = h('div', { class: 'lens-contact__spacer' });
  const win = h('div', { class: 'lens-contact__window' });
  sheet.appendChild(spacer);
  sheet.appendChild(win);
  body.appendChild(sheet);
  body.appendChild(h('p', { class: 'lens-note', text: `Largest recorded image ${fmtBytes(maxBytes)} — the fixed scale for the tile areas.` }));

  let cols = 1, rendered = { from: -1, to: -1 };
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        const src = img.getAttribute('data-src');
        if (src && !img.src) img.src = src;
        io.unobserve(img);
      }
    }, { root: sheet, rootMargin: '200px' })
    : null;

  function layout() {
    cols = Math.max(1, Math.floor((sheet.clientWidth || TILE) / TILE) || 1);
    spacer.style.height = `${Math.ceil(images.length / cols) * TILE}px`;
    rendered = { from: -1, to: -1 };
    draw();
  }
  function draw() {
    const rows = Math.ceil(images.length / cols);
    const top = sheet.scrollTop, viewH = sheet.clientHeight || TILE * 4;
    const first = Math.max(0, Math.floor(top / TILE) - OVERSCAN);
    const last = Math.min(rows - 1, Math.floor((top + viewH) / TILE) + OVERSCAN);
    if (first === rendered.from && last === rendered.to) return;
    rendered = { from: first, to: last };
    while (win.firstChild) win.removeChild(win.firstChild);
    win.setAttribute('style', `transform:translateY(${first * TILE}px);grid-template-columns:repeat(${cols}, ${TILE}px)`);
    for (let i = first * cols; i < Math.min(images.length, (last + 1) * cols); i++) win.appendChild(tileFor(images[i]));
  }
  function tileFor(im) {
    const frac = maxBytes > 0 && im.bytes ? Math.sqrt(im.bytes / maxBytes) : 0;
    const side = Math.max(18, Math.round(frac * (TILE - 36)) || 18);
    const cell = h('figure', { class: 'lens-contact__tile', style: `width:${TILE}px;height:${TILE}px` });
    const box = h('div', { class: 'lens-contact__box', style: `width:${side}px;height:${side}px` });
    if (im.file && im.line !== null) {
      const params = new URLSearchParams({ slug, id: sid, file: im.file, line: String(im.line) });
      if (im.bi !== null && im.bi !== undefined) params.set('block', String(im.bi));
      const img = h('img', {
        class: 'lens-contact__img', loading: 'lazy', decoding: 'async',
        alt: `image recorded at line ${im.line}${im.bi != null ? '.' + im.bi : ''}`,
      });
      img.setAttribute('data-src', `/api/image?${params.toString()}`);
      if (io) io.observe(img); else img.src = img.getAttribute('data-src');
      box.appendChild(img);
      // Images span agent files too — the drill address derives its
      // agentId from the recorded rel, exactly as find.mjs does; 'main' only
      // when the rel names the main transcript.
      const agentId = classifyRel(im.file).agentId ?? 'main';
      cell.appendChild(h('a', {
        class: 'lens-contact__link',
        href: eventHref(slug, sid, agentId, im.bi == null ? String(im.line) : `${im.line}.${im.bi}`),
      }, box));
    } else {
      box.appendChild(dash('no file/line locator is recorded for this image'));
      cell.appendChild(box);
    }
    cell.appendChild(h('figcaption', { class: 'lens-contact__cap' },
      val(fmtClock(im.at), 'no timestamp is recorded on this line'), ' · ',
      val(im.source, 'no source is recorded'), ' · ',
      val(fmtBytes(im.bytes), 'byte size is not recorded'),
      // Pairing is presence/positional per line (parse.mjs); the SHA
      // check was a one-time corpus-wide spec-time verification, never re-run
      // per tile — the wording must not claim otherwise.
      im.twin ? h('span', { class: 'lens-tag', title: 'recorded twice on this line (tool_result block + toolUseResult sidecar) — rendered once; byte-identity was verified corpus-wide at spec time, not re-checked per line' }, 'twin') : null));
    return cell;
  }

  sheet.addEventListener('scroll', draw, { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(layout);
    ro.observe(sheet);
    track({ destroy: () => ro.disconnect() });
  }
  track({ destroy: () => { if (io) io.disconnect(); } });
  layout();
}

/* ---- route registration -------------------------------------------------- */

// One registration path — the injected defineRoute is honoured.
export function register(defineRoute = importedDefineRoute) { defineRoute('/p/:slug/s/:sid', renderSession); }

export { renderSession };
