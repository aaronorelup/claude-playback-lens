// mcp/tools/status.mjs — lens_status.
//
// Orientation, and the recovery path from a "still building" result. Adapts
// GET /api/hello (the app identity the lens itself answers a port probe with)
// and GET /api/index, of which it reads only `status`, `agg`, `aggScope`,
// `rowsSumToHeader`, `lostAgents`, `dayBands` and `problems` — never the
// per-session or per-project arrays, which are what make that payload large.

import { z } from 'zod';

// How many folded problem rows this tool enumerates — in the rendered text AND
// in `structuredContent`. The index serves up to PROBLEMS_CAP (200) rows, each
// carrying up to PROBLEM_SOURCE_CAP (25) source identities; relaying that whole
// array would put ~5000 objects on a ~150-token result. The two caps are the
// same number on purpose: what the text shows is what the JSON carries, and
// `problemsTotal` states what was folded so nothing is hidden silently.
const PROBLEM_CAP = 5;

const DESCRIPTION = 'Report what the Claude Code transcript corpus contains and whether the index is ready to query. Call this first if another lens tool returns a "still building" result, or when you need the corpus root, session/project counts, date range, store-wide totals, or the pricing/index versions a cost figure was computed under. Cheap (~150 tokens). Read-only.';

export function register(server, deps) {
  const { ctx, lens, call, render, meta } = deps;

  server.registerTool(
    'lens_status',
    {
      title: 'Lens status',
      description: DESCRIPTION,
      inputSchema: z.object({
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
    async ({ structured }) => {
      const hello = await call('GET', '/api/hello');
      const index = await call('GET', '/api/index');

      // /api/index answers while the indexer is down (that is where problems[]
      // lives), so a 409 here is not expected — but a route that CAN pend must
      // be rendered as a state rather than thrown at the model.
      if (index.status === 409) {
        return render.structuredWrap(render.pendingResult(index.json), index.json, structured);
      }
      if (index.status !== 200) {
        return render.errorResult(render.httpMessage(index, {
          tool: 'lens_status',
          where: '/api/index',
          // lens_status IS the tool that reports the indexer state, so pointing
          // at itself would be a loop. The recorded problems are on this same
          // payload, which is the one that failed.
          also: 'The index route itself failed, so there is no status to fall back on. Check the server\'s stderr for the indexer\'s own message.',
        }));
      }

      const view = index.json;
      const text = renderStatus({ ctx, lens, meta, render, hello: hello.json, view });
      // The structured payload is the trimmed view, not the whole /api/index
      // body: attaching several MB of sessions[] to a ~150-token status result
      // would defeat the purpose of the tool.
      const json = {
        app: hello.json,
        toolsVersion: meta.TOOLS_VERSION,
        indexVersion: lens.store.INDEX_VERSION,
        pricingVersion: lens.pricing.PRICING_VERSION,
        projectsDir: ctx.projectsDir,
        projectsDirSource: ctx.projectsDirSource,
        cacheDir: ctx.cacheDir,
        lensDir: meta.lensDir,
        status: view.status,
        agg: view.agg,
        aggScope: view.aggScope,
        rowsSumToHeader: view.rowsSumToHeader,
        lostAgents: view.lostAgents,
        projectCount: Array.isArray(view.projects) ? view.projects.length : null,
        dayBands: (view.dayBands ?? []).map((b) => b.localDate),
        // Capped to match the text, and each entry's `sources[]` is REPLACED by
        // its count: the identities are up to 25 objects per row and the index
        // already folded them, so the count is the recorded fact worth carrying
        // here. `sourceCount` is the index's own field; falling back to
        // sources.length reads a length nobody had to compute. The full rows
        // (with their sources) live on GET /api/index for the caller who needs
        // them, and `problemsTotal` says how many there were.
        problems: problemRows(view.problems),
        problemsTotal: Array.isArray(view.problems) ? view.problems.length : 0,
      };
      return render.structuredWrap(render.textResult(render.capText(text)), json, structured);
    },
  );
}

function renderStatus({ ctx, lens, meta, render, hello, view }) {
  const { fmtUsd, fmtBytes, groupInt, plural, tokenSummary, r2Pending, renderRowsSum, renderDisclosures, UNKNOWN } = render;
  const P = ctx.pricing;
  const lines = [];

  // Version line. Four versions, because a cost figure is only traceable if
  // you know the rate table and the index format that produced it.
  const appVersion = (hello && hello.version) || ctx.appVersion;
  lines.push(`LENS ${appVersion} · tools v${meta.TOOLS_VERSION} · index v${lens.store.INDEX_VERSION} · pricing v${lens.pricing.PRICING_VERSION}`);

  // Corpus. The source is the winning rung of the lens's own config ladder
  // (--projects > CLAUDE_PROJECTS > config.json > ~/.claude/projects), and it
  // is fixed for the life of this process.
  lines.push(`corpus: ${ctx.projectsDir}   (from ${ctx.projectsDirSource})`);
  // The lens install dir and the index cache dir are NOT printed here. They are
  // two absolute Windows paths — 146 characters on the author's machine, the
  // largest single line this result ever emitted — and neither is in the §6.2
  // output sketch, neither answers any of pain points (a)–(f), and both already
  // ride `structuredContent` (lensDir/cacheDir above) for the caller that
  // actually needs them. Nothing recorded is lost by leaving them out of the
  // rendered text; ~37 tokens of a ~150-token budget are.

  // Index state. Every count ships its denominator.
  const st = view.status || {};
  const done = st.sessionsDone ?? null;
  const total = st.sessionsTotal ?? null;
  const projects = Array.isArray(view.projects) ? view.projects.length : null;
  const sessionsPart = `${done ?? UNKNOWN} of ${total ?? UNKNOWN} sessions`;
  if (st.state === 'ready') {
    lines.push(`index: ready — ${sessionsPart}, ${fmtBytes(st.bytesTotal)}, ${plural(projects, 'project')}`);
  } else if (st.state === 'building') {
    // The retry hint is the point of the building line: this tool is the
    // documented way out of a "still building" result, and an agent that is
    // told to come back needs to know when. See retryHint() for why it is
    // usually qualitative.
    lines.push(`index: building — ${fmtBytes(st.bytesIndexed)} of ${fmtBytes(st.bytesTotal)} (${sessionsPart} summarised); ${retryHint(st)}; figures below cover what is indexed so far`);
  } else {
    lines.push(`index: ${st.state ?? UNKNOWN} — indexer is not running; totals below cover ${sessionsPart}`);
  }
  // R2 (cross-session duplication) resolution can still be settling while the
  // index builds; inherited/forked figures may move until it is done. The test
  // is render.r2Pending, shared with every other tool that footers this — the
  // resolved state is the common one and must print nothing.
  if (r2Pending(st.r2)) lines.push(`R2 fork resolution: ${st.r2} — inherited/forked figures may still change`);

  // Span, from dayBands (server-host local calendar days, newest first).
  const bands = Array.isArray(view.dayBands) ? view.dayBands : [];
  if (bands.length) {
    const first = bands[bands.length - 1].localDate;
    const last = bands[0].localDate;
    lines.push(`span: ${first} .. ${last} (${plural(bands.length, 'local day')})`);
  } else {
    lines.push('span: no day bands recorded');
  }

  // Store totals, with the denominator of the aggregate itself: `agg` is Σ
  // over the sessions that are indexed, which is not always every session.
  const agg = view.agg;
  const scope = view.aggScope || {};
  if (!agg) {
    lines.push(`store total: ${UNKNOWN} (no session aggregate computable yet — ${scope.sessions ?? UNKNOWN} of ${scope.of ?? UNKNOWN} sessions)`);
  } else {
    lines.push(`store total: ${groupInt(agg.requests)} requests · ${fmtUsd(P, agg.usd?.total ?? null)}   (over ${scope.sessions ?? UNKNOWN} of ${scope.of ?? UNKNOWN} sessions)`);
    lines.push(`  ${tokenSummary(agg.tokens || null)}`);
  }

  // The independent cross-check, always printed — including when it fails.
  // lostAgents is a census (Σ over cards), so a 0 here is provable and renders
  // 0, never `—`.
  lines.push(`rows sum to header: ${renderRowsSum(view.rowsSumToHeader, P)} · lostAgents: ${view.lostAgents ?? UNKNOWN}`);

  const disclosures = renderDisclosures(agg);
  if (disclosures) lines.push(disclosures);

  // Problems are already folded by code+scope with a count by the index layer.
  const problems = Array.isArray(view.problems) ? view.problems : [];
  if (!problems.length) {
    lines.push('problems: 0');
  } else {
    const shown = problems.slice(0, PROBLEM_CAP)
      .map((p) => `${p.code} ×${p.count ?? 1} affects:${p.affects ?? UNKNOWN}`)
      .join(' · ');
    const more = problems.length > PROBLEM_CAP ? ` · … ${problems.length - PROBLEM_CAP} more` : '';
    lines.push(`problems: ${problems.length} (${shown}${more})`);
  }

  // Sessions still waiting on a first parse; an empty list is a provable none.
  const pending = Array.isArray(view.pending) ? view.pending.length : null;
  if (pending) lines.push(`pending parse: ${plural(pending, 'session')}`);

  lines.push('next: lens_sessions   |   lens_usage scope="store" group_by="project"');
  return lines.join('\n');
}

/**
 * retryHint(status) — when to come back, from the building status block.
 *
 * `retryAfterMs` is a field of the lens's 409 `not-indexed-yet` ENVELOPE
 * (server/errors.mjs, RETRY_AFTER_MS), not of `index.status()`, which records
 * only { state, sessionsDone, sessionsTotal, bytesIndexed, bytesTotal } — so on
 * today's server this returns the qualitative hint. Printing "~1s" anyway would
 * be a number nobody recorded on this payload. The numeric branch is honoured
 * for the payload that DOES carry an interval, using pendingResult()'s rounding
 * so the two hints never disagree about the same milliseconds.
 */
function retryHint(st) {
  const ms = st ? st.retryAfterMs : null;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
    return `retry in ~${Math.max(1, Math.round(ms / 1000))}s`;
  }
  return 're-check shortly';
}

/**
 * problemRows(problems) — the capped, source-free problem rows for
 * `structuredContent`. Everything recorded on a row survives EXCEPT the
 * `sources[]` identities, which are replaced by their count.
 */
function problemRows(problems) {
  if (!Array.isArray(problems)) return [];
  return problems.slice(0, PROBLEM_CAP).map((p) => {
    const { sources, ...rest } = p || {};
    return {
      ...rest,
      sourceCount: typeof rest.sourceCount === 'number'
        ? rest.sourceCount
        : (Array.isArray(sources) ? sources.length : null),
    };
  });
}
