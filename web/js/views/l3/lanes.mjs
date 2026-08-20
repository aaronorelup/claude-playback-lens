// web/js/views/l3/lanes.mjs — the turn's lane and tree MODELS, pure: run
// classification (SPEC §7 resumed-run ownership), lane grouping with the two
// fact-named orphan groups, recorded-timestamp bounds, the exact ±1 occupancy
// segments, the orchestration tree with cycle disclosure, and ?sel parsing.

import { occupancy as sharedOccupancy } from '../../components/timeline.mjs';
import { toMs, shortId } from '../../lib/fmt.mjs';
import { normalizeAgent, agentGlyph } from './state.mjs';

/* ==================================================== run classification ==
 * SPEC §7: "A resumed workflow run belongs to the turn of its FIRST spawning
 * call". The resuming turn renders the run as a link-only reference row —
 * zero tokens, `resumed here`, `counted in turn N` — so its rows still sum to
 * its header.
 */

export function classifyRun(run, turnIdx) {
  const owning = firstNum(run?.turnIdx, run?.firstTurnIdx, run?.attributedTurnIdx, run?.firstSpawnTurnIdx);
  const idx = Number(turnIdx);
  if (owning === null) {
    return { kind: 'owned', countedInTurn: null, reason: 'no owning turn recorded on this run — rendered here, where its agents were found' };
  }
  if (owning === idx) {
    const resumedHere = Array.isArray(run?.resumedInTurns) && run.resumedInTurns.includes(idx);
    return {
      kind: 'owned', countedInTurn: owning,
      reason: resumedHere
        ? 'spawned by a call in this turn; also resumed here — counted once, in this turn (SPEC §7)'
        : 'spawned by a call in this turn (SPEC §7)',
    };
  }
  return {
    kind: 'resumed-reference', countedInTurn: owning,
    reason: `this turn resumes a run whose first spawning call is in turn ${owning}; every agent stays with the turn of the call that created its transcript, so this row carries zero tokens (SPEC §7)`,
  };
}

/** Pure: `]` exists only when the payload PROVES a next turn. The server pins
 *  turnCount as the count of non-preamble turns, which (preamble = idx 0)
 *  equals the last addressable idx — unknown count → no next, never a 404. */
export function hasNextTurn(idx, turnCount) {
  return turnCount !== null && turnCount !== undefined && Number.isFinite(turnCount) && idx + 1 <= turnCount;
}

export function firstNum(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/* ========================================================= lane model == */

export const AUTO_COLLAPSE_AGENTS = 24;   // DESIGN §3: auto-collapsed above this

/**
 * buildLanes({ turn, agents, workflows }) -> lane model. Pure.
 * Groups: one per workflow run (with its manifest-absent agents split into the
 * two fact-named orphan groups), then one for plain (Agent-tool) agents, then
 * one for anything with no recorded lineage.
 */
export function buildLanes({ turnIdx, agents = [], workflows = [] } = {}) {
  const norm = agents.map(normalizeAgent);
  const byRun = new Map();
  const plain = [];
  const unlinked = [];

  for (const ag of norm) {
    if (ag.runId) {
      if (!byRun.has(ag.runId)) byRun.set(ag.runId, []);
      byRun.get(ag.runId).push(ag);
    } else if (ag.toolUseId || ag.parentAgentId || ag.lineageKind === 'plain' || ag.lineageKind === 'child') {
      plain.push(ag);
    } else {
      unlinked.push(ag);
    }
  }

  const groups = [];
  const referenceRows = [];
  const runsSeen = new Set();

  const runList = workflows.length
    ? workflows.slice()
    : [...byRun.keys()].map((runId) => ({ runId }));
  // A run named by this turn but with no agents in it still deserves its row.
  for (const runId of byRun.keys()) if (!runList.some((r) => (r.runId ?? r.id) === runId)) runList.push({ runId });

  for (const run of runList) {
    const runId = run.runId ?? run.id;
    if (!runId || runsSeen.has(runId)) continue;
    runsSeen.add(runId);
    const mine = byRun.get(runId) ?? [];
    const cls = classifyRun(run, turnIdx);
    if (cls.kind === 'resumed-reference') {
      referenceRows.push({
        runId, run, countedInTurn: cls.countedInTurn, reason: cls.reason,
        agentCount: mine.length, name: run.workflowName ?? run.name ?? null,
      });
      continue;
    }

    const listed = mine.filter((ag) => ag.inManifest !== false);
    const orphans = mine.filter((ag) => ag.inManifest === false);
    const running = orphans.filter((ag) => agentGlyph(ag).code === 'running');
    const superseded = orphans.filter((ag) => agentGlyph(ag).code !== 'running');

    groups.push({
      kind: 'run', key: `w:${runId}`, runId, run,
      label: run.workflowName ?? run.name ?? runId,
      sublabel: run.workflowName || run.name ? runId : null,
      note: cls.reason,
      agents: sortLanes(listed),
      collapsed: listed.length > AUTO_COLLAPSE_AGENTS,
      autoCollapsed: listed.length > AUTO_COLLAPSE_AGENTS,
    });
    if (running.length) {
      groups.push({
        kind: 'orphan-running', key: `w:${runId}:running`, runId, parentRunId: runId,
        label: 'running — journal records a start, no result yet',
        note: 'these agents have a journal `started` entry and no `result`; the manifest does not list them (SPEC §7).',
        agents: sortLanes(running), collapsed: running.length > AUTO_COLLAPSE_AGENTS,
        autoCollapsed: running.length > AUTO_COLLAPSE_AGENTS,
      });
    }
    if (superseded.length) {
      groups.push({
        kind: 'orphan-superseded', key: `w:${runId}:superseded`, runId, parentRunId: runId,
        label: 'superseded attempt',
        note: 'journal records both a start and a result, and the manifest does not list them (SPEC §7).',
        agents: sortLanes(superseded), collapsed: superseded.length > AUTO_COLLAPSE_AGENTS,
        autoCollapsed: superseded.length > AUTO_COLLAPSE_AGENTS,
      });
    }
  }

  if (plain.length) {
    groups.push({
      kind: 'plain', key: 'plain', label: 'Agent-tool agents', note: 'spawned by an `Agent` tool_use in this turn (meta.toolUseId, SPEC §7).',
      agents: sortLanes(plain), collapsed: plain.length > AUTO_COLLAPSE_AGENTS, autoCollapsed: plain.length > AUTO_COLLAPSE_AGENTS,
    });
  }
  if (unlinked.length) {
    groups.push({
      kind: 'unlinked', key: 'unlinked', label: 'no recorded spawn edge',
      note: 'attributed to this turn by the §7 time-window fallback (the turn whose window contains the agent\'s first timestamp); the rule prints here because it fired.',
      agents: sortLanes(unlinked), collapsed: false, autoCollapsed: false,
    });
  }

  return { groups, referenceRows, agentCount: norm.length, agents: norm };
}

/** Lanes sort by recorded start; agents with no timestamp sort last, in id order. */
function sortLanes(list) {
  return list.slice().sort((x, y) => {
    const ax = x.firstAt ?? x.queuedAt, ay = y.firstAt ?? y.queuedAt;
    if (ax === null && ay === null) return String(x.agentId).localeCompare(String(y.agentId));
    if (ax === null) return 1;
    if (ay === null) return -1;
    if (ax !== ay) return ax - ay;
    return String(x.agentId).localeCompare(String(y.agentId));
  });
}

/** Bounds over recorded timestamps only (SPEC §4 bounds ledger). */
export function laneBounds({ turn, agents = [] }) {
  const starts = [], ends = [];
  const push = (v, arr) => { const n = toMs(v); if (n !== null) arr.push(n); };
  push(turn?.at, starts);
  push(turn?.endAt ?? turn?.endedAt, ends);
  for (const ag of agents) {
    if (ag.queuedAt !== null && ag.queuedAt !== undefined) starts.push(ag.queuedAt);
    if (ag.firstAt !== null && ag.firstAt !== undefined) starts.push(ag.firstAt);
    if (ag.progStartedAt !== null && ag.progStartedAt !== undefined) starts.push(ag.progStartedAt);
    if (ag.lastAt !== null && ag.lastAt !== undefined) ends.push(ag.lastAt);
  }
  if (!starts.length && !ends.length) return null;
  const t0 = Math.min(...(starts.length ? starts : ends));
  const t1 = Math.max(...(ends.length ? ends : starts));
  return { t0, t1, span: t1 - t0 };
}

/**
 * Exact ±1 concurrency arithmetic over recorded intervals — the collapsed
 * group's occupancy model. Pure. Delegates to THE shared occupancy
 * (components/timeline.mjs) and returns its exact segments: [{start, end, n}]
 * — one per stretch of constant concurrency, drawn as DESIGN §2 `bin`
 * primitives (never a scaled column chart).
 */
export function occupancySegments(agents, t0, t1) {
  if (!(t1 > t0)) return { segments: [], max: 0, pointOnly: 0 };
  const intervals = (agents ?? []).map((ag) => ({ start: ag.firstAt ?? null, end: ag.lastAt ?? null }));
  return sharedOccupancy(intervals);
}

/* =========================================================== tree model == */

/** The set of agentIds whose recorded parentAgentId chain returns to itself,
 *  computed over WHATEVER list it is handed. The walk runs at TURN scope
 *  (buildTree) as well as per group: a cycle whose two members land in
 *  different lane groups, or in different phases of the same run, is invisible
 *  to a group-local walk alone. */
export function cyclicAgentIds(all) {
  const byId = new Map(all.map((ag) => [ag.agentId, ag]));
  const out = new Set();
  for (const ag of all) {
    const seen = new Set();
    let cur = ag;
    while (cur?.parentAgentId && byId.has(cur.parentAgentId)) {
      if (seen.has(cur.agentId)) break;
      seen.add(cur.agentId);
      cur = byId.get(cur.parentAgentId);
      if (cur === ag) { out.add(ag.agentId); break; }
    }
  }
  return out;
}

/** main → workflows → phases → agents → children (parentAgentId). Pure. */
export function buildTree(model) {
  const { groups, referenceRows } = model;
  // One walk over the WHOLE turn's agent list, threaded into every
  // attachAgents call. buildLanes ships `agents` (the normalised list) for
  // exactly this; a caller that hands buildTree a model without it loses
  // nothing, because attachAgents still unions in its own group-local walk.
  const cyclic = cyclicAgentIds(model.agents ?? []);
  const nodes = [{ key: 'main', label: 'main thread', kind: 'main', depth: 0, children: [] }];

  for (const g of groups) {
    if (g.kind !== 'run') continue;
    const runNode = {
      key: g.key, label: g.label, sublabel: g.sublabel, kind: 'workflow', runId: g.runId,
      depth: 0, children: [], agentCount: g.agents.length,
    };
    // Phases from workflowProgress, in first-appearance order (recorded order).
    const phases = new Map();
    for (const ag of g.agents) {
      const key = ag.phase === null || ag.phase === undefined ? ' none' : String(ag.phase);
      if (!phases.has(key)) phases.set(key, []);
      phases.get(key).push(ag);
    }
    const single = phases.size === 1 && phases.has(' none');
    for (const [key, list] of phases) {
      const host = single ? runNode : {
        key: `${g.key}|ph:${key}`, kind: 'phase', runId: g.runId,
        label: key === ' none' ? 'no phase recorded' : `phase ${key}`,
        depth: 1, children: [], agentCount: list.length,
      };
      if (!single) runNode.children.push(host);
      attachAgents(host, list, cyclic);
    }
    nodes.push(runNode);
  }
  for (const g of groups) {
    if (g.kind === 'run') continue;
    // treeView builds every row's href straight from node.key, so every key
    // must be one parseSel() recognises — a key that falls through renders a
    // link that selects nothing while the row still paints itself selected.
    // buildLanes gives the two non-run groups BARE keys ('plain', 'unlinked');
    // scheme-qualify them HERE, not in buildLanes, so the
    // `l3.collapsed.${g.key}` preference and the group-shape tests keep their
    // keys. The orphan groups are left alone on purpose: they already carry a
    // working 'w:<runId>:running' / ':superseded' key, and blanket-prefixing
    // would break their currently-correct workflow parse.
    const nodeKey = (g.kind === 'plain' || g.kind === 'unlinked') ? `g:${g.key}` : g.key;
    const node = { key: nodeKey, label: g.label, kind: g.kind, depth: 0, children: [], agentCount: g.agents.length, note: g.note };
    attachAgents(node, g.agents, cyclic);
    nodes.push(node);
  }
  for (const r of referenceRows) {
    nodes.push({
      key: `ref:${r.runId}`, kind: 'reference', runId: r.runId,
      label: r.name ?? r.runId, depth: 0, children: [], reference: true, countedInTurn: r.countedInTurn,
    });
  }
  return nodes;
}

function attachAgents(host, list, cyclic = null) {
  const byId = new Map(list.map((ag) => [ag.agentId, ag]));
  // An agent is a root only when it has no RESOLVABLE recorded parent, and
  // node() recurses from roots only — so if two recorded parentAgentIds point
  // at each other (or a longer chain closes), no member is ever a root and
  // every one of them, plus any innocent descendant hanging off one, would be
  // dropped from the tree while the group header went on counting it. An
  // agent whose parent chain returns to ITSELF is rooted here (the narrow
  // rule: it cuts exactly the back-edge, provably terminates, and does not
  // unparent innocent descendants) and the row is MARKED, so the repair is
  // disclosed rather than performed silently. Nothing is inferred: the
  // recorded parentAgentId is untouched — only where the row is drawn.
  //
  // `cyclic` is buildTree's turn-wide walk, which sees cycle members this
  // group cannot (a different lane group, or a different phase of the same
  // run). It is UNIONed with — never substituted for — the group-local walk,
  // so a caller that hands buildTree a model without `agents` keeps the
  // within-group detection rather than silently losing it.
  const selfCyclic = new Set([...(cyclic ?? []), ...cyclicAgentIds(list)]);
  const childrenOf = new Map();
  const roots = [];
  for (const ag of list) {
    if (ag.parentAgentId && byId.has(ag.parentAgentId) && !selfCyclic.has(ag.agentId)) {
      if (!childrenOf.has(ag.parentAgentId)) childrenOf.set(ag.parentAgentId, []);
      childrenOf.get(ag.parentAgentId).push(ag);
    } else roots.push(ag);
  }
  const node = (ag, depth) => ({
    key: `a:${ag.agentId}`, kind: 'agent', label: laneLabel(ag), agent: ag, depth,
    cycleRoot: selfCyclic.has(ag.agentId),
    children: (childrenOf.get(ag.agentId) ?? []).map((c) => node(c, depth + 1)),
  });
  for (const r of roots) host.children.push(node(r, (host.depth ?? 0) + 1));
}

export function laneLabel(ag) {
  if (ag.label) return ag.label;
  if (ag.agentType && ag.agentId) return `${ag.agentType} ${shortId(ag.agentId, 10)}`;
  return ag.agentId ?? 'agent';
}

/**
 * ?sel parsing — 'main' | 'w:<runId>' | 'w:<runId>|ph:<phase>' | 'a:<agentId>'
 * | 'g:<groupKey>' (the non-run groups the tree also links to).
 *
 * INVARIANT: every key buildTree() emits must parse to a kind named here.
 * A key that falls through to 'unknown' renders a link that selects nothing.
 */
export function parseSel(sel) {
  if (!sel) return { kind: 'main', key: 'main' };
  const str = String(sel);
  if (str === 'main') return { kind: 'main', key: 'main' };
  if (str.startsWith('a:')) return { kind: 'agent', agentId: str.slice(2), key: str };
  if (str.startsWith('w:')) return { kind: str.includes('|ph:') ? 'phase' : 'workflow', key: str, runId: str.slice(2).split('|')[0].split(':')[0] };
  if (str.startsWith('g:')) return { kind: 'group', key: str };
  return { kind: 'unknown', key: str };
}
