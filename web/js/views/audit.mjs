/**
 * Audit (`#/audit[/…scope]`) — SPEC §10 rendered over the audit SSE stream.
 * The "prove it" page: Path A (what the app displays, cache-backed) against
 * Path B (an independent flat rescan with separately-written code), plus the
 * invariant table, the disclosure censuses, expandable evidence rows, and the
 * printed scope of what the equality does and does not prove.
 */

import { kit } from '../lib/net.mjs';
import { h, a, clear, unknown, section, factList } from '../lib/dom.mjs';
import { fmtInt, fmtDur, shortId, truncate } from '../lib/fmt.mjs';
import { routes } from '../lib/links.mjs';
import { copyLocator } from '../lib/locator.mjs';
import { page, errorCard, mountCrumbs, progressBar } from '../lib/chrome.mjs';
import { safeStringify } from '../lib/text.mjs';
import {
  classifyRel, impactsTotals, collapseProblems,
} from './inv.mjs';

/* ============================================================ pure ==== */

const SESSION_ROW = /^session[:/]/i;

/**
 * assembleInvariants(events) — fold the SSE `invariant` stream into the table.
 * Later events for a name supersede earlier ones (a run may refine a figure);
 * per-session A/B rows are separated from global invariants by their name.
 * Pure: this is the whole audit table, testable without a server.
 */
export function assembleInvariants(events = []) {
  const byName = new Map();
  for (const ev of events) {
    if (!ev || ev.name === undefined || ev.name === null) continue;
    const prev = byName.get(ev.name);
    byName.set(ev.name, prev ? { ...prev, ...ev } : { ...ev });
  }
  const rows = [...byName.values()];
  const sessions = rows.filter((r) => SESSION_ROW.test(String(r.name)));
  const invariants = rows.filter((r) => !SESSION_ROW.test(String(r.name)));
  const counted = rows.filter((r) => r.pass !== undefined && r.pass !== null);
  const failed = counted.filter((r) => r.pass === false);
  return {
    rows, invariants, sessions,
    total: counted.length,
    passed: counted.length - failed.length,
    failed: failed.length,
    unreported: rows.length - counted.length,
    allPass: counted.length > 0 && failed.length === 0,
  };
}

/** A recorded expected/actual value as one display string (never a guess). */
export function valueText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return truncate(safeStringify(v).replace(/\s+/g, ' '), 160);
  return String(v);
}

/** Session id out of an invariant row name like `session:<slug>/<id>`. */
export function sessionOfRow(row) {
  const m = /^session[:/](?:([^/]+)\/)?(.+)$/i.exec(String(row?.name ?? ''));
  if (!m) return null;
  return { slug: row.slug ?? m[1] ?? null, id: row.id ?? m[2] ?? null };
}

/** Both paths' file censuses, side by side (SPEC §10). */
export function censusPairs(done = {}) {
  const A = done.pathA ?? done.a ?? done.censusA ?? null;
  const B = done.pathB ?? done.b ?? done.censusB ?? null;
  if (!A && !B) return null;
  const keys = [...new Set([...Object.keys(A ?? {}), ...Object.keys(B ?? {})])];
  return keys.map((k) => ({
    key: k,
    a: A?.[k] ?? null,
    b: B?.[k] ?? null,
    equal: A && B ? JSON.stringify(A[k]) === JSON.stringify(B[k]) : null,
  }));
}

/* ============================================================ view ==== */

export async function renderAudit(ctx) {
  const { body } = page(ctx, 'lens-audit');
  const K = await kit();
  // R14 / STALE-RENDER RULE (BUILD-CONTRACTS): guard after EVERY await. This
  // one is load-bearing beyond the usual repaint concern — the abort listener
  // that closes the SSE stream is registered at the END of this function, so a
  // render superseded during `await kit()` would open a corpus scan whose
  // 'abort' already fired and which therefore nothing would ever close.
  if (ctx.stale) return;
  const scope = ctx.query?.get?.('scope') ?? scopeFromParams(ctx.params) ?? 'store';

  mountCrumbs(ctx, [{ label: 'store', href: routes.store() }, { label: 'audit' }]);
  ctx.setTitle?.('audit — Claude Playback Lens');

  ctx.scopeSentence?.({ extra: [`Path A is the hierarchy this app displays, served from its cache. Path B is an independent flat rescan by separately-written code: its own directory walk, its own \\n-only line reader, its own R1–R4 and R7 implementation, no shared offset tables and no cached summaries. Scope: ${scope}.`] });
  ctx.registerScope?.(scope === 'store' ? null : scope);

  const prog = progressBar();
  const status = h('p', { class: 'lens-audit__status', text: 'starting the audit…' });
  body.appendChild(h('div', { class: 'lens-audit__progress' }, prog.el, status));

  const verdict = h('div', { class: 'lens-audit__verdict' });
  const invSec = section('invariants');
  const sessSec = section('Path A vs Path B — per session');
  const censusSec = section('file censuses — both paths, side by side');
  const disclosureSec = section('disclosure censuses');
  const problemSec = section('problems');
  const proofSec = section('what A === B proves — and what it does not');
  body.append(verdict, invSec, sessSec, censusSec, disclosureSec, problemSec, proofSec);

  proofSec.appendChild(h('div', { class: 'lens-proof' },
    h('p', { text: 'A === B proves: the ledger arithmetic, the R1–R4 application, R7 routing, every level of aggregation, and the cache — GIVEN the rate table.' }),
    h('p', { text: 'It cannot validate the rates or modelKey normalisation: both paths (and the cost panel\'s client-side reprice) import the same shared/pricing.mjs. That single shared piece is disclosed here deliberately.' }),
    h('p', { text: 'The rate table is covered instead by PRICING_VERSION, the printed source and retrieval date, and the module-load integrality assertions — all visible on the settings page.' }),
    a(routes.settings(), 'open the pricing table')));

  const invariants = [];
  const problems = [];
  let stream = null;
  let finished = false;
  const started = Date.now();

  const repaint = () => {
    const model = assembleInvariants(invariants);
    clear(invSec);
    invSec.appendChild(h('h2', { class: 'lens-section__title', text: `invariants — ${fmtInt(model.passed)} of ${fmtInt(model.total)} passing` }));
    if (!model.invariants.length) {
      invSec.appendChild(h('p', { class: 'lens-note', text: 'no invariant has been reported yet.' }));
    } else {
      const t = h('table', { class: 'lens-table' },
        h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'invariant' }), h('th', { text: 'expected' }), h('th', { text: 'actual' }))));
      const tb = h('tbody');
      for (const r of model.invariants) {
        const exp = valueText(r.expected), act = valueText(r.actual);
        tb.appendChild(h('tr', { class: r.pass === false ? 'lens-table__row--error' : '' },
          h('td', { class: 'lens-audit__mark', text: r.pass === true ? '✓' : r.pass === false ? '✗' : '' },
            r.pass === true || r.pass === false ? null : unknown('this run reported the invariant without a pass/fail verdict')),
          h('td', {}, h('code', { text: String(r.name) })),
          h('td', { class: 'lens-table__num' }, exp === null ? unknown('no expected value reported') : h('span', { text: exp })),
          h('td', { class: 'lens-table__num' }, act === null ? unknown('no actual value reported') : h('span', { text: act }))));
      }
      t.appendChild(tb);
      invSec.appendChild(t);
    }

    clear(sessSec);
    sessSec.appendChild(h('h2', { class: 'lens-section__title', text: `Path A vs Path B — ${fmtInt(model.sessions.length)} session(s) reconciled` }));
    if (!model.sessions.length) {
      sessSec.appendChild(h('p', { class: 'lens-note', text: 'no per-session reconciliation has been reported yet.' }));
    } else {
      const t = h('table', { class: 'lens-table' },
        h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'session' }), h('th', { text: 'Path A' }), h('th', { text: 'Path B' }), h('th', { text: 'evidence' }))));
      const tb = h('tbody');
      for (const r of model.sessions) {
        const who = sessionOfRow(r);
        const expandRow = h('tr', { class: 'lens-audit__evidence', hidden: true }, h('td', { colspan: '5' }));
        const btn = h('button', {
          class: 'lens-btn lens-btn--expand', text: 'evidence',
          onclick: async () => {
            expandRow.hidden = !expandRow.hidden;
            if (expandRow.dataset.loaded) return;
            expandRow.dataset.loaded = '1';
            await loadEvidence(expandRow.firstChild, who, K, ctx);
          },
        });
        tb.appendChild(h('tr', { class: r.pass === false ? 'lens-table__row--error' : '' },
          h('td', { class: 'lens-audit__mark', text: r.pass === true ? '✓' : r.pass === false ? '✗' : '—' }),
          h('td', {}, who?.slug && who?.id ? a(routes.session(who.slug, who.id), `${who.slug} · ${shortId(who.id)}`) : h('code', { text: String(r.name) })),
          h('td', { class: 'lens-table__num' }, valueText(r.expected) === null ? unknown('Path A figure not reported') : h('span', { text: valueText(r.expected) })),
          h('td', { class: 'lens-table__num' }, valueText(r.actual) === null ? unknown('Path B figure not reported') : h('span', { text: valueText(r.actual) })),
          h('td', {}, who?.id ? btn : null)));
        tb.appendChild(expandRow);
      }
      t.appendChild(tb);
      sessSec.appendChild(t);
      sessSec.appendChild(h('p', { class: 'lens-note', text: 'Expected = Path A (the displayed hierarchy). Actual = Path B (the independent rescan). Evidence expands the billed rows behind a session, each with a 1-based file:line link into the event view.' }));
    }

    clear(verdict);
    const badge = model.failed > 0 ? '✗' : model.allPass ? '✓' : '…';
    verdict.appendChild(h('p', {
      class: `lens-audit__badge lens-audit__badge--${model.failed > 0 ? 'fail' : model.allPass ? 'pass' : 'pending'}`,
      text: `${badge} ${fmtInt(model.passed)} of ${fmtInt(model.total)} checks passing${model.failed ? ` · ${fmtInt(model.failed)} FAILING` : ''}${model.unreported ? ` · ${fmtInt(model.unreported)} reported without a verdict` : ''}`,
    }));
  };

  stream = K.sse('/api/audit', { scope: scope === 'store' ? '' : scope }, {
    progress: (p) => prog.update(p),
    invariant: (ev) => { invariants.push(ev); repaint(); },
    problem: (p) => { problems.push(p); paintProblems(problemSec, problems); },
    error: (e) => { finished = true; status.textContent = ''; body.appendChild(errorCard({ code: e?.code ?? 'audit-error', message: e?.message ?? 'the audit reported an error' })); },
    done: (d) => {
      finished = true;
      const model = assembleInvariants(invariants);
      prog.done(`${fmtInt(model.total)} checks · ${fmtDur(Date.now() - started)}`);
      status.textContent = model.failed > 0
        ? `${fmtInt(model.failed)} check(s) FAILED — every failing row prints its expected and actual value above.`
        : `all ${fmtInt(model.total)} reported checks passed in ${fmtDur(Date.now() - started)}.`;
      paintCensus(censusSec, d ?? {});
      paintDisclosures(disclosureSec, d ?? {}, model);
      repaint();
    },
  });

  // The router aborts the previous ctx on every navigation —
  // that abort is the stream's lifecycle, not a DOM-connectivity watchdog
  // whose element never actually disconnects.
  void finished;
  ctx.signal?.addEventListener?.('abort', () => { try { stream?.close?.(); } catch { /* already closed */ } });
}

async function loadEvidence(cell, who, K, ctx) {
  clear(cell);
  if (!who?.slug || !who?.id) { cell.appendChild(unknown('this row does not name a session to fetch evidence for')); return; }
  cell.appendChild(h('p', { class: 'lens-note', text: 'loading billed rows…' }));
  try {
    // R14 / STALE-RENDER RULE: the render that painted this row owns the fetch,
    // so leaving the page cancels it instead of leaving 300 billed rows in
    // flight for a table that is already detached.
    const p = await K.api('/api/records', { scope: `session:${who.slug}/${who.id}`, from: 0, count: 300 }, { signal: ctx?.signal });
    if (ctx?.stale) return;
    clear(cell);
    const rows = p.rows ?? p.records ?? [];
    cell.appendChild(h('p', {
      class: 'lens-note',
      text: `${fmtInt(rows.length)} of ${fmtInt(p.total ?? rows.length)} billed rows · rows sum to header: ${p.rowsSumToHeader === true ? '✓' : p.rowsSumToHeader ? safeStringify(p.rowsSumToHeader) : 'not reported'} · CostAgg.requests counts billed rows with synthetic === false (R4).`,
    }));
    const t = h('table', { class: 'lens-table' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'file:line' }), h('th', { text: 'message.id' }), h('th', { text: 'model' }),
        h('th', { class: 'lens-table__num', text: 'in' }), h('th', { class: 'lens-table__num', text: 'out' }),
        h('th', { class: 'lens-table__num', text: 'cache w' }), h('th', { class: 'lens-table__num', text: 'cache r' }),
        h('th', { text: 'flags' }))));
    const tb = h('tbody');
    // NO `?? 0` on the evidence table — this is the prove-it page, and
    // a coerced zero would make a future recording gap invisible exactly where
    // the reader came to check. Unknown renders — with its reason.
    const tokCell = (v) => h('td', { class: 'lens-table__num' },
      Number.isFinite(v) ? h('span', { text: fmtInt(v) }) : unknown('not recorded on this billed row'));
    for (const r of rows) {
      const cls = classifyRel(r.file ?? '');
      const flags = [
        r.synthetic ? 'synthetic (R4)' : null,
        r.finalized === false ? 'never-finalized (R6)' : null,
        r.billedElsewhere ? `billed in ${shortId(r.billedElsewhere.sessionId ?? r.billedElsewhere)} (R2)` : null,
        r.iterIndex !== null && r.iterIndex !== undefined ? `iteration ${r.iterIndex} (R3)` : null,
        r.ttl === 'unrecorded' ? 'ttl assumed (R5)' : null,
      ].filter(Boolean).join(' · ');
      const cacheW = [r.cache5m, r.cache1h, r.cacheFlat].every((v) => Number.isFinite(v))
        ? r.cache5m + r.cache1h + r.cacheFlat : null;
      tb.appendChild(h('tr', {},
        h('td', {}, r.line !== undefined
          ? a(routes.event(who.slug, who.id, cls.agentId ?? 'main', r.line, null), copyLocator(r.file ?? '', r.line, null))
          : unknown('no locator recorded on this row')),
        h('td', {}, h('code', { text: truncate(r.msgId ?? '', 28) })),
        h('td', { text: r.model ?? '' }),
        tokCell(r.input),
        tokCell(r.output),
        h('td', { class: 'lens-table__num' }, cacheW !== null ? h('span', { text: fmtInt(cacheW) })
          : unknown('a cache-write part is not recorded on this billed row, so the sum has no exact value')),
        tokCell(r.cacheRead),
        h('td', { text: flags })));
    }
    t.appendChild(tb);
    cell.appendChild(t);
  } catch (err) {
    // R14 / STALE-RENDER RULE: FIRST statement of the catch. The AbortError
    // from the signal above lands here too, and a superseded render must not
    // paint an error card for a request it cancelled itself.
    if (ctx?.stale) return;
    clear(cell).appendChild(errorCard(err));
  }
}

function paintCensus(sec, done) {
  clear(sec);
  sec.appendChild(h('h2', { class: 'lens-section__title', text: 'file censuses — both paths, side by side' }));
  const pairs = censusPairs(done);
  if (!pairs) {
    sec.appendChild(unknown('this run did not report the two paths\' file censuses'));
    return;
  }
  const t = h('table', { class: 'lens-table' },
    h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'measure' }), h('th', { text: 'Path A' }), h('th', { text: 'Path B (independent walk)' }))));
  const tb = h('tbody');
  for (const p of pairs) {
    tb.appendChild(h('tr', { class: p.equal === false ? 'lens-table__row--error' : '' },
      h('td', { class: 'lens-audit__mark', text: p.equal === true ? '✓' : p.equal === false ? '✗' : '' }),
      h('td', { text: p.key }),
      h('td', { class: 'lens-table__num' }, valueText(p.a) === null ? unknown('not reported by Path A') : h('span', { text: valueText(p.a) })),
      h('td', { class: 'lens-table__num' }, valueText(p.b) === null ? unknown('not reported by Path B') : h('span', { text: valueText(p.b) }))));
  }
  t.appendChild(tb);
  sec.appendChild(t);
  sec.appendChild(h('p', { class: 'lens-note', text: 'Path B walks the directory tree itself and never reuses the FileTable — a difference here is a real disagreement about what exists on disk, not a rounding question.' }));
}

function paintDisclosures(sec, done, model) {
  clear(sec);
  sec.appendChild(h('h2', { class: 'lens-section__title', text: 'disclosure censuses' }));
  const d = done.disclosures ?? done.censuses ?? null;
  if (!d) {
    sec.appendChild(h('p', { class: 'lens-note', text: 'This run reported no separate disclosure block; the disclosure figures it did report appear in the invariant table above (every CostAgg disclosure counter has exactly one chip and one audit census — the drift rule, SPEC §9).' }));
    return;
  }
  sec.appendChild(factList(Object.entries(d).map(([k, v]) => ({
    label: k, value: valueText(v), source: 'audit run', reason: 'not reported',
  }))));
  sec.appendChild(h('p', { class: 'lens-note', text: 'Each counter here has exactly one chip in the UI and one census on this page; adding a counter requires both (SPEC §9 drift rule).' }));
}

function paintProblems(sec, problems) {
  clear(sec);
  const rows = collapseProblems(problems);
  sec.appendChild(h('h2', { class: 'lens-section__title', text: `problems — ${fmtInt(rows.length)} distinct` }));
  if (!rows.length) { sec.appendChild(h('p', { class: 'lens-note', text: '0 problems reported by this run.' })); return; }
  const t = h('table', { class: 'lens-table' },
    h('thead', {}, h('tr', {}, h('th', { text: 'code' }), h('th', { text: 'severity' }), h('th', { class: 'lens-table__num', text: 'count' }), h('th', { text: 'impacts totals?' }), h('th', { text: 'message' }))));
  const tb = h('tbody');
  for (const p of rows) {
    const impacts = impactsTotals(p);
    tb.appendChild(h('tr', {},
      h('td', {}, h('code', { text: p.code ?? '' })),
      h('td', { text: p.severity ?? '' }),
      h('td', { class: 'lens-table__num', text: fmtInt(p.count ?? 1) }),
      h('td', {}, impacts === null ? unknown('no `affects` recorded on this problem') : h('span', { text: impacts })),
      h('td', { text: p.message ?? '' })));
  }
  t.appendChild(tb);
  sec.appendChild(t);
}

function scopeFromParams(P) {
  if (!P) return null;
  // The scope grammar itself contains '/', so it arrives as the remainder.
  if (Array.isArray(P.scopeSegments)) return P.scopeSegments.join('/');
  return P.scope ? String(P.scope) : null;
}

/* ---------------------------------------------------------------- routes */

export const routeList = [
  ['/audit', renderAudit],
  ['/audit/*scope', renderAudit],
];
export function register(defineRoute) {
  for (const [p, r] of routeList) {
    try { defineRoute(p, r); } catch (err) { console.error('defineRoute failed', p, err); }
  }
}
