// web/js/components/rows.mjs — the timetable: one row per recorded block, in
// FILE ORDER, 300-row paging, expand-in-place. Used at L3 (the right pane) and
// L4 (the whole view).
//
// File order is the only order (SPEC §3: file order is a topological order of
// the uuid DAG; timestamps are not monotonic and are never re-sorted here).
//
//   rowsPane(el, { fetchPage, kinds, onExpand })  -> { update, destroy, reload }
//
// Row shape (server, SPEC §9 payload discipline — heads only, never bodies):
//   { line /*1-based*/, bi, kind, at, head /*≤220ch*/, extra, href }

import {
  h, clear, replace, formatInt, formatLocalTime, isKnown, unknownNode, truncate,
} from '../format.mjs';

export const PAGE_SIZE = 300;

/** The closed row-kind vocabulary (SPEC §3). `?k` matches on the prefix before ':'. */
export const KIND_VOCAB = [
  'prompt', 'text', 'thinking', 'tool_use', 'tool_result', 'image', 'fallback',
  'attachment', 'system', 'queue-operation', 'unknown',
];

/** 'attachment:edited_text_file' -> 'attachment' (SPEC §3 prefix matching). */
export function kindPrefix(kind) {
  const s = String(kind || '');
  const c = s.indexOf(':');
  return c === -1 ? s : s.slice(0, c);
}

/** `?k=attachment,system` selects all their subtypes. Unknown values ignored. */
export function matchKinds(kind, k) {
  if (!k) return true;
  const wanted = (Array.isArray(k) ? k : String(k).split(',')).map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return true;
  const full = String(kind || '');
  const pre = kindPrefix(full);
  return wanted.some((w) => w === full || w === pre);
}

/** Census of the kinds actually present, in vocabulary order then extras. */
export function kindCensus(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    const k = String(r.kind || 'unknown');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const ordered = [];
  for (const base of KIND_VOCAB) {
    for (const k of [...counts.keys()].sort()) {
      if (k === base || kindPrefix(k) === base) { ordered.push({ kind: k, count: counts.get(k) }); counts.delete(k); }
    }
  }
  for (const k of [...counts.keys()].sort()) ordered.push({ kind: k, count: counts.get(k) });
  return ordered;
}

/**
 * rowsPane(el, props) -> { update, destroy, reload }
 *
 * props = {
 *   fetchPage(from, count) -> { from, count, total, rows } | Promise<…>
 *   kinds,                    // active `?k` value (string or array) — filter chips
 *   onExpand(row) -> Node | Promise<Node>,   // lazy /api/line, expand IN PLACE
 *   onKinds(next),            // the view writes `?k` back to the URL
 *   pageSize, from,
 *   locatorHref(row),         // `{}` -> L5
 *   caption, emptyLabel,
 * }
 */
export function rowsPane(el, props) {
  const state = {
    props: props || {},
    from: (props && props.from) || 0,
    total: null,
    rows: [],
    loading: false,
    error: null,
    expanded: new Set(),
    headFilter: '',          // in-pane `/` filter over loaded rows' heads (DESIGN §3 Search)
  };

  const root = h('div', { class: 'lens-rows' });
  const chipsEl = h('div', { class: 'lens-rows__kinds' });
  const findEl = h('div', { class: 'lens-rows__find', hidden: true });
  const tableEl = h('div', { class: 'lens-rows__table' });
  const pagerEl = h('div', { class: 'lens-rows__pager' });
  root.appendChild(chipsEl);
  root.appendChild(findEl);
  root.appendChild(tableEl);
  root.appendChild(pagerEl);
  el.appendChild(root);

  // ---- in-pane find (DESIGN §3 Search): filters the LOADED rows' recorded
  // heads only, says so, and offers the full byte scan as its primary escape.
  const findInput = h('input', {
    class: 'lens-input lens-rows__find-q', type: 'search',
    'aria-label': 'filter the loaded rows',
    placeholder: 'filter loaded rows…',
  });
  findInput.addEventListener('input', () => { state.headFilter = findInput.value; drawTable(); drawPager(); });
  findInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeFilter(); ev.stopPropagation(); }
  });
  function drawFindBar() {
    clear(findEl);
    findEl.appendChild(findInput);
    findEl.appendChild(h('span', { class: 'lens-rows__find-note' },
      'searches the ≤220-char recorded heads of the loaded rows only'));
    const scopeStr = state.props.findScope || null;
    findEl.appendChild(h('a', {
      class: 'lens-btn lens-btn--primary lens-rows__find-all',
      href: `#/find${scopeStr ? `?scope=${encodeURIComponent(scopeStr)}` : ''}`,
    }, 'search all bytes in this scope'));
    const closeBtn = h('button', { class: 'lens-btn lens-btn--ghost', type: 'button' }, 'close');
    closeBtn.addEventListener('click', closeFilter);
    findEl.appendChild(closeBtn);
  }
  function openFilter() {
    drawFindBar();
    findEl.removeAttribute('hidden');
    if (findInput.focus) findInput.focus();
    return true;
  }
  function closeFilter() {
    state.headFilter = '';
    findInput.value = '';
    findEl.setAttribute('hidden', '');
    drawTable();
    drawPager();
  }

  function pageSize() { return state.props.pageSize || PAGE_SIZE; }

  async function load(from) {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    state.from = from;
    try {
      const res = await state.props.fetchPage(from, pageSize());
      state.rows = (res && res.rows) || [];
      state.total = res && isKnown(res.total) ? res.total : null;
      state.from = res && isKnown(res.from) ? res.from : from;
    } catch (err) {
      state.error = err;
      state.rows = [];
    } finally {
      state.loading = false;
      draw();
    }
  }

  function visibleRows() {
    const needle = state.headFilter.trim().toLowerCase();
    return state.rows.filter((r) => matchKinds(r.kind, state.props.kinds)
      && (!needle || String(r.head || '').toLowerCase().includes(needle)));
  }

  function drawKinds() {
    clear(chipsEl);
    const census = kindCensus(state.rows);
    if (!census.length) return;
    const active = state.props.kinds
      ? (Array.isArray(state.props.kinds) ? state.props.kinds : String(state.props.kinds).split(','))
      : [];
    chipsEl.appendChild(h('span', { class: 'lens-rows__kinds-label' }, 'kinds on this page'));
    for (const c of census) {
      const isOn = !active.length || active.includes(c.kind) || active.includes(kindPrefix(c.kind));
      const btn = h('button', {
        class: `lens-kind lens-kind--${kindPrefix(c.kind)}${isOn ? ' is-active' : ''}`,
        type: 'button', 'aria-pressed': isOn ? 'true' : 'false',
        title: `${c.kind} — ${formatInt(c.count)} rows on this page`,
      }, c.kind, h('span', { class: 'lens-kind__count' }, formatInt(c.count)));
      btn.addEventListener('click', () => {
        const next = new Set(active);
        if (next.has(c.kind)) next.delete(c.kind); else next.add(c.kind);
        const value = [...next].join(',');
        if (state.props.onKinds) state.props.onKinds(value);
        else { state.props.kinds = value; draw(); }
      });
      chipsEl.appendChild(btn);
    }
    if (active.length) {
      const clearBtn = h('button', { class: 'lens-btn lens-btn--ghost', type: 'button' }, 'clear kind filter');
      clearBtn.addEventListener('click', () => {
        if (state.props.onKinds) state.props.onKinds('');
        else { state.props.kinds = ''; draw(); }
      });
      chipsEl.appendChild(clearBtn);
    }
  }

  function drawTable() {
    clear(tableEl);
    if (state.error) {
      tableEl.appendChild(h('p', { class: 'lens-rows__error' },
        `These rows could not be fetched: ${state.error.message}`));
      return;
    }
    const rows = visibleRows();
    const table = h('table', { class: 'lens-table lens-rows__grid' },
      state.props.caption ? h('caption', null, state.props.caption) : null,
      h('thead', null, h('tr', null,
        h('th', { class: 'lens-num-col' }, 'line'),
        h('th', null, 'bi'),
        h('th', null, 'kind'),
        h('th', null, 'time'),
        h('th', null, 'head'),
        h('th', null, ''))));
    const tbody = h('tbody');
    if (!rows.length) {
      tbody.appendChild(h('tr', null, h('td', { colspan: '6', class: 'lens-rows__empty' },
        state.loading ? 'fetching…' : (state.props.emptyLabel || 'No rows in this window.'))));
    }
    for (const row of rows) tbody.appendChild(rowNode(row));
    table.appendChild(tbody);
    tableEl.appendChild(table);
  }

  function rowNode(row) {
    const id = `${row.line}${row.bi ? '.' + row.bi : ''}`;
    const isOpen = state.expanded.has(id);
    const expandBtn = h('button', {
      class: 'lens-rows__expand', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false',
      title: 'expand this row in place',
    }, isOpen ? '▾' : '▸');
    const tr = h('tr', { class: `lens-rows__tr${isOpen ? ' is-open' : ''}`, 'data-lens-row': '' },
      h('td', { class: 'lens-num-col lens-rows__line' }, isKnown(row.line) ? formatInt(row.line) : unknownNode('no line recorded')),
      // "no block index" is a RECORDED fact (whole event, SPEC §8), not
      // an unknown — it must never wear the reserved '—' glyph.
      h('td', { class: 'lens-rows__bi' }, row.bi
        ? h('code', null, row.bi)
        : h('span', { class: 'lens-dim', title: 'whole event — no block index (SPEC §8)' }, '·')),
      h('td', { class: 'lens-rows__kind' },
        h('span', { class: `lens-kind lens-kind--${kindPrefix(row.kind)}` }, row.kind || 'unknown')),
      h('td', { class: 'lens-rows__at' },
        isKnown(row.at) ? formatLocalTime(row.at) : unknownNode('this event type carries no timestamp (SPEC §3)')),
      h('td', { class: 'lens-rows__head' }, truncate(row.head || '', 220)),
      h('td', { class: 'lens-rows__nav' }, expandBtn, locatorLink(row)));

    expandBtn.addEventListener('click', () => toggleExpand(row, id, tr));
    return tr;
  }

  function locatorLink(row) {
    const hrefStr = state.props.locatorHref ? state.props.locatorHref(row) : row.href;
    if (!hrefStr) return null;
    return h('a', {
      class: 'lens-rows__locator', href: hrefStr, 'data-lens-drill': '',
      title: `open ${row.line}${row.bi ? '.' + row.bi : ''} — the raw event`,
    }, '{}');
  }

  async function toggleExpand(row, id, tr) {
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
      const next = tr.nextSibling;
      if (next && next.getAttribute && next.getAttribute('data-lens-detail') === id) next.parentNode.removeChild(next);
      tr.setAttribute('class', 'lens-rows__tr');
      return;
    }
    state.expanded.add(id);
    tr.setAttribute('class', 'lens-rows__tr is-open');
    // Only promise a fetch when an expander exists — a permanent
    // "fetching…" is an indeterminate state DESIGN §7 forbids.
    const body = h('div', { class: 'lens-rows__detail-body' },
      state.props.onExpand ? 'fetching this line…'
        : h('span', { class: 'lens-dim' }, 'this pane does not expand rows — use the {} link to open the raw event'));
    const detail = h('tr', { class: 'lens-rows__detail', 'data-lens-detail': id },
      h('td', { colspan: '6' }, body));
    if (tr.parentNode) tr.parentNode.insertBefore(detail, tr.nextSibling);
    if (!state.props.onExpand) return;
    try {
      const content = await state.props.onExpand(row);
      replace(body, content || h('p', { class: 'lens-dim' }, 'nothing further is recorded on this row'));
    } catch (err) {
      replace(body, h('p', { class: 'lens-rows__error' }, `could not read the line: ${err.message}`));
    }
  }

  function drawPager() {
    clear(pagerEl);
    const size = pageSize();
    const shown = visibleRows().length;
    // Three denominators, each NAMED — filtered rows on this page, rows
    // on this page, rows in the whole scope. One bare "N of M" mixed them.
    const filtered = !!state.props.kinds || !!state.headFilter.trim();
    const parts = [`showing ${formatInt(shown)} of ${formatInt(state.rows.length)} rows on this page`];
    if (isKnown(state.total)) parts.push(`${formatInt(state.total)} rows in scope`);
    if (filtered) parts.push('the filter applies to the fetched page only');
    pagerEl.appendChild(h('span', { class: 'lens-pager__label' }, parts.join(' · ')));
    if (!isKnown(state.total) || state.total <= size) return;
    const prev = h('button', { class: 'lens-btn', type: 'button', disabled: state.from <= 0 || null }, '← previous 300');
    const next = h('button', { class: 'lens-btn', type: 'button', disabled: state.from + size >= state.total || null }, 'next 300 →');
    prev.addEventListener('click', () => load(Math.max(0, state.from - size)));
    next.addEventListener('click', () => load(state.from + size));
    pagerEl.appendChild(h('div', { class: 'lens-pager' }, prev,
      h('span', { class: 'lens-pager__label' },
        `rows ${formatInt(state.from + 1)}–${formatInt(state.from + state.rows.length)} of ${formatInt(state.total)}`),
      next));
  }

  function draw() { drawKinds(); drawTable(); drawPager(); }

  draw();
  if (state.props.fetchPage) load(state.from);

  return {
    update(next) {
      const wasFetch = state.props.fetchPage;
      state.props = Object.assign({}, state.props, next);
      if (next && next.fetchPage && next.fetchPage !== wasFetch) load(next.from || 0);
      else draw();
    },
    reload() { load(state.from); },
    /** `/` (DESIGN §5) — opens the in-pane head filter. Returns true when opened. */
    openFilter,
    element: root,
    destroy() { if (root.parentNode) root.parentNode.removeChild(root); },
  };
}
