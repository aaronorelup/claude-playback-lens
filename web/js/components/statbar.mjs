// web/js/components/statbar.mjs — band 3 of DESIGN §1. ONE component, identical
// at every level:
//
//     $cost | in · out · cache-w · cache-r | span | counts
//
// Counts vary by level; the slot does not. Every cell is a BUTTON that opens
// its contribution panel: immediate children ranked by contribution to that
// number (a sort, not a score), with share bars and drill links.
//
//   cost cell   -> the four-component split + per-model rates + the R10 interval
//                  (delegated to costfigure.mjs, DESIGN §6)
//   token cell  -> the 4-way split, group-by child / model
//   span cell   -> span vs Σ children (parallelism), and `active` labelled apart
//   count cells -> children ranked by that count
//
// Footnote: `N billed requests · deduped by message.id (R1) · rows sum to
// header ✓` — computed SERVER-SIDE in exact integer tcu (never rendered
// strings). Below it, the disclosure chips (chips.mjs), only when nonzero.
//
// Tokens NEVER collapse to one figure. Unknown is '—' + reason; zero is '0'.

import {
  h, clear, formatUsd, formatTokens, formatInt, formatDuration, formatPercent,
  formatLocalTime, tokenCategories, isKnown, UNKNOWN, unknownNode, pip,
} from '../format.mjs';
import { chipsRow } from './chips.mjs';
import { costfigure } from './costfigure.mjs';

/** The fixed cell order. Views cannot reorder it — that is the point. */
export const CELL_ORDER = ['cost', 'tokens', 'span', 'counts'];

/**
 * statbar(el, props) -> { update, destroy, openCell, closePanel }
 *
 * props = {
 *   pending,        // true -> '—' pips at final widths (DESIGN §7 chrome-first)
 *   cost,           // { tcu } or omitted when `agg` carries it
 *   agg,            // SPEC §9 CostAgg — drives cost, tokens, chips, panels
 *   tokens,         // SPEC §9 Tokens — defaults to agg.tokens
 *   span,           // { ms, from, to, label:'span'|'wall' }
 *   active,         // { ms }  union of intervals — ALWAYS labelled separately
 *   counts,         // [{ key, label, value, href?, reason? }]
 *   chips,          // CostAgg for the chips row (defaults to `agg`)
 *   masses,         // disclosure masses the CostAgg shape does not carry
 *   scope,          // SPEC §9 scope string (cost panel -> /api/records)
 *   at,             // ms epoch used to print the R10 interval in effect
 *   footnote,       // { requests, rowsSumToHeader }  server-computed
 *   contributions,  // { cost:[…], tokens:[…], span:{…}, <countKey>:[…] }
 *   loadContribution(cellKey) -> contribution | Promise<contribution>
 *   onDrill(href|cellKey),
 * }
 *
 * A contribution list entry: { label, href?, value, share?, sublabel? }
 */
export function statbar(el, props) {
  const state = { props: props || {}, openCell: null, groupBy: 'child', cellNodes: new Map() };

  const cellsEl = h('div', { class: 'lens-statbar__cells', role: 'group', 'aria-label': 'Totals for this scope' });
  const panelEl = h('div', { class: 'lens-statbar__panel', hidden: true, 'data-lens-layer': 'statpanel' });
  const footEl = h('p', { class: 'lens-statbar__footnote' });
  const chipsEl = h('div', { class: 'lens-chips', hidden: true });
  const root = h('div', { class: 'lens-statbar' }, cellsEl, panelEl, footEl, chipsEl);
  el.appendChild(root);

  const chips = chipsRow(chipsEl, { agg: null });

  function agg() { return state.props.agg || null; }
  function costTcu() {
    const p = state.props;
    if (p.cost && isKnown(p.cost.tcu)) return p.cost.tcu;
    const a = agg();
    return a && a.usd && isKnown(a.usd.total) ? a.usd.total : null;
  }
  function tokens() {
    return state.props.tokens || (agg() ? agg().tokens : null);
  }

  /* ---------------- cells ---------------- */

  function drawCells() {
    const p = state.props;
    clear(cellsEl);
    state.cellNodes.clear();
    cellsEl.appendChild(costCell());
    cellsEl.appendChild(sep());
    cellsEl.appendChild(tokenCell());
    cellsEl.appendChild(sep());
    cellsEl.appendChild(spanCell());
    const counts = p.counts || [];
    if (counts.length) cellsEl.appendChild(sep());
    for (const c of counts) cellsEl.appendChild(countCell(c));
  }

  function sep() { return h('span', { class: 'lens-statbar__sep', 'aria-hidden': 'true' }, '|'); }

  function cellButton(key, className, children, title) {
    const btn = h('button', {
      class: `lens-statbar__cell ${className}`,
      type: 'button',
      'aria-expanded': state.openCell === key ? 'true' : 'false',
      title: title || 'what makes up this number',
      'data-cell': key,
    }, children);
    btn.addEventListener('click', () => toggleCell(key));
    state.cellNodes.set(key, btn);
    return btn;
  }

  /** Reflect which cell is open WITHOUT rebuilding the cells (focus survives). */
  function syncCellState() {
    for (const [key, node] of state.cellNodes) {
      node.setAttribute('aria-expanded', state.openCell === key ? 'true' : 'false');
    }
  }

  function costCell() {
    if (state.props.pending) {
      return cellButton('cost', 'lens-statbar__cell--cost',
        [labelNode('cost'), pip('usd')], 'not loaded yet');
    }
    const tcu = costTcu();
    // The reason chain — an explicit prop wins, then the reason the
    // caller attached to its cost object, then the generic wording.
    const reason = state.props.costUnknownReason
      || (state.props.cost && state.props.cost.reason)
      || 'no priced requests in this scope';
    return cellButton('cost', 'lens-statbar__cell--cost', [
      labelNode('cost'),
      isKnown(tcu)
        ? h('span', { class: 'lens-statbar__value lens-num lens-num--usd' }, formatUsd(tcu))
        : unknownNode(reason),
    ], 'the four-component split, per-model rates and the rate interval in effect');
  }

  function tokenCell() {
    const p = state.props;
    if (p.pending) {
      return cellButton('tokens', 'lens-statbar__cell--tokens',
        [labelNode('tokens'), h('span', { class: 'lens-statbar__tokens' },
          tokenPip('in'), tokenPip('out'), tokenPip('cache-w'), tokenPip('cache-r'))]);
    }
    const cats = tokenCategories(tokens());
    return cellButton('tokens', 'lens-statbar__cell--tokens', [
      labelNode('tokens'),
      h('span', { class: 'lens-statbar__tokens' },
        tokenPart('in', cats.input),
        tokenPart('out', cats.output),
        tokenPart('cache-w', cats.cacheWrite, 'cache_creation: 5m + 1h (+ flat, R5)'),
        tokenPart('cache-r', cats.cacheRead)),
    ], 'the four token categories, and which children or models they came from');
  }

  function tokenPart(label, value, title) {
    return h('span', { class: 'lens-statbar__tok', title: title || null },
      h('span', { class: 'lens-statbar__tok-label' }, label),
      isKnown(value)
        ? h('span', { class: 'lens-num lens-num--tok' }, formatTokens(value))
        : unknownNode('not recorded'));
  }

  function tokenPip(label) {
    return h('span', { class: 'lens-statbar__tok' },
      h('span', { class: 'lens-statbar__tok-label' }, label), pip('tok'));
  }

  function spanCell() {
    const p = state.props;
    if (p.pending) {
      return cellButton('span', 'lens-statbar__cell--span', [labelNode('span'), pip('span')]);
    }
    const span = p.span || {};
    const label = span.label || 'span';
    const body = isKnown(span.ms)
      ? h('span', { class: 'lens-statbar__value lens-num lens-num--dur' }, formatDuration(span.ms))
      : unknownNode(span.reason || 'fewer than two recorded timestamps in this scope');
    const active = p.active && isKnown(p.active.ms)
      ? h('span', { class: 'lens-statbar__active', title: 'the union of this scope\'s recorded intervals — always labelled apart from span' },
        'active ', h('span', { class: 'lens-num lens-num--dur' }, formatDuration(p.active.ms)))
      : null;
    return cellButton('span', 'lens-statbar__cell--span',
      [labelNode(label), body, active],
      'span is max−min over the scope\'s bars; active is the union of its intervals');
  }

  function countCell(c) {
    if (state.props.pending) {
      return cellButton(`count:${c.key}`, 'lens-statbar__cell--count', [labelNode(c.label), pip('count')]);
    }
    return cellButton(`count:${c.key}`, 'lens-statbar__cell--count', [
      labelNode(c.label),
      isKnown(c.value)
        ? h('span', { class: 'lens-statbar__value lens-num' }, formatInt(c.value))
        : unknownNode(c.reason || 'not recorded'),
    ]);
  }

  function labelNode(text) {
    return h('span', { class: 'lens-statbar__label' }, text);
  }

  /* ---------------- footnote + chips ---------------- */

  function drawFootnote() {
    const p = state.props;
    clear(footEl);
    if (p.pending) { footEl.appendChild(pip('wide')); return; }
    const fn = p.footnote || {};
    const requests = isKnown(fn.requests) ? fn.requests : (agg() ? agg().requests : null);
    footEl.appendChild(h('span', null,
      isKnown(requests) ? formatInt(requests) : UNKNOWN, ' billed requests · deduped by message.id (R1) · '));
    if (fn.rowsSumToHeader === true) {
      footEl.appendChild(h('span', { class: 'lens-ok', title: 'checked server-side in exact integer tcu' }, 'rows sum to header ✓'));
    } else if (fn.rowsSumToHeader === undefined || fn.rowsSumToHeader === null) {
      footEl.appendChild(h('span', { class: 'lens-unknown', title: 'the server did not report rowsSumToHeader for this scope' },
        `rows sum to header ${UNKNOWN}`));
    } else {
      const delta = fn.rowsSumToHeader.delta;
      footEl.appendChild(h('span', { class: 'lens-bad' },
        'rows do NOT sum to header ✗ — delta ',
        h('code', null, typeof delta === 'object' ? JSON.stringify(delta) : String(delta))));
    }
    footEl.appendChild(h('span', { class: 'lens-statbar__exactness' },
      ' · totals are exact; rows shown rounded to 4 dp'));
  }

  function drawChips() {
    chips.update({
      agg: state.props.chips || state.props.agg || null,
      masses: state.props.masses,
      links: state.props.chipLinks,
    });
  }

  /* ---------------- contribution panels ---------------- */

  function toggleCell(key) {
    if (state.openCell === key) { closePanel(); return; }
    state.openCell = key;
    syncCellState();
    panelEl.removeAttribute('hidden');
    drawPanel(key);
  }

  function closePanel() {
    state.openCell = null;
    syncCellState();
    panelEl.setAttribute('hidden', '');
    clear(panelEl);
  }

  async function drawPanel(key) {
    const p = state.props;
    clear(panelEl);
    panelEl.appendChild(h('div', { class: 'lens-statbar__panel-head' },
      h('h3', { class: 'lens-statbar__panel-title' }, panelTitle(key)),
      h('button', { class: 'lens-btn lens-btn--ghost', type: 'button', onclick: closePanel }, 'close')));

    if (key === 'cost') {
      // A caller may declare the cost panel unopenable WITH the stated
      // reason (Σ-filtered day-band sums have no per-model breakdown).
      if (p.costPanel && p.costPanel.enabled === false) {
        panelEl.appendChild(h('p', { class: 'lens-statbar__panel-note' },
          p.costPanel.reason || 'this scope supplies no per-model breakdown for its cost figure'));
        return;
      }
      const holder = h('div', { class: 'lens-statbar__panel-body' });
      panelEl.appendChild(holder);
      costfigure(holder, {
        agg: p.agg, scope: p.scope, at: p.at, masses: p.masses,
        rowsSumToHeader: p.footnote && p.footnote.rowsSumToHeader,
        requests: p.footnote && p.footnote.requests,
        open: true,
      });
    } else if (key === 'span') {
      panelEl.appendChild(spanPanel());
    } else if (key === 'tokens') {
      panelEl.appendChild(tokenSplitTable());
      panelEl.appendChild(groupToggle());
    }

    const contribution = await resolveContribution(key);
    if (contribution && contribution.length) {
      panelEl.appendChild(contributionList(key, contribution));
    } else if (key !== 'cost' && key !== 'span') {
      panelEl.appendChild(h('p', { class: 'lens-statbar__panel-note' },
        'This level did not supply a child breakdown for this number.'));
    }
  }

  function panelTitle(key) {
    if (key === 'cost') return 'Cost — how this number was made';
    if (key === 'tokens') return 'Tokens — the four recorded categories';
    if (key === 'span') return 'Time — span, active, and Σ children';
    const c = (state.props.counts || []).find((x) => `count:${x.key}` === key);
    return `${(c && c.label) || 'count'} — ranked by contribution`;
  }

  async function resolveContribution(key) {
    const p = state.props;
    const table = p.contributions || {};
    const bare = key.startsWith('count:') ? key.slice(6) : key;
    const direct = table[key] !== undefined ? table[key] : table[bare];
    if (direct) return direct;
    if (typeof p.loadContribution === 'function') {
      try { return await p.loadContribution(key, { groupBy: state.groupBy }); } catch { return null; }
    }
    return null;
  }

  function contributionList(key, rows) {
    // These are SHARE bars (DESIGN §1) — the bar is value/total, the
    // same ratio the printed % shows. A max-normalised bar beside a % lies.
    const total = rows.reduce((s, r) => s + (isKnown(r.value) ? r.value : 0), 0);
    const of = rows.of ?? rows.totalCount ?? null;
    const fmt = key === 'cost' ? formatUsd : formatInt;
    const list = h('ol', { class: 'lens-contrib' });
    for (const r of rows) {
      const share = total > 0 && isKnown(r.value) ? r.value / total : 0;
      const bar = h('span', { class: 'lens-contrib__bar' });
      bar.setAttribute('style', `width:${(share * 100).toFixed(2)}%`);
      const label = r.href
        ? h('a', { class: 'lens-contrib__label', href: r.href, 'data-lens-drill': '' }, r.label)
        : h('span', { class: 'lens-contrib__label' }, r.label);
      list.appendChild(h('li', { class: 'lens-contrib__row', 'data-lens-row': '' },
        label,
        r.sublabel ? h('span', { class: 'lens-contrib__sub' }, r.sublabel) : null,
        h('span', { class: 'lens-contrib__track' }, bar),
        h('span', { class: 'lens-contrib__value lens-num' }, isKnown(r.value) ? fmt(r.value) : UNKNOWN),
        h('span', { class: 'lens-contrib__share' }, total > 0 && isKnown(r.value) ? formatPercent(r.value, total) : UNKNOWN)));
    }
    return h('div', { class: 'lens-statbar__panel-body' },
      h('p', { class: 'lens-statbar__panel-note' },
        'Immediate children ranked by their contribution to this number — a sort, not a score.',
        isKnown(of) && of > rows.length
          ? ` Showing ${formatInt(rows.length)} of ${formatInt(of)} children; shares are of the listed rows only.`
          : ''),
      list);
  }

  function tokenSplitTable() {
    const cats = tokenCategories(tokens());
    const rows = [
      ['input', cats.input, null],
      ['output', cats.output, null],
      ['cache write · 5m', cats.cache5m, '×1.25 input rate · R5'],
      ['cache write · 1h', cats.cache1h, '×2 input rate · R5'],
      ['cache write · flat', cats.cacheFlat, 'foreign-transcript channel; billed at the 5m rate · R5'],
      ['cache read', cats.cacheRead, '×0.1 input rate'],
    ];
    const a = agg();
    const thinking = a && a.thinking;
    return h('div', { class: 'lens-statbar__panel-body' },
      h('table', { class: 'lens-table lens-table--tight' },
        h('thead', null, h('tr', null, h('th', null, 'category'), h('th', { class: 'lens-num-col' }, 'tokens'), h('th', null, 'note'))),
        h('tbody', null, ...rows.map(([label, v, note]) => h('tr', null,
          h('td', null, label),
          h('td', { class: 'lens-num-col' }, isKnown(v) ? formatTokens(v) : unknownNode('not recorded')),
          h('td', { class: 'lens-statbar__note' }, note || ''))))),
      thinking ? h('p', { class: 'lens-statbar__panel-note' },
        `${isKnown(thinking.tokens) ? formatTokens(thinking.tokens) : UNKNOWN} thinking tokens recorded on `
        + `${formatInt(thinking.recordedOn)} of ${formatInt((thinking.recordedOn || 0) + (thinking.notRecordedOn || 0))} rows · `
        // A null thinkingTokens is either an old harness OR a non-final
        // R3 split row (null by rule, not by age) — the wording must not
        // over-claim the harness explanation.
        + `${formatInt(thinking.notRecordedOn)} rows do not record it (pre-2.1.229 harness or non-final R3 split row)`) : null);
  }

  function groupToggle() {
    const mk = (key, label) => {
      const b = h('button', {
        class: `lens-statbar__group-btn${state.groupBy === key ? ' is-active' : ''}`,
        type: 'button', 'aria-pressed': state.groupBy === key ? 'true' : 'false',
      }, label);
      b.addEventListener('click', () => { state.groupBy = key; drawPanel('tokens'); });
      return b;
    };
    return h('div', { class: 'lens-statbar__group', role: 'group', 'aria-label': 'Group tokens by' },
      h('span', { class: 'lens-statbar__group-label' }, 'group by'), mk('child', 'child'), mk('model', 'model'));
  }

  function spanPanel() {
    const p = state.props;
    const span = p.span || {};
    const sumChildren = p.contributions && p.contributions.spanSumChildren;
    const rows = [
      ['span', span.ms, 'max − min over this scope\'s bars (SPEC §4 bounds ledger)'],
      ['active', p.active && p.active.ms, 'the union of this scope\'s recorded intervals'],
      ['Σ children', sumChildren, 'the children\'s wall times added up — larger than span means work overlapped'],
    ];
    const parallel = isKnown(span.ms) && isKnown(sumChildren) && span.ms > 0
      ? (sumChildren / span.ms) : null;
    return h('div', { class: 'lens-statbar__panel-body' },
      h('table', { class: 'lens-table lens-table--tight' },
        h('thead', null, h('tr', null, h('th', null, 'figure'), h('th', { class: 'lens-num-col' }, 'value'), h('th', null, 'definition'))),
        h('tbody', null, ...rows.map(([label, v, note]) => h('tr', null,
          h('td', null, label),
          h('td', { class: 'lens-num-col' }, isKnown(v) ? formatDuration(v) : unknownNode('not recorded for this scope')),
          h('td', { class: 'lens-statbar__note' }, note))))),
      span.from || span.to ? h('p', { class: 'lens-statbar__panel-note' },
        'from ', isKnown(span.from) ? formatLocalTime(span.from) : UNKNOWN,
        ' to ', isKnown(span.to) ? formatLocalTime(span.to) : UNKNOWN) : null,
      parallel !== null ? h('p', { class: 'lens-statbar__panel-note' },
        `Σ children is ${parallel.toFixed(2)}× span — recorded overlap, stated as arithmetic, not as a conclusion.`) : null);
  }

  /* ---------------- lifecycle ---------------- */

  function drawAll() { drawCells(); syncCellState(); drawFootnote(); drawChips(); }
  drawAll();

  return {
    update(next) {
      state.props = Object.assign({}, state.props, next);
      drawAll();
      if (state.openCell) drawPanel(state.openCell);
    },
    openCell(key) { toggleCell(key); },
    closePanel,
    destroy() { chips.destroy(); if (root.parentNode) root.parentNode.removeChild(root); },
  };
}
