// server/api/routes-project.mjs — /api/project/:slug (the memoized project
// slice of the index view) and /api/records (billed rows for any scope, with
// the server-computed rows-sum-to-header verdict).

import { httpError } from '../errors.mjs';
import { sendJson } from '../http.mjs';
import { ROWS_PAGE_DEFAULT, ROWS_PAGE_MAX } from '../limits.mjs';
import { parseScope, scopeString } from './scope.mjs';
import { intParam } from './params.mjs';
import { requireIndex, scopeSessionList, slugEq } from './session-lookup.mjs';
import { makeBands, bandsFromRows, bandsFromLite, finishBands } from './bands.mjs';
import {
  getCanonical, r2State, priceRowTcu, rowsSumTcuOf, liteRowSumTcu, sumVerdict,
  turnRowPredicate, isAgentFile,
} from './costs.mjs';

export function registerProjectRoutes({ G }, ctx, { canonMemo, buildIndexView, projectSlice }) {
  G('/api/project/:slug', async (_req, res, { params }) => {
    requireIndex(ctx);
    const { slug } = params;
    if (!ctx.index.projects().some((p) => p.slug === slug)) {
      throw httpError(404, 'unknown-project', `no project ${slug}`);
    }
    // slice the (memoized) index view: sessions with aggs, project agg + label,
    // project-filtered dayBands + turnBars (SPEC §9 route table)
    const version = ctx.index.version();
    const view = await buildIndexView(version);
    const project = view.projects.find((p) => p.slug === slug);
    const cards = view.sessions.filter((c) => c.slug === slug);
    const turnBars = view.turnBars.filter((b) => b.slug === slug);
    // The per-project day walk is memoized on the index version (projectSlice)
    // for the same reason buildIndexView is: rebuilt from scratch it costs
    // seconds per request on a clock-skewed session.
    const { dayBands, rowsSumToHeader, problems: bandProblems } = await projectSlice(version, slug, async () => {
      const canonicalOf = getCanonical(ctx, canonMemo);
      const bandAcc = makeBands();
      let projRowSum = 0;
      let projRowSumComplete = true;
      for (const raw of ctx.index.cards().values()) {
        if (raw.slug !== slug) continue;
        const key = `${raw.slug}/${raw.id}`;
        if (raw.ledgerLite) {
          bandsFromLite(ctx, bandAcc, key, raw.id, raw.ledgerLite, canonicalOf);
          const s = liteRowSumTcu(ctx, raw, canonicalOf);
          if (s === null) projRowSumComplete = false; else projRowSum += s;
        } else {
          try {
            const rows = await ctx.index.rows(raw.slug, raw.id);
            bandsFromRows(ctx, bandAcc, key, raw.id, rows, canonicalOf);
            projRowSum += rowsSumTcuOf(ctx, rows, raw.id, canonicalOf);
          } catch { projRowSumComplete = false; /* pending — denominator discloses */ }
        }
      }
      const problems = [];
      return {
        dayBands: finishBands(bandAcc, turnBars, problems),
        rowsSumToHeader: project?.agg && projRowSumComplete
          ? sumVerdict(project.agg.usd.total, projRowSum)
          : null,
        problems,
      };
    });
    const fileTable = ctx.index.fileTable();
    const memory = [...fileTable.keys()]
      .filter((k) => k.startsWith(`${slug}/memory/`))
      .map((k) => ({ name: k.slice(`${slug}/memory/`.length), rel: `mem/${k.slice(`${slug}/memory/`.length)}`, ...fileTable.get(k) }));
    const fragments = ctx.index.sessions()
      .filter((s) => s.slug === slug && s.fragmentDirs && s.fragmentDirs.length)
      .map((s) => ({ id: s.id, fragmentDirs: s.fragmentDirs }));
    sendJson(res, 200, {
      project,
      agg: project?.agg ?? null,
      rowsSumToHeader,
      sessions: cards,
      turnBars,
      dayBands,
      memory, fragments,
      r2: r2State(ctx),
      problems: bandProblems,
    });
  });

  // ---------- records (billed rows for a scope)
  async function rowsForScope(scope) {
    const sessions = scopeSessionList(ctx, scope);
    const canonicalOf = getCanonical(ctx, canonMemo);
    const out = [];
    for (const s of sessions) {
      const rows = await ctx.index.rows(s.slug, s.id);
      for (const row of rows) {
        // billedElsewhere derived PURELY from canonicalOf here (aggregate()
        // never mutates rows, so there is no stale annotation to fall back
        // to). Same routing rule as aggregate(): only main-tier rows are
        // contestable; sidechain rows keep their channel.
        const contestable = row.embeddedSidechain !== true && !isAgentFile(row.file ?? '');
        const canonical = contestable ? canonicalOf.get(row.msgId) : undefined;
        const billedElsewhere = canonical !== undefined && canonical !== s.id ? { sessionId: canonical } : null;
        out.push({ ...row, slug: s.slug, sessionId: s.id, billedElsewhere });
      }
    }
    if (scope.kind === 'agent') {
      if (scope.agentId !== 'main') {
        // an unknown agentId is a 404 (SPEC §9 status table), never a
        // confident 200 with total 0 — validity = a transcript file exists
        // in the session's file set (the enumeration source, §7)
        const entry = ctx.index.sessions().find((s) => slugEq(s.slug, scope.slug) && s.id === scope.id);
        const known = (entry?.files ?? []).some((f) => String(f).endsWith(`agent-${scope.agentId}.jsonl`));
        if (!known) throw httpError(404, 'unknown-agent', `no agent ${scope.agentId} in ${scope.slug}/${scope.id}`);
      }
      return out.filter((r) => scope.agentId === 'main'
        ? !isAgentFile(r.file)
        : String(r.file).endsWith(`agent-${scope.agentId}.jsonl`));
    }
    if (scope.kind === 'turn') {
      const detail = await ctx.index.detail(scope.slug, scope.id);
      const turns = detail?.turns ?? [];
      if (scope.idx > turns.length - 1) throw httpError(404, 'unknown-turn', `turn ${scope.idx} is past the end`);
      // same predicate the per-turn CostAggs use (kept-line position on opener
      // boundaries; lineRange / time-window as the disclosed fallbacks)
      return out.filter(turnRowPredicate(detail, scope.idx));
    }
    return out;
  }

  G('/api/records', async (_req, res, { query }) => {
    requireIndex(ctx);
    const scope = parseScope(query.get('scope'));
    const from = intParam(query, 'from', { def: 0, min: 0 });
    const count = intParam(query, 'count', { def: ROWS_PAGE_DEFAULT, min: 1, max: ROWS_PAGE_MAX });
    const all = await rowsForScope(scope);
    const page = all.slice(from, from + count);
    // server-computed rows-sum-to-header in exact integer tcu (SPEC §9).
    // The header is aggregated PER SESSION — aggregate() needs each row's own
    // sessionId as the canonical authority; a null sessionId over a mixed row
    // set would misroute every canonical fork copy to `inherited` (both
    // comparisons pass) and the header would exclude money the rows carry.
    let headerTcu = 0;
    try {
      const canonicalOf = getCanonical(ctx, canonMemo);
      const bySession = new Map();
      for (const r of all) {
        let list = bySession.get(r.sessionId);
        if (!list) bySession.set(r.sessionId, list = []);
        list.push(r);
      }
      let combined = null;
      for (const [sid, group] of bySession) {
        const a = ctx.ledger.aggregate(group, { canonicalOf, sessionId: sid, priceRow: ctx.pricing.priceRow });
        combined = combined === null ? a : ctx.ledger.addCostAgg(combined, a);
      }
      headerTcu = combined?.usd?.total ?? 0;
    } catch {
      headerTcu = null; // group A absent — disclosed below
    }
    let rowSum = 0;
    for (const r of all) rowSum += priceRowTcu(ctx, r);
    const rowsSumToHeader = sumVerdict(headerTcu, rowSum);
    sendJson(res, 200, {
      scope: scopeString(scope), from, count: page.length, total: all.length,
      rows: page, rowsSumToHeader, r2: r2State(ctx), problems: [],
    });
  });
}
