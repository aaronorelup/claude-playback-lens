// server/api/routes-session.mjs — the session detail envelope and its
// children: /api/session/:slug/:id (+ /images, /files), /api/turn, /api/agent.
// Per-turn and per-agent CostAggs are derived read-time from the same row
// partition the summariser used, so session = Σ turns + channels holds exactly.

import { httpError } from '../errors.mjs';
import { sendJson } from '../http.mjs';
import { ROWS_PAGE_DEFAULT, ROWS_PAGE_MAX } from '../limits.mjs';
import { intParam } from './params.mjs';
import { sessionRelOf } from './fileref.mjs';
import { requireIndex, findSession } from './session-lookup.mjs';
import {
  getCanonical, r2State, forkPartnersOf, forkedBadgeOf,
  rowsSumTcuOf, sumVerdict, turnRowPredicate, isAgentFile,
} from './costs.mjs';

export function registerSessionRoutes({ G }, ctx, { canonMemo, dupMemo }) {
  G('/api/session/:slug/:id', async (_req, res, { params }) => {
    requireIndex(ctx);
    const card = findSession(ctx, params.slug, params.id);
    const detail = await ctx.index.detail(params.slug, params.id);
    if (!detail) throw httpError(404, 'unknown-session', `no session ${params.slug}/${params.id}`);
    // strip the cache-only bulk (ledgerLite, R2 msgId sets) AND the two
    // on-demand lists from the HTTP payload (SPEC §9 payload discipline):
    // images[] and filesLedger[] ship from their own endpoints; counts stay.
    const { ledgerLite, mainMsgIds, foreignMsgIds, images, filesLedger, ...detailOut } = detail;
    detailOut.imagesTotal = Array.isArray(images) ? images.length : null;
    detailOut.filesLedgerTotal = Array.isArray(filesLedger) ? filesLedger.length : null;
    let agg = null;
    let rowsSumToHeader = null;
    let turnsOut = detailOut.turns ?? [];
    let agentsOut = detailOut.agents ?? [];
    let sessionRows = null; // the loaded rows, for forkPartnersOf's billing evidence
    try {
      // the parsed session's rows are resident at this point (LRU); per-turn
      // and per-agent CostAggs are derived read-time from the same partition
      // the summariser used, so session = Σ turns + channels holds exactly
      const rows = await ctx.index.rows(params.slug, params.id);
      sessionRows = rows;
      const opts = {
        canonicalOf: getCanonical(ctx, canonMemo),
        sessionId: params.id,
        priceRow: ctx.pricing.priceRow,
      };
      agg = ctx.ledger.aggregate(rows, opts);
      rowsSumToHeader = sumVerdict(agg?.usd?.total ?? null, rowsSumTcuOf(ctx, rows, params.id, opts.canonicalOf));
      turnsOut = (detail.turns ?? []).map((t) => {
        const pred = turnRowPredicate(detail, t.idx);
        return { ...t, agg: ctx.ledger.aggregate(rows.filter(pred), opts) };
      });
      agentsOut = (detail.agents ?? []).map((a) => ({
        ...a,
        agg: ctx.ledger.aggregate(rows.filter((r) => String(r.file).endsWith(`agent-${a.agentId}.jsonl`)), opts),
      }));
    } catch { /* aggs stay null with r2 pending disclosure */ }
    // forkPartners — every session sharing a duplicated msgId with this one,
    // with exact billed-here/billed-there counts (R2). {} is a real "no fork
    // partners"; null means the counts are not derivable yet (index still
    // building, or this session's billing evidence is not loaded).
    const forkPartners = forkPartnersOf(ctx, canonMemo, dupMemo, params.id, sessionRows);
    // Badge parity: /api/index OR's the `forked` badge in at read time
    // (cardOut); the detail payload must agree, or L1's table tags a session
    // its own L2 page does not. Same helper, and the SAME msgId list cardOut
    // reads (the card's) — the detail's copy is only the fallback, so the two
    // routes cannot drift apart.
    const contested = getCanonical(ctx, canonMemo);
    // Re-read the card AFTER detail()/rows() resolved: the index layer
    // reparses on a rowsStore miss (exactly the state a worker `stale`
    // message leaves behind: rowsStore/details dropped, the old card KEPT)
    // and a reparse replaces ctx.index.cards()'s entry with a fresh object —
    // the `card` captured at the top of this handler for the 404/409 guard is
    // the pre-reparse object, so reading its mainMsgIds here would disclose
    // the badge and the R2-pending chip off a stale msgId list. forkPartnersOf
    // already re-fetches the same way (cards() is keyed by bare sessionId), so
    // the two stay in step.
    const liveCard = ctx.index.cards().get(params.id) ?? card;
    const msgIds = liveCard?.mainMsgIds ?? mainMsgIds;
    const badgesOut = forkedBadgeOf(detailOut.badges, msgIds, contested);
    if (badgesOut !== detailOut.badges) detailOut.badges = badgesOut;
    // R2 pending (SPEC) — while the index builds, a session whose main tier
    // already intersects a DETECTED duplicate group flags inheritedPending,
    // which is what lights the client's R2-pending chip on this payload's own
    // CostAgg. forkPartnersOf cannot serve this: it withholds everything
    // until R2 resolves, which is the whole point.
    if (agg && r2State(ctx) !== 'resolved' && Array.isArray(msgIds)
      && msgIds.some((mid) => contested.has(mid))) {
      agg.inheritedPending = true;
    }
    sendJson(res, 200, {
      ...detailOut, turns: turnsOut, agents: agentsOut,
      agg, forkPartners, rowsSumToHeader, r2: r2State(ctx), problems: detail.problems ?? [],
    });
  });

  // ---------- session images / files (on-demand lists, split off the detail)
  G('/api/session/:slug/:id/images', async (_req, res, { params }) => {
    requireIndex(ctx);
    findSession(ctx, params.slug, params.id);
    const detail = await ctx.index.detail(params.slug, params.id);
    if (!detail) throw httpError(404, 'unknown-session', `no session ${params.slug}/${params.id}`);
    // rels are SESSION-RELATIVE so each locator feeds /api/image directly
    // (the guard requires the SPEC §9 rel grammar; store-relative rels 403).
    const images = (detail.images ?? []).map((im) => ({
      ...im, file: sessionRelOf(params.slug, params.id, im.file),
    }));
    sendJson(res, 200, {
      slug: params.slug, id: params.id,
      images, total: images.length, problems: [],
    });
  });

  G('/api/session/:slug/:id/files', async (_req, res, { params }) => {
    requireIndex(ctx);
    findSession(ctx, params.slug, params.id);
    const detail = await ctx.index.detail(params.slug, params.id);
    if (!detail) throw httpError(404, 'unknown-session', `no session ${params.slug}/${params.id}`);
    const filesLedger = detail.filesLedger ?? [];
    sendJson(res, 200, {
      slug: params.slug, id: params.id,
      filesLedger, total: filesLedger.length,
      denominators: detail.inventory?.filesLedgerDenominators ?? null,
      problems: [],
    });
  });

  G('/api/turn/:slug/:id/:idx', async (_req, res, { params, query }) => {
    requireIndex(ctx);
    findSession(ctx, params.slug, params.id);
    const idx = Number(params.idx);
    if (!Number.isInteger(idx) || idx < 0) throw httpError(400, 'bad-param', 'turn idx must be a non-negative integer');
    const detail = await ctx.index.detail(params.slug, params.id);
    if (!detail) throw httpError(404, 'unknown-session', `no session ${params.slug}/${params.id}`);
    const turns = detail.turns ?? [];
    if (idx > turns.length - 1) throw httpError(404, 'unknown-turn', `turn ${idx} is past the end (${turns.length - 1})`);
    let turn = turns[idx];
    const agentIds = new Set(turn.agentIds ?? []);
    let agents = (detail.agents ?? []).filter((a) => agentIds.has(a.agentId) || a.turnIdx === idx);
    const runIds = new Set(turn.workflowRunIds ?? []);
    const workflows = (detail.workflows ?? []).filter((w) => runIds.has(w.runId));
    let agg = null;
    let rowsSumToHeader = null;
    try {
      const rows = await ctx.index.rows(params.slug, params.id);
      const opts = {
        canonicalOf: getCanonical(ctx, canonMemo),
        sessionId: params.id,
        priceRow: ctx.pricing.priceRow,
      };
      const turnRows = rows.filter(turnRowPredicate(detail, idx));
      agg = ctx.ledger.aggregate(turnRows, opts);
      rowsSumToHeader = sumVerdict(agg?.usd?.total ?? null, rowsSumTcuOf(ctx, turnRows, params.id, opts.canonicalOf));
      turn = { ...turn, agg };
      agents = agents.map((a) => ({
        ...a,
        agg: ctx.ledger.aggregate(rows.filter((r) => String(r.file).endsWith(`agent-${a.agentId}.jsonl`)), opts),
      }));
    } catch { /* aggs stay null while pending */ }
    // main-thread row index for the turn (SPEC §9: "turn slice: main-thread
    // row index (no text)") — the turn's slice of the main rows partitioned
    // on opener-line boundaries, the same rule the billed-row predicate uses.
    // Optional ?from&count page the index; the default ships it whole (row
    // heads are ≤220 chars).
    let rowsOut = null;
    let rowsTotal = null;
    try {
      const main = await ctx.index.agentRows(params.slug, params.id, 'main', { from: 0, count: Number.MAX_SAFE_INTEGER });
      if (main && Array.isArray(main.rows)) {
        const openers = turns
          .filter((t) => !t.preamble && t.openerLine != null)
          .map((t) => ({ idx: t.idx, line: t.openerLine }));
        const turnOfLine = (line) => {
          let k = 0;
          for (const o of openers) { if (o.line <= line) k = o.idx; else break; }
          return k;
        };
        const mine = main.rows.filter((r) => typeof r.line === 'number' && turnOfLine(r.line) === idx);
        rowsTotal = mine.length;
        const from = intParam(query, 'from', { def: 0, min: 0 });
        const count = intParam(query, 'count', { def: mine.length, min: 1, max: mine.length || 1 });
        rowsOut = mine.slice(from, from + count);
      }
    } catch { /* rows stay null (unknown) while the model is pending */ }
    sendJson(res, 200, {
      slug: params.slug, id: params.id, turn, agents, workflows, agg,
      rows: rowsOut, rowsTotal, turnCount: Math.max(0, turns.length - 1),
      rowsSumToHeader, r2: r2State(ctx), problems: [],
    });
  });

  G('/api/agent/:slug/:id/:agentId', async (_req, res, { params, query }) => {
    requireIndex(ctx);
    findSession(ctx, params.slug, params.id);
    const from = intParam(query, 'from', { def: 0, min: 0 });
    const count = intParam(query, 'count', { def: ROWS_PAGE_DEFAULT, min: 1, max: ROWS_PAGE_MAX });
    const out = await ctx.index.agentRows(params.slug, params.id, params.agentId, { from, count });
    if (!out) throw httpError(404, 'unknown-agent', `no agent ${params.agentId} in ${params.slug}/${params.id}`);
    let agg = null;
    let rowsSumToHeader = null;
    try {
      const rows = await ctx.index.rows(params.slug, params.id);
      const mine = params.agentId === 'main'
        ? rows.filter((r) => !isAgentFile(r.file))
        : rows.filter((r) => String(r.file).endsWith(`agent-${params.agentId}.jsonl`));
      const canonicalOf = getCanonical(ctx, canonMemo);
      agg = ctx.ledger.aggregate(mine, {
        canonicalOf,
        sessionId: params.id,
        priceRow: ctx.pricing.priceRow,
      });
      rowsSumToHeader = sumVerdict(agg?.usd?.total ?? null, rowsSumTcuOf(ctx, mine, params.id, canonicalOf));
    } catch { /* agg stays null while pending */ }
    sendJson(res, 200, { ...out, agg, rowsSumToHeader, r2: r2State(ctx), problems: out.problems ?? [] });
  });
}
