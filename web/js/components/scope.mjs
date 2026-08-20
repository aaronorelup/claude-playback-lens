// web/js/components/scope.mjs — bands 1 and 2 of DESIGN §1, plus the app shell.
//
//   chrome(root)                      -> the three fixed bands + banner/content slots
//   crumbs(el, props)                 -> band 1: the crumb rail
//   scopeSentence(el, props)          -> band 2: the generated scope sentence
//   buildScopeSentence(props)         -> the sentence as a string (pure, tested)
//   scopeString(level, parts)         -> SPEC §9 scope grammar (pure, tested)
//   parseScopeString(s)               -> the inverse (pure, tested)
//
// The scope sentence is "the contract between the header and the rows": it
// states what the numbers above cover and by what rule the set was formed. It
// is generated from recorded counts — it never characterises or summarises.

import { h, clear, formatInt, formatOf } from '../format.mjs';

/* ------------------------------------------------------------------ *
 * app shell
 * ------------------------------------------------------------------ */

/**
 * Build the three fixed bands into `root` and return their elements.
 * Called once by router.buildShell().
 */
export function chrome(root) {
  clear(root);
  root.setAttribute('class', 'lens-app');

  const reloadEl = h('div', { class: 'lens-reload', role: 'status', hidden: true });
  const crumbEl = h('nav', { class: 'lens-crumbs', 'aria-label': 'Breadcrumb' });
  const scopeEl = h('div', { class: 'lens-scope' });
  const statEl = h('div', { class: 'lens-statband' });
  const bannerEl = h('div', { class: 'lens-banners' });
  const contentEl = h('main', { class: 'lens-content', id: 'lens-content', tabindex: '-1' });
  const sheetEl = h('div', { class: 'lens-sheet', hidden: true, 'data-lens-layer': 'sheet' });
  const footEl = h('footer', { class: 'lens-foot' });

  root.appendChild(reloadEl);
  root.appendChild(h('header', { class: 'lens-head' }, crumbEl, scopeEl, statEl));
  root.appendChild(bannerEl);
  root.appendChild(contentEl);
  root.appendChild(footEl);
  root.appendChild(sheetEl);

  return { root, reloadEl, crumbEl, scopeEl, statEl, bannerEl, contentEl, sheetEl, footEl };
}

/* ------------------------------------------------------------------ *
 * band 1 — the crumb rail
 * ------------------------------------------------------------------ */

/**
 * crumbs(el, { items, up })
 *   items: [{ label, id?, href? }]  full chain to root; the LAST item is never
 *          a link (you are standing on it). `id` renders dim beside the name.
 *   up:    { href, label }          the `↑` control, labelled with where it goes.
 */
export function crumbs(el, props) {
  const state = { props: props || {} };

  function draw() {
    const { items = [], up } = state.props;
    clear(el);
    if (up && up.href) {
      el.appendChild(h('a', {
        class: 'lens-crumbs__up', href: up.href,
        title: `up to ${up.label || 'the parent'}`,
      }, '↑ ', h('span', { class: 'lens-crumbs__up-label' }, up.label || 'up')));
    }
    const list = h('ol', { class: 'lens-crumbs__list' });
    items.forEach((item, i) => {
      const last = i === items.length - 1;
      const body = [
        h('span', { class: 'lens-crumbs__name' }, item.label),
        item.id ? h('span', { class: 'lens-crumbs__id', title: item.idTitle || item.id }, item.id) : null,
      ];
      list.appendChild(h('li', { class: `lens-crumbs__item${last ? ' lens-crumbs__item--current' : ''}` },
        last || !item.href
          ? h('span', { class: 'lens-crumbs__here', 'aria-current': last ? 'page' : null }, body)
          : h('a', { class: 'lens-crumbs__link', href: item.href }, body)));
    });
    el.appendChild(list);
  }

  draw();
  return {
    update(next) { state.props = Object.assign({}, state.props, next); draw(); },
    destroy() { clear(el); },
  };
}

/* ------------------------------------------------------------------ *
 * band 2 — the scope sentence
 * ------------------------------------------------------------------ */

/**
 * The generated sentence. PURE — no DOM, fully testable.
 *
 * props = {
 *   subject,                 // 'the whole store' | 'project proj-h' | …
 *   counts: [{n, noun}],     // recorded counts this scope covers
 *   rule,                    // the rule by which the set was formed (a clause)
 *   filters: [{label,value}],// active filters incl. from/to, q, k
 *   totals: {all, filtered}, // row counts under/without the filter
 *   sigma: 'all'|'filtered', // which one the header is totalling
 *   extra: ['…']             // level-specific clauses appended verbatim
 * }
 */
export function buildScopeSentence(props = {}) {
  const { subject, counts = [], rule, filters = [], totals, sigma = 'all', extra = [] } = props;
  // Only invite "switch to Σ filtered" when a toggle will actually
  // render (the caller wired onSigma, or said so explicitly) — never promise
  // a control the page does not have.
  const sigmaAvailable = props.sigmaAvailable !== undefined ? !!props.sigmaAvailable : typeof props.onSigma === 'function';
  const out = [];

  const phrase = counts
    .filter((c) => c && c.noun)
    .map((c) => `${formatInt(c.n)} ${c.n === 1 ? c.noun : (c.plural || c.noun + 's')}`)
    .join(', ');

  if (phrase && subject) out.push(`Showing ${phrase} in ${subject}.`);
  else if (phrase) out.push(`Showing ${phrase}.`);
  else if (subject) out.push(`Showing ${subject}.`);

  if (rule) out.push(sentenceCase(endWithStop(rule)));

  if (filters.length) {
    const list = filters.map((f) => `${f.label} ${f.value}`).join(', ');
    if (totals && totals.all !== undefined && totals.filtered !== undefined) {
      out.push(`Filtered by ${list} — ${formatOf(totals.filtered, totals.all)} rows match.`);
    } else {
      out.push(`Filtered by ${list}.`);
    }
    out.push(sigma === 'filtered'
      ? 'The header totals the filtered rows.'
      : (sigmaAvailable
        ? 'The header totals all rows; switch to Σ filtered to total the matches instead.'
        : 'The header totals all rows.'));
  }

  for (const e of extra) if (e) out.push(sentenceCase(endWithStop(e)));
  return out.join(' ');
}

function endWithStop(s) {
  const t = String(s).trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : t + '.';
}

/** Capitalise a leading lowercase letter only — never touch an id or a symbol. */
function sentenceCase(s) {
  return /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * scopeSentence(el, props) — band 2. Adds the Σ all / Σ filtered toggle when
 * a filter is active (DESIGN §4), wired to props.onSigma.
 */
export function scopeSentence(el, props) {
  const state = { props: props || {} };

  function draw() {
    const p = state.props;
    clear(el);
    el.appendChild(h('p', { class: 'lens-scope__sentence' }, buildScopeSentence(p)));
    if (p.filters && p.filters.length && p.onSigma) {
      const cur = p.sigma || 'all';
      el.appendChild(h('div', { class: 'lens-scope__sigma', role: 'group', 'aria-label': 'What the header totals' },
        sigmaBtn('all', 'Σ all', cur, p.onSigma),
        sigmaBtn('filtered', 'Σ filtered', cur, p.onSigma)));
    }
    if (p.note) el.appendChild(h('p', { class: 'lens-scope__note' }, p.note));
  }

  function sigmaBtn(key, label, cur, onSigma) {
    return h('button', {
      class: `lens-scope__sigma-btn${cur === key ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': cur === key ? 'true' : 'false',
      onclick: () => onSigma(key),
    }, label);
  }

  draw();
  return {
    update(next) { state.props = Object.assign({}, state.props, next); draw(); },
    destroy() { clear(el); },
  };
}

/* ------------------------------------------------------------------ *
 * SPEC §9 scope grammar — shared by /api/records, /api/audit, /api/find
 * ------------------------------------------------------------------ */

const E = (s) => encodeURIComponent(String(s));

/**
 * scopeString('session', {slug, id}) -> 'session:<slug>/<id>'
 * Components are percent-encoded, exactly as SPEC §9 requires.
 */
export function scopeString(level, parts = {}) {
  switch (level) {
    case 'store': return 'store';
    case 'project': return `project:${E(parts.slug)}`;
    case 'session': return `session:${E(parts.slug)}/${E(parts.id)}`;
    case 'turn': return `turn:${E(parts.slug)}/${E(parts.id)}/${E(parts.idx)}`;
    case 'agent': return `agent:${E(parts.slug)}/${E(parts.id)}/${E(parts.agentId)}`;
    default: throw new TypeError(`unknown scope level: ${level}`);
  }
}

/** The inverse. Returns null for anything that is not valid scope grammar. */
export function parseScopeString(s) {
  const str = String(s || '');
  if (str === 'store') return { level: 'store', parts: {} };
  const colon = str.indexOf(':');
  if (colon === -1) return null;
  const level = str.slice(0, colon);
  const rest = str.slice(colon + 1).split('/').map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  switch (level) {
    case 'project': return rest.length === 1 ? { level, parts: { slug: rest[0] } } : null;
    case 'session': return rest.length === 2 ? { level, parts: { slug: rest[0], id: rest[1] } } : null;
    case 'turn': return rest.length === 3 ? { level, parts: { slug: rest[0], id: rest[1], idx: rest[2] } } : null;
    case 'agent': return rest.length === 3 ? { level, parts: { slug: rest[0], id: rest[1], agentId: rest[2] } } : null;
    default: return null;
  }
}

/** Human label for a scope string, for the find page and panel headings. */
export function scopeLabel(s) {
  const p = parseScopeString(s);
  if (!p) return String(s || '');
  switch (p.level) {
    case 'store': return 'the whole store';
    case 'project': return `project ${p.parts.slug}`;
    case 'session': return `session ${p.parts.id}`;
    case 'turn': return `turn ${p.parts.idx} of session ${p.parts.id}`;
    case 'agent': return `agent ${p.parts.agentId}`;
    default: return s;
  }
}

/** Convenience: the filter descriptors the scope sentence expects, from a query. */
export function filtersFromQuery(query) {
  const out = [];
  if (!query) return out;
  const get = (k) => (query.get ? query.get(k) : query[k]);
  const q = get('q'); if (q) out.push({ label: get('re') ? 'regex' : 'text containing', value: `“${q}”` });
  const k = get('k'); if (k) out.push({ label: 'row kinds', value: k });
  const from = get('from'); const to = get('to');
  if (from && to) out.push({ label: 'dates', value: `${from} to ${to}` });
  else if (from) out.push({ label: 'dates', value: `from ${from}` });
  else if (to) out.push({ label: 'dates', value: `up to ${to}` });
  return out;
}
