/**
 * L4 — one agent ("main" = the main thread).   DESIGN §3 (L4), SPEC §7
 * (agents), §8 (images, file paths), §9 (/api/agent, /api/lines).
 *
 * This file owns the PAGE: header facts with sources named, the event strip,
 * the timetable, and the images/files/raw views. The pure data shaping —
 * span pairing, censuses, path harvest, fact descriptors, raw-view windowing
 * — lives in ./l4/analysis.mjs and is re-exported below so its import paths
 * are unchanged.
 *
 * An agent's `cwd` is deliberately absent from the header facts (SPEC §2's
 * phantom-project rule); it stays visible in ?v=raw and at L5.
 */

import { kit, apiUrl } from '../lib/net.mjs';
import { h, s, a, clear, unknown, section, factList } from '../lib/dom.mjs';
import { fmtInt, fmtBytes, fmtDur, fmtLocalTime, tzLabel, toMs, shortId, truncate, spanProps } from '../lib/fmt.mjs';
import { routes } from '../lib/links.mjs';
import { copyLocator } from '../lib/locator.mjs';
import {
  page, errorCard, pendingCard, statHeader, mountCrumbs, handle404,
  registerSiblings, siblingPager,
} from '../lib/chrome.mjs';
import { safeStringify } from '../lib/text.mjs';
import { filtersFromQuery } from '../components/scope.mjs';
import { PAGE_SIZE as ROWS_PAGE } from '../components/rows.mjs';
import { normalizeAgent, agentGlyph, agentTags } from './l3/state.mjs';
import {
  toolHistogram, attributionCensus, census, censusText, pairToolSpans,
  harvestPaths, headerFacts, pickAgentFacts, journalResultFact,
  RAW_WINDOW, RAW_LINE_H, windowFor,
} from './l4/analysis.mjs';

export {
  toolUseIdOf, toolResultIdOf, toolNameOf, pairToolSpans, toolHistogram,
  attributionCensus, census, censusText, harvestPaths, headerFacts,
  pickAgentFacts, journalResultFact, RAW_WINDOW, RAW_LINE_H, windowFor,
} from './l4/analysis.mjs';

/* ============================================================== view == */

const _sessionAgents = new Map();      // `${slug}/${sid}` -> { ids:[agentId…], byId:Map }

/** The session detail's agents[] — sibling order for [ / ] AND the flattened
 *  recorded facts (firstAt/lastAt/queuedAt/attempt/phase/runId/toolUseId/…)
 *  the /api/agent envelope does not carry. One fetch, cached. */
async function siblingAgents(slug, sid, signal) {
  const key = `${slug}/${sid}`;
  if (_sessionAgents.has(key)) return _sessionAgents.get(key);
  const K = await kit();
  try {
    // STALE-RENDER RULE: the caller's render owns this fetch even though the
    // RESULT is a cross-render memo — an aborted call returns null and caches
    // nothing, so no render can poison the cache for the next one.
    const detail = await K.api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}`, null, { signal });
    const agents = (detail?.agents ?? []).filter((x) => x && (x.agentId ?? x.id));
    const byId = new Map(agents.map((x) => [x.agentId ?? x.id, x]));
    const out = { ids: ['main', ...agents.map((x) => x.agentId ?? x.id)], byId };
    _sessionAgents.set(key, out);
    return out;
  } catch { return null; }
}

export async function renderAgent(ctx) {
  const { body } = page(ctx, 'lens-l4');
  const P = ctx.params ?? {};
  const slug = P.slug, sid = P.sid ?? P.id, agentId = P.agentId ?? P.agent;
  const view = ctx.query?.get?.('v') ?? null;
  const K = await kit();
  if (ctx.stale) return;

  mountCrumbs(ctx, [
    { label: 'store', href: routes.store() },
    { label: slug ?? 'project', href: routes.project(slug) },
    { label: `session ${shortId(sid)}`, sub: sid, href: routes.session(slug, sid) },
    { label: agentId === 'main' ? 'main thread' : `agent ${shortId(agentId)}`, sub: agentId === 'main' ? '' : agentId },
  ]);

  // DESIGN §7: chrome first.
  statHeader(ctx, { pending: true });

  let payload;
  try {
    payload = await K.api(`/api/agent/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/${encodeURIComponent(agentId)}`,
      { from: 0, count: ROWS_PAGE }, { signal: ctx.signal });
  } catch (err) {
    // STALE-RENDER RULE: FIRST statement of the catch, ahead of handle404 — a
    // stale 404 continuation banners and NAVIGATES, yanking the reader off the
    // page they are on. The AbortError from the `signal` above lands here too,
    // and returns without painting an error card for a superseded render.
    if (ctx.stale) return;
    // DESIGN §0: an unknown agent inside a real session resolves to the session.
    if (handle404(ctx, err, { slug, sid, thing: `agent ${shortId(agentId)}` })) return;
    body.appendChild(errorCard(err, { retry: () => renderAgent(ctx) }));
    return;
  }
  if (ctx.stale) return;
  // pendingCard -> ctx.loading() -> replace(ctx.el, …) and ctx.el IS
  // shell.contentEl, so a stale pending envelope blanks the live page.
  if (payload?.pending) { pendingCard(ctx, payload.pending, () => renderAgent(ctx)); return; }

  const rows = payload.rows ?? [];
  const total = payload.total ?? payload.rowsTotal ?? rows.length;
  const rel = payload.rel ?? payload.file ?? payload.agent?.rel ?? rows[0]?.file ?? null;
  // The session detail's agents[] carry the flattened recorded facts the
  // /api/agent envelope does not (firstAt/lastAt/queuedAt/attempt/phase/…).
  // Same server, same recorded fields — merged in FIRST so the agent
  // envelope's own fields still win where both exist.
  const sibs = await siblingAgents(slug, sid, ctx.signal);
  if (ctx.stale) return; // the SECOND await needs its own stale check
  const detailFacts = agentId !== 'main' && sibs ? pickAgentFacts(sibs.byId.get(agentId)) : {};
  // Explicit key pick — envelope fields outside AGENT_FACT_KEYS (e.g. a
  // future session-level `state`) can never leak into the signature; an
  // explicit payload.agent object still wins over everything.
  const ag = normalizeAgent({ ...detailFacts, ...pickAgentFacts(payload), ...(payload.agent ? pickAgentFacts(payload.agent) : {}), agentId });
  const agg = payload.agg ?? payload.cost ?? null; // server attaches `agg` (SPEC §9)
  const isMain = agentId === 'main';

  ctx.setTitle?.(`${isMain ? 'main thread' : `agent ${shortId(agentId)}`} · ${shortId(sid)} — Claude Playback Lens`);

  // The header cell claims the AGENT total only when a recorded census covers
  // the whole transcript; a 300-row page histogram is page-local and must not
  // wear the agent-total label.
  const censusToolCalls = payload.toolCalls ?? ag.toolCalls ?? null;
  const pageToolCalls = toolHistogram(rows).reduce((n, [, c]) => n + c, 0);
  const toolsCell = censusToolCalls !== null
    ? { key: 'tools', label: 'tool calls', value: censusToolCalls }
    : (rows.length >= total
      ? { key: 'tools', label: 'tool calls', value: pageToolCalls }
      : { key: 'tools', label: 'tool calls', value: null, reason: `not reported by this payload; the histogram below covers the ${fmtInt(rows.length)} loaded rows of ${fmtInt(total)} only` });
  statHeader(ctx, {
    agg,
    scope: `agent:${slug}/${sid}/${agentId}`,
    subject: isMain ? `the main thread of session ${shortId(sid)}` : `agent ${shortId(agentId)} of session ${shortId(sid)}`,
    sentenceCounts: [{ n: total, noun: 'row' }],
    rule: isMain
      ? `every row of ${rel ?? 'its transcript'} in file order, across all turns; agent transcripts are separate files and are not included here`
      : `every row of its own transcript (${rel ?? 'path not reported'}) in file order; its bar is its own first/last timestamp — an async agent outlives its parent's tool_result and is never bounded by it (SPEC §7)`,
    filters: filtersFromQuery(ctx.query),
    // The cost panel's printed interval resolves at this agent's
    // recorded first timestamp — never at render time.
    at: ag.firstAt,
    span: spanProps(ag.firstAt, ag.lastAt, 'wall'),
    counts: [
      { key: 'rows', label: 'rows', value: total },
      toolsCell,
    ],
    footnote: { requests: agg?.requests ?? null, rowsSumToHeader: payload.rowsSumToHeader },
  });
  // The state is a glyph with a named source, not a number — it belongs in the
  // recorded-facts list below, never in a count cell.

  // [ / ] prev/next agent.
  let prevHref = null, nextHref = null;
  if (payload.prevAgentId) prevHref = routes.agent(slug, sid, payload.prevAgentId, viewQuery(view));
  if (payload.nextAgentId) nextHref = routes.agent(slug, sid, payload.nextAgentId, viewQuery(view));
  const sibIds = sibs && sibs.ids;
  if (sibIds && (!prevHref || !nextHref)) {
    const i = sibIds.indexOf(agentId);
    if (i > 0 && !prevHref) prevHref = routes.agent(slug, sid, sibIds[i - 1], viewQuery(view));
    if (i !== -1 && i < sibIds.length - 1 && !nextHref) nextHref = routes.agent(slug, sid, sibIds[i + 1], viewQuery(view));
  }
  registerSiblings(ctx, { prev: prevHref, next: nextHref, label: 'agent' });
  // DESIGN §5: `t` cycles this level's views, `\` opens the raw JSON.
  ctx.registerViews?.(L4_VIEWS);
  if (rel) ctx.registerRaw?.(routes.agent(slug, sid, agentId, { v: 'raw' }));
  body.appendChild(h('div', { class: 'lens-l4__bar' },
    viewTabs(slug, sid, agentId, view),
    siblingPager(prevHref, nextHref, {
      prevLabel: 'prev agent', nextLabel: 'next agent',
      endReason: sibs ? 'no further agent in this session\'s recorded order' : 'the sibling list is not available from this payload',
    })));

  // ---- header facts (all views)
  if (!isMain) body.appendChild(headerSection(ag, payload, { slug, sid }));
  else body.appendChild(mainFactsSection(payload, { slug, sid, rel }));

  if (ctx.stale) return;
  switch (view) {
    case 'raw': await renderRawView(body, { ctx, slug, sid, agentId, rel }); return;
    case 'images': await renderImagesView(body, { slug, sid, agentId, rel, rows, total }); return;
    case 'files': renderFilesView(body, { slug, sid, agentId, rows, total }); return;
    default: break;
  }

  // ---- strip + timetable (default view)
  body.appendChild(stripSection(rows, ag, { slug, sid, agentId }));

  const paneHost = h('div', { class: 'lens-l4__timetable' });
  body.appendChild(section('timetable', paneHost));
  const fetchPage = async (arg, maybeCount) => {
    const from = typeof arg === 'object' && arg !== null ? (arg.from ?? 0) : (arg ?? 0);
    const count = typeof arg === 'object' && arg !== null ? (arg.count ?? ROWS_PAGE) : (maybeCount ?? ROWS_PAGE);
    if (from === 0 && rows.length && count <= rows.length) return { rows: rows.slice(0, count), from, count, total, rel };
    const p = await K.api(`/api/agent/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/${encodeURIComponent(agentId)}`, { from, count }, { signal: ctx.signal });
    return { rows: p.rows ?? [], from, count, total: p.total ?? p.rowsTotal ?? total, rel: p.rel ?? rel };
  };
  const kinds = ctx.query?.get?.('k') ?? null;
  if (!K.rowsPane) {
    paneHost.appendChild(errorCard({ code: 'rows-pane-missing', message: 'components/rows.mjs did not load — the timetable cannot render.' }));
    return;
  }
  const pane = K.rowsPane(paneHost, {
    fetchPage, kinds,
    // A REAL expander — /api/line for the addressed row, never a permanent
    // "fetching…" that resolves nothing.
    onExpand: async (row) => {
      const file = row.file ?? rel;
      if (!file) return h('p', { class: 'lens-note', text: 'no transcript path available for this row' });
      const line = await K.api('/api/line', { slug, id: sid, file, line: row.line }, { signal: ctx.signal });
      const ev = line.event ?? line.value ?? (typeof line.raw === 'string' ? tryParseJson(line.raw) : line.raw);
      return h('pre', { class: 'lens-json', text: safeStringify(ev) });
    },
    // `{}` → L5 for every row with a recorded line.
    locatorHref: (r) => (Number.isFinite(r.line) ? routes.event(slug, sid, agentId, r.line, r.bi ?? null) : null),
    // `?k` is the address of the kind filter.
    onKinds: (v) => {
      const q = new URLSearchParams(ctx.query?.toString?.() ?? '');
      if (v) q.set('k', v); else q.delete('k');
      const qs = q.toString();
      ctx.navigate?.(`#${ctx.path}${qs ? `?${qs}` : ''}`);
    },
    findScope: `agent:${slug}/${sid}/${agentId}`,
  });
  ctx.registerFind?.(() => pane.openFilter?.() ?? false);
}

function tryParseJson(t) { try { return JSON.parse(t); } catch { return t; } }

/** DESIGN §3 L4 — the view set, in `t`-cycle order. */
export const L4_VIEWS = [
  { key: 'timetable', label: 'timetable' },
  { key: 'images', label: 'images' },
  { key: 'files', label: 'files' },
  { key: 'raw', label: 'raw' },
];

function viewQuery(view) { return view ? { v: view } : {}; }

function viewTabs(slug, sid, agentId, view) {
  const tabs = [[null, 'timetable'], ['images', 'images'], ['files', 'files'], ['raw', 'raw']];
  return h('nav', { class: 'lens-tabs' }, tabs.map(([v, label]) =>
    v === (view ?? null)
      ? h('span', { class: 'lens-tabs__tab lens-tabs__tab--current', text: label })
      : a(routes.agent(slug, sid, agentId, v ? { v } : {}), label, { class: 'lens-link lens-tabs__tab' })));
}

function headerSection(ag, payload, { slug, sid }) {
  const sec = section('recorded facts');
  const worktreeOnDisk = payload.worktreeOnDisk ?? payload.worktreeExists ?? null;
  const facts = headerFacts({ ...ag, promptTag: payload.promptTag ?? payload.agentTag ?? null, resolvedModel: payload.resolvedModel ?? ag.raw?.resolvedModel ?? null, effortCensus: payload.effortCensus ?? censusTextOf(payload.rows, (r) => r.extra?.effort) }, { worktreeOnDisk });

  const dl = factList(facts);
  sec.appendChild(dl);

  // Links that need routing, appended as their own rows.
  const extras = [];
  if (ag.parentAgentId) extras.push(h('div', { class: 'lens-facts__link' }, h('span', { text: 'parent → ' }), a(routes.agent(slug, sid, ag.parentAgentId), ag.parentAgentId)));
  if (ag.toolUseId && ag.spawnLine) extras.push(h('div', { class: 'lens-facts__link' }, h('span', { text: 'spawn tool_use → ' }), a(routes.event(slug, sid, 'main', ag.spawnLine, null), `main line ${fmtInt(ag.spawnLine)}`)));
  else if (ag.toolUseId) extras.push(h('div', { class: 'lens-facts__link' }, h('span', { text: 'spawn tool_use → ' }), a(routes.find({ q: ag.toolUseId, scope: `session:${slug}/${sid}` }), `find ${ag.toolUseId} in this session`)));
  if (ag.runId) extras.push(h('div', { class: 'lens-facts__link' }, h('span', { text: 'workflow run → ' }), a(routes.workflow(slug, sid, ag.runId), ag.runId)));
  if (extras.length) sec.append(...extras);

  // Glyph provenance.
  const gl = agentGlyph({ ...ag, journal: payload.journal ?? ag.journal });
  sec.appendChild(h('p', { class: 'lens-note', text: `state glyph ${gl.glyph} — ${gl.label}${gl.source ? ` · source: ${gl.source}` : ' · nothing recorded a state for this agent'}` }));
  for (const tag of agentTags(ag)) sec.appendChild(h('span', { class: `lens-chip lens-chip--${tag.key}`, title: tag.title, text: tag.text }));

  // Censuses over the loaded rows.
  const rows = payload.rows ?? [];
  const hist = toolHistogram(rows);
  const attribs = attributionCensus(hist);
  const stops = census(rows.filter((r) => r.kind === 'text' || r.kind === 'thinking' || r.extra?.stopReason !== undefined), (r) => r.extra?.stopReason);
  const loadedNote = (payload.total ?? rows.length) > rows.length
    ? ` (over the ${fmtInt(rows.length)} rows loaded of ${fmtInt(payload.total)} — page on to widen the census)` : '';

  sec.appendChild(factList([
    { label: 'stop_reasons', value: censusText(stops) ?? null, source: `recorded stop_reason on assistant rows${loadedNote}`, reason: 'no stop_reason recorded on the loaded rows' },
    { label: 'tool histogram', value: hist.length ? hist.map(([n, c]) => `${n} ${fmtInt(c)}`).join(' · ') : null, source: `recorded tool_use names${loadedNote}`, reason: 'this transcript records no tool_use rows' },
    { label: 'MCP servers', value: attribs.mcp.length ? attribs.mcp.map(([n, c]) => `${n} ${fmtInt(c)}`).join(' · ') : null, source: 'tool names of the form mcp__<server>__<tool>', reason: 'no MCP tool call recorded on the loaded rows' },
    { label: 'skills', value: attribs.skills.length ? attribs.skills.map(([n, c]) => `${n} ${fmtInt(c)}`).join(' · ') : null, source: 'recorded Skill tool calls', reason: 'no Skill tool call recorded on the loaded rows' },
    { label: 'structured output', value: payload.structuredOutput ? safeStringify(payload.structuredOutput) : null, source: 'recorded structured output', reason: 'not recorded for this agent' },
    journalResultFact(payload.journal ?? ag.journal, ag.stateFacts ?? null),
    { label: 'peer messages', value: peerText(rows), source: 'origin.kind peer/coordinator with origin.senderTaskId', reason: 'no peer or coordinator continuation recorded on the loaded rows' },
  ]));
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: 'cwd is deliberately not a header fact here: an agent\'s cwd is never a project signal (a worktree would invent a phantom project — SPEC §2). It stays visible in ?v=raw and at L5.',
  }));
  return sec;
}

function censusTextOf(rows, pick) {
  if (!rows?.length) return null;
  return censusText(census(rows, pick));
}

function peerText(rows) {
  const peers = rows.filter((r) => {
    const k = r.extra?.origin?.kind ?? r.extra?.originKind ?? null;
    return k === 'peer' || k === 'coordinator';
  });
  if (!peers.length) return null;
  const senders = new Map();
  for (const p of peers) {
    const sender = p.extra?.origin?.senderTaskId ?? p.extra?.senderTaskId ?? '(sender not recorded)';
    senders.set(sender, (senders.get(sender) ?? 0) + 1);
  }
  return [...senders.entries()].map(([k, n]) => `${k} ${fmtInt(n)}`).join(' · ');
}

function mainFactsSection(payload, { slug, sid, rel }) {
  return section('recorded facts', factList([
    { label: 'transcript', value: rel, source: 'the session\'s main .jsonl', reason: 'this payload reports no path' },
    { label: 'rows', value: fmtInt(payload.total ?? payload.rows?.length ?? null), source: 'parsed rows of the main transcript', reason: 'not reported' },
    { label: 'turns', value: fmtInt(payload.turnCount ?? null), source: 'R-T applied to this file (SPEC §4)', reason: 'not reported on this payload' },
  ]), h('p', {
    class: 'lens-note',
    text: 'The main transcript may be a minority of the session\'s bytes (as low as 1%) — agent transcripts are about half the corpus. It is never "the session" (SPEC §2).',
  }));
}

/* ------------------------------------------------------------ strip */

function stripSection(rows, ag, { slug, sid, agentId }) {
  const sec = section('event strip');
  const { spans, unmatchedUses, unmatchedResults } = pairToolSpans(rows);
  const times = rows.map((r) => toMs(r.at)).filter((t) => t !== null);
  if (!times.length) {
    sec.appendChild(h('p', { class: 'lens-note', text: 'no row of this transcript records a timestamp, so no strip can be drawn (DESIGN §2: no invented geometry).' }));
    return sec;
  }
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const span = Math.max(1, t1 - t0);
  const W = 980, H = 96;
  const x = (t) => ((t - t0) / span) * (W - 20) + 10;

  const svg = s('svg', { class: 'lens-strip', width: '100%', height: String(H), viewBox: `0 0 ${W} ${H}` });
  // Lane 1 — tool spans.
  svg.appendChild(s('text', { x: '4', y: '14', class: 'lens-strip__lane', text: `tool spans (${fmtInt(spans.length)})` }));
  for (const sp of spans) {
    if (sp.startAt === null) continue;
    const href = sp.startLine !== null ? routes.event(slug, sid, agentId, sp.startLine, sp.startBi) : null;
    const title = `${sp.name ?? 'tool'}${sp.id ? ` · id ${sp.id}` : ' · no id recorded'}\n` +
      (sp.matched
        ? `${fmtLocalTime(sp.startAt)} → ${sp.endAt === null ? 'result recorded without a timestamp' : fmtLocalTime(sp.endAt)}${sp.endAt !== null ? ` · ${fmtDur(sp.endAt - sp.startAt)}` : ''}${sp.isError === true ? ' · is_error true' : ''}`
        : `no tool_result carries this id${sp.denialKind ? ` · toolDenialKind ${sp.denialKind}` : ''}`);
    const gnode = s('g', {}, s('title', { text: title }));
    if (sp.matched && sp.endAt !== null) {
      gnode.appendChild(s('rect', {
        x: String(x(sp.startAt)), y: '20', width: String(Math.max(1.5, x(sp.endAt) - x(sp.startAt))), height: '12',
        class: `lens-strip__span${sp.isError === true ? ' lens-strip__span--error' : ''}`,
      }));
    } else {
      // Unmatched = tick + ∅ (DESIGN §3 L4). No invented width.
      gnode.appendChild(s('rect', { x: String(x(sp.startAt)), y: '20', width: '2', height: '12', class: 'lens-strip__tick lens-strip__tick--unmatched' }));
      gnode.appendChild(s('text', { x: String(x(sp.startAt) + 3), y: '31', class: 'lens-strip__empty', text: '∅' }));
    }
    svg.appendChild(href ? s('a', { href }, gnode) : gnode);
  }
  // Lane 2 — thinking/text ticks (zero width).
  svg.appendChild(s('text', { x: '4', y: '54', class: 'lens-strip__lane', text: 'thinking / text' }));
  for (const r of rows) {
    if (r.kind !== 'thinking' && r.kind !== 'text') continue;
    const t = toMs(r.at);
    if (t === null) continue;
    const node = s('rect', { x: String(x(t)), y: '58', width: '2', height: '10', class: `lens-strip__tick lens-strip__tick--${r.kind}` },
      s('title', { text: `${r.kind} · line ${r.line} · ${fmtLocalTime(t)}` }));
    svg.appendChild(r.line !== undefined ? s('a', { href: routes.event(slug, sid, agentId, r.line, r.bi ?? null) }, node) : node);
  }
  // Lane 3 — image markers.
  const images = rows.filter((r) => r.kind === 'image');
  svg.appendChild(s('text', { x: '4', y: '86', class: 'lens-strip__lane', text: `images (${fmtInt(images.length)})` }));
  for (const r of images) {
    const t = toMs(r.at);
    if (t === null) continue;
    const node = s('text', { x: String(x(t)), y: '90', class: 'lens-strip__image', text: '▣' },
      s('title', { text: `image · line ${r.line}${r.bi ? `.${r.bi}` : ''} · ${fmtLocalTime(t)}` }));
    svg.appendChild(r.line !== undefined ? s('a', { href: routes.event(slug, sid, agentId, r.line, r.bi ?? null) }, node) : node);
  }
  sec.appendChild(svg);
  sec.appendChild(h('p', { class: 'lens-note', text: `axis in local time (${tzLabel(t0)}) · ${fmtLocalTime(t0)} → ${fmtLocalTime(t1)}` }));

  if (unmatchedUses.length || unmatchedResults.length) {
    sec.appendChild(h('p', {
      class: 'lens-note',
      text: `${fmtInt(unmatchedUses.length)} tool_use row(s) have no tool_result carrying their id, and ${fmtInt(unmatchedResults.length)} tool_result row(s) carry an id no tool_use in this transcript declares. Pairing is by recorded id only — never by adjacency.`,
    }));
    const denials = unmatchedUses.filter((sp) => sp.denialKind);
    if (denials.length) {
      sec.appendChild(h('p', { class: 'lens-note', text: `toolDenialKind recorded on ${fmtInt(denials.length)} of them: ${[...new Set(denials.map((d) => d.denialKind))].join(', ')}.` }));
    }
  }
  return sec;
}

/* ------------------------------------------------------------ ?v=images */

async function renderImagesView(body, { slug, sid, agentId, rel, rows, total }) {
  const images = rows.filter((r) => r.kind === 'image');
  const sec = section(`images — ${fmtInt(images.length)} recorded on the loaded rows`);
  if (rows.length < total) {
    sec.appendChild(h('p', { class: 'lens-note', text: `census over the ${fmtInt(rows.length)} rows loaded of ${fmtInt(total)}.` }));
  }
  if (!images.length) {
    sec.appendChild(h('p', { class: 'lens-note', text: 'this transcript records no image blocks on the loaded rows.' }));
    body.appendChild(sec);
    return;
  }
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: 'Images are decoded on demand by /api/image, which re-reads the addressed line — the transcript itself never ships its base64 (SPEC §1, §8).',
  }));
  // The contact sheet is lens-contact, its own scroll box — never the keyboard
  // overlay's fixed-inset lens-sheet class.
  const grid = h('div', { class: 'lens-contact lens-contact--grid' });
  for (const r of images) {
    const src = rel ? apiUrl('/api/image', { slug, id: sid, file: rel, line: r.line, block: r.bi ?? '' }) : null;
    const at = toMs(r.at);
    grid.appendChild(h('figure', { class: 'lens-contact__tile' },
      src ? h('img', { class: 'lens-contact__img', src, loading: 'lazy', alt: `image at line ${r.line}${r.bi ? `.${r.bi}` : ''}` })
        : unknown('no transcript path available to decode this image from'),
      h('figcaption', { class: 'lens-contact__cap' },
        a(routes.event(slug, sid, agentId, r.line, r.bi ?? null), copyLocator('', r.line, r.bi ?? null)),
        at === null ? unknown('no timestamp recorded') : h('span', { text: fmtLocalTime(at, { date: false }) }),
        h('span', { text: r.extra?.bytes ? fmtBytes(r.extra.bytes) : (r.extra?.base64Length ? `${fmtInt(r.extra.base64Length)} b64 chars` : '') }))));
  }
  sec.appendChild(grid);
  body.appendChild(sec);
}

/* ------------------------------------------------------------ ?v=files */

function renderFilesView(body, { slug, sid, agentId, rows, total }) {
  const harvest = harvestPaths(rows);
  // The title names its denominator — these are the LOADED rows' paths, never
  // presented as the agent's total.
  const sec = section(`files — ${fmtInt(harvest.paths.length)} path(s) on the loaded rows`);
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: `paths come from tool_use.input keyed by tool name (Read/Write/Edit → file_path, NotebookEdit → notebook_path, Glob/Grep → path) unioned with recorded toolUseResult.filePath. ` +
      `Denominator: ${fmtInt(harvest.withPath)} of ${fmtInt(harvest.toolCalls)} tool calls on the loaded rows carry a path key; ${fmtInt(harvest.resultsWithoutSidecar)} tool results carry no path sidecar` +
      `${rows.length < total ? ` · census over ${fmtInt(rows.length)} of ${fmtInt(total)} rows` : ''}. ` +
      `Path-shaped keys inside StructuredOutput/MCP inputs are payload fields, not file operations, and are excluded (SPEC §8).`,
  }));
  if (!harvest.paths.length) {
    sec.appendChild(h('p', { class: 'lens-note' },
      'no file path is recorded on the loaded row heads — the row index carries tool names and ids, not tool inputs (SPEC §9 payload discipline). The session-wide ledger, built from the full recorded inputs, is on ',
      a(routes.session(slug, sid, { v: 'files' }), 'the session files view'), '.'));
    body.appendChild(sec);
    return;
  }
  const t = h('table', { class: 'lens-table' },
    h('thead', {}, h('tr', {},
      h('th', { text: 'path' }), h('th', { class: 'lens-table__num', text: 'read' }),
      h('th', { class: 'lens-table__num', text: 'write' }), h('th', { class: 'lens-table__num', text: 'edit' }),
      h('th', { class: 'lens-table__num', text: 'search' }), h('th', { text: 'first call' }))));
  const tb = h('tbody');
  for (const p of harvest.paths) {
    tb.appendChild(h('tr', {},
      h('td', {}, h('code', { text: p.path })),
      h('td', { class: 'lens-table__num', text: fmtInt(p.read) }),
      h('td', { class: 'lens-table__num', text: fmtInt(p.write) }),
      h('td', { class: 'lens-table__num', text: fmtInt(p.edit) }),
      h('td', { class: 'lens-table__num', text: fmtInt(p.search) }),
      h('td', {}, p.lines.length ? a(routes.event(slug, sid, agentId, p.lines[0], null), `line ${fmtInt(p.lines[0])}`) : unknown('no tool_use line recorded for this path'))));
  }
  t.appendChild(tb);
  sec.appendChild(t);
  body.appendChild(sec);
}

/* ------------------------------------------------------------ ?v=raw */

// CONTRACT-DEVIATION (BUILD-CONTRACTS: "no inline styles except SVG geometry
// and computed/data-driven geometry whose value is the datum"): this function
// sets exactly TWO geometries inline, and each one is a number computed from
// recorded data — the spacer's height (this transcript's total recorded lines
// x RAW_LINE_H) and the window block's top (the visible 500-line window's
// first line x RAW_LINE_H). Both change per session and per scroll position,
// so no static class can carry them. Nothing else here is inline: the
// viewport's 640px scroll box, the fixed row height, and the spacer/block
// position properties are static and live in web/styles.css, under
// `.lens-raw--virt`, `.lens-raw__line--virt`, `.lens-raw__spacer` and
// `.lens-raw__block`. Those classes are scoped to this virtualised view on
// purpose: bare `.lens-raw` / `.lens-raw__line` are shared with the
// inventory's non-virtualised file listing (inv.mjs), which must keep its
// natural flow height.
async function renderRawView(body, { ctx, slug, sid, agentId, rel }) {
  const K = await kit();
  if (ctx?.stale) return;
  const sec = section('raw JSONL');
  body.appendChild(sec);
  if (!rel) {
    sec.appendChild(unknown('this payload reports no transcript path, so no window can be requested'));
    return;
  }
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: `${rel} — served in ${RAW_WINDOW}-line windows by /api/lines; line numbers are 1-based, as an editor shows them (SPEC §1).`,
  }));

  let first;
  try { first = await K.api('/api/lines', { slug, id: sid, file: rel, from: 1, count: RAW_WINDOW }, { signal: ctx?.signal }); }
  catch (err) { if (ctx?.stale) return; sec.appendChild(errorCard(err)); return; }
  if (ctx?.stale) return;
  const total = first.total ?? first.lines?.length ?? 0;

  const jump = h('input', { class: 'lens-input', type: 'number', min: '1', max: String(total || 1), value: '1', 'aria-label': 'jump to line' });
  const status = h('span', { class: 'lens-raw__status' });
  sec.appendChild(h('div', { class: 'lens-raw__tools' },
    h('span', { text: `${fmtInt(total)} lines` }), jump,
    h('button', { class: 'lens-btn', text: 'go', onclick: () => scrollToLine(Number(jump.value)) }),
    status,
    a(apiUrl('/api/file', { slug, id: sid, rel }), 'download raw file', { target: '_blank', rel: 'noreferrer' })));

  const viewport = h('div', { class: 'lens-raw lens-raw--virt' });
  const spacer = h('div', { class: 'lens-raw__spacer', style: `height:${Math.max(1, total) * RAW_LINE_H}px` });
  viewport.appendChild(spacer);
  sec.appendChild(viewport);

  const cache = new Map([[1, first.lines ?? []]]);
  let painted = null;

  const paint = async () => {
    const firstVisible = Math.floor(viewport.scrollTop / RAW_LINE_H) + 1;
    const win = windowFor(firstVisible);
    if (painted === win.from) return;
    painted = win.from;
    if (!cache.has(win.from)) {
      status.textContent = `loading lines ${fmtInt(win.from)}–${fmtInt(Math.min(total, win.from + RAW_WINDOW - 1))}…`;
      try {
        const p = await K.api('/api/lines', { slug, id: sid, file: rel, from: win.from, count: RAW_WINDOW }, { signal: ctx?.signal });
        cache.set(win.from, p.lines ?? []);
      } catch (err) {
        status.textContent = `window ${win.from} failed: ${err?.message ?? err}`;
        return;
      }
    }
    status.textContent = `lines ${fmtInt(win.from)}–${fmtInt(Math.min(total, win.from + RAW_WINDOW - 1))} of ${fmtInt(total)}`;
    clear(spacer);
    const block = h('div', { class: 'lens-raw__block', style: `top:${(win.from - 1) * RAW_LINE_H}px` });
    (cache.get(win.from) ?? []).forEach((text, i) => {
      const lineNo = win.from + i;
      block.appendChild(h('div', { class: 'lens-raw__line lens-raw__line--virt' },
        a(routes.event(slug, sid, agentId, lineNo, null), String(lineNo), { class: 'lens-raw__no' }),
        h('code', { class: 'lens-raw__text', text: truncate(text, 400) })));
    });
    spacer.appendChild(block);
  };
  const scrollToLine = (n) => {
    if (!Number.isFinite(n) || n < 1) return;
    viewport.scrollTop = (n - 1) * RAW_LINE_H;
    paint();
  };
  let ticking = false;
  viewport.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; paint(); });
  });
  await paint();
}

/* ---------------------------------------------------------------- routes */

export const routeList = [['/p/:slug/s/:sid/a/:agentId', renderAgent]];
export function register(defineRoute) {
  for (const [p, r] of routeList) {
    try { defineRoute(p, r); } catch (err) { console.error('defineRoute failed', p, err); }
  }
}
