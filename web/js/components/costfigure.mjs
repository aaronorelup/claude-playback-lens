// web/js/components/costfigure.mjs — DESIGN §6, "cost transparency".
//
// EVERY dollar figure in the app is one of these. It is a button; opening it
// shows how the number was made:
//   * per-raw-model groups with `tokens × rate` lines and the multipliers inline
//   * the R10 rate interval in effect
//   * the disclosure lines that apply (R2/R4/R5/R6/R7/R9, cited by number)
//   * "show the N requests" — /api/records paging (300/page, hard cap 5,000)
//   * a client-side reprice of ONLY the fetched page through the same shared
//     pricing module, with a visible ✓/✗
//   * PRICING_VERSION
//
// The server's CostAgg is the headline and its rowsSumToHeader check is shown.
// At store scope the panel shows the server's check plus the first page rather
// than shipping 29,741 rows.

import {
  h, clear, replace, formatUsd, formatTokens, formatInt, formatRate, formatLocalTime,
  tokenCategories, isKnown, UNKNOWN, unknownNode,
} from '../format.mjs';
import { api, pricingOrNull } from '../api.mjs';
import { buildChips } from './chips.mjs';

export const PAGE_SIZE = 300;
export const HARD_CAP = 5000;

/** The four priced components, in the order the panel prints them. */
export const COMPONENTS = [
  { key: 'input', label: 'input', mult: '×1', tokenKey: 'input' },
  { key: 'output', label: 'output', mult: '×1', tokenKey: 'output' },
  { key: 'cacheWrite', label: 'cache write', mult: '5m ×1.25 · 1h ×2', tokenKey: 'cacheWrite' },
  { key: 'cacheRead', label: 'cache read', mult: '×0.1', tokenKey: 'cacheRead' },
  { key: 'webSearch', label: 'web search', mult: '$0.01/request', tokenKey: null },
];

/** Pure: HARD_CAP bounds one PAGE, not the reachable range — the
 *  server accepts any `from`, so the tail past 5,000 stays reachable. */
export function pagerBounds(from, shown, total) {
  return { prevDisabled: from <= 0, nextDisabled: from + shown >= total };
}

/** Pure: format an R10 interval for printing. */
export function formatInterval(interval) {
  if (!interval) return null;
  const from = interval.from || interval.effectiveFrom;
  const to = interval.to || interval.effectiveTo;
  return `in effect ${from || '…'}..${to || '…'}`;
}

/**
 * Pure: reprice a page of billed rows and compare it with a reference total.
 * Returns { ok, pageTcu, referenceTcu, delta, basis, unpriced }.
 *   basis 'scope'  — the page IS the whole scope, so it must equal agg.usd.total
 *   basis 'rows'   — the rows carried their own usd, compared row by row
 *   basis 'page'   — a partial page; nothing to assert, the subtotal is shown
 */
export function repriceCheck({ rows, total, agg, priceRow }) {
  let pageTcu = 0;
  let unpriced = 0;
  let rowSideTcu = 0;
  let rowsCarriedUsd = true;
  let excludedInherited = 0;
  let excludedSynthetic = 0;
  let excludedSidechain = 0;
  for (const row of rows) {
    // The header's CostAgg excludes inherited copies (R2), synthetic
    // rows (R4) and embedded-sidechain rows (their own channel) — the reprice
    // must apply the SAME exclusion rule or a forked session's panel shows a
    // false ✗. Excluded rows are counted and disclosed, never silently dropped.
    if (row.billedElsewhere !== null && row.billedElsewhere !== undefined) { excludedInherited++; continue; }
    if (row.synthetic) { excludedSynthetic++; continue; }
    if (row.embeddedSidechain === true) { excludedSidechain++; continue; }
    const priced = priceRow ? priceRow(row) : null;
    if (!priced || priced.unpriced) unpriced++;
    else pageTcu += priced.usd.total;
    if (row.usd && isKnown(row.usd.total)) rowSideTcu += row.usd.total;
    else rowsCarriedUsd = false;
  }
  const excluded = {
    inherited: excludedInherited, synthetic: excludedSynthetic, sidechain: excludedSidechain,
    total: excludedInherited + excludedSynthetic + excludedSidechain,
  };
  const counted = rows.length - excluded.total;
  if (rowsCarriedUsd && counted > 0) {
    return { ok: rowSideTcu === pageTcu, pageTcu, referenceTcu: rowSideTcu, delta: pageTcu - rowSideTcu, basis: 'rows', unpriced, excluded };
  }
  const scopeTotal = agg && agg.usd ? agg.usd.total : null;
  if (isKnown(total) && rows.length >= total && isKnown(scopeTotal)) {
    return { ok: pageTcu === scopeTotal, pageTcu, referenceTcu: scopeTotal, delta: pageTcu - scopeTotal, basis: 'scope', unpriced, excluded };
  }
  return { ok: null, pageTcu, referenceTcu: null, delta: null, basis: 'page', unpriced, excluded };
}

/**
 * costfigure(el, props) -> { update, destroy, open, close }
 *
 * props = {
 *   agg,                  // SPEC §9 CostAgg — the headline and the breakdown
 *   scope,                // SPEC §9 scope string, for /api/records
 *   at,                   // ms epoch used to resolve the R10 interval to print
 *   label,                // optional caption on the button
 *   rowsSumToHeader,      // server-computed: true | { delta }
 *   requests,             // billed-request count for "show the N requests"
 *   masses,               // optional disclosure masses (see chips.mjs)
 *   compact,              // render as an inline figure (tables use this)
 *   open,                 // start expanded
 * }
 */
export function costfigure(el, props) {
  const state = { props: props || {}, open: !!(props && props.open), panel: null, records: null, loading: false };

  const btn = h('button', { class: 'lens-cost__figure', type: 'button', 'aria-expanded': 'false' });
  const panel = h('div', { class: 'lens-cost__panel', hidden: true, 'data-lens-layer': 'cost' });

  function drawButton() {
    const agg = state.props.agg;
    const tcu = agg && agg.usd ? agg.usd.total : null;
    clear(btn);
    if (!isKnown(tcu)) {
      btn.appendChild(unknownNode(state.props.unknownReason || 'no cost recorded for this scope'));
    } else {
      btn.appendChild(h('span', { class: 'lens-cost__usd' }, formatUsd(tcu)));
    }
    if (state.props.label) btn.appendChild(h('span', { class: 'lens-cost__label' }, state.props.label));
    btn.setAttribute('title', 'how this number was made');
    btn.setAttribute('aria-expanded', state.open ? 'true' : 'false');
  }

  async function drawPanel() {
    clear(panel);
    const p = state.props;
    const agg = p.agg || {};
    const pricing = await pricingOrNull();

    panel.appendChild(h('h3', { class: 'lens-cost__title' }, 'How this number was made'));

    // --- the four priced components -------------------------------------
    const usd = agg.usd || {};
    const cats = tokenCategories(agg.tokens);
    const comp = h('table', { class: 'lens-table lens-table--tight lens-cost__components' },
      h('thead', null, h('tr', null,
        h('th', null, 'component'), h('th', { class: 'lens-num-col' }, 'tokens'),
        h('th', null, 'multiplier'), h('th', { class: 'lens-num-col' }, 'cost'))),
      h('tbody', null, ...COMPONENTS.map((c) => h('tr', null,
        h('td', null, c.label),
        h('td', { class: 'lens-num-col' }, c.tokenKey ? cell(cats[c.tokenKey]) : cell(agg.webSearchRequests, formatInt)),
        h('td', { class: 'lens-cost__mult' }, c.mult),
        h('td', { class: 'lens-num-col' }, isKnown(usd[c.key]) ? formatUsd(usd[c.key]) : UNKNOWN)))),
      h('tfoot', null, h('tr', null,
        h('th', null, 'total'), h('th', { class: 'lens-num-col' }, ''), h('th', null, ''),
        h('th', { class: 'lens-num-col' }, isKnown(usd.total) ? formatUsd(usd.total) : UNKNOWN))));
    panel.appendChild(comp);

    // --- per-raw-model groups with tokens × rate ------------------------
    panel.appendChild(h('h4', { class: 'lens-cost__subtitle' }, 'By recorded model'));
    const byModel = agg.byModel || {};
    const models = Object.keys(byModel);
    if (!models.length) {
      panel.appendChild(h('p', { class: 'lens-cost__note' }, 'No billed requests in this scope.'));
    } else if (!pricing) {
      panel.appendChild(h('p', { class: 'lens-cost__note lens-cost__note--warn' },
        'The rate table could not be loaded from the server, so only recorded token totals are shown here — no rates, no derived figures.'));
      panel.appendChild(modelTable(byModel, null, null));
    } else {
      panel.appendChild(modelTable(byModel, pricing, p.at));
    }

    // --- disclosures that apply, cited by number ------------------------
    const chips = buildChips(agg, { masses: p.masses });
    if (chips.length) {
      panel.appendChild(h('h4', { class: 'lens-cost__subtitle' }, 'Disclosures that apply'));
      panel.appendChild(h('ul', { class: 'lens-cost__disclosures' },
        ...chips.map((c) => h('li', { class: `lens-cost__disclosure lens-cost__disclosure--${c.tone}`, title: c.title || null }, c.text))));
    }

    // --- the server's own sum check -------------------------------------
    panel.appendChild(sumCheckNode(p.rowsSumToHeader, agg.requests));

    // --- "show the N requests" ------------------------------------------
    const n = isKnown(p.requests) ? p.requests : agg.requests;
    if (p.scope && isKnown(n) && n > 0) {
      const holder = h('div', { class: 'lens-cost__records' });
      const showBtn = h('button', { class: 'lens-btn', type: 'button' },
        `show the ${formatInt(n)} requests`);
      showBtn.addEventListener('click', () => { loadRecords(holder, 0); });
      panel.appendChild(showBtn);
      panel.appendChild(holder);
    }

    panel.appendChild(h('p', { class: 'lens-cost__version' },
      'PRICING_VERSION ', h('code', null, (pricing && pricing.PRICING_VERSION) || UNKNOWN),
      pricing ? null : h('span', { class: 'lens-unknown', title: 'shared/pricing.mjs was not served' }, ' (rate table unavailable)')));
    panel.appendChild(h('p', { class: 'lens-cost__version' },
      'Totals are exact integer tcu; rows shown rounded to 4 dp.'));
  }

  function cell(v, fmt) {
    return isKnown(v) ? (fmt || formatTokens)(v) : unknownNode('not recorded');
  }

  function modelTable(byModel, pricing, at) {
    const table = h('table', { class: 'lens-table lens-table--tight lens-cost__models' },
      h('thead', null, h('tr', null,
        h('th', null, 'model (raw)'), h('th', { class: 'lens-num-col' }, 'requests'),
        h('th', null, 'tokens × rate'), h('th', { class: 'lens-num-col' }, 'cost'))));
    const body = h('tbody');
    for (const raw of Object.keys(byModel)) {
      const lite = byModel[raw] || {};
      const cats = tokenCategories(lite.tokens);
      let lines;
      if (!pricing) {
        lines = h('div', { class: 'lens-cost__rateline lens-cost__rateline--unknown' },
          'rate table unavailable — tokens shown, nothing derived');
      } else if (!isKnown(at)) {
        // With no scope timestamp there is NO honest way to
        // pick an R10 interval — never resolve one at Date.now(). Each billed
        // row resolves its own interval from its recorded `at`; this table
        // simply cannot print a single rate line for the group.
        lines = h('div', { class: 'lens-cost__rateline lens-cost__rateline--unknown' },
          'no single date for this scope — each billed row resolves its own R10 interval from its recorded timestamp; open "show the requests" for the per-row arithmetic');
      } else {
        const rate = safeResolve(pricing, raw, at);
        if (!rate) {
          lines = h('div', { class: 'lens-cost__rateline lens-cost__rateline--unpriced' },
            'no rate for this model — its tokens are counted in the unpriced channel, never $0 · R7');
        } else {
          const interval = formatInterval(rate.interval);
          lines = h('div', { class: 'lens-cost__ratelines' },
            rateLine('input', cats.input, rate.inputU, '×1'),
            rateLine('output', cats.output, rate.outputU, '×1'),
            rateLine('cache write 5m', cats.cache5m, rate.w5mU !== undefined ? rate.w5mU : rate.inputU * 1.25, `(1.25 × ${formatRate(rate.inputU)})`),
            rateLine('cache write 1h', cats.cache1h, rate.w1hU !== undefined ? rate.w1hU : rate.inputU * 2, `(2 × ${formatRate(rate.inputU)})`),
            rateLine('cache read', cats.cacheRead, rate.readU !== undefined ? rate.readU : rate.inputU * 0.1, `(0.1 × ${formatRate(rate.inputU)})`),
            interval ? h('div', { class: 'lens-cost__interval' }, interval, rate.tier && rate.tier !== 'standard' ? ` · tier ${rate.tier}` : '') : null,
            at ? h('div', { class: 'lens-cost__interval-note' },
              'interval resolved at ', formatLocalTime(at), ' — each billed row resolves its own from its recorded timestamp (R10)') : null);
        }
      }
      body.appendChild(h('tr', null,
        h('td', null, h('code', { class: 'lens-model' }, raw)),
        h('td', { class: 'lens-num-col' }, cell(lite.requests, formatInt)),
        h('td', null, lines),
        h('td', { class: 'lens-num-col' }, lite.usd && isKnown(lite.usd.total) ? formatUsd(lite.usd.total) : UNKNOWN)));
    }
    table.appendChild(body);
    return table;
  }

  function rateLine(label, tokens, units, mult) {
    return h('div', { class: 'lens-cost__rateline' },
      h('span', { class: 'lens-cost__rateline-label' }, label),
      h('span', { class: 'lens-cost__rateline-body' },
        isKnown(tokens) ? formatTokens(tokens) : UNKNOWN, ' × ', formatRate(units),
        mult ? h('span', { class: 'lens-cost__mult' }, ' ' + mult) : null));
  }

  function sumCheckNode(rowsSumToHeader, requests) {
    if (rowsSumToHeader === undefined || rowsSumToHeader === null) {
      return h('p', { class: 'lens-cost__note' },
        h('span', { class: 'lens-unknown', title: 'the server did not report rowsSumToHeader for this scope' }, UNKNOWN),
        ' rows-sum-to-header was not reported for this scope.');
    }
    if (rowsSumToHeader === true) {
      return h('p', { class: 'lens-cost__check lens-cost__check--ok' },
        '✓ the server checked, in exact integer tcu, that these rows sum to the header',
        isKnown(requests) ? ` (${formatInt(requests)} billed requests · deduped by message.id · R1)` : '');
    }
    const delta = rowsSumToHeader && rowsSumToHeader.delta;
    return h('p', { class: 'lens-cost__check lens-cost__check--bad' },
      '✗ rows do not sum to the header — delta ',
      h('code', null, typeof delta === 'object' ? JSON.stringify(delta) : String(delta)));
  }

  async function loadRecords(holder, from) {
    if (state.loading) return;
    state.loading = true;
    replace(holder, h('p', { class: 'lens-cost__note' }, 'fetching…'));
    try {
      const count = Math.min(PAGE_SIZE, HARD_CAP);
      const res = await api('/api/records', { scope: state.props.scope, from, count });
      if (res && res.pending) {
        replace(holder, h('p', { class: 'lens-cost__note lens-cost__note--warn' },
          'the index is still building — ', formatInt(res.pending.bytesIndexed), ' of ', formatInt(res.pending.bytesTotal), ' bytes'));
        return;
      }
      state.records = res;
      renderRecords(holder, res, from);
    } catch (err) {
      replace(holder, h('p', { class: 'lens-cost__note lens-cost__note--warn' },
        `could not fetch the rows: ${err.message}`));
    } finally {
      state.loading = false;
    }
  }

  async function renderRecords(holder, res, from) {
    const rows = (res && res.rows) || [];
    const total = res && res.total;
    const pricing = await pricingOrNull();
    const check = repriceCheck({ rows, total, agg: state.props.agg, priceRow: pricing && pricing.priceRow });

    const table = h('table', { class: 'lens-table lens-table--tight lens-cost__rows' },
      h('thead', null, h('tr', null,
        h('th', null, 'at'), h('th', null, 'model'),
        h('th', { class: 'lens-num-col' }, 'in'), h('th', { class: 'lens-num-col' }, 'out'),
        h('th', { class: 'lens-num-col' }, 'cache-w'), h('th', { class: 'lens-num-col' }, 'cache-r'),
        h('th', { class: 'lens-num-col' }, 'cost'), h('th', null, 'file:line'))),
      h('tbody', null, ...rows.map((r) => recordRow(r, pricing))));

    const checkNode = check.basis === 'page'
      ? h('p', { class: 'lens-cost__check lens-cost__check--partial' },
        `page subtotal ${formatUsd(check.pageTcu)}, repriced client-side from the same shared pricing module. `
        + 'Full-scope equality is the server\'s rows-sum-to-header check above — this page is one slice of '
        + `${formatInt(total)} rows.`)
      : h('p', { class: `lens-cost__check lens-cost__check--${check.ok ? 'ok' : 'bad'}` },
        check.ok ? '✓ ' : '✗ ',
        `client-side reprice of these ${formatInt(rows.length)} rows `,
        check.basis === 'scope' ? 'equals the scope total' : 'equals the server\'s per-row figures',
        ': ', formatUsd(check.pageTcu),
        check.ok ? '' : ` vs ${formatUsd(check.referenceTcu)} (delta ${formatUsd(check.delta)})`);

    const ex = check.excluded || { total: 0 };
    replace(holder,
      h('p', { class: 'lens-cost__note' },
        `showing ${formatInt(rows.length)} of ${formatInt(total)} billed rows`,
        total > HARD_CAP ? ` · the server caps a page at ${formatInt(HARD_CAP)}` : ''),
      table,
      ex.total ? h('p', { class: 'lens-cost__note' },
        `${formatInt(ex.total)} rows excluded from the reprice, matching the header's own exclusions: `
        + [ex.inherited ? `${formatInt(ex.inherited)} billed in another session (R2)` : null,
          ex.synthetic ? `${formatInt(ex.synthetic)} synthetic (R4)` : null,
          ex.sidechain ? `${formatInt(ex.sidechain)} embedded sidechain (SPEC §3)` : null,
        ].filter(Boolean).join(' · ')) : null,
      check.unpriced ? h('p', { class: 'lens-cost__note lens-cost__note--warn' },
        `${formatInt(check.unpriced)} of these rows have no rate and are not priced · R7`) : null,
      checkNode,
      pager(holder, from, rows.length, total));
  }

  function recordRow(r, pricing) {
    const priced = pricing && pricing.priceRow ? pricing.priceRow(r) : null;
    const cats = tokenCategories({
      input: r.input, output: r.output, cache5m: r.cache5m, cache1h: r.cache1h,
      cacheFlat: r.cacheFlat, cacheRead: r.cacheRead,
    });
    const locator = r.file && r.line ? `${r.file}:${r.line}` : null;
    // Rows the header does NOT price are marked in the table itself,
    // so a reader summing the visible cost column reproduces the header.
    const inheritedSid = r.billedElsewhere ? (r.billedElsewhere.sessionId ?? r.billedElsewhere) : null;
    const flag = inheritedSid
      ? { text: `billed in ${String(inheritedSid).slice(0, 8)} · R2`, title: `an inherited copy — its usage is billed in session ${inheritedSid} (SPEC R2); this row adds nothing to the header` }
      : r.synthetic
        ? { text: 'synthetic · R4', title: 'an API-error event with zero usage — excluded from billing (SPEC R4)' }
        : r.embeddedSidechain === true
          ? { text: 'sidechain · §3', title: 'an embedded sidechain row — accumulated in its own channel, excluded from turn billing (SPEC §3)' }
          : null;
    const costCell = flag
      ? h('span', { class: 'lens-dim', title: flag.title },
        priced && !priced.unpriced ? formatUsd(priced.usd.total) : UNKNOWN, ' · ', flag.text)
      : (priced && !priced.unpriced ? formatUsd(priced.usd.total)
        : h('span', { class: 'lens-unknown', title: 'no rate for this model · R7' }, UNKNOWN));
    return h('tr', { 'data-lens-row': '' },
      h('td', null, isKnown(r.at) ? formatLocalTime(r.at) : unknownNode('no timestamp recorded')),
      h('td', null, h('code', { class: 'lens-model' }, r.model || UNKNOWN)),
      h('td', { class: 'lens-num-col' }, cell(cats.input)),
      h('td', { class: 'lens-num-col' }, cell(cats.output)),
      h('td', { class: 'lens-num-col' }, cell(cats.cacheWrite)),
      h('td', { class: 'lens-num-col' }, cell(cats.cacheRead)),
      h('td', { class: 'lens-num-col' }, costCell),
      h('td', null, r.href
        ? h('a', { href: r.href, class: 'lens-locator', 'data-lens-drill': '' }, locator || 'open')
        : h('span', { class: 'lens-locator' }, locator || UNKNOWN)));
  }

  function pager(holder, from, shown, total) {
    if (!isKnown(total) || total <= PAGE_SIZE) return null;
    const bounds = pagerBounds(from, shown, total);
    const prev = h('button', { class: 'lens-btn', type: 'button', disabled: bounds.prevDisabled || null },
      '← previous 300');
    const next = h('button', { class: 'lens-btn', type: 'button', disabled: bounds.nextDisabled || null },
      'next 300 →');
    prev.addEventListener('click', () => loadRecords(holder, Math.max(0, from - PAGE_SIZE)));
    next.addEventListener('click', () => loadRecords(holder, from + PAGE_SIZE));
    return h('div', { class: 'lens-pager' }, prev,
      h('span', { class: 'lens-pager__label' },
        `rows ${formatInt(from + 1)}–${formatInt(from + shown)} of ${formatInt(total)}`), next);
  }

  function toggle() {
    state.open = !state.open;
    btn.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    if (state.open) { panel.removeAttribute('hidden'); drawPanel(); }
    else panel.setAttribute('hidden', '');
  }

  btn.addEventListener('click', toggle);

  const root = h('div', { class: `lens-cost${state.props.compact ? ' lens-cost--compact' : ''}` }, btn, panel);
  el.appendChild(root);
  drawButton();
  if (state.open) { panel.removeAttribute('hidden'); drawPanel(); }

  return {
    update(next) {
      state.props = Object.assign({}, state.props, next);
      drawButton();
      if (state.open) drawPanel();
    },
    open() { if (!state.open) toggle(); },
    close() { if (state.open) toggle(); },
    destroy() { if (root.parentNode) root.parentNode.removeChild(root); },
  };
}

function safeResolve(pricing, raw, at) {
  // No Date.now() fallback, ever — a rate interval resolved at render
  // time is not a recorded fact. Callers guard `at` before reaching here.
  if (!isKnown(at)) return null;
  try {
    const key = pricing.modelKey(raw);
    return pricing.resolveRate({ key, speed: null, serviceTier: null, atMs: at });
  } catch { return null; }
}
