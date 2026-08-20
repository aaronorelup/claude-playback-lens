// web/js/views/l3/turnpage.mjs — the L3 page: fetch /api/turn, mount the
// prompt card, lanes, orchestration tree and timetable pane, and register the
// /p/:slug/s/:sid/t/:idx route. Models come from ./lanes.mjs and ./state.mjs;
// SVG drawing from ./svg.mjs.

import { kit } from '../../lib/net.mjs';
import { h, s, a, clear, unknown, section } from '../../lib/dom.mjs';
import { fmtInt, fmtDur, fmtLocalTime, tzLabel, toMs, shortId, spanProps } from '../../lib/fmt.mjs';
import { routes } from '../../lib/links.mjs';
import {
  page, errorCard, pendingCard, statHeader, mountCrumbs, handle404,
  registerSiblings, siblingPager,
} from '../../lib/chrome.mjs';
import { textBody, safeStringify, getPref, setPref } from '../../lib/text.mjs';
import { filtersFromQuery } from '../../components/scope.mjs';
import { PAGE_SIZE as ROWS_PAGE } from '../../components/rows.mjs';
import { agentGlyph } from './state.mjs';
import { buildLanes, laneBounds, buildTree, parseSel, hasNextTurn, firstNum, AUTO_COLLAPSE_AGENTS } from './lanes.mjs';
import { laneSvg, axisStrip, occupancyStrip, xOf, LANE_LABEL_W, TRACK_W, GLYPH_W } from './svg.mjs';

export async function renderTurn(ctx) {
  const { body } = page(ctx, 'lens-l3');
  const P = ctx.params ?? {};
  const slug = P.slug, sid = P.sid ?? P.id;
  const idx = Number(P.idx);
  const K = await kit();
  if (ctx.stale) return;

  mountCrumbs(ctx, [
    { label: 'store', href: routes.store() },
    { label: slug ?? 'project', href: routes.project(slug) },
    { label: `session ${shortId(sid)}`, sub: sid, href: routes.session(slug, sid) },
    { label: Number.isFinite(idx) && idx === 0 ? 'preamble' : `turn ${idx}` },
  ]);

  if (!Number.isFinite(idx) || idx < 0) {
    body.appendChild(errorCard({ status: 400, code: 'bad-turn-index', message: `"${P.idx}" is not a turn index. idx is the sole addressable index; the preamble is 0 (SPEC §4).` }));
    return;
  }

  // DESIGN §7: chrome first — '—' pips at final widths while fetching.
  statHeader(ctx, { pending: true });

  let payload;
  try {
    payload = await K.api(`/api/turn/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/${idx}`,
      null, { signal: ctx.signal });
  } catch (err) {
    // STALE-RENDER RULE: a superseded render must stop HERE, ahead of
    // handle404 — a stale 404 continuation does not merely mislabel the page,
    // it banners and navigates the reader off the page they are on. With the
    // `signal` above, an abandoned fetch's AbortError lands here too and
    // returns without painting an error card for a render nobody is watching.
    if (ctx.stale) return;
    // DESIGN §0: within-pattern unknowns (bad sid, past-the-end turn) resolve to
    // the nearest ancestor with a banner; 400/403 keep the error card.
    if (handle404(ctx, err, { slug, sid, thing: `turn ${idx}` })) return;
    body.appendChild(errorCard(err, { retry: () => renderTurn(ctx) }));
    return;
  }
  if (ctx.stale) return;
  // pendingCard -> ctx.loading() -> replace(ctx.el, …), and ctx.el IS
  // shell.contentEl, so a stale pending envelope blanks the live page.
  if (payload?.pending) { pendingCard(ctx, payload.pending, () => renderTurn(ctx)); return; }

  const turn = payload.turn ?? payload;
  const agentsRaw = payload.agents ?? turn.agents ?? [];
  const workflows = payload.workflows ?? turn.workflows ?? [];
  // `turnCount` is the payload's OWN field, nothing else. The server pins it
  // as the count of non-preamble turns, which (preamble = idx 0) equals the
  // LAST ADDRESSABLE idx — so `]` exists iff idx + 1 <= turnCount.
  const turnCount = firstNum(payload.turnCount) ?? null;
  const preamble = turn.preamble === true || idx === 0;

  const model = buildLanes({ turnIdx: idx, agents: agentsRaw, workflows });
  const bounds = laneBounds({ turn, agents: model.agents });
  // The main-thread mini strip: the turn bar itself (SPEC §4 bounds ledger —
  // opener timestamp → max over the turn's conversation rows only).
  const turnStart = toMs(turn.at), turnEnd = toMs(turn.endAt ?? turn.endedAt);
  model.mainSpan = (turnStart !== null && turnEnd !== null && turnEnd >= turnStart) ? [turnStart, turnEnd] : null;
  model.turnAt = turnStart;
  const agg = payload.agg ?? payload.cost ?? turn.agg ?? turn.cost ?? null; // server attaches `agg` (SPEC §9)

  ctx.setTitle?.(`turn ${idx} · ${shortId(sid)} — Claude Playback Lens`);

  // Bands 2+3 — the scope sentence states the attribution rule (DESIGN §3),
  // in generated parts: subject / recorded counts / rule / filters from the
  // query — never one opaque prose blob.
  statHeader(ctx, {
    agg,
    scope: `turn:${slug}/${sid}/${idx}`,
    subject: preamble
      ? `the preamble (turn 0) of session ${shortId(sid)}`
      : `turn ${idx} of session ${shortId(sid)}`,
    sentenceCounts: [
      { n: model.agentCount, noun: 'agent' },
      { n: model.groups.filter((g) => g.kind === 'run').length, noun: 'workflow run' },
    ],
    rule: (preamble ? 'the preamble is every row before the first human opener (R-T). ' : '')
      + 'An agent belongs to the turn containing its spawning tool_use line (transitively at depth ≥2); a resumed run stays with the turn of its FIRST spawning call; '
      + 'an agent with no recorded spawn edge falls back to the turn whose time window contains its first timestamp (SPEC §7)',
    filters: filtersFromQuery(ctx.query),
    // The R10 interval in the cost panel resolves at THIS turn's
    // recorded timestamp — never at render time.
    at: toMs(turn.at),
    span: spanProps(toMs(turn.at), toMs(turn.endAt ?? turn.endedAt), 'wall'),
    counts: [
      { key: 'agents', label: 'agents', value: model.agentCount },
      { key: 'workflows', label: 'workflows', value: model.groups.filter((g) => g.kind === 'run').length },
      { key: 'rows', label: 'rows', value: firstNum(payload.rowsTotal, turn.rowCount, payload.rows?.length), reason: 'this payload does not report a row total for the turn' },
    ],
    footnote: { requests: agg?.requests ?? null, rowsSumToHeader: payload.rowsSumToHeader },
  });

  // [ / ] prev-next turn (DESIGN §5). `]` renders ONLY when the payload
  // proves a next turn exists — an unknown count disables it with the reason,
  // it never navigates into a 404.
  const prevHref = idx > 0 ? routes.turn(slug, sid, idx - 1, currentQuery(ctx)) : null;
  const nextHref = hasNextTurn(idx, turnCount) ? routes.turn(slug, sid, idx + 1, currentQuery(ctx)) : null;
  registerSiblings(ctx, { prev: prevHref, next: nextHref, label: 'turn' });
  body.appendChild(siblingPager(prevHref, nextHref, {
    prevLabel: 'prev turn', nextLabel: 'next turn',
    endReason: !nextHref && idx === 0 && turnCount === null
      ? 'this payload reports no turn count, so a next turn cannot be proven to exist'
      : idx === 0 ? 'the preamble is the first addressable turn (SPEC §4)'
        : turnCount === null ? 'this payload reports no turn count, so a next turn cannot be proven to exist'
          : 'this is the last recorded turn of the session',
  }));

  // ---- prompt card
  body.appendChild(promptCard(turn, { slug, sid, idx, preamble, signal: ctx.signal }));

  // ---- lanes + tree + timetable
  const zeroAgents = model.agentCount === 0 && model.referenceRows.length === 0;
  if (zeroAgents) {
    // DESIGN §3: 0-agent turns collapse lanes+tree entirely; the timetable
    // takes full width with an explicit `0 agents`.
    body.appendChild(h('p', { class: 'lens-l3__noagents', text: '0 agents — this turn spawned none, so the lane chart and orchestration tree are omitted (they would have nothing to show).' }));
    const pane = h('div', { class: 'lens-l3__timetable lens-l3__timetable--full' });
    body.appendChild(section('timetable · main-thread rows of this turn', pane));
    if (ctx.stale) return;
    await mountTimetable(pane, { ctx, slug, sid, idx, sel: { kind: 'main' }, payload });
    return;
  }

  body.appendChild(lanesSection(model, bounds, { slug, sid, idx }));

  const split = h('div', { class: 'lens-l3__split' });
  const treeHost = h('div', { class: 'lens-l3__tree' });
  const paneHost = h('div', { class: 'lens-l3__timetable' });
  split.append(treeHost, paneHost);
  body.appendChild(split);

  const selRaw = ctx.query?.get?.('sel') ?? null;
  const sel = parseSel(selRaw);
  treeHost.appendChild(treeView(buildTree(model), sel, { ctx, slug, sid, idx, formatUsd: K.formatUsd }));
  if (ctx.stale) return;
  await mountTimetable(paneHost, { ctx, slug, sid, idx, sel, payload, model });
}

function currentQuery(ctx) {
  const q = {};
  for (const key of ['k', 'q', 'v', 'sel']) {
    const v = ctx.query?.get?.(key);
    if (v) q[key] = v;
  }
  delete q.sel;   // selection is per-turn
  return q;
}

/* ------------------------------------------------------------ prompt card */

function promptCard(turn, { slug, sid, idx, preamble, signal }) {
  const head = turn.promptHead ?? turn.head ?? turn.prompt ?? null;
  const openerLine = firstNum(turn.openerLine, turn.line);
  const at = toMs(turn.at);
  const card = h('section', { class: 'lens-prompt' });
  card.appendChild(h('div', { class: 'lens-prompt__meta' },
    h('span', { class: 'lens-prompt__idx', text: preamble ? 'preamble' : `turn ${idx}` }),
    at === null ? unknown('no timestamp recorded on the opener') : h('span', { class: 'lens-prompt__at', text: `${fmtLocalTime(at)} (${tzLabel(at)})` }),
    openerLine !== null ? a(routes.event(slug, sid, 'main', openerLine, null), `line ${fmtInt(openerLine)}`) : unknown('no opener line recorded')));

  if (preamble) {
    card.appendChild(h('p', { class: 'lens-note', text: 'Everything before the first human opener (R-T). The preamble has no prompt of its own.' }));
  }
  if (head === null && !preamble) {
    card.appendChild(unknown('no prompt head recorded on this turn payload'));
  } else if (head !== null) {
    const pre = h('pre', { class: 'lens-prompt__head', text: String(head) });
    card.appendChild(pre);
    if (openerLine !== null) {
      const full = h('div', { class: 'lens-prompt__full', hidden: true });
      const btn = h('button', {
        class: 'lens-btn', text: 'expand verbatim',
        onclick: async () => {
          if (!full.hidden) { full.hidden = true; btn.textContent = 'expand verbatim'; return; }
          full.hidden = false; btn.textContent = 'collapse';
          if (full.dataset.loaded) return;
          full.dataset.loaded = '1';
          full.appendChild(h('p', { class: 'lens-note', text: 'loading the opener line…' }));
          try {
            const K = await kit();
            const rel = (await resolveMainRel(slug, sid, signal)) ?? null;
            if (!rel) { clear(full).appendChild(unknown('no main-transcript path available to read the opener from')); return; }
            const line = await K.api('/api/line', { slug, id: sid, file: rel, line: openerLine }, { signal });
            clear(full);
            const ev = line.event ?? line.value ?? (typeof line.raw === 'string' ? JSON.parse(line.raw) : line.raw);
            const content = ev?.message?.content;
            const text = typeof content === 'string' ? content
              : Array.isArray(content) ? content.filter((b) => b?.type === 'text' || typeof b === 'string').map((b) => (typeof b === 'string' ? b : b.text)).join('\n\n')
                : null;
            if (text === null) {
              full.appendChild(h('p', { class: 'lens-note', text: 'the opener records no text block; the whole event is below.' }));
              full.appendChild(h('pre', { class: 'lens-json', text: safeStringify(ev) }));
            } else {
              full.appendChild(textBody(text, { prefKey: 'markdown.prompt' }));
              if (Array.isArray(content)) {
                const others = content.filter((b) => b?.type && b.type !== 'text');
                if (others.length) full.appendChild(h('p', { class: 'lens-note', text: `plus ${fmtInt(others.length)} non-text block(s) on this opener: ${others.map((b) => b.type).join(', ')} — open the event to address them.` }));
              }
            }
            full.appendChild(a(routes.event(slug, sid, 'main', openerLine, null), `open line ${fmtInt(openerLine)}`));
          } catch (err) {
            clear(full).appendChild(errorCard(err));
          }
        },
      });
      card.append(btn, full);
    }
  }
  return card;
}

const _mainRel = new Map();
async function resolveMainRel(slug, sid, signal) {
  const key = `${slug}/${sid}`;
  if (_mainRel.has(key)) return _mainRel.get(key);
  const K = await kit();
  try {
    // STALE-RENDER RULE: the requesting render owns the fetch. Only a
    // resolved rel is memoised, so an aborted call caches nothing.
    const p = await K.api(`/api/agent/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/main`, { from: 0, count: 1 }, { signal });
    const rel = p?.rel ?? p?.file ?? p?.rows?.[0]?.file ?? null;
    if (rel) _mainRel.set(key, rel);
    return rel;
  } catch { return null; }
}

/* ------------------------------------------------------------ lanes */

function lanesSection(model, bounds, { slug, sid, idx }) {
  const sec = section('lanes');
  if (!bounds) {
    sec.appendChild(h('p', { class: 'lens-note', text: 'no timestamps are recorded on this turn or its agents, so no lane can be drawn (a bar needs two recorded timestamps — SPEC §4).' }));
  } else {
    sec.appendChild(axisStrip(bounds));
  }

  // Main thread as a mini-L4 strip.
  const mainBar = s('svg', { class: 'lens-lanes__main', width: '100%', height: '24', viewBox: `0 0 ${LANE_LABEL_W + TRACK_W + GLYPH_W} 24` });
  mainBar.appendChild(s('a', { href: routes.agent(slug, sid, 'main') },
    s('text', { x: '6', y: '16', class: 'lens-lane__label lens-lane__label--main', text: 'main thread' })));
  if (bounds && model.mainSpan) {
    const x0 = LANE_LABEL_W + xOf(model.mainSpan[0], bounds);
    const x1 = LANE_LABEL_W + xOf(model.mainSpan[1], bounds);
    mainBar.appendChild(s('rect', { x: String(x0), y: '6', width: String(Math.max(2, x1 - x0)), height: '10', class: 'lens-lane__bar lens-lane__bar--main' },
      s('title', { text: `turn bar ${fmtLocalTime(model.mainSpan[0])} → ${fmtLocalTime(model.mainSpan[1])} · wall ${fmtDur(model.mainSpan[1] - model.mainSpan[0])} (opener timestamp → max over this turn's conversation rows, SPEC §4)` })));
  } else {
    mainBar.appendChild(s('text', { x: String(LANE_LABEL_W + 2), y: '16', class: 'lens-lane__none', text: '— the turn records fewer than two bounds, so no bar is drawn' }));
  }
  sec.appendChild(mainBar);

  for (const g of model.groups) {
    sec.appendChild(groupBlock(g, bounds, { slug, sid, idx }));
  }
  for (const r of model.referenceRows) {
    sec.appendChild(referenceRow(r, { slug, sid }));
  }
  return sec;
}

function groupBlock(g, bounds, { slug, sid, idx }) {
  const box = h('section', { class: `lens-lanegroup lens-lanegroup--${g.kind}` });
  const bodyEl = h('div', { class: 'lens-lanegroup__body' });
  const prefKey = `l3.collapsed.${g.key}`;
  const stored = getPref(prefKey, null);
  let collapsed = stored === null ? !!g.collapsed : !!stored;

  const toggle = h('button', {
    class: 'lens-btn lens-lanegroup__toggle', 'aria-expanded': String(!collapsed),
    text: collapsed ? '▸' : '▾',
  });
  const title = h('h3', { class: 'lens-lanegroup__title' },
    toggle,
    g.runId ? a(routes.workflow(slug, sid, g.runId), g.label) : h('span', { text: g.label }),
    g.sublabel ? h('span', { class: 'lens-lanegroup__sub', text: g.sublabel }) : null,
    h('span', { class: 'lens-lanegroup__count', text: `${fmtInt(g.agents.length)} agent${g.agents.length === 1 ? '' : 's'}` }),
    g.autoCollapsed ? h('span', { class: 'lens-note', text: `auto-collapsed above ${AUTO_COLLAPSE_AGENTS} agents` }) : null);
  box.appendChild(title);
  if (g.note) box.appendChild(h('p', { class: 'lens-note', text: g.note }));

  const paint = () => {
    clear(bodyEl);
    if (collapsed) bodyEl.appendChild(occupancyStrip(g.agents, bounds ?? { t0: 0, t1: 0, span: 0 }));
    else bodyEl.appendChild(laneSvg(g.agents, bounds, { slug, sid }));
  };
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    setPref(prefKey, collapsed);
    toggle.textContent = collapsed ? '▸' : '▾';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    paint();
  });
  paint();
  box.appendChild(bodyEl);
  return box;
}

/** A run resumed in this turn: link-only, zero tokens, `counted in turn N`. */
function referenceRow(r, { slug, sid }) {
  return h('div', { class: 'lens-lanegroup lens-lanegroup--reference' },
    h('h3', { class: 'lens-lanegroup__title' },
      a(routes.workflow(slug, sid, r.runId), r.name ?? r.runId),
      h('span', { class: 'lens-chip lens-chip--resumed', text: 'resumed here' }),
      h('span', {
        class: 'lens-chip lens-chip--countedin',
        title: r.reason,
        text: r.countedInTurn === null ? 'counted in another turn' : `counted in turn ${r.countedInTurn}`,
      })),
    h('p', { class: 'lens-note', text: r.reason }),
    h('p', { class: 'lens-lanegroup__zero', text: `0 tokens counted here${r.agentCount ? ` · ${fmtInt(r.agentCount)} agent transcript(s) of this run live in the owning turn` : ''}` }),
    r.countedInTurn !== null ? a(routes.turn(slug, sid, r.countedInTurn), `open turn ${r.countedInTurn}`) : null);
}

/* ------------------------------------------------------------ tree */

// CONTRACT-DEVIATION (BUILD-CONTRACTS: "no inline styles except SVG or
// data-driven geometry"): the tree rows set padding-left inline because the
// indent IS the datum — depth * 14px encodes each node's recorded lineage
// depth, a per-row value no static class can carry. Everything else in this
// module is classed.
function treeView(nodes, sel, { ctx, slug, sid, idx, formatUsd }) {
  const box = h('nav', { class: 'lens-tree', 'aria-label': 'orchestration tree' });
  const walk = (node, depth) => {
    const key = node.key;
    const selected = sel.key === key;
    const href = routes.turn(slug, sid, idx, { ...currentQuery(ctx), sel: key });
    const row = h('div', { class: `lens-tree__row lens-tree__row--${node.kind}${selected ? ' lens-tree__row--sel' : ''}`, style: `padding-left:${depth * 14}px` });
    row.appendChild(node.reference
      ? h('span', { class: 'lens-tree__label', text: node.label })
      : a(href, node.label, { class: `lens-link lens-tree__label${selected ? ' lens-tree__label--sel' : ''}` }));
    if (node.agentCount !== undefined) row.appendChild(h('span', { class: 'lens-tree__count', text: `${fmtInt(node.agentCount)}` }));
    const ag = node.agent;
    if (ag) {
      // An absent CostAgg is an unknown WITH its reason, never a bare —.
      row.appendChild(ag.cost
        ? h('span', { class: 'lens-tree__cost', text: formatUsd(ag.cost.usd?.total ?? null) })
        : unknown('no CostAgg recorded for this agent on this payload'));
      row.appendChild(ag.firstAt !== null && ag.lastAt !== null
        ? h('span', { class: 'lens-tree__wall', text: fmtDur(ag.lastAt - ag.firstAt) })
        : unknown('a wall figure needs two recorded timestamps'));
      const gl = agentGlyph(ag);
      row.appendChild(h('span', { class: `lens-tree__glyph lens-tree__glyph--${gl.code}`, title: `${gl.label}${gl.source ? ` · source: ${gl.source}` : ''}`, text: gl.glyph }));
    }
    if (node.reference) {
      row.appendChild(h('span', { class: 'lens-chip lens-chip--countedin', text: node.countedInTurn === null ? 'counted elsewhere' : `counted in turn ${node.countedInTurn}` }));
    }
    // This row is only at this depth because its recorded lineage closes on
    // itself. Say so — a silently re-parented agent is an inference.
    if (node.cycleRoot) {
      row.appendChild(h('span', {
        class: 'lens-note lens-tree__cycle',
        text: 'recorded parentAgentId forms a cycle — shown unnested',
      }));
    }
    box.appendChild(row);
    for (const c of node.children ?? []) walk(c, depth + 1);
  };
  for (const n of nodes) walk(n, n.depth ?? 0);
  return box;
}

/* ------------------------------------------------------------ timetable */

async function mountTimetable(host, { ctx, slug, sid, idx, sel, payload, model }) {
  const K = await kit();
  if (ctx.stale) return;
  clear(host);

  const isMain = sel.kind === 'main' || sel.kind === 'unknown';
  const agentId = sel.kind === 'agent' ? sel.agentId : null;

  host.appendChild(h('p', {
    class: 'lens-scope lens-scope--pane',
    text: isMain
      ? `Main-thread rows of this turn, in file order (file order is a topological order of the uuid DAG, never timestamp order — SPEC §3).`
      : agentId
        ? `Rows of agent ${agentId}, in file order.`
        : `Selected: ${sel.key}. Rows are shown per agent — pick an agent in the tree.`,
  }));

  // An unrecognised ?sel still renders the main thread — a hand-edited or
  // stale URL should show something — but it SAYS the selection was not
  // honoured instead of painting the no-selection pane as if it had been.
  if (sel.kind === 'unknown') {
    host.appendChild(h('p', { class: 'lens-note lens-note--problem' },
      unknown(`?sel=${sel.key} is not a selection this turn recognises — showing the main thread`)));
  }

  if (!isMain && !agentId) {
    // 'this node', not 'a workflow or phase node' — the two non-run groups
    // (Agent-tool agents, no recorded spawn edge) land here too.
    host.appendChild(h('p', { class: 'lens-note', text: 'this node groups agents; it has no rows of its own.' }));
    return;
  }

  const mainRows = payload?.rows ?? payload?.turn?.rows ?? null;

  const fetchPage = async (arg, maybeCount) => {
    const from = typeof arg === 'object' && arg !== null ? (arg.from ?? 0) : (arg ?? 0);
    const count = typeof arg === 'object' && arg !== null ? (arg.count ?? ROWS_PAGE) : (maybeCount ?? ROWS_PAGE);
    if (isMain) {
      if (Array.isArray(mainRows)) {
        return { rows: mainRows.slice(from, from + count), from, count, total: mainRows.length };
      }
      const p = await K.api(`/api/turn/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/${idx}`, { from, count }, { signal: ctx.signal });
      return { rows: p.rows ?? [], from, count, total: p.rowsTotal ?? p.rows?.length ?? 0 };
    }
    const p = await K.api(`/api/agent/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/${encodeURIComponent(agentId)}`, { from, count }, { signal: ctx.signal });
    return { rows: p.rows ?? [], from, count, total: p.total ?? p.rowsTotal ?? p.rows?.length ?? 0, rel: p.rel ?? p.file ?? null };
  };

  const kinds = ctx.query?.get?.('k') ?? null;
  const paneAgentId = agentId ?? 'main';
  if (!K.rowsPane) {
    // rows.mjs is a foundation module and always present; a missing one is a
    // broken build, said plainly — never silently fallen back from.
    host.appendChild(errorCard({ code: 'rows-pane-missing', message: 'components/rows.mjs did not load — the timetable cannot render.' }));
    return;
  }
  const pane = K.rowsPane(host, {
    fetchPage, kinds,
    onExpand: (row) => expandRow(row, { slug, sid, agentId: paneAgentId, signal: ctx.signal }),
    // Every row gets its `{}` → L5 drill from the recorded line/bi.
    locatorHref: (r) => (Number.isFinite(r.line) ? routes.event(slug, sid, paneAgentId, r.line, r.bi ?? null) : null),
    // The kind filter is ADDRESSABLE — chips write `?k` to the URL.
    onKinds: (v) => ctx.navigate?.(withQueryHash(ctx, { k: v || null })),
    findScope: `turn:${slug}/${sid}/${idx}`,
  });
  // DESIGN §5: `/` opens the pane's in-scope head filter.
  ctx.registerFind?.(() => pane.openFilter?.() ?? false);
}

/** Same hash, one query param changed — preserves unknown params (DESIGN §0). */
function withQueryHash(ctx, changes) {
  const q = new URLSearchParams(ctx.query?.toString?.() ?? '');
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === '') q.delete(k); else q.set(k, String(v));
  }
  const qs = q.toString();
  return `#${ctx.path}${qs ? `?${qs}` : ''}`;
}

async function expandRow(row, { slug, sid, agentId, signal }) {
  const K = await kit();
  const box = h('div', { class: 'lens-rows__detail' });
  try {
    const file = row.file ?? (await resolveMainRel(slug, sid, signal));
    const line = await K.api('/api/line', { slug, id: sid, file, line: row.line }, { signal });
    const ev = line.event ?? line.value ?? (typeof line.raw === 'string' ? safeParse(line.raw) : line.raw);
    box.appendChild(h('pre', { class: 'lens-json', text: safeStringify(ev) }));
  } catch (err) { box.appendChild(errorCard(err)); }
  return box;
}

/* ---------------------------------------------------------------- routes */

export const routeList = [['/p/:slug/s/:sid/t/:idx', renderTurn]];
export function register(defineRoute) {
  for (const [p, r] of routeList) {
    try { defineRoute(p, r); } catch (err) { console.error('defineRoute failed', p, err); }
  }
}
