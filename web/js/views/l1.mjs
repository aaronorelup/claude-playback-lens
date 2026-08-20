// web/js/views/l1.mjs — L1 (one project). Group F.
// DESIGN §3 L1: default sessions table; ?v=timeline (L0 grammar filtered, with a
// thin session underline); ?v=memory. Badges are the seven recorded conditions —
// there is NO `lost agents` badge (DESIGN §3; the provable zero lives in the
// inventory census instead).

import { defineRoute as importedDefineRoute, navigate } from '../router.mjs';
import { api } from '../api.mjs';
import { scopeString } from '../components/scope.mjs';
import { timeline } from '../components/timeline.mjs';
import {
  h, val, dash, replaceEl, storeHref, projectHref, sessionHref, memoryHref, turnHref,
  mountBands, buildStatbarProps, mountTable, sessionsTableProps, viewTabs, col,
  resetViewState, schedulePoll, ensurePricing, usdCell, fmtInt, fmtBytes, fmtStamp, fmtClock,
  tokenCells, withQuery, parseRange, rangeClause, assembleBands, withSeparators,
  bandRuns, dayLabel, hostCalendar, tzLabel, sessionRowsFromIndex, addTokens,
  emptyTokens, cardAgg, storeAgg, pendingOf, aggTokens, projectLabelOf, denominatorSentence, indexStatus,
  track, firstFinite, MS_DAY,
} from './l0.mjs';

/* ===========================================================================
   Pure helpers (covered by tests/views-overview-l1.test.mjs)
   =========================================================================== */

/** /api/project/:slug ships "its sessions in full, memory listing, fragments"
 *  (SPEC §9); the exact key names are not pinned, so probe and normalise. */
export function projectPayload(res, slug) {
  const p = (res && (res.project || res.meta)) || res || {};
  const sessions = (res && (res.sessions || res.cards)) || [];
  const memory = (res && (res.memory || res.memoryFiles || res.memoryListing)) || [];
  const fragments = (res && (res.fragments || res.fragmentDirs)) || [];
  const label = projectLabelOf({ slug, label: p.label, cwd: p.cwd }, sessions);
  return {
    slug, label: label.text, labelReason: label.reason,
    sessions, memory, fragments,
    agg: cardAgg(p) || cardAgg(res) || storeAgg(res),
    turnBars: (res && res.turnBars) || null,
    dayBands: (res && res.dayBands) || null,
    problems: (res && res.problems) || [],
    scope: (res && res.scope) || null,
    // The server's exact-tcu header-vs-rows verdict (payload-level).
    rowsSumToHeader: res && res.rowsSumToHeader !== undefined ? res.rowsSumToHeader : null,
  };
}

/** DESIGN §3 L1 memory view: `memory/*.md` with frontmatter originSessionId
 *  links; a dangling id says "session not on disk" — never a fabricated link.
 *  "not on disk" is a CORPUS claim, so it needs the corpus — when the
 *  store index could not be loaded (`indexAvailable` false) a cross-project id
 *  is merely unresolvable right now, and is excluded from the dangling count. */
export function memoryRows(memory, slug, sessionIndex, { indexAvailable = true } = {}) {
  const idx = sessionIndex instanceof Map ? sessionIndex : new Map(Object.entries(sessionIndex || {}));
  return (memory || []).map((m) => {
    const name = typeof m === 'string' ? m : (m.name || m.rel || m.file || '');
    const bare = name.replace(/^mem\//, '');
    const origin = (typeof m === 'object' && (m.originSessionId || (m.metadata && m.metadata.originSessionId))) || null;
    let resolved = null;
    if (origin) {
      if (typeof m === 'object' && m.originSlug) resolved = { slug: m.originSlug, id: origin };
      else if (idx.has(origin)) resolved = { slug: idx.get(origin), id: origin };
    }
    const unresolvable = !!origin && !resolved && !indexAvailable;
    const size = typeof m === 'object' ? firstFinite(m.bytes, m.size) : null;
    return {
      name: bare,
      bytes: size,
      mtimeMs: typeof m === 'object' && Number.isFinite(m.mtimeMs) ? m.mtimeMs : null,
      originSessionId: origin,
      resolved,
      unresolvable,
      crossProject: !!(resolved && resolved.slug !== slug),
      note: !origin ? 'no originSessionId is recorded for this file on the project listing'
        : resolved ? null
          : unresolvable ? 'not resolvable right now — the store index could not be loaded'
            : 'session not on disk',
      rawHref: memoryHref(slug, bare),
      originHref: resolved ? sessionHref(resolved.slug, resolved.id) : null,
    };
  });
}

/** Thin session underline beneath a day band's turns (DESIGN §3 L1): the extent
 *  of each session's own bars within that day — recorded bounds only. */
export function sessionUnderlines(band) {
  const bySession = new Map();
  for (const seg of (band && band.segments) || []) {
    const key = `${seg.bar.slug}/${seg.bar.id}`;
    const end = seg.endMs === null ? seg.startMs : seg.endMs;
    const cur = bySession.get(key);
    if (!cur) bySession.set(key, { slug: seg.bar.slug, id: seg.bar.id, start: seg.startMs, end, turns: 1 });
    else {
      cur.start = Math.min(cur.start, seg.startMs);
      cur.end = Math.max(cur.end, end);
      cur.turns++;
    }
  }
  return [...bySession.values()].sort((a, b) => a.start - b.start);
}

/** Props for components/scope.mjs — band 2 (DESIGN §1). */
export function scopeSentenceL1({ view, label, labelReason, counts, range, st, bandCount, tzText, fragments, hasDayBands, sigma }) {
  const rule = {
    sessions: 'one row per session whose main transcript lives in this dir; a fragment dir with no sibling .jsonl unions into the session that owns its id (SPEC §2)',
    timeline: `one bar per recorded turn in this project across ${Number.isFinite(bandCount) ? fmtInt(bandCount) : '—'} local calendar ${bandCount === 1 ? 'day' : 'days'} ${tzText || ''}, with a thin underline marking each session’s extent within a day`,
    memory: 'every memory/*.md file in this project dir, with the session its frontmatter names',
  }[view] || null;
  const extra = [];
  if (labelReason) extra.push(`this dir is shown by its raw slug because ${labelReason}`);
  if (fragments) extra.push(`${fmtInt(fragments)} fragment dir${fragments === 1 ? '' : 's'} in this project union into the session that owns their id`);
  if (view === 'timeline' && hasDayBands === false) {
    // A sentence that parses. Say what shows, what is absent, and why
    // the token/cost columns read — with a reason.
    extra.push('per-project day totals are not recorded, so each band shows only its turn bars and the token and cost columns read — with that reason');
  }
  const denom = denominatorSentence(st);
  if (denom) extra.push(`the header ${denom}`);
  return {
    subject: `project ${label}`,
    counts: [
      Number.isFinite(counts && counts.sessions) ? { n: counts.sessions, noun: 'session' } : null,
      Number.isFinite(counts && counts.turns) ? { n: counts.turns, noun: 'turn' } : null,
      Number.isFinite(counts && counts.agents) ? { n: counts.agents, noun: 'agent' } : null,
    ].filter(Boolean),
    rule,
    filters: range && range.active ? [{ label: 'date', value: rangeClause(range) }] : [],
    totals: (range && range.active && Number.isFinite(counts && counts.shown) && Number.isFinite(counts && counts.sessions))
      ? { all: counts.sessions, filtered: counts.shown } : undefined,
    sigma: sigma || 'all',
    extra,
  };
}

/* ===========================================================================
   Rendering
   =========================================================================== */

const L1_TABS = [
  { v: 'sessions', label: 'sessions' },
  { v: 'timeline', label: 'timeline' },
  { v: 'memory', label: 'memory' },
];
const L1_VIEWS = L1_TABS.map((t) => t.v);

async function renderProject(ctx) {
  resetViewState();
  const slug = ctx.params.slug;
  const query = ctx.query;
  const requested = query.get('v');
  const view = L1_VIEWS.includes(requested) ? requested : 'sessions';

  ctx.setTitle(slug);
  ctx.crumbs({ items: [{ label: 'the store', href: storeHref() }, { label: slug }], up: { href: storeHref(), label: 'the store' } });
  ctx.registerUp(storeHref(), 'the store');
  ctx.registerLevels({ 0: storeHref(), 1: projectHref(slug) });
  ctx.registerScope(scopeString('project', { slug }));
  ctx.registerViews(L1_TABS.map((t) => ({ key: t.v, label: t.label })));
  ctx.statbar({ pending: true, counts: [] });

  await ensurePricing();
  const res = await api(`/api/project/${encodeURIComponent(slug)}`, null, { signal: ctx.signal });
  if (ctx.stale) return;
  const pending = pendingOf(res);
  if (pending) {
    ctx.loading({
      label: 'this project’s sessions are still being summarised — no figures are claimed for them yet',
      bytesDone: pending.bytesIndexed, bytesTotal: pending.bytesTotal,
      done: pending.sessionsDone, of: pending.sessionsOf,
    });
    schedulePoll(ctx, () => renderProject(ctx), pending.retryAfterMs || 1000);
    return;
  }

  const P = projectPayload(res, slug);
  // The timeline and memory views need the store index: turn bars are recorded
  // store-wide, and an originSessionId may name a session in another project.
  let index = null;
  if (view === 'timeline' || view === 'memory' || !P.turnBars) {
    try { index = await api('/api/index', null, { signal: ctx.signal }); } catch { index = null; }
    if (pendingOf(index)) index = null;
  }
  if (ctx.stale) return;
  ctx.ready();
  paintProject(ctx, { P, index, view, range: parseRange(query), query, slug });
}

function paintProject(ctx, o) {
  const { P, index, view, range, query, slug } = o;
  const st = indexStatus(index || { scope: P.scope });
  // A project payload's cards may omit the slug they are already scoped by.
  const owned = (P.sessions || []).map((c) => (c && c.slug ? c : { ...c, slug }));
  const rows = owned.length ? sessionRowsFromIndex({ sessions: owned }, { range }) : sessionRowsFromIndex(index || {}, { slug, range });
  const rowsAll = owned.length ? sessionRowsFromIndex({ sessions: owned }, {}) : sessionRowsFromIndex(index || {}, { slug });

  for (const bad of range.invalid) {
    ctx.banner(`Ignored ${bad.param}=${bad.value} — that is not a YYYY-MM-DD date.`, 'warn');
  }

  const turnBars = ((P.turnBars || (index && index.turnBars)) || []).filter((b) => b.slug === slug);
  const bands = assembleBands({ dayBands: P.dayBands || [], turnBars }, { range });

  const agg = P.agg;
  let tokens = aggTokens(agg);
  if (!tokens) for (const r of rowsAll) if (r.tokens) tokens = addTokens(tokens || emptyTokens(), r.tokens);

  // L1 honours the same Σ toggle as L0 — Σ filtered totals the in-range
  // session rows (their recorded card figures added up, never re-derived).
  const sigma = range.active && query.get('sum') === 'filtered' ? 'filtered' : 'all';
  const useFiltered = sigma === 'filtered';
  let filteredTokens = null;
  if (useFiltered) for (const r of rows) if (r.tokens) filteredTokens = addTokens(filteredTokens || emptyTokens(), r.tokens);
  const filteredAgg = useFiltered
    ? { requests: null, tokens: filteredTokens, usd: { total: sumRows(rows, 'usd') } }
    : null;

  const scope = scopeSentenceL1({
    view, label: P.label, labelReason: P.labelReason,
    counts: { sessions: rowsAll.length, shown: rows.length, turns: sumRows(rowsAll, 'turns'), agents: sumRows(rowsAll, 'agents') },
    range, st, bandCount: bands.length, sigma,
    tzText: tzLabel(hostCalendar.offsetMinutesAt(Date.now())),
    fragments: (P.fragments || []).length,
    hasDayBands: !!P.dayBands,
  });
  scope.onSigma = (next) => navigate(withQuery(projectHref(slug), query, { sum: next === 'filtered' ? 'filtered' : null }));
  if (useFiltered) {
    scope.note = `Σ filtered sums the ${fmtInt(rows.length)} in-range session card${rows.length === 1 ? '' : 's'}; the disclosure chips are shown for Σ all only.`;
  }

  ctx.setTitle(P.label);          // the recorded cwd label, once the payload has it
  mountBands(ctx, {
    items: [{ label: 'the store', href: storeHref() }, { label: P.label, id: P.labelReason ? null : slug, idTitle: slug }],
    up: { href: storeHref(), label: 'the store' },
    scope,
    stat: buildStatbarProps({
      agg: useFiltered ? filteredAgg : agg,
      chipsAgg: useFiltered ? null : agg,
      tokens: useFiltered ? filteredTokens : tokens,
      span: spanOfRows(useFiltered ? rows : rowsAll), active: firstFinite(P.activeMs),
      at: maxStart(rowsAll), scope: scopeString('project', { slug }), st,
      rowsSumToHeader: useFiltered ? null : P.rowsSumToHeader,
      costPanel: useFiltered ? {
        enabled: false,
        reason: 'Σ filtered sums the in-range session cards; the per-model breakdown exists for Σ all — switch back to open it.',
      } : undefined,
      counts: [
        { key: 'sessions', label: 'sessions', value: useFiltered ? rows.length : rowsAll.length },
        { key: 'turns', label: 'turns', value: sumRows(useFiltered ? rows : rowsAll, 'turns'), reason: 'no turn counts recorded on these session cards' },
        { key: 'agents', label: 'agents', value: sumRows(useFiltered ? rows : rowsAll, 'agents'), reason: 'no agent counts recorded on these session cards' },
        { key: 'workflows', label: 'workflows', value: sumRows(useFiltered ? rows : rowsAll, 'workflows'), reason: 'no workflow counts recorded on these session cards' },
        { key: 'bytes', label: 'bytes', value: sumRows(useFiltered ? rows : rowsAll, 'bytes'), reason: 'no byte totals recorded on these session cards' },
      ],
    }),
  });

  const root = h('div', { class: 'lens-l1' });
  root.appendChild(viewTabs(projectHref(slug), query, L1_TABS, view, 'sessions'));
  const body = h('div', { class: 'lens-l1__body' });
  root.appendChild(body);
  replaceEl(ctx.el, root);

  if (view === 'timeline') paintProjectTimeline(body, { bands, query, base: projectHref(slug), hasDayBands: !!P.dayBands, range });
  else if (view === 'memory') paintMemory(body, { P, index, slug, indexAvailable: index !== null });
  else paintSessions(body, rows, ctx);

  if (st.building) schedulePoll(ctx, () => renderProject(ctx), 1000);
}

function sumRows(rows, key) {
  let t = null;
  for (const r of rows) if (Number.isFinite(r[key])) t = (t || 0) + r[key];
  return t;
}
function spanOfRows(rows) {
  let lo = null, hi = null;
  for (const r of rows) {
    if (Number.isFinite(r.startedAt)) lo = lo === null ? r.startedAt : Math.min(lo, r.startedAt);
    const e = Number.isFinite(r.endedAt) ? r.endedAt : r.startedAt;
    if (Number.isFinite(e)) hi = hi === null ? e : Math.max(hi, e);
  }
  return lo === null || hi === null ? null : hi - lo;
}
function maxStart(rows) {
  let hi = null;
  for (const r of rows) if (Number.isFinite(r.startedAt)) hi = hi === null ? r.startedAt : Math.max(hi, r.startedAt);
  return hi;
}

/* ---- default: sessions table -------------------------------------------- */

function paintSessions(body, rows, ctx) {
  const el = h('div', { class: 'lens-table lens-table--sessions' });
  body.appendChild(el);
  mountTable(el, sessionsTableProps(rows, { showProject: false }));
  ctx.registerRows(el);
  body.appendChild(h('p', { class: 'lens-note' },
    'Each badge is a recorded condition: ',
    h('span', { class: 'lens-badge lens-badge--fragment' }, 'fragment'), ' a session dir with no sibling .jsonl · ',
    h('span', { class: 'lens-badge lens-badge--forked' }, 'forked'), ' an R2 fork-group member · ',
    h('span', { class: 'lens-badge lens-badge--no-reply' }, 'no reply'), ' the final turn holds zero assistant message.id groups · ',
    h('span', { class: 'lens-badge lens-badge--retried' }, 'retried'), ' more journal starts than manifest agents · ',
    h('span', { class: 'lens-badge lens-badge--running' }, 'running'), ' a start with no result · ',
    h('span', { class: 'lens-badge lens-badge--cached' }, 'cached'), ' workflowProgress cached:true · ',
    h('span', { class: 'lens-badge lens-badge--live' }, 'live'), ' the file is growing on disk.'));
}

/* ---- ?v=timeline : L0 grammar, filtered, with session underlines -------- */

function paintProjectTimeline(body, { bands, query, base, hasDayBands, range }) {
  if (!bands.length) {
    body.appendChild(h('p', { class: 'lens-empty', text: range.active ? 'No turns are recorded in this date range.' : 'No turns are recorded in this project.' }));
    return;
  }
  const list = h('div', { class: 'lens-bands lens-bands--project' });
  const runs = bandRuns(withSeparators(bands));
  // One gutter scale for the whole page (recorded dayBand turnCounts, with
  // the bar count NEVER standing in for a recorded figure).
  let pageMax = null;
  for (const b of bands) {
    const t = b.gutter && b.gutter.turnCount;
    if (Number.isFinite(t)) pageMax = Math.max(pageMax ?? 0, t);
  }
  // Split the ≤2,500-mark view budget across this page's mounts.
  const runCount = Math.max(1, runs.filter((r) => r.kind === 'run').length);
  const capPerRun = Math.max(100, Math.floor(2500 / runCount));
  for (const run of runs) {
    if (run.kind === 'gap') {
      list.appendChild(h('div', { class: 'lens-sep lens-sep--gap', title: `no turns are recorded between ${run.older} and ${run.newer}` },
        h('span', { class: 'lens-sep__label', text: run.label })));
      continue;
    }
    if (run.kind === 'month') {
      const s = run.subtotal;
      const reason = hasDayBands ? 'no day bands are recorded in this month' : 'day totals are recorded store-wide; /api/project ships no per-project day bands';
      list.appendChild(h('div', { class: 'lens-sep lens-sep--month' },
        h('span', { class: 'lens-sep__label', text: run.label }),
        h('span', { class: 'lens-sep__stat' }, 'turns ', val(fmtInt(s.turnCount), reason)),
        h('span', { class: 'lens-sep__stat' }, ...tokenCells(s.tokens, reason)),
        h('span', { class: 'lens-sep__stat' }, usdCell(s.usd, reason))));
      continue;
    }
    list.appendChild(projectRunBlock(run, { query, base, hasDayBands, pageMax, binsCap: capPerRun }));
  }
  body.appendChild(list);
}

/** DESIGN §2: the ⓘ popover carries SPEC §4's bounds ledger — per view. */
function l1BoundsLedger() {
  return h('div', { class: 'lens-ledger' },
    h('h4', { class: 'lens-ledger__h', text: 'how these bars are bounded (SPEC §4)' }),
    h('ul', { class: 'lens-ledger__list' },
      h('li', { text: 'Turn bar: starts at the opener event’s timestamp; ends at the max timestamp over the turn’s conversation rows only — assistant and user rows, excluding queue-operation, system, attachment and isMeta rows.' }),
      h('li', { text: 'A turn crossing local midnight is split between day bands by its rows’ recorded timestamps, never counted twice.' }),
      h('li', { text: 'The thin underline beneath a band marks each session’s extent within that day — the min/max of its own bars, recorded bounds only.' }),
      h('li', { text: 'Band gutter figures are the server-computed dayBands turn counts (the gutter’s sole data source); nothing in the gutter is re-derived in the browser. A day with no recorded day band reads — with that reason.' }),
      h('li', { text: 'A bar with only one recorded timestamp renders as a tick — no width is invented.' })));
}

function projectRunBlock(run, { query, base, hasDayBands, pageMax = null, binsCap = 2500 }) {
  const host = h('div', { class: 'lens-bands__run' });
  const axisFrom = hostCalendar.dayStartMs(run.bands[0].localDate);
  const lanes = [], marks = [];
  for (const band of run.bands) {
    const dayStart = hostCalendar.dayStartMs(band.localDate);
    const unders = sessionUnderlines(band);
    const g = band.gutter || {};
    lanes.push({
      id: band.localDate,
      label: dayLabel(band.localDate),
      href: withQuery(base, query, { day: band.localDate }),
      sublabel: `${band.segments.length} turn bar${band.segments.length === 1 ? '' : 's'} · ${unders.length} session${unders.length === 1 ? '' : 's'}`
        + (hasDayBands ? '' : ' · day totals not recorded per project'),
      // The gutter shows the RECORDED dayBand turnCount, exactly as
      // L0's runBlock does — never the client's bar count for the same day.
      gutter: {
        value: Number.isFinite(g.turnCount) ? g.turnCount : null,
        label: 'turns',
        reason: g.recorded ? 'the recorded day band carries no turn count'
          : (g.reason || 'no day band recorded for this date — the gutter shows only server-computed day totals'),
      },
    });
    for (const seg of band.segments) {
      const b = seg.bar;
      marks.push({
        lane: band.localDate,
        at: axisFrom + Math.max(0, Math.min(MS_DAY, seg.startMs - dayStart)),
        end: seg.endMs === null ? null : axisFrom + Math.max(0, Math.min(MS_DAY, seg.endMs - dayStart)),
        // DESIGN §2: no colour semantics at L1.
        color: 'var(--lens-mark, #7aa2f7)',
        href: turnHref(b.slug, b.id, b.idx),
        title: `turn ${b.idx} · session ${b.id} · ${fmtStamp(seg.startMs)}`
          + (seg.endMs === null ? ' (one timestamp recorded — drawn as a tick)' : ` → ${fmtClock(seg.endMs)}`),
      });
    }
    for (const u of unders) {
      marks.push({
        lane: band.localDate, kind: 'underline', tone: 'under',
        at: axisFrom + Math.max(0, Math.min(MS_DAY, u.start - dayStart)),
        end: axisFrom + Math.max(0, Math.min(MS_DAY, u.end - dayStart)),
        color: 'var(--lens-underline, #6b7686)',
        href: sessionHref(u.slug, u.id),
        title: `session ${u.id} — ${u.turns} turn${u.turns === 1 ? '' : 's'} recorded in this day`,
      });
    }
  }
  try {
    track(timeline(host, {
      lanes, marks,
      axis: { from: axisFrom, to: axisFrom + MS_DAY },
      gutter: { max: pageMax, label: 'turns' },
      binsCap, info: l1BoundsLedger,
      onMark: (m, ev) => { if (m.href) { ev.preventDefault(); navigate(m.href); } },
    }));
  } catch (e) {
    host.appendChild(h('div', { class: 'lens-card lens-card--error', text: `timeline component unavailable: ${e && e.message}` }));
    for (const band of run.bands) {
      const row = h('div', { class: 'lens-band' },
        h('a', { class: 'lens-band__date', href: withQuery(base, query, { day: band.localDate }) }, dayLabel(band.localDate)),
        h('span', { class: 'lens-band__count', text: `${band.segments.length} turn bar${band.segments.length === 1 ? '' : 's'}` }));
      for (const u of sessionUnderlines(band)) {
        row.appendChild(h('a', { class: 'lens-band__under', href: sessionHref(u.slug, u.id), title: `${u.turns} turns` }, u.id.slice(0, 8)));
      }
      host.appendChild(row);
    }
  }
  return host;
}

/* ---- ?v=memory ---------------------------------------------------------- */

function paintMemory(body, { P, index, slug, indexAvailable = true }) {
  const sessionIndex = new Map();
  for (const c of (index && index.sessions) || []) if (c && c.id) sessionIndex.set(c.id, c.slug);
  for (const c of P.sessions || []) if (c && c.id) sessionIndex.set(c.id, c.slug || slug);

  const rows = memoryRows(P.memory, slug, sessionIndex, { indexAvailable });
  if (!rows.length) {
    body.appendChild(h('p', { class: 'lens-empty', text: 'No memory/*.md files are recorded in this project dir.' }));
    return;
  }
  // `dangling` counts only what the loaded index PROVES absent; an
  // unresolvable id (index fetch failed) is disclosed apart, never counted.
  const dangling = rows.filter((r) => r.originSessionId && !r.resolved && !r.unresolvable).length;
  const unresolvable = rows.filter((r) => r.unresolvable).length;
  // DESIGN §4 one table behaviour — the memory listing is a vtable.
  const el = h('div', { class: 'lens-memtable' });
  mountTable(el, {
    columns: [
      col('name', 'file', { href: (row) => row.rawHref }),
      col('bytes', 'bytes', { type: 'bytes', sum: true, reason: 'file size is not recorded' }),
      col('mtimeMs', 'modified', { type: 'time', reason: 'mtime is not recorded' }),
      col('origin', 'originSessionId', {
        reason: 'no originSessionId is recorded for this file on the project listing',
        render: (v, row) => row.originHref
          ? h('span', {},
            h('a', { href: row.originHref, title: row.originSessionId }, row.originSessionId.slice(0, 8)),
            row.crossProject ? h('span', { class: 'lens-tag', title: `that session's main transcript lives in ${row.resolved.slug}` }, 'other project') : null)
          : row.originSessionId
            ? h('span', { class: 'lens-dangling', title: row.unresolvable
              ? `the frontmatter names ${row.originSessionId}; the store index could not be loaded, so it cannot be resolved right now`
              : `the frontmatter names ${row.originSessionId}; no session with that id is on disk` },
            `${row.originSessionId.slice(0, 8)} — ${row.unresolvable ? 'not resolvable right now' : 'session not on disk'}`)
            : dash(row.note),
      }),
      col('raw', 'raw', { sortable: false, filterable: false, render: (v, row) => h('a', { href: row.rawHref }, 'raw') }),
    ],
    rows: rows.map((r) => ({ ...r, origin: r.originSessionId })),
    sort: [{ key: 'name', dir: 'asc' }],
    footerSums: true,
    emptyLabel: 'no memory files',
  });
  body.appendChild(el);
  body.appendChild(h('p', { class: 'lens-note', text: `${fmtInt(rows.length)} memory file${rows.length === 1 ? '' : 's'} · ${fmtInt(dangling)} originSessionId${dangling === 1 ? '' : 's'} name a session that is not on disk${unresolvable ? ` · ${fmtInt(unresolvable)} not resolvable right now (the store index could not be loaded)` : ''}. Sessions do get deleted; a dangling id is a recorded fact, not an error.` }));
}

/* ---- route registration ------------------------------------------------- */

// One registration path — the injected defineRoute is honoured.
export function register(defineRoute = importedDefineRoute) { defineRoute('/p/:slug', renderProject); }

export { renderProject };
