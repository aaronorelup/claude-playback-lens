/**
 * Session inventory (`…/s/<sid>/inv`) — the completeness proof.
 * DESIGN §3 (Inventory), SPEC §2 (store layout), §3 (event shapes),
 * §8 (spills/images/memory), §9 (Problem shape).
 *
 * Also hosts the raw-file route `…/s/<sid>/x/<relpath>` and
 * `#/p/<slug>/x/<relpath>`: BUILD-CONTRACTS assigns no owner to `x`, and the
 * files ledger below links to it for every path — "nothing in the app lacks a
 * raw view". See the integrator note at the bottom of this file.
 */

import { kit, apiUrl, fetchRaw } from '../lib/net.mjs';
import { h, a, unknown, section, factList, tablewrap, disclosure, disclosureTools } from '../lib/dom.mjs';
import { fmtInt, fmtBytes, shortId, truncate } from '../lib/fmt.mjs';
import { routes, withReturn } from '../lib/links.mjs';
import { page, errorCard, pendingCard, statHeader, mountCrumbs, handle404 } from '../lib/chrome.mjs';

/* ==================================================== rel classification ==
 * SPEC §2's ten verified store patterns. Pure: a session-relative POSIX path
 * in, its class and the app surface that shows it out. Nothing is guessed —
 * an unrecognised shape returns class 'unclassified' and says so, which is
 * exactly what the ledger's "0 unclassified" line is proving.
 */

export function classifyRel(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/');
  let m;

  if ((m = /^mem\/(.+)$/.exec(p))) return { class: 'project memory', surface: 'memory', name: m[1] };
  if ((m = /^frag\/([^/]+)\/(.+)$/.exec(p))) {
    const inner = classifyRel(m[2]);
    return { ...inner, class: `fragment (${m[1]}) · ${inner.class}`, fragmentSlug: m[1], fragmentRel: m[2] };
  }
  if (/^[0-9a-f-]{36}\.jsonl$/i.test(p)) return { class: 'main transcript', surface: 'agent', agentId: 'main' };
  if ((m = /^subagents\/workflows\/([^/]+)\/agent-([^/]+)\.jsonl$/.exec(p))) {
    return { class: 'workflow agent transcript', surface: 'agent', agentId: m[2], runId: m[1] };
  }
  if ((m = /^subagents\/workflows\/([^/]+)\/agent-([^/]+)\.meta\.json$/.exec(p))) {
    return { class: 'workflow agent sidecar', surface: 'agent', agentId: m[2], runId: m[1] };
  }
  if ((m = /^subagents\/workflows\/([^/]+)\/journal\.jsonl$/.exec(p))) {
    return { class: 'workflow journal', surface: 'workflow', runId: m[1] };
  }
  if ((m = /^subagents\/agent-([^/]+)\.jsonl$/.exec(p))) return { class: 'agent transcript', surface: 'agent', agentId: m[1] };
  if ((m = /^subagents\/agent-([^/]+)\.meta\.json$/.exec(p))) return { class: 'agent sidecar', surface: 'agent', agentId: m[1] };
  if ((m = /^workflows\/scripts\/(.+)$/.exec(p))) {
    const run = /-(wf_[0-9a-f]{8}-[0-9a-f]{3})\.[a-z]+$/i.exec(m[1]);
    return { class: 'workflow script', surface: run ? 'workflow' : 'raw', runId: run ? run[1] : null, name: m[1] };
  }
  if ((m = /^workflows\/([^/]+)\.json$/.exec(p))) return { class: 'workflow record', surface: 'workflow', runId: m[1] };
  if ((m = /^tool-results\/(.+)$/.exec(p))) return { class: 'spilled tool result', surface: 'raw', name: m[1] };
  return { class: 'unclassified', surface: 'raw' };
}

/** The ledger's closing line — the number the page exists to print. */
export function ledgerSummary(files = []) {
  let classified = 0, unclassified = 0, bytes = 0;
  for (const f of files) {
    const cls = f.class ?? classifyRel(f.rel).class;
    if (cls === 'unclassified') unclassified++; else classified++;
    bytes += Number(f.bytes ?? f.size ?? 0) || 0;
  }
  return { files: files.length, classified, unclassified, bytes };
}

/* ====================================================== events ledger ==
 * parsed → rendered → not-rendered, every not-rendered bucket enumerated.
 * The state-snapshot types are the recorded reason rows do not exist 1:1 with
 * events: they are massively duplicated and shown as latest value + count on
 * the L2 session facts row (SPEC §3), never as a timeline row each.
 */

export const SNAPSHOT_TYPES = ['last-prompt', 'ai-title', 'custom-title', 'mode', 'pr-link', 'frame-link'];

export function bucketEvents(inv = {}) {
  const perType = inv.perType ?? inv.eventsByType ?? {};
  const parsed = Object.values(perType).reduce((n, v) => n + (Number(v) || 0), 0);
  const rendered = Number(inv.rows ?? inv.rowCount ?? inv.renderedRows ?? NaN);
  const buckets = [];
  for (const t of SNAPSHOT_TYPES) {
    const n = Number(perType[t] ?? 0);
    if (!n) continue;
    buckets.push({
      bucket: t, count: n, kind: t,
      why: t === 'queue-operation'
        ? 'a real timeline event'
        : 'state snapshot — shown as latest value + count on the session facts row, never one row per occurrence (SPEC §3)',
    });
  }
  const unknownTypes = Object.keys(perType).filter((t) => t.startsWith('unknown:'));
  for (const t of unknownTypes) {
    buckets.push({ bucket: t, count: Number(perType[t]), kind: t, why: 'unknown event type — surfaced here and in the raw view, never dropped (SPEC §3)' });
  }
  const torn = Number(inv.tornLines ?? inv.torn ?? 0) || 0;
  if (torn) buckets.push({ bucket: 'torn line', count: torn, kind: null, why: 'a line that failed JSON.parse: counted, located, and contributing zero everywhere (SPEC §1)' });
  return {
    parsed,
    rendered: Number.isFinite(rendered) ? rendered : null,
    notRendered: buckets,
    notRenderedTotal: buckets.reduce((n, b) => n + b.count, 0),
  };
}

/** "impacts totals?" column — driven by Problem.affects (SPEC §9). */
export function impactsTotals(problem) {
  switch (problem?.affects) {
    case 'aggregates': return 'yes — the totals on this page';
    case 'display': return 'no — display only';
    case 'nothing': return 'no';
    default: return null;
  }
}

/** Identical code+scope Problems collapse to one row carrying count (SPEC §9). */
export function collapseProblems(problems = []) {
  const byKey = new Map();
  for (const p of problems) {
    const key = `${p.code}|${p.scope}`;
    const prev = byKey.get(key);
    if (prev) { prev.count += Number(p.count ?? 1); prev.examples.push(p); }
    else byKey.set(key, { ...p, count: Number(p.count ?? 1), examples: [p] });
  }
  return [...byKey.values()];
}

/* ============================================================== view == */

export async function renderInventory(ctx) {
  const { body } = page(ctx, 'lens-inv');
  const P = ctx.params ?? {};
  const slug = P.slug, sid = P.sid ?? P.id;
  const K = await kit();
  if (ctx.stale) return;

  mountCrumbs(ctx, [
    { label: 'store', href: routes.store() },
    { label: slug ?? 'project', href: routes.project(slug) },
    { label: `session ${shortId(sid)}`, sub: sid, href: routes.session(slug, sid) },
    { label: 'inventory' },
  ]);

  // DESIGN §7: chrome first.
  statHeader(ctx, { pending: true });

  let payload;
  try {
    payload = await K.api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}`,
      null, { signal: ctx.signal });
  } catch (err) {
    // STALE-RENDER RULE: ahead of handle404, which banners AND navigates.
    if (ctx.stale) return;
    if (handle404(ctx, err, { slug, sid: null, thing: `session ${shortId(sid)}` })) return;
    body.appendChild(errorCard(err, { retry: () => renderInventory(ctx) }));
    return;
  }
  if (ctx.stale) return;
  if (payload?.pending) { pendingCard(ctx, payload.pending, () => renderInventory(ctx)); return; }

  // Payload split: images[] and filesLedger[] ship from
  // their own endpoints; the detail carries the totals. NOTHING here assumes
  // a list where the payload ships a count — that was the /inv crash.
  const inv = (payload.inventory && typeof payload.inventory === 'object') ? payload.inventory : {};
  let filesPayload = null, imagesPayload = null;
  try {
    [filesPayload, imagesPayload] = await Promise.all([
      K.api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/files`, null, { signal: ctx.signal }),
      K.api(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/images`, null, { signal: ctx.signal }),
    ]);
  } catch { /* each section discloses its own absence below */ }
  // The second resume point of this render, and the easiest one
  // missed — everything from setTitle down repaints the SHELL's own bands.
  if (ctx.stale) return;
  const ledgerRows = Array.isArray(filesPayload?.filesLedger) ? filesPayload.filesLedger : [];
  const images = Array.isArray(imagesPayload?.images) ? imagesPayload.images : null;
  const events = bucketEvents({ ...inv, rows: inv.rows ?? (Number.isFinite(payload.rows) ? payload.rows : undefined) });

  ctx.setTitle?.(`inventory · ${shortId(sid)} — Claude Playback Lens`);

  statHeader(ctx, {
    agg: payload.agg ?? payload.cost ?? null,
    scope: `session:${slug}/${sid}`,
    subject: `the inventory of session ${shortId(sid)}`,
    sentenceCounts: [
      Number.isFinite(events.parsed) ? { n: events.parsed, noun: 'parsed event' } : null,
      Number.isFinite(payload.imagesTotal) ? { n: payload.imagesTotal, noun: 'image block' } : null,
    ].filter(Boolean),
    rule: 'every recorded census for this session — parsed events, recorded file paths, images, spills, and every problem found while reading them; this page exists to be checked, and nothing in the app lacks a raw view',
    rowsSumToHeader: payload.rowsSumToHeader,
    span: { label: 'span', ms: null, reason: 'an inventory is a census of what exists, not a bar — the session timeline carries the span' },
    counts: [
      { key: 'files', label: 'recorded paths', value: Number.isFinite(payload.filesLedgerTotal) ? payload.filesLedgerTotal : null, reason: 'no files ledger total reported on this payload' },
      { key: 'images', label: 'images', value: Number.isFinite(payload.imagesTotal) ? payload.imagesTotal : null, reason: 'no image census reported on this payload' },
      { key: 'events', label: 'events parsed', value: events.parsed },
      { key: 'problems', label: 'problems', value: (payload.problems ?? inv.problems ?? []).length },
    ],
    footnote: { requests: (payload.agg ?? payload.cost)?.requests ?? null, rowsSumToHeader: payload.rowsSumToHeader },
  });

  // ---- files ledger (recorded paths — SPEC §8 sources, from /files)
  const filesSec = section('files ledger — recorded paths');
  if (!filesPayload || pendingOfLocal(filesPayload)) {
    filesSec.appendChild(unknown('the files ledger endpoint could not be fetched — nothing is claimed for it'));
  } else if (!ledgerRows.length) {
    filesSec.appendChild(h('p', { class: 'lens-note', text: '0 recorded file paths — no tool_use input in this session carries a path key and no main-tier sidecar names one (SPEC §8).' }));
  } else {
    const denom = filesPayload.denominators ?? inv.filesLedgerDenominators ?? null;
    if (denom) {
      filesSec.appendChild(h('p', { class: 'lens-coverage', title: 'the denominator for this ledger, printed on it' },
        ...coverageNodes(denom)));
    } else {
      filesSec.appendChild(unknown('the payload records no tool-call denominators for this ledger'));
    }
    const t = h('table', { class: 'lens-table lens-table--files' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'path' }), h('th', { text: 'tier' }),
        h('th', { class: 'lens-table__num', text: 'reads' }), h('th', { class: 'lens-table__num', text: 'writes' }),
        h('th', { class: 'lens-table__num', text: 'edits' }), h('th', { class: 'lens-table__num', text: 'searches' }),
        h('th', { class: 'lens-table__num', text: 'sidecar' }),
        h('th', { title: 'the page in this app that shows the recorded path — only a path inside the session directory has one', text: 'in this app' }))));
    const tb = h('tbody');
    for (const f of ledgerRows) {
      // "nothing in the app lacks a raw view" — for a path the app can
      // address. A ledger path is a recorded tool input: when it is
      // session-relative it gets its surface (…/x/<rel> or the agent /
      // workflow / memory page it is served as); when it is an absolute
      // working-tree path the cell says so rather than fabricating a rel.
      const rel = sessionRelOf(f.path);
      tb.appendChild(h('tr', {},
        h('td', {}, h('code', { text: f.path })),
        h('td', { text: f.tier ?? '' }),
        h('td', { class: 'lens-table__num', text: fmtInt(f.reads ?? 0) }),
        h('td', { class: 'lens-table__num', text: fmtInt(f.writes ?? 0) }),
        h('td', { class: 'lens-table__num', text: fmtInt(f.edits ?? 0) }),
        h('td', { class: 'lens-table__num', text: fmtInt(f.searches ?? 0) }),
        h('td', { class: 'lens-table__num', text: fmtInt(f.sidecar ?? 0) }),
        h('td', {}, rel
          ? surfaceLink(classifyRel(rel), { slug, sid, rel })
          : unknown('this row records an absolute working-tree path; the store holds no such file, and deriving a session-relative path from it would need a store root no payload records'))));
    }
    t.appendChild(tb);
    filesSec.appendChild(tablewrap(t));
    filesSec.appendChild(h('p', {
      class: 'lens-ledger__total',
      text: `${fmtInt(ledgerRows.length)} of ${fmtInt(filesPayload.total ?? ledgerRows.length)} recorded (path, tier) pairs`,
    }));
    // Arithmetic over the rows above, so the "in this app" column is a proof
    // rather than a column of dashes: exactly this many recorded paths lie
    // inside the session directory and therefore have a page here.
    const addressable = ledgerRows.reduce((n, f) => n + (sessionRelOf(f.path) ? 1 : 0), 0);
    filesSec.appendChild(h('p', { class: 'lens-coverage' },
      h('span', { class: 'lens-num', text: fmtInt(addressable) }),
      ' of ', h('span', { class: 'lens-num', text: fmtInt(ledgerRows.length) }),
      ' recorded paths are session-relative and have a page in this app; the rest are absolute working-tree paths, which the store does not hold.'));
  }
  filesSec.appendChild(h('p', {
    class: 'lens-note',
    text: 'These are the file paths the session RECORDED touching (tool_use inputs keyed by tool name ∪ main-tier toolUseResult.filePath — SPEC §8). The session’s own on-disk tree is enumerated by the store inventory and every file of it has a raw view via …/x/<relpath>.',
  }));
  body.appendChild(filesSec);

  // ---- events ledger
  const evSec = section('events ledger');
  evSec.appendChild(factList([
    { label: 'parsed', value: fmtInt(events.parsed), source: 'per-type event census over every file of this session' },
    { label: 'rendered as rows', value: events.rendered === null ? null : fmtInt(events.rendered), source: 'rows built by the parser (one row per content block, file order)', reason: 'the row count is not reported on this payload' },
    { label: 'not rendered as rows', value: fmtInt(events.notRenderedTotal), source: 'the buckets below, each enumerated' },
  ]));
  if (events.notRendered.length) {
    const t = h('table', { class: 'lens-table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'bucket' }), h('th', { class: 'lens-table__num', text: 'events' }), h('th', { text: 'why' }), h('th', { text: '' }))));
    const tb = h('tbody');
    for (const b of events.notRendered) {
      tb.appendChild(h('tr', {},
        h('td', { text: b.bucket }),
        h('td', { class: 'lens-table__num', text: fmtInt(b.count) }),
        h('td', { text: b.why }),
        h('td', {}, b.kind ? a(withReturn(routes.session(slug, sid, { k: b.kind })), 'show these') : unknown('no row kind to filter on — see the raw files above'))));
    }
    t.appendChild(tb);
    evSec.appendChild(tablewrap(t));
  }
  body.appendChild(evSec);

  // ---- censuses. Four recorded censuses, each a native disclosure carrying
  // its own row count, under one expand-all/collapse-all control: the page is
  // a completeness proof and every census must stay reachable, but four full
  // tables above the problems drawer buried it.
  const censuses = h('div', { class: 'lens-inv__censuses' });
  censuses.append(
    censusSection('events by type', inv.perType ?? inv.eventsByType, { slug, sid, linkKind: true }),
    censusSection('attachment kinds', inv.attachmentKinds, { slug, sid, prefix: 'attachment:' }),
    censusSection('sessionIds seen in these files',
      arrayCensus(inv.sessionIdsSeen ?? payload.sessionIdsSeen
        ?? (Array.isArray(payload.otherSessionIds) ? [sid, ...payload.otherSessionIds] : null)), { slug, sid }),
    censusSection('models', inv.models ?? payload.usageByModel, { slug, sid }));
  const censusSec = section('recorded censuses');
  const tools = disclosureTools(censuses, { label: 'censuses' });
  if (tools) censusSec.appendChild(tools);
  censusSec.appendChild(censuses);
  body.appendChild(censusSec);
  body.appendChild(imagesSection(images, { slug, sid }));
  body.appendChild(spillsSection(inv.spills ?? inv.spillCounts, { slug, sid }));
  body.appendChild(expectedZeros(inv, payload));

  // ---- problems drawer
  body.appendChild(problemsDrawer(payload.problems ?? inv.problems ?? [], { slug, sid }));
}

/** api() returns a pending OBJECT for 409 — a list-shaped payload never is one. */
function pendingOfLocal(res) {
  const p = res && typeof res === 'object' ? res.pending : null;
  return !!(p && typeof p === 'object' && !Array.isArray(p));
}

/**
 * The denominator sentence, as NODES: the figures ride in `.lens-num` so a
 * column of counts inside a sentence still reads as monospace tabular figures
 * rather than as prose. An unreported figure is `—` with its reason, never a 0.
 */
function coverageNodes(denom) {
  // shipped names first, older aliases as fallbacks
  const main = Number(denom.mainToolCallsWithPath ?? denom.mainToolCalls ?? denom.main ?? NaN);
  const agent = Number(denom.agentToolCallsWithPath ?? denom.agentToolCalls ?? denom.agent ?? NaN);
  const noSidecar = Number(denom.agentResultsNoSidecar ?? denom.agentResultsWithoutSidecar ?? denom.noSidecar ?? NaN);
  const fig = (n, reason) => (Number.isFinite(n) ? h('span', { class: 'lens-num', text: fmtInt(n) }) : unknown(reason));
  const out = [
    'paths from ', fig(main, 'no main-thread tool-call denominator is recorded on this payload'),
    ' main-thread and ', fig(agent, 'no agent tool-call denominator is recorded on this payload'),
    ' agent tool calls that carry a path key',
  ];
  if (Number.isFinite(noSidecar)) {
    out.push('; ', h('span', { class: 'lens-num', text: fmtInt(noSidecar) }), ' agent tool results carry no path sidecar');
  }
  out.push('.');
  return out;
}

/**
 * The app surface that shows a SESSION-RELATIVE path (SPEC §2's ten store
 * patterns), carrying the reader's current hash so the surface can offer a way
 * back. Every branch is driven by what classifyRel RECOGNISED in the path —
 * `unclassified` never reaches here, because a path the store patterns do not
 * match has no surface and is said to have none at the call site.
 */
export function surfaceLink(cls, { slug, sid, rel }) {
  switch (cls.surface) {
    case 'agent':
      return cls.agentId && sid
        ? a(withReturn(routes.agent(slug, sid, cls.agentId)), cls.agentId === 'main' ? 'main thread' : `agent ${shortId(cls.agentId, 10)}`)
        : unknown(sid ? 'this path matches an agent shape but records no agentId' : 'a project-level path has no session to surface it under');
    case 'workflow':
      return cls.runId && sid
        ? a(withReturn(routes.workflow(slug, sid, cls.runId)), `workflow ${cls.runId}`)
        : unknown(sid ? 'this path matches a workflow shape but records no runId' : 'a project-level path has no session to surface it under');
    case 'memory':
      return cls.name
        ? a(withReturn(routes.memory(slug, cls.name)), `memory ${cls.name}`)
        : unknown('this path matches the memory shape but records no file name');
    case 'raw':
    default:
      // The RECORDED rel, verbatim — `x` consumes the remainder of the hash,
      // so any depth works. cls.name is the matched TAIL of a pattern
      // (`tool-results/<name>`), never a path, and is deliberately not used.
      return rel && sid
        ? a(withReturn(routes.sessionFile(slug, sid, rel)), 'raw view')
        : rel
          ? a(withReturn(routes.projectFile(slug, rel)), 'raw view')
          : unknown('this row records no session-relative path to open');
  }
}

/**
 * A ledger path is a RECORDED tool input — usually an absolute working-tree
 * path, which the store does not hold and this app therefore has no page for.
 * Only a path that is ALREADY session-relative can be addressed by `…/x/`;
 * turning an absolute path into one would need the store root, which no
 * payload records. Returns the POSIX rel, or null (which the caller prints as
 * `—` with the reason).
 */
export function sessionRelOf(recordedPath) {
  const p = String(recordedPath ?? '').replace(/\\/g, '/');
  if (!p) return null;
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('/') || p.startsWith('//')) return null;   // absolute
  if (p.split('/').includes('..')) return null;                                          // escapes the session dir
  return p;
}

function arrayCensus(list) {
  if (!Array.isArray(list)) return list ?? null;
  const out = {};
  for (const v of list) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

function censusSection(title, obj, { slug, sid, prefix = '', linkKind = false } = {}) {
  const entries = obj && typeof obj === 'object' ? Object.entries(obj) : [];
  if (!entries.length) {
    return disclosure(title, unknown('not reported on this payload'), { count: 'not reported' });
  }
  const t = h('table', { class: 'lens-table' }, h('thead', {}, h('tr', {}, h('th', { text: 'value' }), h('th', { class: 'lens-table__num', text: 'count' }), h('th', { text: '' }))));
  const tb = h('tbody');
  for (const [k, v] of entries.sort((x, y) => (Number(y[1]?.count ?? y[1]) || 0) - (Number(x[1]?.count ?? x[1]) || 0))) {
    const n = typeof v === 'object' && v !== null ? (v.count ?? v.requests ?? null) : v;
    tb.appendChild(h('tr', {},
      h('td', {}, h('code', { text: k })),
      h('td', { class: 'lens-table__num' }, n === null || n === undefined ? unknown('count not reported') : h('span', { text: fmtInt(n) })),
      h('td', {}, linkKind || prefix ? a(withReturn(routes.session(slug, sid, { k: `${prefix}${k}` })), 'show these') : null)));
  }
  t.appendChild(tb);
  // The count in the summary is the RECORDED number of distinct values, so
  // the reader knows the size of the census without opening it.
  return disclosure(title, tablewrap(t), { count: `${fmtInt(entries.length)} distinct` });
}

function imagesSection(images, { slug, sid }) {
  const sec = section('images');
  if (!images) { sec.appendChild(unknown('not reported on this payload')); return sec; }
  const list = Array.isArray(images) ? images : [images];
  const bySource = new Map();
  let bytes = 0;
  for (const im of list) {
    const src = im.source ?? im.path ?? 'source not recorded';
    const e = bySource.get(src) ?? { count: 0, bytes: 0 };
    e.count++; e.bytes += Number(im.bytes ?? im.length ?? 0) || 0;
    bySource.set(src, e);
    bytes += Number(im.bytes ?? im.length ?? 0) || 0;
  }
  sec.appendChild(h('p', { class: 'lens-note', text: `${fmtInt(list.length)} image block(s), ${fmtBytes(bytes)} of recorded payload. Four JSON paths carry images and two shapes exist; 859 lines corpus-wide record the same image twice (block copy + sidecar) and are rendered once with the twin noted (SPEC §8).` }));
  const t = h('table', { class: 'lens-table' }, h('thead', {}, h('tr', {}, h('th', { text: 'source path' }), h('th', { class: 'lens-table__num', text: 'count' }), h('th', { class: 'lens-table__num', text: 'bytes' }))));
  const tb = h('tbody');
  for (const [src, e] of bySource) {
    tb.appendChild(h('tr', {}, h('td', {}, h('code', { text: src })), h('td', { class: 'lens-table__num', text: fmtInt(e.count) }), h('td', { class: 'lens-table__num', text: e.bytes ? fmtBytes(e.bytes) : '0' })));
  }
  t.appendChild(tb);
  sec.appendChild(tablewrap(t));
  return sec;
}

function spillsSection(spills, { slug, sid }) {
  const sec = section('spill files');
  // payload split: the detail ships spill COUNTS (refs/files/unreferenced),
  // not the per-file list — render the recorded counts, never fake rows.
  if (spills && !Array.isArray(spills) && typeof spills === 'object') {
    sec.appendChild(factList([
      { label: 'recorded spill references', value: fmtInt(spills.refs), source: 'the three recorded reference forms (SPEC §8)', reason: 'not reported' },
      { label: 'spill files on disk', value: fmtInt(spills.files), source: 'tool-results/ census', reason: 'not reported' },
      { label: 'unreferenced spill files', value: fmtInt(spills.unreferenced), source: 'files no transcript references — still viewable (SPEC §8)', reason: 'not reported' },
    ]));
    sec.appendChild(h('p', { class: 'lens-note', text: 'the per-file spill list is not shipped on this payload; every tool-results/ file is reachable through the raw view (…/x/tool-results/<name>).' }));
    return sec;
  }
  if (!spills || !spills.length) { sec.appendChild(unknown('no spill files reported on this payload')); return sec; }
  const t = h('table', { class: 'lens-table' },
    h('thead', {}, h('tr', {}, h('th', { text: 'file' }), h('th', { class: 'lens-table__num', text: 'bytes' }), h('th', { text: 'reference form' }), h('th', { text: 'referenced from' }), h('th', { text: 'raw' }))));
  const tb = h('tbody');
  for (const sp of spills) {
    const rel = sp.rel ?? sp.file ?? sp.path ?? '';
    const refs = sp.references ?? sp.refs ?? [];
    tb.appendChild(h('tr', {},
      h('td', {}, h('code', { text: rel })),
      h('td', { class: 'lens-table__num' }, sp.bytes === undefined ? unknown('size not reported') : h('span', { text: fmtBytes(sp.bytes) })),
      h('td', { text: sp.form ?? (refs[0]?.form ?? '') }, sp.form || refs[0]?.form ? null : unknown('reference form not reported')),
      h('td', {}, refs.length
        ? refs.map((r) => a(withReturn(routes.event(slug, sid, r.agentId ?? 'main', r.line, r.bi ?? null)), `line ${fmtInt(r.line)}`))
        : h('span', { class: 'lens-note', text: 'not referenced from any transcript — still viewable (SPEC §8)' })),
      h('td', {}, a(withReturn(routes.sessionFile(slug, sid, rel)), 'raw'))));
  }
  t.appendChild(tb);
  sec.appendChild(tablewrap(t));
  return sec;
}

/** Expected-zero censuses: the provable zeros live here, not in a badge. */
function expectedZeros(inv, payload) {
  // The zeros print only when RECORDED — the provable 0 is the point.
  const lost = Number.isFinite(inv.lostAgents) ? inv.lostAgents
    : Number.isFinite(payload.lostAgents) ? payload.lostAgents : null;
  const tornRecorded = Number.isFinite(inv.tornLines) ? inv.tornLines
    : Number.isFinite(inv.torn) ? inv.torn
      : Number.isFinite(payload.tornLines) ? payload.tornLines : null;
  // A problems array IS shipped on this payload, so its torn-line count is a
  // recorded 0 when no such problem exists — not an invented one.
  const problems = payload.problems ?? inv.problems ?? null;
  const torn = tornRecorded !== null ? tornRecorded
    : Array.isArray(problems)
      ? problems.filter((p) => p && p.code === 'torn-line').reduce((n, p) => n + (Number(p.count) || 1), 0)
      : null;
  const enumerated = inv.agentCount ?? payload.agentCount ?? null;
  return section('expected-zero censuses',
    factList([
      {
        label: 'lost agents', value: lost === null ? null : fmtInt(lost),
        source: 'the session card\'s lostAgents census (journal starts with no transcript on disk — SPEC §7)',
        reason: 'no lostAgents census is recorded on this payload',
        note: enumerated !== null ? `${fmtInt(enumerated)} enumerated, ${fmtInt(enumerated)} attributed — the enumeration is closed, which is why there is no "lost agents" badge anywhere in the app (DESIGN §3 L1).` : null,
      },
      {
        label: 'torn lines', value: torn === null ? null : fmtInt(torn),
        source: tornRecorded !== null ? 'lines that failed JSON.parse while reading (SPEC §1)' : 'the payload\'s problems census (code torn-line)',
        reason: 'neither a torn-line census nor a problems list is recorded on this payload',
        note: 'a torn line would be counted, located to (file, line, byteOffset, bytes), contribute zero everywhere, and appear above with a raw link.',
      },
    ]),
    h('p', { class: 'lens-note', text: 'These are printed zeros, not absent rows: a zero renders 0 and an unknown renders — with its reason (house rule 3).' }));
}

function problemsDrawer(problems, { slug, sid }) {
  const rows = collapseProblems(problems);
  const sec = section(`problems — ${fmtInt(rows.length)} distinct`);
  if (!rows.length) {
    sec.appendChild(h('p', { class: 'lens-note', text: '0 problems recorded while reading this session.' }));
    return sec;
  }
  const t = h('table', { class: 'lens-table' },
    h('thead', {}, h('tr', {},
      h('th', { text: 'code' }), h('th', { text: 'severity' }), h('th', { text: 'scope' }),
      h('th', { class: 'lens-table__num', text: 'count' }), h('th', { text: 'impacts totals?' }),
      h('th', { text: 'message' }), h('th', { text: 'where' }))));
  const tb = h('tbody');
  for (const p of rows) {
    const impacts = impactsTotals(p);
    tb.appendChild(h('tr', { class: `lens-table__row--${p.severity ?? 'note'}` },
      h('td', {}, h('code', { text: p.code ?? 'unknown code' })),
      h('td', { text: p.severity ?? '' }),
      h('td', { text: p.scope ?? '' }),
      h('td', { class: 'lens-table__num', text: fmtInt(p.count ?? 1) }),
      h('td', {}, impacts === null ? unknown('this problem does not record an `affects` value') : h('span', { text: impacts })),
      h('td', { text: p.message ?? '' }),
      h('td', {}, p.file && p.line
        ? a(withReturn(routes.event(slug, sid, p.agentId ?? 'main', p.line, null)), `${p.file}:${fmtInt(p.line)}`)
        : p.file ? a(withReturn(routes.sessionFile(slug, sid, p.file)), p.file) : h('span', { text: '' }))));
  }
  t.appendChild(tb);
  sec.appendChild(tablewrap(t));
  return sec;
}

/* ============================================== raw file view (`x`) == */

const RAW_HEAD_BYTES = 512 * 1024;

export async function renderRawFile(ctx) {
  const { body } = page(ctx, 'lens-x');
  const P = ctx.params ?? {};
  const slug = P.slug, sid = P.sid ?? P.id ?? null;
  const rel = relFromParams(P);

  mountCrumbs(ctx, [
    { label: 'store', href: routes.store() },
    { label: slug ?? 'project', href: routes.project(slug) },
    ...(sid ? [{ label: `session ${shortId(sid)}`, sub: sid, href: routes.session(slug, sid) },
      { label: 'inventory', href: routes.inventory(slug, sid) }] : []),
    { label: rel || 'raw file' },
  ]);

  if (!rel) {
    body.appendChild(errorCard({ status: 400, code: 'no-relpath', message: 'no relative path in this route. `x` consumes the remainder of the hash; every segment is percent-encoded on write and decoded on read (DESIGN §0).' }));
    return;
  }
  const cls = classifyRel(rel);
  ctx.setTitle?.(`${rel} — Claude Playback Lens`);

  statHeader(ctx, {
    agg: null,
    scopeSentence: `The raw bytes of ${rel}${sid ? ` in session ${shortId(sid)}` : ` in project ${slug}`}, exactly as stored. Classified as: ${cls.class}.`,
    span: { label: 'span', ms: null, reason: 'a file is bytes on disk, not a bar' },
    counts: [{ key: 'bytes', label: 'bytes', value: null, reason: 'measured after the bytes are fetched, below' }],
  });

  const params = sid ? { slug, id: sid, rel } : { slug, rel };
  body.appendChild(h('div', { class: 'lens-x__tools' },
    a(apiUrl('/api/file', params), 'open the bytes directly', { target: '_blank', rel: 'noreferrer' }),
    // ONE surface resolver, shared with the files ledger — the two used to
    // spell the same three cases separately. A `raw` classification's surface
    // IS this page, so it names itself rather than linking to itself.
    cls.surface === 'raw'
      ? h('span', { class: 'lens-x__surface', title: 'this raw view is the surface for this file class', text: `surfaced as: this raw view (${cls.class})` })
      : h('span', { class: 'lens-x__surface' }, 'surfaced as: ', surfaceLink(cls, { slug, sid, rel }))));

  let res;
  try { res = await fetchRaw('/api/file', params, { rangeBytes: RAW_HEAD_BYTES, signal: ctx.signal }); }
  catch (err) {
    if (ctx.stale) return; // including the AbortError of a superseded render
    body.appendChild(errorCard(err, { retry: () => renderRawFile(ctx) })); return;
  }
  if (ctx.stale) return;

  const truncated = res.partial || (res.total !== null && res.bytes < res.total);
  const sec = section('raw bytes');
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: truncated
      ? `showing the first ${fmtBytes(res.bytes)}${res.total ? ` of ${fmtBytes(res.total)}` : ''} — the rest is one click away above; the app never loads a whole 38 MB transcript into a page (SPEC §11).`
      : `${fmtBytes(res.bytes)} — the whole file.`,
  }));

  const isJsonl = /\.jsonl$/i.test(rel);
  if (isJsonl) {
    const lines = res.text.split('\n');
    if (truncated) lines.pop();            // the unterminated tail is not a line (SPEC §1)
    const box = h('div', { class: 'lens-raw' });
    lines.forEach((text, i) => {
      const lineNo = i + 1;
      box.appendChild(h('div', { class: 'lens-raw__line' },
        sid && cls.agentId ? a(withReturn(routes.event(slug, sid, cls.agentId, lineNo, null)), String(lineNo), { class: 'lens-raw__no' })
          : h('span', { class: 'lens-raw__no', text: String(lineNo) }),
        h('code', { class: 'lens-raw__text', text: truncate(text, 400) })));
    });
    sec.appendChild(box);
    sec.appendChild(h('p', { class: 'lens-note', text: 'line numbers are 1-based, as an editor shows them (SPEC §1).' }));
  } else {
    sec.appendChild(h('pre', { class: 'lens-raw__blob', text: res.text }));
  }
  body.appendChild(sec);
}

/**
 * The relpath out of the route params. router.matchCompiled has already
 * percent-DECODED every segment, so decoding again here would corrupt a name
 * that legitimately contains a '%' (DESIGN §0).
 */
export function relFromParams(P) {
  if (Array.isArray(P?.relSegments)) return P.relSegments.join('/');
  if (P?.rel) return String(P.rel);
  return '';
}

/* ---------------------------------------------------------------- routes
 * INTEGRATION-NOTE (resolved 2026-08-17): this file OWNS the two `x` raw-file
 * routes. BUILD-CONTRACTS assigned them no view file; DESIGN §0 lists them
 * beside `inv` and DESIGN §3 requires every ledger row to carry a raw link.
 * Verified at integration that no E/F module registers them — do not add a
 * second registration elsewhere.
 *
 * A trailing `x` is expanded by router.compilePattern into a remainder
 * segment, so one pattern covers a relpath of any depth: params.rel arrives
 * already decoded, with params.relSegments beside it (DESIGN §0).
 */

export const routeList = [
  ['/p/:slug/s/:sid/inv', renderInventory],
  ['/p/:slug/s/:sid/x', renderRawFile],
  ['/p/:slug/x', renderRawFile],
];

/** Each pattern registers independently: one bad pattern cannot silence the rest. */
export function register(defineRoute) {
  for (const [p, r] of routeList) {
    try { defineRoute(p, r); } catch (err) { console.error('defineRoute failed', p, err); }
  }
}
