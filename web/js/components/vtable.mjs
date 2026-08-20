// web/js/components/vtable.mjs — DESIGN §4, "tables, one behaviour".
//
//   * click-sort, shift-click adds a secondary key
//   * substring filter on TEXT columns only
//   * optional group-by on a recorded field, with sticky subtotal subheaders
//     in the SAME CELL ORDER as the stat header
//   * numeric columns right-aligned monospace with column-sum footers
//   * `→` is always the last column
//   * 300-row paging with `showing N of M`; NO infinite scroll
//   * Σ all vs Σ filtered toggle, wired to the scope sentence
//
// The sort/filter/group/sum primitives below are PURE and separately tested.

import {
  h, clear, formatInt, formatUsd, formatTokens, formatBytes, formatDuration,
  formatLocalTime, isKnown, UNKNOWN, unknownNode,
} from '../format.mjs';

export const PAGE_SIZE = 300;

/** Column types the table knows how to align, sum and format. */
export const NUMERIC_TYPES = ['num', 'money', 'tokens', 'bytes', 'duration'];
export const TEXT_TYPES = ['text', 'code', 'link'];

/* ------------------------------------------------------------------ *
 * pure primitives
 * ------------------------------------------------------------------ */

export function isNumeric(col) { return NUMERIC_TYPES.includes(col.type); }
export function isFilterable(col) {
  return col.filterable !== undefined ? !!col.filterable : TEXT_TYPES.includes(col.type || 'text');
}

export function cellValue(row, col) {
  if (typeof col.value === 'function') return col.value(row);
  return row[col.key];
}

/** Substring filter over the filterable (text) columns only. Case-insensitive. */
export function filterRows(rows, columns, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows;
  const cols = columns.filter(isFilterable);
  return rows.filter((row) => cols.some((col) => {
    const v = cellValue(row, col);
    return v !== null && v !== undefined && String(v).toLowerCase().includes(needle);
  }));
}

function compareValues(a, b, numeric) {
  if (numeric) return a === b ? 0 : (a < b ? -1 : 1);
  const as = String(a), bs = String(b);
  return as === bs ? 0 : (as < bs ? -1 : 1);
}

/** sort = [{key, dir:'asc'|'desc'}] — primary first, then secondaries. */
export function sortRows(rows, columns, sort) {
  if (!sort || !sort.length) return rows;
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const keys = sort.filter((s) => byKey.has(s.key));
  if (!keys.length) return rows;
  const decorated = rows.map((row, i) => ({ row, i }));
  decorated.sort((x, y) => {
    for (const s of keys) {
      const col = byKey.get(s.key);
      const a = cellValue(x.row, col), b = cellValue(y.row, col);
      const aKnown = isKnown(a), bKnown = isKnown(b);
      // An unrecorded value sorts LAST in both directions — it is not a small
      // number and not a large one, so the direction must not move it.
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (!aKnown) continue;                       // both unknown: tie on this key
      const cmp = compareValues(a, b, isNumeric(col));
      if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
    }
    return x.i - y.i;               // stable: file order breaks every tie
  });
  return decorated.map((d) => d.row);
}

/** Click behaviour: plain click sets/flips the primary; shift adds a secondary. */
export function nextSort(sort, key, shift) {
  const cur = sort || [];
  const at = cur.findIndex((s) => s.key === key);
  if (!shift) {
    if (at === 0) return [{ key, dir: cur[0].dir === 'asc' ? 'desc' : 'asc' }];
    return [{ key, dir: 'asc' }];
  }
  if (at === -1) return [...cur, { key, dir: 'asc' }];
  const copy = cur.slice();
  copy[at] = { key, dir: copy[at].dir === 'asc' ? 'desc' : 'asc' };
  return copy;
}

/** Group rows by a recorded field, preserving the sorted order within groups. */
export function groupRows(rows, key) {
  if (!key) return [{ key: null, label: null, rows }];
  const order = [];
  const map = new Map();
  for (const row of rows) {
    const raw = row[key];
    const k = raw === null || raw === undefined ? '\u0000unknown' : String(raw);
    if (!map.has(k)) { map.set(k, []); order.push(k); }
    map.get(k).push(row);
  }
  return order.map((k) => ({
    key: k,
    label: k === '\u0000unknown' ? UNKNOWN : k,
    unknown: k === '\u0000unknown',
    rows: map.get(k),
  }));
}

/** Column sums for every column with sum:true. Unknown poisons a sum to null. */
export function sumColumns(rows, columns) {
  const out = {};
  for (const col of columns) {
    if (!col.sum) continue;
    let total = 0, ok = true;
    for (const row of rows) {
      const v = cellValue(row, col);
      if (!isKnown(v)) { ok = false; break; }
      total += v;
    }
    out[col.key] = ok ? total : null;
  }
  return out;
}

export function pageSlice(rows, { index = 0, size = PAGE_SIZE } = {}) {
  const from = Math.max(0, index * size);
  return { from, rows: rows.slice(from, from + size), size, index, total: rows.length };
}

/* ------------------------------------------------------------------ *
 * rendering
 * ------------------------------------------------------------------ */

const FORMATTERS = {
  num: formatInt,
  money: formatUsd,
  tokens: formatTokens,
  bytes: formatBytes,
  duration: formatDuration,
  time: formatLocalTime,
};

function renderCell(row, col) {
  const v = cellValue(row, col);
  if (typeof col.render === 'function') return col.render(v, row);
  if (!isKnown(v)) return unknownNode(typeof col.reason === 'function' ? col.reason(row) : (col.reason || 'not recorded'));
  const text = (col.format || FORMATTERS[col.type] || String)(v);
  const hrefStr = typeof col.href === 'function' ? col.href(row) : null;
  if (hrefStr) return h('a', { href: hrefStr, class: 'lens-table__link', 'data-lens-drill': '' }, text);
  if (col.type === 'code') return h('code', { class: 'lens-code' }, text);
  return document.createTextNode(text);
}

/**
 * vtable(el, props) -> { update, destroy, getState, setState }
 *
 * props = {
 *   columns: [{ key, label, type, sum?, href?(row), render?(v,row), format?,
 *               filterable?, sortable?, title?, reason? }],
 *   rows,
 *   sort:  [{key, dir}],
 *   group: { key, label } | 'columnKey' | null,
 *   page:  { index, size },
 *   filter: '<initial filter text>',     // the substring the filter box starts with (NOT a mode flag)
 *   footerSums: true,
 *   footerFilter?(row),                  // rows the Σ footer counts (e.g. exclude memory-only dirs)
 *   footerNote,                          // printed beside the Σ label when footerFilter excludes rows
 *   sigma: 'all' | 'filtered',        // which set the FOOTER totals
 *   onSigma(next), onSort(sort), onFilter(q), onGroup(key), onPage(index),
 *   onNav(row),                       // the `→` last column
 *   navHref(row),                     // preferred: a real <a href>
 *   emptyLabel,
 *   caption,
 * }
 */
export function vtable(el, props) {
  const state = {
    props: props || {},
    sort: (props && props.sort) || [],
    filter: (props && props.filter) || '',
    group: normaliseGroup(props && props.group),
    page: Object.assign({ index: 0, size: PAGE_SIZE }, (props && props.page) || {}),
    sigma: (props && props.sigma) || 'all',
  };

  const root = h('div', { class: 'lens-vtable' });
  const toolbar = h('div', { class: 'lens-vtable__toolbar' });
  const scroller = h('div', { class: 'lens-vtable__scroll' });
  const footer = h('div', { class: 'lens-vtable__foot' });
  root.appendChild(toolbar);
  root.appendChild(scroller);
  root.appendChild(footer);
  el.appendChild(root);

  function columns() { return state.props.columns || []; }
  function allRows() { return state.props.rows || []; }

  function view() {
    const cols = columns();
    const filtered = filterRows(allRows(), cols, state.filter);
    const sorted = sortRows(filtered, cols, state.sort);
    const groups = groupRows(sorted, state.group);
    // Paging applies in BOTH shapes. Grouped rows page across the
    // flattened group order (subheaders repeat as needed) — never every row.
    const paged = state.group
      ? pageSlice(groups.flatMap((g) => g.rows.map((row) => ({ g, row }))), state.page)
      : pageSlice(sorted, state.page);
    return { filtered, sorted, groups, paged };
  }

  function drawToolbar(v) {
    clear(toolbar);
    const cols = columns();
    const textCols = cols.filter(isFilterable);
    if (textCols.length) {
      const input = h('input', {
        class: 'lens-vtable__filter', type: 'search', value: state.filter,
        placeholder: `filter ${textCols.map((c) => c.label).join(' / ')}`,
        'aria-label': 'Substring filter on the text columns',
      });
      input.addEventListener('input', () => {
        state.filter = input.value;
        state.page.index = 0;
        if (state.props.onFilter) state.props.onFilter(state.filter);
        draw();
        if (input.focus) input.focus();
      });
      toolbar.appendChild(input);
    }

    const groupable = cols.filter((c) => c.groupable);
    if (groupable.length) {
      const sel = h('select', { class: 'lens-vtable__group', 'aria-label': 'Group rows by' },
        h('option', { value: '' }, 'no grouping'),
        ...groupable.map((c) => h('option', { value: c.key, selected: state.group === c.key || null }, `group by ${c.label}`)));
      sel.addEventListener('change', () => {
        state.group = sel.value || null;
        state.page.index = 0;
        if (state.props.onGroup) state.props.onGroup(state.group);
        draw();
      });
      toolbar.appendChild(sel);
    }

    if (state.filter) {
      const mk = (key, label) => {
        const b = h('button', {
          class: `lens-vtable__sigma${state.sigma === key ? ' is-active' : ''}`, type: 'button',
          'aria-pressed': state.sigma === key ? 'true' : 'false',
        }, label);
        b.addEventListener('click', () => {
          state.sigma = key;
          if (state.props.onSigma) state.props.onSigma(key);
          draw();
        });
        return b;
      };
      toolbar.appendChild(h('span', { class: 'lens-vtable__sigma-group', role: 'group', 'aria-label': 'What the footer totals' },
        mk('all', 'Σ all'), mk('filtered', 'Σ filtered')));
    }

    toolbar.appendChild(h('span', { class: 'lens-vtable__showing' },
      `showing ${formatInt(Math.min(v.paged.rows.length, v.sorted.length))} of ${formatInt(v.sorted.length)}`,
      state.filter ? ` (filtered from ${formatInt(allRows().length)})` : ''));
  }

  function headerRow() {
    const tr = h('tr');
    for (const col of columns()) {
      const at = state.sort.findIndex((s) => s.key === col.key);
      const dir = at === -1 ? null : state.sort[at].dir;
      const sortable = col.sortable !== false;
      const th = h('th', {
        class: [
          'lens-vtable__th',
          isNumeric(col) ? 'lens-num-col' : null,
          sortable ? 'lens-vtable__th--sortable' : null,
          dir ? `is-sorted is-sorted-${dir}` : null,
        ],
        scope: 'col',
        title: col.title || (sortable ? 'click to sort · shift-click to add a secondary key' : null),
        'aria-sort': dir ? (dir === 'asc' ? 'ascending' : 'descending') : null,
      }, col.label,
        dir ? h('span', { class: 'lens-vtable__sortmark' }, dir === 'asc' ? '▲' : '▼') : null,
        at > 0 ? h('span', { class: 'lens-vtable__sortrank' }, String(at + 1)) : null);
      if (sortable) {
        th.addEventListener('click', (ev) => {
          state.sort = nextSort(state.sort, col.key, !!ev.shiftKey);
          state.page.index = 0;
          if (state.props.onSort) state.props.onSort(state.sort);
          draw();
        });
      }
      tr.appendChild(th);
    }
    if (hasNav()) tr.appendChild(h('th', { class: 'lens-vtable__th lens-vtable__th--nav', scope: 'col' }, ''));
    return tr;
  }

  function hasNav() {
    return typeof state.props.navHref === 'function' || typeof state.props.onNav === 'function';
  }

  function bodyRow(row) {
    const tr = h('tr', { class: 'lens-vtable__tr', 'data-lens-row': '' });
    for (const col of columns()) {
      tr.appendChild(h('td', {
        class: ['lens-vtable__td', isNumeric(col) ? 'lens-num-col' : null, col.cellClass || null],
      }, renderCell(row, col)));
    }
    if (hasNav()) {
      const hrefStr = state.props.navHref ? state.props.navHref(row) : null;
      tr.appendChild(h('td', { class: 'lens-vtable__td lens-vtable__td--nav' },
        hrefStr
          ? h('a', { class: 'lens-vtable__nav', href: hrefStr, 'data-lens-drill': '', title: 'open' }, '→')
          : h('button', { class: 'lens-vtable__nav', type: 'button', onclick: () => state.props.onNav(row) }, '→')));
    }
    return tr;
  }

  function subtotalRow(group, shownOnPage) {
    const sums = sumColumns(group.rows, columns());
    const tr = h('tr', { class: 'lens-vtable__subtotal' });
    let first = true;
    for (const col of columns()) {
      if (first) {
        first = false;
        tr.appendChild(h('th', { class: 'lens-vtable__subtotal-label', scope: 'row' },
          group.unknown
            ? unknownNode('this recorded field is absent on these rows')
            : group.label,
          h('span', { class: 'lens-vtable__subtotal-count' }, ` · ${formatInt(group.rows.length)} rows`,
            isKnown(shownOnPage) && shownOnPage < group.rows.length
              ? ` (${formatInt(shownOnPage)} on this page; the subtotal covers the whole group)` : '')));
        continue;
      }
      const v = sums[col.key];
      tr.appendChild(h('td', { class: ['lens-vtable__td', isNumeric(col) ? 'lens-num-col' : null] },
        col.sum ? (isKnown(v) ? (col.format || FORMATTERS[col.type] || String)(v) : unknownNode('a row in this group has no recorded value')) : ''));
    }
    if (hasNav()) tr.appendChild(h('td', { class: 'lens-vtable__td' }, ''));
    return tr;
  }

  function footRow(rowsForSum, excluded = 0) {
    const sums = sumColumns(rowsForSum, columns());
    const tr = h('tr', { class: 'lens-vtable__total' });
    let first = true;
    for (const col of columns()) {
      if (first) {
        first = false;
        tr.appendChild(h('th', { class: 'lens-vtable__total-label', scope: 'row' },
          state.sigma === 'filtered' ? 'Σ filtered' : 'Σ all',
          excluded > 0 && state.props.footerNote
            ? h('span', { class: 'lens-vtable__total-note' }, ` · ${state.props.footerNote}`) : null));
        continue;
      }
      const v = sums[col.key];
      tr.appendChild(h('td', { class: ['lens-vtable__td', isNumeric(col) ? 'lens-num-col' : null] },
        col.sum ? (isKnown(v) ? (col.format || FORMATTERS[col.type] || String)(v) : unknownNode('a row has no recorded value, so this column has no exact sum')) : ''));
    }
    if (hasNav()) tr.appendChild(h('td', { class: 'lens-vtable__td' }, ''));
    return tr;
  }

  function draw() {
    const v = view();
    drawToolbar(v);
    clear(scroller);

    const table = h('table', { class: 'lens-table lens-vtable__table' });
    if (state.props.caption) table.appendChild(h('caption', { class: 'lens-vtable__caption' }, state.props.caption));
    table.appendChild(h('thead', { class: 'lens-vtable__head' }, headerRow()));

    const tbody = h('tbody');
    if (!v.sorted.length) {
      const span = columns().length + (hasNav() ? 1 : 0);
      tbody.appendChild(h('tr', null, h('td', { class: 'lens-vtable__empty', colspan: String(span) },
        state.props.emptyLabel || (state.filter ? 'No rows match this filter.' : 'No rows.'))));
    } else if (state.group) {
      // Grouped rows page too (DESIGN §4: no infinite scroll). The page
      // slice walks the flattened group order; a group's subheader repeats on
      // every page it appears on, counting how much of it is visible here.
      const onPage = new Map();
      for (const e of v.paged.rows) onPage.set(e.g, (onPage.get(e.g) || 0) + 1);
      let lastG = null;
      for (const e of v.paged.rows) {
        if (e.g !== lastG) { tbody.appendChild(subtotalRow(e.g, onPage.get(e.g))); lastG = e.g; }
        tbody.appendChild(bodyRow(e.row));
      }
    } else {
      for (const row of v.paged.rows) tbody.appendChild(bodyRow(row));
    }
    table.appendChild(tbody);

    if (state.props.footerSums !== false && columns().some((c) => c.sum)) {
      let rowsForSum = state.sigma === 'filtered' ? v.sorted : allRows();
      let excluded = 0;
      if (typeof state.props.footerFilter === 'function') {
        const kept = rowsForSum.filter(state.props.footerFilter);
        excluded = rowsForSum.length - kept.length;
        rowsForSum = kept;
      }
      table.appendChild(h('tfoot', { class: 'lens-vtable__tfoot' }, footRow(rowsForSum, excluded)));
    }
    scroller.appendChild(table);

    clear(footer);
    if (v.sorted.length > state.page.size) footer.appendChild(pager(v));
  }

  function pager(v) {
    const pages = Math.ceil(v.sorted.length / state.page.size);
    const prev = h('button', { class: 'lens-btn', type: 'button', disabled: state.page.index <= 0 || null }, '← previous');
    const next = h('button', { class: 'lens-btn', type: 'button', disabled: state.page.index >= pages - 1 || null }, 'next →');
    prev.addEventListener('click', () => { state.page.index--; emitPage(); });
    next.addEventListener('click', () => { state.page.index++; emitPage(); });
    return h('div', { class: 'lens-pager' }, prev,
      h('span', { class: 'lens-pager__label' },
        `rows ${formatInt(v.paged.from + 1)}–${formatInt(v.paged.from + v.paged.rows.length)} `
        + `of ${formatInt(v.sorted.length)} · page ${formatInt(state.page.index + 1)} of ${formatInt(pages)}`),
      next);
  }

  function emitPage() {
    if (state.props.onPage) state.props.onPage(state.page.index);
    draw();
    if (scroller.scrollTo) scroller.scrollTo({ top: 0 });
  }

  draw();

  return {
    update(next) {
      state.props = Object.assign({}, state.props, next);
      if (next && next.sort) state.sort = next.sort;
      if (next && next.filter !== undefined) state.filter = next.filter;
      if (next && next.group !== undefined) state.group = normaliseGroup(next.group);
      if (next && next.page) state.page = Object.assign(state.page, next.page);
      if (next && next.sigma) state.sigma = next.sigma;
      draw();
    },
    getState() {
      return { sort: state.sort.slice(), filter: state.filter, group: state.group, page: Object.assign({}, state.page), sigma: state.sigma };
    },
    setState(s) { Object.assign(state, s); draw(); },
    element: root,
    destroy() { if (root.parentNode) root.parentNode.removeChild(root); },
  };
}

function normaliseGroup(g) {
  if (!g) return null;
  return typeof g === 'string' ? g : g.key || null;
}
