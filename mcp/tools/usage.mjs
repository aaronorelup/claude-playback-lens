// mcp/tools/usage.mjs — lens_usage.
//
// Token and dollar usage out of the lens's own ledger, grouped and scoped.
// This is the tool that kills the hand-written "parse the JSONL and add up the
// usage blocks" script, and the reason it can is that it never adds anything
// up itself: every figure below arrives already computed by the same handler
// the browser UI reads, which means R2 (one message.id recorded in two files
// after a fork or a resume) is already resolved, the interval rate table is
// already applied, and the rows that could not be priced are already reported
// as such instead of being quietly billed at $0.
//
// THE THREE THINGS THIS FILE IS CAREFUL ABOUT
//
// 1. Where each grouping's numbers come from, because the sources differ and
//    they do not all carry the same facts (SPEC §9 payload shapes):
//
//      group_by=project  /api/index         projects[].agg     FULL CostAgg
//      group_by=session  /api/index or
//                        /api/project/:slug sessions[].agg     LITE (no maps,
//                                                              no component usd)
//      group_by=model    the scope's own agg.byModel           CostAggLite
//      group_by=day      dayBands[]                            tokens + usd only
//      group_by=agent    /api/session       agents[].agg       FULL CostAgg
//
//    A renderer that pretended these were interchangeable would print `$0.0000`
//    where the payload says nothing at all. So each grouping declares what it
//    carries and `detail: true` prints only what is actually there.
//
// 2. The date-range limitation, printed rather than hidden. `since`/`until`
//    are answered from day bands, and day bands carry tokens and dollars — not
//    requests, not a per-model split, not the disclosure counters. Splitting a
//    date range by model would mean apportioning, and apportioning is
//    inference. So the tool says what it cannot do and how to get it.
//
// 3. `null` is not `0`. A model with only unpriced rows has `usd.total: null`
//    (a missing rate, never a free request); it renders `—`, and its share of
//    the total renders `—` too, because a share of an unknown is unknown.

import { z } from 'zod';

// The shared helpers this file needs at module scope (the rest arrive through
// deps.render, which is the same module). TOKEN_KEYS is the ledger's Tokens
// shape; descUnknownLast is the rule that an unaggregated group does not sort
// where $0 sorts; sessionTitleOf is shared with lens_sessions so the two never
// name one session differently.
import { TOKEN_KEYS, agentModelFact, descUnknownLast, groupInt, sessionTitleOf } from '../render.mjs';

// The description is written for an agent deciding whether to call this rather
// than reach for Bash + a parse script. It names the two errors that make a
// hand-rolled script wrong (double-billing forked messages, blending unpriced
// rows into $0) because those are the reasons to prefer this tool.
const DESCRIPTION = 'Token and dollar usage from Claude Code\'s own recorded ledger, grouped by project, session, model, day or agent, over any scope and date range. Use this instead of writing a script over the JSONL — it already de-duplicates rows by `message.id` across forked and resumed sessions (billing the same message twice is the classic error), already applies the interval rate table, and already reports the requests it could not price rather than guessing. Answers "what did project X cost this week", "what share of my usage was project X", "which model am I spending on". All figures are the same ones the lens UI shows. Read-only.';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Display ceiling on the group-name column, in characters.
//
// A project slug is a SANITISED ABSOLUTE PATH — on the author's corpus they run
// to 125 characters and 20 of them share the same 46-character prefix
// (`C--Users-userx-Organized-Personal-My-Projects-`). Unbounded, one such
// outlier padded all 22 lines of the store table to ~163 characters and made
// the table 82% of a result 3.7× over its ~300-token budget. 44 keeps the whole
// distinguishing tail of every slug on this corpus while cutting the column to
// roughly a third. Clipping is tail-keeping and DISPLAY ONLY: `r.name` stays
// full in the `next:` hints, in `detail: true` and in `structuredContent`, so
// every group listed here is still addressable.
const NAME_MAX = 44;

// Declared default for `limit`, in rendered groups.
//
// It was 20 until TOOLS_VERSION 2. The ~300-token budget §7.1 assigns this tool
// was written against a THREE-ROW output sketch; on the real 31-project corpus
// 20 rows is roughly twice the answer anyone asked for — the top 10 projects
// carry ~93% of the store's spend, and rows 11-20 are the long tail that the
// TOTAL row already accounts for. 10 is what an agent's first call should cost.
// Nothing is hidden by this: the truncation line says how many groups it did
// not show, the TOTAL row covers every group, and `limit` up to 100 remains
// available for the caller who actually wants the tail.
const DEFAULT_LIMIT = 10;

const SCOPE_GRAMMAR = 'scope grammar: store | project:<slug> | session:<slug>/<id> | turn:<slug>/<id>/<idx> | agent:<slug>/<id>/<agentId> — components percent-encoded. lens_sessions reports the slug and id for a session.';

export function register(server, deps) {
  server.registerTool(
    'lens_usage',
    {
      title: 'Token and cost usage',
      description: DESCRIPTION,
      inputSchema: z.object({
        scope: z.string().default('store')
          .describe('store | project:<slug> | session:<slug>/<id> | turn:<slug>/<id>/<idx> | agent:<slug>/<id>/<agentId>. Components are percent-encoded; lens_sessions reports the slug and id.'),
        group_by: z.enum(['project', 'session', 'model', 'day', 'agent', 'workflow', 'none']).optional()
          .describe('Default: project for the store scope, session for a project scope, model for a session/turn/agent scope. "agent" requires a session scope; "workflow" is not implemented yet (lens_workflow, phase 2).'),
        since: z.string().regex(DATE_RE).optional()
          .describe('Inclusive start date, YYYY-MM-DD in the server host\'s local calendar. Date filtering is answered from day bands, which carry tokens and dollars only — see the note the result prints.'),
        until: z.string().regex(DATE_RE).optional()
          .describe('Inclusive end date, YYYY-MM-DD in the server host\'s local calendar.'),
        sort: z.enum(['usd', 'requests', 'tokens', 'name']).default('usd')
          .describe('Row order. usd/requests/tokens are descending with unknowns last; name is ascending.'),
        limit: z.number().int().min(1).max(100).default(DEFAULT_LIMIT)
          .describe('Max groups to render. The TOTAL row always covers every group, not just the ones shown.'),
        detail: z.boolean().default(false)
          .describe('Add the per-component USD split (input/output/cacheWrite/cacheRead/webSearch) and the full token object per row, where the source carries them.'),
        structured: z.boolean().default(false)
          .describe('Also return the machine-readable JSON as structuredContent, including exact integer tcu (USD = tcu / 2e9).'),
      }),
      // Every tool on this server is a reader over files already on this disk.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => runUsage(deps, args ?? {}),
  );
}

// ---------------------------------------------------------------- the handler

async function runUsage(deps, args) {
  const { ctx, lens, call, render } = deps;

  const scopeRaw = args.scope ?? 'store';
  let scope;
  try {
    // The app's own parser, not a second one. A scope string that works in the
    // UI's URL bar works here and vice versa, and there is exactly one place
    // the grammar can change.
    scope = lens.api.parseScope(scopeRaw);
  } catch (e) {
    return render.errorResult(`${(e && e.message) || `unparseable scope: ${scopeRaw}`}\n${SCOPE_GRAMMAR}`);
  }

  const since = args.since ?? null;
  const until = args.until ?? null;
  const dated = !!(since || until);

  // Date bounds are compared as instants, never as label strings: a band label
  // is 'YYYY-MM-DD' with an unpadded year, so a clock-skew day in year 99
  // string-compares below every real one. dayStartMsOf is the lens's own
  // local-day resolver (DST-safe, noon-anchored).
  const sinceMs = since ? lens.api.dayStartMsOf(since) : null;
  const untilMs = until ? lens.api.dayStartMsOf(until) : null;
  if (since && sinceMs === null) return render.errorResult(`since=${since} is not a resolvable calendar date.`);
  if (until && untilMs === null) return render.errorResult(`until=${until} is not a resolvable calendar date.`);
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    return render.errorResult(`since=${since} is after until=${until}; both bounds are inclusive, so the range is empty. Swap them.`);
  }

  const groupBy = args.group_by ?? defaultGroupBy(scope.kind);
  const gate = checkGrouping(groupBy, scope, dated);
  if (gate) return render.errorResult(gate);

  // The scope's own payload: header aggregate, the payload's own
  // rows-sum-to-header verdict, and (for store/project) the day bands.
  const scoped = await fetchScope(call, scope);
  if (scoped.status === 409) return render.structuredWrap(render.pendingResult(scoped.json), scoped.json, args.structured);
  if (scoped.status !== 200) {
    return render.errorResult(render.httpMessage(scoped, {
      tool: 'lens_usage',
      where: lens.api.scopeString(scope),
    }));
  }

  const view = scoped.json;
  const agg = view.agg ?? null;

  let built;
  try {
    built = dated
      ? await buildDated(deps, { scope, view, groupBy, sinceMs, untilMs })
      : await buildUndated(deps, { scope, view, groupBy });
  } catch (e) {
    if (e && e.usageError) return render.errorResult(e.message);
    throw e;
  }
  if (built.pending) return render.structuredWrap(render.pendingResult(built.pending), built.pending, args.structured);

  const text = renderUsage(deps, {
    scope, scopeRaw: lens.api.scopeString(scope), view, agg, groupBy,
    since, until, sinceMs, untilMs, dated,
    sort: args.sort ?? 'usd', limit: args.limit ?? DEFAULT_LIMIT, detail: !!args.detail,
    built,
  });

  // Built only when asked for: the rendered text is the complete result, and
  // an unrequested structuredContent is exactly the token doubling §7.2 exists
  // to avoid.
  const json = args.structured
    ? structuredJson(deps, { scope, agg, view, groupBy, since, until, dated, built, limit: args.limit ?? DEFAULT_LIMIT, sort: args.sort ?? 'usd' })
    : null;
  return render.structuredWrap(
    render.textResult(render.capText(text, { narrow: 'limit' })),
    json,
    !!args.structured,
  );
}

// ---------------------------------------------------------------- gating

// SPEC §6.4: project for the store, session for a project, model for a
// session. A turn and an agent are session-shaped — the only grouping their
// payload can carry is the model split — so they default the same way.
function defaultGroupBy(kind) {
  if (kind === 'store') return 'project';
  if (kind === 'project') return 'session';
  return 'model';
}

// Returns an error string when the (grouping, scope, dates) combination is not
// derivable from a recorded payload, or null when it is. Every message names
// what to do instead: a refusal an agent cannot act on is a dead end.
function checkGrouping(groupBy, scope, dated) {
  if (groupBy === 'workflow') {
    return 'group_by="workflow" is not implemented yet. Per-run cost lands in phase 2 with lens_workflow, which reports a run\'s journal, its agents and its total. For now: lens_usage scope="session:<slug>/<id>" group_by="agent" gives the per-agent split of a session, which includes the agents a workflow run spawned.';
  }
  if (dated) {
    // Day bands are recorded per project and per local day. Nothing else is
    // day-partitioned, and apportioning would be inference.
    if (scope.kind !== 'store' && scope.kind !== 'project') {
      return `since/until are answered from day bands, and day bands exist at store and project scope only — a ${scope.kind} scope has none. Re-run without since/until for this scope, or use scope="project:${scope.slug}" (or scope="store") with the dates.`;
    }
    if (groupBy === 'session' || groupBy === 'model' || groupBy === 'agent') {
      return `group_by="${groupBy}" cannot be combined with since/until: day bands carry tokens and dollars per local day (and, per project, per project) — they are not partitioned by ${groupBy}, and splitting them would be an estimate rather than a recorded fact. Either drop since/until to get the ${groupBy} split over the whole scope, or keep the dates with group_by="day"${scope.kind === 'store' ? ' or group_by="project"' : ''}.`;
    }
    if (groupBy === 'project' && scope.kind !== 'store') {
      return 'group_by="project" needs the store scope — a project scope is already one project. Use scope="store" with the dates, or group_by="day" here.';
    }
    return null;
  }
  if (groupBy === 'project' && scope.kind !== 'store') {
    return `group_by="project" needs the store scope — ${scope.kind === 'project' ? 'a project scope is already one project' : 'this scope sits inside a single project'}. Use scope="store", or group_by="session" here.`;
  }
  if (groupBy === 'session' && scope.kind !== 'store' && scope.kind !== 'project') {
    return `group_by="session" needs the store scope or a project scope — a ${scope.kind} scope is inside one session. Use group_by="model"${scope.kind === 'session' ? ' or group_by="agent"' : ''} here.`;
  }
  if (groupBy === 'day' && scope.kind !== 'store' && scope.kind !== 'project') {
    return `group_by="day" needs the store scope or a project scope: day bands are computed per project and per local calendar day, and a ${scope.kind} scope has none. Use scope="project:${scope.slug}" for this project's days.`;
  }
  if (groupBy === 'agent' && scope.kind !== 'session') {
    return `group_by="agent" requires a session scope — per-agent aggregates ride /api/session, one row per subagent transcript in that session. Use scope="session:<slug>/<id>"${scope.kind === 'turn' || scope.kind === 'agent' ? ` (here: scope="session:${scope.slug}/${scope.id}")` : ''}.`;
  }
  return null;
}

// ---------------------------------------------------------------- fetching

const enc = encodeURIComponent;

async function fetchScope(call, scope) {
  switch (scope.kind) {
    case 'store': return call('GET', '/api/index');
    case 'project': return call('GET', `/api/project/${enc(scope.slug)}`);
    case 'session': return call('GET', `/api/session/${enc(scope.slug)}/${enc(scope.id)}`);
    case 'turn': return call('GET', `/api/turn/${enc(scope.slug)}/${enc(scope.id)}/${scope.idx}`);
    case 'agent': return call('GET', `/api/agent/${enc(scope.slug)}/${enc(scope.id)}/${enc(scope.agentId)}`);
    default: return call('GET', '/api/index');
  }
}

// A thrown gate from deep inside a builder (an error the model can act on).
function usageError(message) {
  const e = new Error(message);
  e.usageError = true;
  return e;
}

// ---------------------------------------------------------------- groupings
//
// Every builder returns the same shape:
//   rows      [{ name, requests, tokens, usdTcu, turnCount?, sessionsTouched?,
//                usdSplit?, source }]   — null anywhere means "not recorded /
//                                          not carried by this payload"
//   total     { requests, tokens, usdTcu }  the figure the rows are shares OF
//   totalUsdSplit  the component USD object BELONGING TO `total`, or null when
//                  this source carries no split of exactly that figure — see
//                  the note below. Never the scope aggregate's split when
//                  `total` is a date-filtered subtotal.
//   totalUsdSplitWhy  why the split is null, in one clause, when it is
//   covers    true when the rows partition the whole scope (share column legal)
//   carries   what the source carries, printed under `detail:`
//   notes[]   honest limitations for this particular source

async function buildUndated(deps, { scope, view, groupBy }) {
  const { call, ctx } = deps;
  const agg = view.agg ?? null;
  const totalOf = (a) => ({
    requests: a ? a.requests : null,
    tokens: a ? a.tokens : null,
    usdTcu: a && a.usd ? a.usd.total : null,
  });

  // On every UNDATED grouping but `day`, `total` IS the scope aggregate — so
  // the aggregate's own component split is a split of exactly that figure and
  // travels with it. `day` totals Σ day bands, a different quantity, and the
  // dated path is a subtotal of it; neither may borrow this. Spelled once, and
  // attached at build time, so the renderer never has to pick a source.
  const aggSplit = agg && agg.usd ? agg.usd : null;
  const noAggWhy = 'this scope has no aggregate yet, so no component split is recorded (lens_status reports whether the index is still building)';

  if (groupBy === 'none') {
    return {
      rows: [],
      total: totalOf(agg),
      totalUsdSplit: aggSplit,
      totalUsdSplitWhy: aggSplit ? null : noAggWhy,
      covers: true,
      carries: 'full',
      notes: [],
      groupNoun: 'group',
    };
  }

  if (groupBy === 'project') {
    const rows = (view.projects ?? []).map((p) => ({
      name: p.slug,
      label: p.label ?? null,
      // A project the index has not aggregated yet is UNKNOWN, not zero — the
      // same distinction the agent grouping makes, counted the same way so
      // `unknownGroupCount` means one thing across every grouping that has an
      // aggregate to be missing. (model rows come from byModel entries and day
      // rows from bands; neither can be "missing an agg", so neither is marked.)
      aggMissing: !p.agg,
      ...fromFullAgg(p.agg),
      source: 'project agg (FULL CostAgg)',
    }));
    return { rows, total: totalOf(agg), totalUsdSplit: aggSplit, totalUsdSplitWhy: aggSplit ? null : noAggWhy, covers: true, carries: 'full', notes: [], groupNoun: 'project' };
  }

  if (groupBy === 'session') {
    const rows = (view.sessions ?? []).map((s) => ({
      name: `${s.slug}/${s.id}`,
      // The SAME title ladder lens_sessions prints (customTitle ▸ aiTitle ▸
      // title, the lens UI's own). This file used to order it customTitle ▸
      // title ▸ aiTitle, which named a session with both an aiTitle and a
      // title differently from the tool an agent got the locator from.
      label: sessionTitleOf(s),
      aggMissing: !s.agg,
      ...fromLiteAgg(s.agg),
      source: 'session agg (LITE)',
    }));
    return {
      rows,
      total: totalOf(agg),
      totalUsdSplit: aggSplit,
      totalUsdSplitWhy: aggSplit ? null : noAggWhy,
      covers: true,
      carries: 'lite',
      notes: [],
      groupNoun: 'session',
    };
  }

  if (groupBy === 'model') {
    if (!agg) throw usageError('This scope has no aggregate yet, so there is no per-model split to report. lens_status reports whether the index is still building.');
    const rows = Object.entries(agg.byModel ?? {}).map(([raw, lite]) => ({
      name: raw,
      label: null,
      requests: lite.requests ?? null,
      tokens: lite.tokens ?? null,
      // CostAggLite carries usd.total only, and a model with nothing but
      // unpriced rows keeps it null — a missing rate is never $0.
      usdTcu: lite.usd ? lite.usd.total : null,
      usdSplit: null,
      source: 'agg.byModel (CostAggLite)',
    }));
    return {
      rows,
      total: totalOf(agg),
      totalUsdSplit: aggSplit,
      totalUsdSplitWhy: aggSplit ? null : noAggWhy,
      covers: true,
      carries: 'model',
      notes: [],
      groupNoun: 'model',
    };
  }

  if (groupBy === 'agent') {
    const rows = (view.agents ?? []).map((a) => ({
      name: a.agentId,
      label: a.label || a.tag || null,
      // The SAME ladder lens_session's AGENTS table and structuredContent walk
      // (render.agentModelFact). `resolvedModel` alone is null for most
      // workflow-spawned agents, so a copy of the ladder here that drifted from
      // that one would make two tools name one agent's model differently.
      ...modelFacts(a),
      turnIdx: a.turnIdx ?? null,
      // `agg: null` on an agent is UNKNOWN — its transcript was never parsed —
      // and is a different fact from an agent the ledger covers that billed
      // nothing. fromFullAgg keeps the nulls; the renderer prints `—`.
      //
      // Marked at BUILD time rather than re-derived from the nulls later, so
      // the coverage sentence and the structured payload can never disagree
      // about which rows contributed nothing to the covered figures.
      aggMissing: !a.agg,
      ...fromFullAgg(a.agg),
      source: 'agents[].agg (FULL CostAgg)',
    }));
    // `?? 0` here is the arithmetic that makes `coveredRequests` an AT-LEAST
    // whenever any agent's agg is missing. The number is kept (it is the right
    // floor) and the renderer discloses the shortfall — §0 rule 1 forbids the
    // silent fold, not the floor.
    const covered = rows.reduce((n, r) => n + (r.requests ?? 0), 0);
    return {
      rows,
      total: totalOf(agg),
      totalUsdSplit: aggSplit,
      totalUsdSplitWhy: aggSplit ? null : noAggWhy,
      covers: false, // main-thread rows belong to no agent — see the note
      carries: 'full',
      coveredRequests: covered,
      notes: [],
      groupNoun: 'agent',
    };
  }

  if (groupBy === 'day') {
    const bands = view.dayBands ?? [];
    const rows = bands.map((b) => bandRow(b));
    return {
      rows,
      total: sumBands(bands),
      // Σ day bands, NOT the scope aggregate — so the aggregate's split is a
      // split of a different number (scopeTotal below) and must not ride here.
      totalUsdSplit: null,
      totalUsdSplitWhy: 'day bands carry one dollar TOTAL per local day and no component object, so Σ bands has no component split; the scope aggregate\'s split ships under group_by="none" with detail=true',
      scopeTotal: totalOf(agg),
      covers: true,
      carries: 'band',
      notes: [dayNote()],
      groupNoun: 'day',
    };
  }

  throw usageError(`unsupported group_by: ${groupBy}`);
}

// The dated path. Everything here comes from day bands and therefore carries
// tokens and dollars only — no requests, no model split, no disclosure
// counters. That limitation is printed by the renderer, always.
async function buildDated(deps, { scope, view, groupBy, sinceMs, untilMs }) {
  const { call, lens } = deps;
  const all = view.dayBands ?? [];
  const inRange = all.filter((b) => bandInRange(b, sinceMs, untilMs));
  const undatable = all.filter((b) => b.startMs === null || b.startMs === undefined).length;
  const total = sumBands(inRange);
  const notes = [limitationNote()];
  if (undatable > 0) {
    notes.push(`note: ${undatable} day band${undatable === 1 ? '' : 's'} carry a label that does not resolve to an instant (recorded clock skew) and are excluded from the range.`);
  }

  if (groupBy === 'day' || groupBy === 'none') {
    return {
      rows: groupBy === 'none' ? [] : inRange.map((b) => bandRow(b)),
      total,
      // THE DEFECT THIS NULL EXISTS TO PREVENT. A day band carries ONE dollar
      // number (server/api/bands.mjs: `b.usd += priceRowTcu(...)`), not a
      // component object — so no split of THIS date range exists anywhere in
      // the recorded data. The renderer used to fall back to the SCOPE
      // aggregate's split here, which put a whole-store `usd: … total
      // $999.9999` line directly beneath a range header reading $111.1111
      // (figures synthetic; the real repro had the same shape at store scale).
      // The split is not carried, so it is not printed: null, and a reason.
      totalUsdSplit: null,
      totalUsdSplitWhy: `day bands carry one dollar TOTAL per local day and no component object, so no input/output/cacheWrite/cacheRead/webSearch split of this date range is a recorded fact — re-run without since/until (lens_usage scope="${lens.api.scopeString(scope)}" group_by="none" detail=true) for the whole scope's split`,
      covers: true,
      carries: 'band',
      dayCount: inRange.length,
      notes: groupBy === 'day' ? [...notes, dayNote()] : notes,
      groupNoun: 'day',
    };
  }

  // group_by=project over a date range: each project's OWN day bands, summed
  // over the same range. /api/project computes them the same way /api/index
  // does (same walk, same memo), so Σ projects = the store's range total by
  // construction, and the renderer's own cross-check states it.
  if (groupBy === 'project') {
    const rows = [];
    for (const p of view.projects ?? []) {
      const r = await call('GET', `/api/project/${enc(p.slug)}`);
      if (r.status === 409) return { pending: r.json };
      if (r.status !== 200) {
        // Unknown, not zero: the project exists, its bands did not answer.
        rows.push({ name: p.slug, label: p.label ?? null, aggMissing: true, requests: null, tokens: null, usdTcu: null, turnCount: null, sessionsTouched: null, source: `unreadable (${r.status})` });
        notes.push(`note: project ${p.slug} answered ${r.status}; its figures are unknown (—), not zero.`);
        continue;
      }
      const bands = (r.json.dayBands ?? []).filter((b) => bandInRange(b, sinceMs, untilMs));
      const s = sumBands(bands);
      rows.push({
        name: p.slug,
        label: p.label ?? null,
        requests: null, // day bands carry no request count
        tokens: s.tokens,
        usdTcu: s.usdTcu,
        turnCount: s.turnCount,
        sessionsTouched: s.sessionsTouched,
        source: 'project dayBands, summed over the range',
      });
    }
    return { rows, total, covers: true, carries: 'band', dayCount: inRange.length, notes, groupNoun: 'project' };
  }

  throw usageError(`unsupported group_by over a date range: ${groupBy}`);
}

function bandInRange(b, sinceMs, untilMs) {
  const ms = b.startMs;
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return false;
  if (sinceMs !== null && ms < sinceMs) return false;
  if (untilMs !== null && ms > untilMs) return false;
  return true;
}

function bandRow(b) {
  return {
    name: b.localDate,
    label: null,
    requests: null, // bands carry no request count — `—`, never 0
    tokens: b.tokens ?? null,
    usdTcu: typeof b.usd === 'number' ? b.usd : null,
    turnCount: b.turnCount ?? null,
    sessionsTouched: b.sessionsTouched ?? null,
    usdSplit: null,
    source: 'dayBands',
  };
}

function sumBands(bands) {
  const tokens = emptyTokens();
  let usdTcu = 0;
  let turnCount = 0;
  let sessionsTouched = 0;
  for (const b of bands) {
    for (const k of TOKEN_KEYS) tokens[k] += (b.tokens && b.tokens[k]) || 0;
    usdTcu += typeof b.usd === 'number' ? b.usd : 0;
    turnCount += b.turnCount || 0;
    // sessionsTouched is a per-day count of distinct sessions; summing it over
    // days counts a session once per day it appears in. Labelled as such.
    sessionsTouched += b.sessionsTouched || 0;
  }
  return { requests: null, tokens, usdTcu, turnCount, sessionsTouched };
}

function emptyTokens() {
  const t = {};
  for (const k of TOKEN_KEYS) t[k] = 0;
  return t;
}

// An agent row's model fields, from the one shared ladder. `modelSource` names
// which recorded field answered, so `model` is never mistaken for a recorded
// `resolvedModel`; both are null when nothing recorded one.
function modelFacts(a) {
  const { model, source } = agentModelFact(a);
  return { model, modelSource: source };
}

function fromFullAgg(a) {
  if (!a) return { requests: null, tokens: null, usdTcu: null, usdSplit: null };
  return {
    requests: a.requests ?? null,
    tokens: a.tokens ?? null,
    usdTcu: a.usd ? a.usd.total : null,
    usdSplit: a.usd ?? null,
  };
}

function fromLiteAgg(a) {
  if (!a) return { requests: null, tokens: null, usdTcu: null, usdSplit: null };
  return {
    requests: a.requests ?? null,
    tokens: a.tokens ?? null,
    usdTcu: a.usd ? a.usd.total : null,
    usdSplit: null, // LITE carries usd.total only
  };
}

// Groups whose source payload carried no aggregate at all — UNKNOWN, and a
// different fact from a group the ledger covers that billed nothing. One
// function so the coverage sentence and `unknownGroupCount` in the structured
// payload are always the same count over the same rows.
function unknownGroupCount(rows) {
  return rows.filter((r) => r.aggMissing === true).length;
}

// ---------------------------------------------------------------- notes

// SPEC §6.4's honest limitation, printed whenever since/until are used. It is
// spec'd behaviour, not an apology: the alternative is a per-model split of a
// date range, which nothing recorded.
function limitationNote() {
  return [
    'note: date-filtered totals come from day bands, which carry tokens and $ only.',
    '      Request counts, the per-model split and the disclosure counters are not',
    '      day-partitioned — re-run without since/until to get them. A turn crossing',
    '      local midnight splits across days by its rows\' recorded timestamps.',
  ].join('\n');
}

function dayNote() {
  return 'note: `turns` counts a turn in every local day its recorded bar touches (so Σ turns can exceed the distinct turn count) and `sessions` counts a session once per day it appears in.';
}

// ---------------------------------------------------------------- rendering

function renderUsage(deps, s) {
  const { ctx, render } = deps;
  const { fmtUsd, fmtTokens, sharePct, table, renderRowsSum, renderDisclosures, UNKNOWN } = render;
  const P = ctx.pricing;
  const { scope, scopeRaw, view, agg, groupBy, built, dated, detail } = s;
  const lines = [];

  // ---- header
  const range = dated
    ? ` · ${s.since ?? 'earliest'}..${s.until ?? 'latest'} (${built.dayCount ?? 0} recorded local day${(built.dayCount ?? 0) === 1 ? '' : 's'} in range)`
    : '';
  lines.push(`USAGE — ${scopeRaw}${range} · group_by=${groupBy} · sort=${s.sort}`);

  // ---- basis: the denominator of everything below, plus the versions a cost
  // figure is only traceable under.
  lines.push(basisLine(deps, s));

  const st = safeStatus(ctx);
  if (st && st.state && st.state !== 'ready') {
    lines.push(`index: ${st.state} — ${st.sessionsDone ?? UNKNOWN} of ${st.sessionsTotal ?? UNKNOWN} sessions summarised; the figures below cover what is indexed so far.`);
  }
  // The deeper payloads carry a top-level `r2`; /api/index carries it under
  // `status`. Same vocabulary, same test (render.r2Pending), two homes.
  if (render.r2Pending(view.r2) || render.r2Pending(view.status && view.status.r2)) {
    lines.push('R2 fork resolution is still pending — inherited/forked figures may change; re-run when lens_status reports the index ready.');
  }

  // ---- rows
  //
  // A group that recorded NOTHING is collapsed into a single counted line
  // rather than given a row each. This is not hiding a fact: the count is
  // printed, and a provable zero is named as one (it is not an unknown — an
  // unaggregated group carries `null` and keeps its own `—` row). On a real
  // corpus a one-week range leaves two dozen projects at zero, and two dozen
  // rows of zeros is the entire token budget spent saying nothing.
  const { rows, emptyCount } = partitionRows(built.rows, s.sort, s.groupBy);
  const shown = rows.slice(0, s.limit);
  const totalTcu = built.total.usdTcu;
  const showShare = built.covers === true;

  if (groupBy !== 'none' && rows.length === 0) {
    lines.push(emptyCount > 0
      ? `all ${emptyCount} ${built.groupNoun}${emptyCount === 1 ? '' : 's'} recorded nothing in this ${dated ? 'date range' : 'scope'} — a provable zero from the same source, not an unknown.`
      : `no ${built.groupNoun} groups recorded in this ${dated ? 'date range' : 'scope'}.`);
  } else if (groupBy !== 'none') {
    const isBand = built.carries === 'band';
    const head = isBand
      ? [colName(groupBy), 'turns', 'sessions', 'tokens', 'total $']
      : [colName(groupBy), 'requests', 'tokens', 'total $'];
    if (showShare) head.push('share');
    const align = isBand ? ['l', 'r', 'r', 'r', 'r', 'r'] : ['l', 'r', 'r', 'r', 'r'];

    const body = [head];
    for (const r of shown) {
      const cells = isBand
        ? [r.name, groupInt(r.turnCount), groupInt(r.sessionsTouched), fmtTokens(tokenMass(r.tokens)), fmtUsd(P, r.usdTcu)]
        : [r.name, groupInt(r.requests), fmtTokens(tokenMass(r.tokens)), fmtUsd(P, r.usdTcu)];
      if (showShare) cells.push(sharePct(r.usdTcu, totalTcu));
      body.push(cells);
    }
    // The TOTAL row covers every group, not only the ones shown — that is why
    // it can read 100.0% under a truncated list.
    const totalCells = isBand
      ? ['TOTAL', groupInt(built.total.turnCount), groupInt(built.total.sessionsTouched), fmtTokens(tokenMass(built.total.tokens)), fmtUsd(P, totalTcu)]
      : ['TOTAL', groupInt(built.total.requests), fmtTokens(tokenMass(built.total.tokens)), fmtUsd(P, totalTcu)];
    if (showShare) totalCells.push(totalTcu === null || totalTcu === 0 ? UNKNOWN : '100.0%');
    body.push(totalCells);

    // Only the name column is bounded; every other cell is a formatted number
    // whose width is already its own.
    lines.push(table(body, { align, max: [NAME_MAX], clip: ['tail'] }));

    // A clipped name is not a name — it carries `…` precisely so it can never
    // be pasted into a `scope` and mistaken for a real slug. Say so, and say
    // where the unclipped ones are, rather than letting a reader guess.
    const clipped = shown.filter((r) => String(r.name).length > NAME_MAX).length;
    if (clipped > 0) {
      lines.push(`${clipped} of ${shown.length} ${built.groupNoun} name${clipped === 1 ? '' : 's'} clipped for DISPLAY at ${NAME_MAX} chars (tail kept, marked …) — a clipped name is not addressable; the full names ride next:, detail=true and structured=true.`);
    }

    if (rows.length > shown.length) {
      const more = rows.length - shown.length;
      lines.push(`… ${more} more ${built.groupNoun}${more === 1 ? '' : 's'} (${rows.length} total; raise limit to see all)`);
    }
    if (emptyCount > 0) {
      lines.push(`… and ${emptyCount} ${built.groupNoun}${emptyCount === 1 ? '' : 's'} recorded nothing in this ${dated ? 'date range' : 'scope'} — a provable zero from the same source, not an unknown; raising limit will not list them.`);
    }

    if (detail) {
      const detailLines = renderDetail(deps, shown, built);
      if (detailLines.length) lines.push(...detailLines);
    }
  } else {
    // group_by=none — the scope's own totals, nothing else.
    lines.push(`total: ${groupInt(built.total.requests)} requests · ${fmtUsd(P, totalTcu)} · tokens ${fmtTokens(tokenMass(built.total.tokens))}`);
    if (detail && built.total.tokens) lines.push(`  tokens: ${tokenLine(built.total.tokens, fmtTokens)}`);
    if (detail) {
      // The split of `built.total` — the SAME figure the header above prints —
      // or a stated absence. Reading the scope aggregate here instead is what
      // put a whole-store component split under a date-range header; the
      // builder now decides, so the two can never disagree about scope.
      if (built.totalUsdSplit) lines.push(`  usd: ${usdSplitLine(P, built.totalUsdSplit, fmtUsd)}`);
      else lines.push(`  usd: total ${fmtUsd(P, totalTcu)} · component split not available for this total — ${built.totalUsdSplitWhy ?? 'this source does not carry one'}.`);
    }
  }

  // ---- the cross-checks. Two different facts, named separately: the payload's
  // own rows-vs-header verdict, and this tool's Σ-groups-vs-total check.
  const payloadVerdict = view.rowsSumToHeader;
  if (payloadVerdict !== undefined) {
    lines.push(`rows sum to header: ${renderRowsSum(payloadVerdict, P)}${dated ? ' (the payload\'s own check over the whole scope, not the date range)' : ''}`);
  }
  // A Σ-groups-vs-TOTAL check only means anything when the groups partition the
  // scope. For the agent grouping they deliberately do not, so the coverage
  // line below states the shortfall instead of dressing it up as a delta.
  if (groupBy !== 'none' && built.covers !== false) {
    lines.push(groupSumLine(deps, { rows, built, totalTcu }));
  }

  // An undated day grouping totals Σ day bands, which is a DIFFERENT quantity
  // from the scope's ledger aggregate: bands are built from rows carrying a
  // recorded timestamp and exclude §3 embedded-sidechain rows. Printing only
  // one of the two would quietly redefine "the total", so both ship, and so
  // does the difference.
  if (built.scopeTotal) {
    const sa = built.scopeTotal;
    const cmp = sa.usdTcu === null || totalTcu === null
      ? 'not comparable (one side has no dollar figure)'
      : (totalTcu - sa.usdTcu === 0
        ? 'Σ day bands agree exactly'
        : `Σ day bands differ by ${fmtUsd(P, totalTcu - sa.usdTcu)} — bands exclude rows with no recorded timestamp and §3 embedded-sidechain rows`);
    lines.push(`scope aggregate (full ledger, every day): ${groupInt(sa.requests)} requests · ${fmtUsd(P, sa.usdTcu)} · ${cmp}`);
  }

  // ---- coverage, when the grouping is not a partition of the scope
  if (built.covers === false && built.coveredRequests !== undefined) {
    let covered = 0;
    for (const r of rows) covered += r.usdTcu ?? 0;
    // Both figures above fold every unaggregated group in at 0. That makes them
    // an AT-LEAST, not an exact — and an at-least printed as an exact is the
    // §0 rule 1 violation this clause exists to prevent. Phrased to mirror
    // groupSumLine()'s own "adds nothing to the Σ" tail, so a reader meets the
    // same fact in the same words wherever this tool folds an unknown.
    const unknown = unknownGroupCount(rows);
    const tail = unknown > 0
      ? ` ${unknown} of these ${rows.length} agent group${rows.length === 1 ? '' : 's'} ${unknown === 1 ? 'has' : 'have'} no computable figures (rendered —: the transcript was never parsed, or the index has not aggregated it yet) — ${unknown === 1 ? 'its' : 'their'} contribution is unknown, not zero, and is NOT included in the covered figures above, which are therefore floors rather than exact.`
      : '';
    lines.push(`coverage: these ${rows.length} agent group${rows.length === 1 ? '' : 's'} cover ${groupInt(built.coveredRequests)} of ${groupInt(built.total.requests)} billed requests and ${fmtUsd(P, covered)} of ${fmtUsd(P, totalTcu)} in this scope — the rest are main-thread rows, which belong to no agent (no percentage column for that reason).${tail}`);
  }

  // ---- disclosures. The scope aggregate is a FULL CostAgg at every scope this
  // tool fetches, so this line is driven by renderDisclosures's own enumeration
  // of the counter keys (§7.3.4) rather than by anything picked here.
  if (agg) {
    const d = renderDisclosures(agg);
    // In a dated result the counters are the WHOLE scope's — they do not ride
    // day bands and cannot be narrowed to the range. Say which they are.
    if (d) lines.push(dated ? d.replace(/^disclosures:/, 'disclosures (whole scope, not the date range):') : d);
  } else {
    lines.push('disclosures: — (no aggregate computed for this scope yet)');
  }
  if (built.carries === 'lite') {
    lines.push('per-row detail at this grouping is the LITE session aggregate: requests, tokens, usd.total and the plain counters. The component USD split and the per-model/inherited/unpriced maps ship at session scope — lens_usage scope="session:<slug>/<id>".');
  }
  // Undated day grouping needs the band caveat spelled out; the dated path
  // already prints the fuller limitation note, so this would repeat it.
  if (built.carries === 'band' && !dated) {
    lines.push('day bands carry tokens and $ only: no request count, no model split, no disclosure counters — those come from the scope aggregate above.');
  }

  for (const n of built.notes) lines.push(n);

  lines.push(nextHints(s, shown));
  return lines.join('\n');
}

function colName(groupBy) {
  if (groupBy === 'day') return 'day (local)';
  if (groupBy === 'model') return 'model (recorded)';
  if (groupBy === 'agent') return 'agentId';
  if (groupBy === 'session') return 'slug/id';
  return groupBy;
}

function basisLine(deps, s) {
  const { ctx, render, lens } = deps;
  const { fmtBytes, UNKNOWN } = render;
  const { scope, view } = s;
  const versions = `pricing v${lens.pricing.PRICING_VERSION} · index v${lens.store.INDEX_VERSION}`;
  const st = safeStatus(ctx);
  const bytes = st ? fmtBytes(st.bytesTotal ?? null) : UNKNOWN;

  if (scope.kind === 'store') {
    const sc = view.aggScope || {};
    return `basis: ${sc.sessions ?? UNKNOWN} of ${sc.of ?? UNKNOWN} sessions indexed · ${bytes} · ${versions}`;
  }
  if (scope.kind === 'project') {
    const cards = view.sessions ?? [];
    const withAgg = cards.filter((c) => c.agg).length;
    const projBytes = cards.reduce((n, c) => n + (typeof c.bytes === 'number' ? c.bytes : 0), 0);
    return `basis: ${withAgg} of ${cards.length} sessions in this project aggregated · ${fmtBytes(projBytes)} · store index ${st ? `${st.sessionsDone ?? UNKNOWN} of ${st.sessionsTotal ?? UNKNOWN}` : UNKNOWN} sessions · ${versions}`;
  }
  if (scope.kind === 'session') {
    const files = view.files;
    return `basis: 1 session · ${fmtBytes(view.bytes ?? null)} · ${Array.isArray(files) ? files.length : (files ?? UNKNOWN)} files · ${view.lines ?? UNKNOWN} lines · ${versions}`;
  }
  const what = scope.kind === 'turn' ? `turn ${scope.idx}` : `agent ${scope.agentId}`;
  return `basis: ${what} of session ${scope.slug}/${scope.id} · ${versions}`;
}

function safeStatus(ctx) {
  try { return ctx.index.status(); } catch { return null; }
}

function sortRows(rows, sort) {
  const copy = [...rows];
  // Ties (and both-unknown pairs) break on the group name, so paging with
  // `limit` returns the same rows in the same order on every call.
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  // Unknown sorts LAST under every descending order — a group with no dollar
  // figure is not the cheapest group. The rule lives in render.mjs and is
  // shared with lens_sessions's cost order.
  const desc = (get) => descUnknownLast(get, byName);
  if (sort === 'name') return copy.sort(byName);
  if (sort === 'requests') return copy.sort(desc((r) => r.requests));
  if (sort === 'tokens') return copy.sort(desc((r) => tokenMass(r.tokens)));
  return copy.sort(desc((r) => r.usdTcu));
}

// Sort, then split off the groups that recorded nothing. One function so the
// rendered table and the structured payload can never disagree about which
// groups were listed.
function partitionRows(all, sort, groupBy) {
  const sorted = sortRows(all, sort);
  // A day band of zero is a real point in a time series and keeps its row.
  const rows = groupBy === 'day' ? sorted : sorted.filter((r) => !isEmptyGroup(r));
  return { rows, emptyCount: sorted.length - rows.length };
}

// A group with a proven zero everywhere it carries a figure. `requests: null`
// qualifies only alongside a zero dollar AND a zero token mass — that is the
// day-band shape, which records no request count at all. A group whose DOLLARS
// are null is an unknown and never lands here.
function isEmptyGroup(r) {
  if (r.usdTcu !== 0) return false;
  if (tokenMass(r.tokens) !== 0) return false;
  return r.requests === 0 || r.requests === null || r.requests === undefined;
}

function tokenMass(t) {
  if (!t) return null;
  let n = 0;
  for (const k of TOKEN_KEYS) n += t[k] ?? 0;
  return n;
}

// This tool's OWN cross-check, labelled as such: Σ of every group's dollars
// against the TOTAL row, in exact integer tcu. It is not the payload's
// rowsSumToHeader (rows vs header inside the ledger) and must not be confused
// with it, so both lines name what they compare.
function groupSumLine(deps, { rows, built, totalTcu }) {
  const { ctx, render } = deps;
  const P = ctx.pricing;
  const unknown = rows.filter((r) => r.usdTcu === null || r.usdTcu === undefined).length;
  if (totalTcu === null || totalTcu === undefined) {
    return `groups sum to TOTAL: — (this scope has no dollar total to compare against)`;
  }
  let sum = 0;
  for (const r of rows) sum += r.usdTcu ?? 0;
  const delta = sum - totalTcu;
  const what = `Σ ${rows.length} ${built.groupNoun}${rows.length === 1 ? '' : 's'} vs TOTAL, exact tcu, checked by this tool`;
  const tail = unknown > 0
    ? ` · ${unknown} group${unknown === 1 ? ' carries' : 's carry'} no dollar figure (rendered —: a model with no rate, or a group the index has not aggregated yet) and add${unknown === 1 ? 's' : ''} nothing to the Σ`
    : '';
  if (delta === 0) return `groups sum to TOTAL: ✓ (${what})${tail}`;
  const why = built.carries === 'band'
    ? ' — day bands exclude rows with no recorded timestamp and §3 embedded-sidechain rows, which the scope aggregate counts'
    : '';
  return `groups sum to TOTAL: delta ${render.fmtUsd(P, delta)} (${what})${tail}${why}`;
}

function renderDetail(deps, shown, built) {
  const { ctx, render } = deps;
  const { fmtUsd, fmtTokens, UNKNOWN } = render;
  const P = ctx.pricing;
  const out = [];
  out.push('detail (per group, recorded):');
  for (const r of shown) {
    out.push(`  ${r.name}`);
    if (r.usdSplit) out.push(`    usd: ${usdSplitLine(P, r.usdSplit, fmtUsd)}`);
    else out.push(`    usd: total ${fmtUsd(P, r.usdTcu)} (component split not carried by this source: ${r.source})`);
    if (r.tokens) out.push(`    tokens: ${tokenLine(r.tokens, fmtTokens)}`);
    else out.push(`    tokens: ${UNKNOWN} (not carried by ${r.source})`);
    if (r.model) out.push(`    model (recorded): ${r.model}`);
    if (r.label) out.push(`    label (recorded): ${r.label}`);
  }
  return out;
}

function usdSplitLine(P, usd, fmtUsd) {
  return `in ${fmtUsd(P, usd.input ?? null)} · out ${fmtUsd(P, usd.output ?? null)} · cacheWrite ${fmtUsd(P, usd.cacheWrite ?? null)} · cacheRead ${fmtUsd(P, usd.cacheRead ?? null)} · webSearch ${fmtUsd(P, usd.webSearch ?? null)} · total ${fmtUsd(P, usd.total ?? null)}`;
}

function tokenLine(t, fmtTokens) {
  return TOKEN_KEYS.map((k) => `${k} ${fmtTokens(t[k] ?? null)}`).join(' · ');
}

// The drill-down, named as a literal call. This is what stops an agent from
// reaching for Bash and a parse script for the next question.
function nextHints(s, shown) {
  const { scope, groupBy, dated } = s;
  const top = shown[0];
  const dates = dated ? `${s.since ? ` since="${s.since}"` : ''}${s.until ? ` until="${s.until}"` : ''}` : '';
  const hints = [];
  if (groupBy === 'project' && top) {
    hints.push(dated
      ? `lens_usage scope="project:${top.name}" group_by="day"${dates}`
      : `lens_usage scope="project:${top.name}" group_by="session"`);
  } else if (groupBy === 'session' && top) {
    hints.push(`lens_usage scope="session:${top.name}" group_by="model"`);
    hints.push(`lens_session slug="${String(top.name).split('/')[0]}" id="${String(top.name).split('/').slice(1).join('/')}"`);
  } else if (groupBy === 'model' && scope.kind === 'session') {
    hints.push(`lens_usage scope="session:${scope.slug}/${scope.id}" group_by="agent"`);
    hints.push(`lens_session slug="${scope.slug}" id="${scope.id}"`);
  } else if (groupBy === 'model' && (scope.kind === 'turn' || scope.kind === 'agent')) {
    // Inside a session already. This used to offer `lens_rows scope="…"` — the
    // row index of this exact slice — but lens_rows is phase 2 and this server
    // does not register it, so the hint read as callable and dead-ended. What
    // it can answer instead: the structure this slice sits inside, and the
    // session's own per-agent split.
    hints.push(`lens_session slug="${scope.slug}" id="${scope.id}"`);
    hints.push(`lens_usage scope="session:${scope.slug}/${scope.id}" group_by="agent"`);
  } else if (groupBy === 'agent' && top) {
    // Same rewrite: the agentId stays addressable, through a tool that exists.
    hints.push(`lens_usage scope="agent:${scope.slug}/${scope.id}/${top.name}" group_by="model"`);
  } else if (groupBy === 'day') {
    hints.push(scope.kind === 'store'
      ? `lens_usage scope="store" group_by="project"${dates}`
      : `lens_usage scope="${s.scopeRaw}" group_by="session"`);
  } else if (scope.kind === 'store') {
    hints.push('lens_usage scope="store" group_by="project"');
  }
  if (dated) hints.push(`lens_usage scope="${s.scopeRaw}" group_by="${scope.kind === 'session' ? 'model' : 'session'}"   (no dates — restores requests, the model split and the counters)`);
  // The per-component USD split ships ONLY under group_by="none" with
  // detail:true, and until this line existed nothing on any other grouping said
  // so — a figure the tool has and never offers is a figure the caller writes a
  // script for. Dates are deliberately not carried into the hint: the split is
  // not day-partitioned (day bands carry one dollar total), so a dated call
  // cannot answer it.
  if (groupBy !== 'none' || !s.detail) {
    hints.push(`lens_usage scope="${s.scopeRaw}" group_by="none" detail=true   (per-component USD split: in/out/cacheWrite/cacheRead/webSearch${dated ? ' — whole scope; not day-partitioned' : ''})`);
  }
  if (!hints.length) hints.push('lens_status');
  return `next: ${hints.join('\n      ')}`;
}

// ---------------------------------------------------------------- structured

// Opt-in machine-readable output (`structured: true`). Money is exact integer
// tcu here, never a rounded dollar string: a caller post-processing this is
// the one caller that needs the unrounded figure.
function structuredJson(deps, { scope, agg, view, groupBy, since, until, dated, built, limit, sort }) {
  const { lens } = deps;
  const { rows, emptyCount } = partitionRows(built.rows, sort, groupBy);
  const shown = rows.slice(0, limit);
  return {
    scope: lens.api.scopeString(scope),
    scopeKind: scope.kind,
    groupBy,
    since: since ?? null,
    until: until ?? null,
    dated,
    sort,
    limit,
    source: built.carries,
    total: {
      requests: built.total.requests,
      tokens: built.total.tokens,
      usdTcu: built.total.usdTcu, // integer tcu; USD = tcu / 2e9
      // The component split OF `usdTcu`, when the source carries one. `null` on
      // every date-filtered result: day bands record one dollar total per day
      // and no split, so a split of the range does not exist. It is NOT filled
      // from `agg` below — that is the whole scope's, and pairing it with a
      // range subtotal is exactly the defect this field replaced.
      usd: built.totalUsdSplit ?? null,
      usdSplitUnavailable: built.totalUsdSplit ? null : (built.totalUsdSplitWhy ?? null),
    },
    // Present only for the undated day grouping, where `total` is Σ day bands
    // and this is the scope's ledger aggregate over every day.
    scopeTotal: built.scopeTotal ?? null,
    groupCount: rows.length,
    shownCount: shown.length,
    // Of `groupCount`, how many carried NO aggregate at all. A structured
    // caller summing `groups[].usdTcu` gets the same at-least the coverage
    // line discloses in prose, and this is how it learns that it did.
    unknownGroupCount: unknownGroupCount(rows),
    // Groups that recorded nothing, collapsed out of `groups` — a provable
    // zero, counted rather than listed.
    emptyGroupCount: emptyCount,
    groups: shown.map((r) => ({
      name: r.name,
      label: r.label ?? null,
      requests: r.requests,
      tokens: r.tokens,
      usdTcu: r.usdTcu,
      usd: r.usdSplit ?? null,
      turnCount: r.turnCount ?? null,
      sessionsTouched: r.sessionsTouched ?? null,
      model: r.model ?? null,
      modelSource: r.modelSource ?? null,
      source: r.source,
    })),
    covers: built.covers,
    rowsSumToHeader: view.rowsSumToHeader ?? null,
    agg, // the scope's FULL CostAgg as the payload shipped it (null when none)
    // …and it is the WHOLE scope's, over every recorded day, even when `since`
    // /`until` narrowed `total` above. False here is the machine-readable form
    // of the "(whole scope, not the date range)" label the text prints, and it
    // is why a structured caller must not read `agg.usd` as the range's cost.
    aggCoversDateRange: !dated,
    pricingVersion: lens.pricing.PRICING_VERSION,
    indexVersion: lens.store.INDEX_VERSION,
  };
}
