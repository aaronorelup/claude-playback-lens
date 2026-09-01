// mcp/tools/sessions.mjs — lens_sessions.
//
// The addressing layer. Nothing else on this server is callable without a
// `slug` + `id`, and this is where an agent gets them: "that session last
// Tuesday about the parser" -> a locator every other lens tool accepts.
//
// Source of truth is one route, chosen by whether `project` was given:
//
//   no project  ->  GET /api/index      -> sessions[] (SessionCard + LITE agg)
//   project     ->  GET /api/project/:slug -> sessions[] (same cards, same LITE agg)
//
// Both ship the same SessionCard shape (SPEC §9), so the filtering, sorting
// and rendering below are identical on either branch; only the scope label,
// the scope-wide total and its denominator differ.
//
// EVERY filter here reads a RECORDED card field. Nothing is derived, inferred
// or reconstructed:
//
//   since/until    startedAt / endedAt   (epoch ms, host-local calendar day)
//   title_contains title, aiTitle, customTitle
//   cwd_contains   cwd
//   branch         branch
//   min_usd        agg.usd.total         (integer tcu; USD = tcu / TCU_PER_USD)
//   has            agentCount, workflowCount, images
//   badges         badges[]
//
// One filter from the KAN-106 §6.3 sketch is deliberately ABSENT: `has:
// "problems"`. See NOT-IMPLEMENTED below — there is no recorded per-card field
// it could stand on, and standing it on a reconstruction would be exactly the
// inference this server exists not to do.
//
// NOT-IMPLEMENTED: has:"problems".
//   cardOut() in the lens's server/api/index-view.mjs strips `problems` from
//   every card before it ships ("`problems` is cache-only card state"), and
//   SPEC §9's SessionCard does not list it. The store-level `problems[]` on
//   /api/index is a census whose records carry `file` and, only sometimes,
//   `slug`/`id` — attributing one to a session would mean reconstructing
//   session identity from a file path, and would silently miss every problem
//   recorded against an agent transcript or a workflow file. A filter that
//   quietly returns an under-set is worse than an absent one, so the enum
//   value is not offered. `lens_status` prints the store-wide problems census;
//   `lens_session` ships a session's own problems[].

import { z } from 'zod';

// The shared helpers this file needs at module scope. The rest arrive through
// the `render` namespace on deps, which is the same module.
import { dayNumOfMs, dayNumOfLabel, descUnknownLast, groupInt, r2Pending, TOKEN_KEYS } from '../render.mjs';

const DESCRIPTION = 'List Claude Code sessions with their locators, timings, turn/agent counts and cost — filtered by project, date, working directory, git branch, recorded title, or minimum cost. This is how you turn "that session last Tuesday about the parser" into the `slug` + `id` every other lens tool needs. Returns one compact line per session, newest first. It does NOT search transcript text — use `lens_search` for that. Read-only.';

// The recorded badge vocabulary, verbatim from the lens's summary.mjs. Every
// one is a recorded fact about the session; none is computed here.
const BADGES = ['fragment', 'forked', 'no-reply', 'retried', 'running', 'cached', 'live'];

// `has` -> the recorded card counter it tests. The map IS the contract: a key
// with no recorded counter cannot be added to it, which is why "problems" is
// not here.
const HAS_FIELD = { agents: 'agentCount', workflows: 'workflowCount', images: 'images' };

export function register(server, deps) {
  const { ctx, call, render } = deps;

  server.registerTool(
    'lens_sessions',
    {
      title: 'Find sessions',
      description: DESCRIPTION,
      inputSchema: z.object({
        project: z.string().optional()
          .describe('Project slug (the directory name under the corpus root, e.g. "claude-playback-lens"). Omit for all projects.'),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Inclusive start date, YYYY-MM-DD in the server host\'s local calendar (the same calendar as dayBands). A session matches when its RECORDED span — startedAt to endedAt — touches the window on or after this day. A session with no recorded startedAt cannot be tested and is excluded, with the count disclosed.'),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Inclusive end date, YYYY-MM-DD in the server host\'s local calendar. A session matches when its RECORDED startedAt falls on or before this day.'),
        title_contains: z.string().optional()
          .describe('Case-insensitive substring of the RECORDED title — any of title, aiTitle or customTitle. Not a transcript search; use lens_search for that.'),
        cwd_contains: z.string().optional()
          .describe('Case-insensitive substring of the recorded working directory. A session with no recorded cwd never matches.'),
        branch: z.string().optional()
          .describe('Exact recorded git branch. A session with no recorded branch never matches.'),
        min_usd: z.number().min(0).optional()
          .describe('Only sessions whose recorded cost is at least this many US dollars. A session whose cost is not computable (agg unknown) is excluded, with the count disclosed — unknown is never treated as 0.'),
        has: z.array(z.enum(['agents', 'workflows', 'images'])).optional()
          .describe('Only sessions whose recorded counts for ALL of these are > 0: agents -> agentCount, workflows -> workflowCount, images -> images. ("problems" is not offered: it is not a recorded card field — see lens_status for the problems census.)'),
        badges: z.array(z.enum(BADGES)).optional()
          .describe('Only sessions carrying ALL of these recorded badges. fragment = no main transcript; forked = shares a message.id with another session; no-reply = last turn got no assistant reply; retried = a retried request is recorded; running = an agent or workflow is recorded running; cached = a cached agent is recorded; live = the session is still being written.'),
        sort: z.enum(['recent', 'cost', 'turns', 'bytes']).default('recent')
          .describe('recent = recorded startedAt, newest first (the lens UI\'s own order). cost = recorded cost, largest first, sessions with no computable cost last. turns = recorded turnCount. bytes = recorded transcript bytes.'),
        limit: z.number().int().min(1).max(200).default(20)
          .describe('Session lines to render.'),
        offset: z.number().int().min(0).default(0)
          .describe('Session lines to skip, over the filtered and sorted list. Paging is arithmetic over that list, and the header states both ends.'),
        structured: z.boolean().default(false)
          .describe('Also return the machine-readable JSON as structuredContent.'),
      }),
      // Every tool on this server is a reader. openWorldHint is false because
      // the whole answer comes from files already on this disk.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const a = args || {};
      const structured = a.structured === true;

      // ---- source route -------------------------------------------------
      const byProject = typeof a.project === 'string' && a.project.length > 0;
      const path = byProject ? `/api/project/${encodeURIComponent(a.project)}` : '/api/index';
      const r = await call('GET', path);

      // A pending index is a STATE, not an error: the answer exists in a few
      // seconds and an agent can act on "retry in 2s". An exception it cannot.
      if (r.status === 409) {
        return render.structuredWrap(render.pendingResult(r.json), r.json, structured);
      }
      if (r.status === 404) {
        return render.errorResult(render.httpMessage(r, {
          tool: 'lens_sessions',
          where: path,
          // The generic 404 way out is "call lens_sessions" — which is this
          // tool. The actionable move here is dropping the one filter that
          // addresses something.
          also: 'Re-run lens_sessions without `project` to list sessions across every project; each line names the slug that project is addressed by.',
        }));
      }
      if (r.status !== 200 || !r.json) {
        return render.errorResult(render.httpMessage(r, { tool: 'lens_sessions', where: path }));
      }

      const view = r.json;
      const cards = Array.isArray(view.sessions) ? view.sessions : [];

      // ---- filter -------------------------------------------------------
      const { kept, excluded } = applyFilters(cards, a, ctx.pricing);

      // ---- sort ---------------------------------------------------------
      sortCards(kept, a.sort || 'recent');

      // ---- page ---------------------------------------------------------
      const offset = Number.isInteger(a.offset) ? a.offset : 0;
      const limit = Number.isInteger(a.limit) ? a.limit : 20;
      const shown = kept.slice(offset, offset + limit);

      const text = renderSessions({
        ctx, render, view, byProject,
        project: a.project ?? null,
        args: a, cards, kept, shown, excluded, offset, limit,
      });

      const json = {
        scope: byProject ? `project:${a.project}` : 'store',
        filters: filterEcho(a),
        sort: a.sort || 'recent',
        limit,
        offset,
        matched: kept.length,
        inScope: cards.length,
        excluded,
        sessions: shown,
        scopeAgg: view.agg ?? null,
        aggScope: view.aggScope ?? null,
        rowsSumToHeader: view.rowsSumToHeader ?? null,
        // R2 comes off the FETCHED VIEW at both scopes. The raw index status
        // (ctx.index.status()) has no `r2` field at all — the lens attaches it
        // in server/api/index-view.mjs (`status: { ...status, r2: r2State(ctx) }`),
        // so it exists only on what the route shipped. Reading the raw status
        // here made store-scope r2 permanently null, which is not the same fact
        // as 'resolved' and made the pending footer below unreachable.
        r2: byProject ? (view.r2 ?? null) : ((view.status && view.status.r2) ?? null),
      };
      return render.structuredWrap(
        render.textResult(render.capText(text, { narrow: 'limit' })),
        json,
        structured,
      );
    },
  );
}

// ------------------------------------------------------------------ filtering

/**
 * applyFilters(cards, args, pricing) -> { kept, excluded }
 *
 * `excluded` counts the sessions a filter could not TEST rather than could not
 * match — a session with no recorded startedAt tested against `since`, or one
 * whose cost is not computable tested against `min_usd`. Those two are
 * reported as their own line: dropping a session because a fact is missing is
 * a different event from dropping it because the fact did not match, and
 * collapsing them would let an unknown masquerade as a no.
 */
function applyFilters(cards, a, pricing) {
  const excluded = { noStartDate: 0, noCost: 0 };

  const sinceNum = a.since ? dayNumOfLabel(a.since) : null;
  const untilNum = a.until ? dayNumOfLabel(a.until) : null;
  const title = a.title_contains ? a.title_contains.toLowerCase() : null;
  const cwd = a.cwd_contains ? a.cwd_contains.toLowerCase() : null;
  const has = Array.isArray(a.has) ? a.has : [];
  const badges = Array.isArray(a.badges) ? a.badges : [];

  // USD -> integer tcu, through the lens's own constant rather than a literal
  // 2e9 copied into this file. Costs are compared in tcu, never in rounded
  // dollars: `min_usd: 0.0001` must not admit a row that rounds up to it.
  //
  // The product is SNAPPED to an integer when it lands within a few ulp of
  // one. Recorded costs are integer tcu, but `min_usd` arrives as a float
  // dollar amount, and float × 2e9 can overshoot the integer the caller meant:
  // `61 / TCU_PER_USD * TCU_PER_USD === 61.00000000000001`. Without the snap a
  // session costing EXACTLY min_usd fails `tcu >= minTcu` and is dropped, which
  // contradicts the schema's own "at least this many US dollars". The snap is
  // deliberately narrow — a genuinely fractional threshold stays fractional, so
  // `min_usd: 0.0001` still refuses a row that only rounds up to it.
  const minTcu = typeof a.min_usd === 'number'
    ? snapToInt(a.min_usd * (pricing?.TCU_PER_USD ?? 2e9))
    : null;

  const kept = [];
  for (const c of cards) {
    // Dates. The window test is an INTERSECTION of the session's recorded span
    // with [since, until]: a session that opened before `since` and was still
    // being written inside the window is in the window. Both ends are the
    // host's local calendar day, matching dayBands (SPEC §9).
    if (sinceNum !== null || untilNum !== null) {
      const startMs = num(c.startedAt);
      if (startMs === null) { excluded.noStartDate += 1; continue; }
      const endMs = num(c.endedAt) ?? startMs;
      if (untilNum !== null && dayNumOfMs(startMs) > untilNum) continue;
      if (sinceNum !== null && dayNumOfMs(endMs) < sinceNum) continue;
    }

    if (title !== null) {
      const hay = [c.title, c.aiTitle, c.customTitle]
        .filter((t) => typeof t === 'string')
        .join('\u0000')
        .toLowerCase();
      if (!hay.includes(title)) continue;
    }

    if (cwd !== null) {
      if (typeof c.cwd !== 'string' || !c.cwd.toLowerCase().includes(cwd)) continue;
    }

    if (a.branch !== undefined && a.branch !== null) {
      if (c.branch !== a.branch) continue;
    }

    if (minTcu !== null) {
      const tcu = c.agg && c.agg.usd ? num(c.agg.usd.total) : null;
      if (tcu === null) { excluded.noCost += 1; continue; }
      if (tcu < minTcu) continue;
    }

    if (has.length) {
      let ok = true;
      for (const k of has) {
        const n = num(c[HAS_FIELD[k]]);
        if (n === null || n <= 0) { ok = false; break; }
      }
      if (!ok) continue;
    }

    if (badges.length) {
      const own = Array.isArray(c.badges) ? c.badges : [];
      if (!badges.every((b) => own.includes(b))) continue;
    }

    kept.push(c);
  }
  return { kept, excluded };
}

function sortCards(cards, sort) {
  // Every order ends in the same deterministic tail (startedAt desc, then id)
  // so that paging with `offset` is stable across calls: a wobbling sort would
  // make page 2 skip or repeat rows from page 1.
  const tail = (x, y) => (num(y.startedAt) ?? -Infinity) - (num(x.startedAt) ?? -Infinity)
    || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

  if (sort === 'cost') {
    // Unknown is not zero, so a session whose cost is not computable sorts
    // LAST rather than at the bottom of the money order as if it were $0.
    // That rule is descUnknownLast's, shared with lens_usage's row order.
    cards.sort(descUnknownLast((c) => (c.agg && c.agg.usd ? num(c.agg.usd.total) : null), tail));
    return;
  }
  if (sort === 'turns') {
    cards.sort((x, y) => (num(y.turnCount) ?? -1) - (num(x.turnCount) ?? -1) || tail(x, y));
    return;
  }
  if (sort === 'bytes') {
    cards.sort((x, y) => (num(y.bytes) ?? -1) - (num(x.bytes) ?? -1) || tail(x, y));
    return;
  }
  // 'recent' — recorded startedAt, newest first. This is the lens UI's own
  // session order (web/js/views/l0.mjs), so the two surfaces agree.
  cards.sort(tail);
}

// ------------------------------------------------------------------ rendering

function renderSessions({ ctx, render, view, byProject, project, args, cards, kept, shown, excluded, offset, limit }) {
  const { fmtUsd, fmtBytes, fmtWhen, tokenSummary, plural, liteDisclosures, renderRowsSum, FENCE, UNKNOWN } = render;
  const P = ctx.pricing;
  const lines = [];

  // ---- header. Scope, filters, and the paging arithmetic with BOTH
  // denominators: how many matched, and how many were in scope to match.
  const scope = byProject ? `project:${project}` : 'store';
  const filters = filterEchoLine(args);
  // The paging window is described by what was actually sliced, not by what
  // was asked for: an offset past the end shows 0–0, never a range of rows
  // that do not exist.
  const from = shown.length ? offset + 1 : 0;
  const to = shown.length ? offset + shown.length : 0;
  const paging = kept.length === cards.length
    ? `showing ${from}–${to} of ${kept.length}`
    : `showing ${from}–${to} of ${kept.length} matched (of ${cards.length} in scope)`;
  lines.push(`SESSIONS — ${scope}${filters ? ` · ${filters}` : ''} · ${paging} · sort=${args.sort || 'recent'}`);

  // ---- basis. The denominator under every figure below: an index that is
  // still building has read only some of the corpus, and a total over a subset
  // must say so.
  const st = ctx.index.status() || {};
  lines.push(
    `basis: ${st.sessionsDone ?? UNKNOWN} of ${st.sessionsTotal ?? UNKNOWN} sessions indexed`
    + ` · index ${st.state ?? UNKNOWN} · pricing v${P?.PRICING_VERSION ?? UNKNOWN}`,
  );

  if (!shown.length) {
    // An honest empty page, not an error. Two DIFFERENT facts can produce it
    // and they are never conflated: nothing matched the filters, or something
    // matched and this page is past the end of it. An agent's next move
    // differs completely between the two.
    if (!kept.length) {
      lines.push(
        cards.length
          ? `no sessions match — all ${plural(cards.length, 'session')} in ${scope} were tested and none passed every filter.`
          : `no sessions match — ${scope} contains 0 recorded sessions.`,
      );
    } else {
      lines.push(`this page is empty — offset ${offset} is past the end of the ${plural(kept.length, 'matched session')}. The matches are still there; ask for offset < ${kept.length}.`);
    }
    pushExclusions(lines, excluded);
    lines.push(scopeTotalLine(view, byProject, project, P, render));
    lines.push(`rows sum to header (${scope}): ${renderRowsSum(view.rowsSumToHeader, P)}`);
    pushR2(lines, view, byProject);
    lines.push(kept.length
      ? `next: lens_sessions ${byProject ? `project="${project}" ` : ''}offset=0`
      : 'next: lens_sessions   (drop a filter, or widen since/until)');
    if (!byProject) lines.push('      lens_status   (corpus span, project count, index state)');
    return lines.join('\n');
  }

  // ---- the table. Recorded titles are corpus-authored strings (aiTitle is
  // written into the transcript by Claude Code), so the block carrying them is
  // fenced and labelled per KAN-106 §4.6 / §7.3.7.
  lines.push(FENCE);
  const rows = [['id', 'started', 'ended', 'turns', 'agents', '$', 'title (recorded)']];
  for (const c of shown) {
    const startMs = num(c.startedAt);
    const endMs = num(c.endedAt);
    rows.push([
      c.id,
      fmtWhen(startMs),
      fmtEnd(startMs, endMs, fmtWhen),
      c.turnCount ?? UNKNOWN,
      c.agentCount ?? UNKNOWN,
      c.agg && c.agg.usd ? fmtUsd(P, num(c.agg.usd.total)) : UNKNOWN,
      titleCell(c, render),
    ]);
  }
  lines.push(render.table(rows, { align: ['l', 'l', 'l', 'r', 'r', 'r', 'l'] }));

  // ---- totals over the shown rows, each with its own denominator. A sum is
  // only over the rows that recorded the thing being summed, and when that is
  // fewer than the rows shown, the line says so.
  const withCost = shown.filter((c) => c.agg && c.agg.usd && num(c.agg.usd.total) !== null);
  const usdTcu = withCost.reduce((n, c) => n + c.agg.usd.total, 0);
  const reqs = withCost.reduce((n, c) => n + (num(c.agg.requests) ?? 0), 0);
  const withTurns = shown.filter((c) => num(c.turnCount) !== null);
  const turns = withTurns.reduce((n, c) => n + c.turnCount, 0);
  const bytes = shown.reduce((n, c) => n + (num(c.bytes) ?? 0), 0);
  const costDen = withCost.length === shown.length ? '' : ` over ${withCost.length} of ${shown.length} with a recorded cost`;
  const turnDen = withTurns.length === shown.length ? '' : ` (over ${withTurns.length} of ${shown.length})`;
  lines.push(
    `totals over the ${shown.length} shown: ${groupInt(turns)} turns${turnDen}`
    + ` · ${groupInt(reqs)} requests · ${fmtUsd(P, usdTcu)}${costDen}`
    + ` · ${fmtBytes(bytes)}   (${scopeTotalLine(view, byProject, project, P, render)})`,
  );

  // Token mass over the shown rows, from the same lite aggs — but over its OWN
  // denominator, not the money one. `withCost` is "has a computable DOLLAR
  // total"; a session whose rows are all UNPRICED (R7: a real model with no
  // rate recorded) has `usd.total: null` and real, recorded token counts.
  // Summing tokens over `withCost` silently dropped exactly those sessions and
  // then labelled the result "over the N with an agg", which is a denominator
  // for a different set. Tokens are a recorded fact independent of pricing, so
  // the set is every shown row that HAS an agg.
  const withAgg = shown.filter((c) => c.agg);
  const tok = sumTokens(withAgg.map((c) => c.agg.tokens));
  if (tok) lines.push(`  tokens over the ${withAgg.length} with an agg: ${tokenSummary(tok)}`);

  pushExclusions(lines, excluded);

  // The independent cross-check. It is a SCOPE-wide fact — the route computes
  // it over every session in scope, not over an arbitrary filtered subset — so
  // it is printed with the scope named rather than implied.
  lines.push(`rows sum to header (${scope}): ${renderRowsSum(view.rowsSumToHeader, P)}`);

  // The LITE disclosure line. Note it is liteDisclosures, not
  // renderDisclosures: these cards carry cardAggLite's flattened
  // inheritedRequests/unpricedRequests scalars, and the FULL renderer would
  // read them as absent maps and drop both counters silently.
  const disc = liteDisclosures(shown.map((c) => c.agg));
  if (disc) lines.push(`disclosures over the ${shown.length} shown: ${disc}`);

  pushR2(lines, view, byProject);

  // ---- locators and the drill-down, named literally. This footer is what
  // turns "I found something interesting" into a 200-token follow-up instead
  // of an agent reaching for Bash and grep.
  const first = shown[0];
  lines.push(`locators: slug="${first.slug}", id="<id column above>"`);
  lines.push(`next: lens_session slug="${first.slug}" id="${first.id}"`);
  lines.push(`      lens_usage scope="session:${first.slug}/${first.id}" group_by="model"`);
  if (!byProject) lines.push(`      lens_sessions project="${first.slug}"   (narrow to one project)`);
  if (offset + limit < kept.length) {
    lines.push(`      lens_sessions ${byProject ? `project="${project}" ` : ''}offset=${offset + limit}   (${kept.length - (offset + limit)} more matched)`);
  }
  return lines.join('\n');
}

// The scope-wide total, parenthesised beside the shown total so the two are
// read together. Both ends carry a denominator: `agg` is Σ over the sessions
// that HAVE an agg, which is not always every session in scope.
function scopeTotalLine(view, byProject, project, P, render) {
  const agg = view.agg;
  if (!agg) {
    return `${byProject ? `project ${project}` : 'store'} total: ${render.UNKNOWN} — no aggregate computable yet`;
  }
  let den;
  if (!byProject && view.aggScope) {
    den = `${view.aggScope.sessions ?? render.UNKNOWN} of ${view.aggScope.of ?? render.UNKNOWN} sessions`;
  } else {
    // /api/project ships no aggScope, so the denominator is counted from the
    // cards it did ship: how many of this project's sessions carry an agg.
    const all = Array.isArray(view.sessions) ? view.sessions : [];
    const withAgg = all.filter((c) => c.agg).length;
    den = `${withAgg} of ${all.length} sessions`;
  }
  return `${byProject ? `project ${project}` : 'store'} total: ${den} · ${groupInt(agg.requests)} requests · ${render.fmtUsd(P, agg.usd ? agg.usd.total : null)}`;
}

// Sessions a filter could not TEST. Reported separately from sessions that
// were tested and did not match: "unknown" is not "no".
function pushExclusions(lines, excluded) {
  if (excluded.noStartDate) {
    lines.push(`not testable against since/until: ${excluded.noStartDate} session${excluded.noStartDate === 1 ? '' : 's'} record no start time (excluded, not counted as non-matching).`);
  }
  if (excluded.noCost) {
    lines.push(`not testable against min_usd: ${excluded.noCost} session${excluded.noCost === 1 ? '' : 's'} have no computable cost (excluded — unknown is never treated as $0).`);
  }
}

// R2 is the cross-session de-duplication of one message.id across forked and
// resumed sessions. While it is still settling, inherited/forked figures can
// move, and a cost figure read now may not be the one read in ten seconds.
function pushR2(lines, view, byProject) {
  // Both scopes read the VIEW. `/api/project/:slug` carries r2 at the top
  // level; `/api/index` carries it on `status`, put there by the lens's
  // index-view.mjs. The raw ctx.index.status() carries it NOWHERE, so reading
  // that at store scope could only ever produce undefined — and a footer that
  // can never print is a disclosure that does not exist.
  const r2 = byProject ? view.r2 : (view.status || {}).r2;
  if (r2Pending(r2)) {
    lines.push(`R2 fork resolution: ${r2} — inherited/forked figures may still change; re-run when lens_status reports the index ready.`);
  }
}

// ------------------------------------------------------------------ cells

/**
 * titleCell(card) — the recorded title, clipped, plus the recorded badges.
 *
 * The title itself comes from render.sessionTitleOf, shared with lens_usage so
 * the two surfaces never name the same session differently. The clip width and
 * the badge suffix are this table's own layout and stay here.
 *
 * A session with no recorded title renders `—`, never a fabricated one.
 */
function titleCell(c, render) {
  const t = render.sessionTitleOf(c);
  const text = t === null ? render.UNKNOWN : render.quote(clip(String(t), 48));
  const badges = Array.isArray(c.badges) && c.badges.length ? `  [${c.badges.join(' ')}]` : '';
  return `${text}${badges}`;
}

function clip(s, n) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

// The end time, dropping the date when it is the same local day as the start —
// the common case, and the two columns are read side by side. The same-day test
// runs on the shared calendar-day NUMBER, never on a label string.
function fmtEnd(startMs, endMs, fmtWhen) {
  if (endMs === null) return '—';
  if (startMs !== null && dayNumOfMs(startMs) === dayNumOfMs(endMs)) {
    const d = new Date(endMs);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return fmtWhen(endMs);
}

// ------------------------------------------------------------------ small

// null/undefined and non-finite alike are UNKNOWN, and unknown is never 0.
// This is a VALUE coercion, not a renderer — it returns a number or null for
// the filters and the sums to compute on — which is why it stays local while
// render.groupInt does the printing.
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// A float that is within a few ulp of an integer IS that integer. Used only on
// the USD -> tcu conversion, where the target space is integers and the one ulp
// of error introduced by the multiplication is not a fact about any cost. The
// tolerance is scaled by the magnitude because ulp is: four ulp of `x` leaves
// room for the multiply and the division that produced `min_usd`, and is still
// astronomically tighter than the 1-tcu gap between two distinguishable costs.
function snapToInt(x) {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(x);
  return Math.abs(x - r) <= Math.max(1, Math.abs(x)) * Number.EPSILON * 4 ? r : x;
}

// Σ over a list of recorded Tokens objects. `null` when NOT ONE of them was
// recorded — a sum over nothing is unknown, not a row of zeros.
function sumTokens(list) {
  const out = {};
  for (const k of TOKEN_KEYS) out[k] = 0;
  let any = false;
  for (const t of list) {
    if (!t) continue;
    any = true;
    for (const k of TOKEN_KEYS) out[k] += num(t[k]) ?? 0;
  }
  return any ? out : null;
}

// The filters actually applied, echoed so the result states its own question.
function filterEcho(a) {
  const out = {};
  for (const k of ['project', 'since', 'until', 'title_contains', 'cwd_contains', 'branch', 'min_usd', 'has', 'badges']) {
    if (a[k] !== undefined && a[k] !== null && !(Array.isArray(a[k]) && a[k].length === 0)) out[k] = a[k];
  }
  return out;
}

function filterEchoLine(a) {
  const e = filterEcho(a);
  delete e.project; // already the scope label
  const parts = [];
  if (e.since || e.until) parts.push(`${e.since ?? '…'}..${e.until ?? '…'}`);
  if (e.title_contains) parts.push(`title~"${e.title_contains}"`);
  if (e.cwd_contains) parts.push(`cwd~"${e.cwd_contains}"`);
  if (e.branch) parts.push(`branch=${e.branch}`);
  if (e.min_usd !== undefined) parts.push(`min_usd=${e.min_usd}`);
  if (e.has) parts.push(`has=${e.has.join('+')}`);
  if (e.badges) parts.push(`badges=${e.badges.join('+')}`);
  return parts.join(' · ');
}
