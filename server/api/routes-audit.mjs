// server/api/routes-audit.mjs — /api/audit, the SSE A/B reconciliation
// stream. Owns Path A (the index's own aggregates, built from live values,
// never SPEC snapshot numbers); Path B is server/audit.mjs's independent walk.

import { sseOpen } from '../http.mjs';
import { problem } from '../errors.mjs';
import { runAudit } from '../audit.mjs';
import { SSE_HEARTBEAT_MS } from '../limits.mjs';
import { parseScope } from './scope.mjs';
import { requireIndex, scopeSessionList, slugEq } from './session-lookup.mjs';
import { getCanonical, zeroTokens, addTok, turnRowPredicate, isAgentFile } from './costs.mjs';

export function registerAuditRoutes({ G }, ctx, { canonMemo }) {
  async function buildPathA(scope) {
    const st = ctx.index.status();
    if (st.state !== 'ready') return null;
    let sessions;
    try { sessions = scopeSessionList(ctx, scope); } catch { return null; }
    const canonicalOf = getCanonical(ctx, canonMemo);
    const fileTable = ctx.index.fileTable();
    const out = {
      sessions: {},
      totals: { requests: 0, usdTotal: 0, tokens: zeroTokens() },
      fileCensus: { files: 0, bytes: 0 },
      agentCount: 0,
    };
    // File-scope membership honours the sessions' FULL file sets (SPEC §2: a
    // session is keyed by sessionId alone — its fragment dirs can live under
    // other project dirs), so Path A's census covers the same set Path B walks.
    const sessionsAll = ctx.index.sessions();
    const claimedBy = new Map(); // rel -> owning slug
    for (const s of sessionsAll) for (const rel of s.files ?? []) claimedBy.set(rel, s.slug);
    const scopedEntry = scope.kind === 'session' || scope.kind === 'turn' || scope.kind === 'agent'
      ? sessionsAll.find((s) => slugEq(s.slug, scope.slug) && s.id === scope.id) ?? null
      : null;
    const scopedFiles = scopedEntry
      ? new Set(scopedEntry.files ?? [])
      : null;
    const inScopeKey = (k) => {
      if (scope.kind === 'store') return true;
      if (scope.kind === 'project') {
        const owner = claimedBy.get(k);
        return owner !== undefined ? owner === scope.slug : k.startsWith(`${scope.slug}/`);
      }
      if (scopedFiles) return scopedFiles.has(k);
      return k === `${scope.slug}/${scope.id}.jsonl` || k.startsWith(`${scope.slug}/${scope.id}/`);
    };
    for (const [k, v] of fileTable) {
      if (!inScopeKey(k)) continue;
      out.fileCensus.files += 1;
      out.fileCensus.bytes += v.size;
      if (/\/subagents\/(?:workflows\/[^/]+\/)?agent-a[0-9a-f]{16}\.jsonl$/.test(k)) out.agentCount += 1;
    }
    // Per-session figures + the SPEC §10 headline expectations, all from Path
    // A's own aggregates (live values, never the SPEC snapshot numbers):
    //   neverFinalized / synthetic censuses, the (speed, service_tier) pair
    //   census (from the billed rows' recorded *Absent flags), Σ agents over
    //   turns, and session = Σ turns + channels (the leak detector).
    const expectations = { neverFinalized: 0, synthetic: 0 };
    const pairCensus = new Map();
    let turnAgentSum = 0;
    let haveTurnData = true;
    const sessionSum = { pass: true, failures: [] };
    for (const s of sessions) {
      try {
        const rows = await ctx.index.rows(s.slug, s.id);
        const opts = { canonicalOf, sessionId: s.id, priceRow: ctx.pricing.priceRow };
        const agg = ctx.ledger.aggregate(rows, opts);
        const rec = { requests: agg.requests, usdTotal: agg.usd.total, tokens: agg.tokens };
        out.sessions[`${s.slug}/${s.id}`] = rec;
        out.totals.requests += rec.requests;
        out.totals.usdTotal += rec.usdTotal;
        addTok(out.totals.tokens, agg.tokens);
        expectations.neverFinalized += agg.neverFinalized ?? 0;
        expectations.synthetic += agg.synthetic ?? 0;
        for (const r of rows) {
          if (r.iterIndex != null && r.iterIndex !== 0) continue; // one census entry per R1-kept line
          const sp = r.speedAbsent === true ? 'ABSENT' : (r.speed === null || r.speed === undefined ? 'null' : String(r.speed));
          const tr = r.serviceTierAbsent === true ? 'ABSENT' : (r.serviceTier === null || r.serviceTier === undefined ? 'null' : String(r.serviceTier));
          const k = `${sp}|${tr}`;
          pairCensus.set(k, (pairCensus.get(k) ?? 0) + 1);
        }
        let detail = null;
        try { detail = await ctx.index.detail(s.slug, s.id); } catch { detail = null; }
        if (detail && Array.isArray(detail.turns)) {
          let reqSum = 0;
          let usdSum = 0;
          for (const t of detail.turns) {
            const ta = ctx.ledger.aggregate(rows.filter(turnRowPredicate(detail, t.idx)), opts);
            reqSum += ta.requests;
            usdSum += ta.usd.total;
            turnAgentSum += (t.agentIds ?? []).length;
          }
          if (reqSum !== agg.requests || usdSum !== agg.usd.total) {
            sessionSum.pass = false;
            sessionSum.failures.push(`${s.slug}/${s.id}`);
          }
        } else {
          haveTurnData = false;
        }
      } catch { return null; /* incomplete — Path A withheld rather than wrong */ }
    }
    // agent scope: Path B narrows billing to the one transcript while these
    // whole-session figures cannot — withhold the whole-session expectations
    // there rather than assert a mismatch that is really a scope difference.
    if (scope.kind !== 'agent') {
      out.expectations = { ...expectations, pairCensus: Object.fromEntries([...pairCensus.entries()].sort()) };
      if (haveTurnData) {
        out.turnAgentSum = turnAgentSum;
        out.sessionSum = sessionSum;
      }
    }
    if (scope.kind !== 'store' && scope.kind !== 'project') {
      // disclose inherited msgIds so Path B's session-scope R2 can honour them
      const s = sessions[0];
      const rows = await ctx.index.rows(s.slug, s.id);
      const inheritedMsgIds = [];
      let canonicalSessionId = null;
      for (const r of rows) {
        const contestable = !isAgentFile(r.file ?? '');
        const canon = contestable ? canonicalOf.get(r.msgId) : undefined;
        if (canon !== undefined && canon !== s.id) { inheritedMsgIds.push(r.msgId); canonicalSessionId = canon; }
      }
      if (inheritedMsgIds.length) out.r2Inherited = { msgIds: inheritedMsgIds, canonicalSessionId };
    }
    return out;
  }

  G('/api/audit', async (req, res, { query }) => {
    requireIndex(ctx);
    const scope = parseScope(query.get('scope'));
    if (scope.kind !== 'store') scopeSessionList(ctx, scope); // 404 before the stream opens
    // open the stream BEFORE building Path A: Path A over a large scope can
    // take seconds, and the client needs the heartbeat/progress channel alive
    const stream = sseOpen(res, { heartbeatMs: ctx.heartbeatMs ?? SSE_HEARTBEAT_MS });
    const ac = new AbortController();
    stream.onClientClose(() => ac.abort());
    const pathA = await buildPathA(scope);
    if (!pathA) {
      stream.event('problem', problem('usage-reconcile', {
        severity: 'note', scope: 'store',
        message: 'Path A unavailable (index still building) — Path B runs alone; re-run when ready for the A/B table',
        affects: 'display',
      }));
    }
    try {
      await runAudit({
        projectsDir: ctx.projectsDir,
        scope,
        pricing: ctx.pricing,
        pathA,
        emit: (ev, data) => stream.event(ev, data),
        signal: ac.signal,
      });
    } catch (e) {
      stream.event('error', { code: 'audit-failed', message: String(e && e.message) });
    }
    stream.close();
  });
}
