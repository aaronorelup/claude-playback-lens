// web/js/format.mjs — display formatting + tiny DOM helpers.
//
// LEAF MODULE: imports nothing. Every other web module may import it.
// (The DOM helpers live here, not in router.mjs, precisely so components can
// use them without importing the router — that would be an import cycle.)
//
// HOUSE RULES ENFORCED HERE (SPEC house rule 3):
//   * an UNKNOWN value renders '—' and always carries a reason (title=)
//   * a real ZERO renders '0'
//   * they are never the same glyph
//   * money is 4dp, exact zero renders '0', sub-threshold renders '<$0.0001'
//   * the four token categories are NEVER collapsed into one figure
//
// formatUsd() delegates to shared/pricing.mjs once api.pricing() has loaded it
// (setPricingModule) so the browser and the server print byte-identical money.
// Until then it applies the identical SPEC §6 rule locally, so this module is
// importable and testable in plain node with no server and no pricing module.

export const UNKNOWN = '—';          // em dash — the unknown glyph, reserved
export const MINUS = '−';            // true minus, for (UTC−7)
export const TCU_PER_USD_FALLBACK = 2e9;  // SPEC §6

let _pricing = null;

export function setPricingModule(mod) { _pricing = mod || null; return _pricing; }
export function getPricingModule() { return _pricing; }
export function pricingVersion() { return _pricing ? _pricing.PRICING_VERSION : null; }
export function tcuPerUsd() { return (_pricing && _pricing.TCU_PER_USD) || TCU_PER_USD_FALLBACK; }

/* ------------------------------------------------------------------ *
 * numbers
 * ------------------------------------------------------------------ */

export function isKnown(v) {
  return v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
}

function group3(intStr) {
  // deterministic thousands separators (no toLocaleString: locale-dependent)
  return String(intStr).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Integer with thousands separators. Unknown -> '—'. Real 0 -> '0'. */
export function formatInt(n) {
  if (!isKnown(n)) return UNKNOWN;
  const neg = n < 0;
  const s = group3(Math.abs(Math.trunc(n)).toString());
  return neg ? '-' + s : s;
}

export const formatCount = formatInt;

/** Token counts. Never used to collapse the four categories — one number each. */
export function formatTokens(n) { return formatInt(n); }

/** a + b + c … where any unknown poisons the sum to unknown (never treated as 0). */
export function sumOrUnknown(...vals) {
  let t = 0;
  for (const v of vals) { if (!isKnown(v)) return null; t += v; }
  return t;
}

/**
 * The four display categories of a SPEC §9 Tokens object.
 * cache-w = cache5m + cache1h + cacheFlat (the panel splits them again).
 * Returns raw numbers (null = unknown) — never pre-collapsed.
 */
export function tokenCategories(tokens) {
  const t = tokens || {};
  return {
    input: isKnown(t.input) ? t.input : null,
    output: isKnown(t.output) ? t.output : null,
    cacheWrite: sumOrUnknown(t.cache5m, t.cache1h, t.cacheFlat ?? 0),
    cacheRead: isKnown(t.cacheRead) ? t.cacheRead : null,
    cache5m: isKnown(t.cache5m) ? t.cache5m : null,
    cache1h: isKnown(t.cache1h) ? t.cache1h : null,
    cacheFlat: isKnown(t.cacheFlat) ? t.cacheFlat : null,
  };
}

export function addTokens(a, b) {
  const out = {};
  for (const k of ['input', 'output', 'cache5m', 'cache1h', 'cacheFlat', 'cacheRead']) {
    out[k] = sumOrUnknown(a && a[k], b && b[k]);
  }
  return out;
}

export function tokensTotal(tokens) {
  const t = tokens || {};
  return sumOrUnknown(t.input, t.output, t.cache5m, t.cache1h, t.cacheFlat ?? 0, t.cacheRead);
}

/* ------------------------------------------------------------------ *
 * money (SPEC §6)
 * ------------------------------------------------------------------ */

/**
 * Local implementation of the SPEC §6 display rule, used only until
 * shared/pricing.mjs loads. It is a faithful copy of that module's formatUsd
 * — SAME digits, SAME rounding, and deliberately NO thousands separators — so
 * a figure never changes shape when the rate table arrives mid-paint.
 */
export function formatUsdLocal(tcu, per) {
  const scale = per || tcuPerUsd();
  if (tcu === 0) return '0';                      // real zero — never '$0.0000'
  const neg = tcu < 0;
  const abs = neg ? -tcu : tcu;
  const perE4 = scale / 1e4;                      // tcu per $0.0001, exact
  // sub-threshold, nonzero: a small NEGATIVE exceeds −$0.0001, so the correct
  // bound is `>-$0.0001` (faithful copy of shared/pricing.mjs)
  if (abs < perE4) return neg ? '>-$0.0001' : '<$0.0001';
  const e4 = Math.round(abs / perE4);             // rounding happens only at display
  const whole = Math.floor(e4 / 10000);
  const frac = String(e4 % 10000).padStart(4, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

/**
 * Money display. Argument is integer tcu (SPEC §6). Unknown -> '—'.
 * Delegates to shared/pricing.mjs's formatUsd when loaded so the client and
 * server never disagree by a rounding rule.
 */
export function formatUsd(tcu) {
  if (!isKnown(tcu)) return UNKNOWN;
  if (_pricing && typeof _pricing.formatUsd === 'function') return _pricing.formatUsd(tcu);
  return formatUsdLocal(tcu);
}

/** A rate in SPEC §6 "rate units" (1/20 cent per Mtok) -> '$5.00/M'. */
export function formatRate(units) {
  if (!isKnown(units)) return UNKNOWN;
  const usdPerM = units / 2000;
  const s = usdPerM >= 1 ? usdPerM.toFixed(2) : usdPerM.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  return '$' + s + '/M';
}

/* ------------------------------------------------------------------ *
 * time — local always (DESIGN §2), never UTC in the reading surface
 * ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

function d(ms) { return new Date(ms); }

export function formatLocalDate(ms) {
  if (!isKnown(ms)) return UNKNOWN;
  const t = d(ms);
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

export function formatClock(ms, { seconds = true } = {}) {
  if (!isKnown(ms)) return UNKNOWN;
  const t = d(ms);
  return seconds
    ? `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`
    : `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

export function formatLocalTime(ms, opts) {
  if (!isKnown(ms)) return UNKNOWN;
  return `${formatLocalDate(ms)} ${formatClock(ms, opts)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatLocalShort(ms) {
  if (!isKnown(ms)) return UNKNOWN;
  const t = d(ms);
  return `${MONTHS[t.getMonth()]} ${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

export function formatMonth(ms) {
  if (!isKnown(ms)) return UNKNOWN;
  const t = d(ms);
  return `${MONTHS[t.getMonth()]} ${t.getFullYear()}`;
}

/** ISO of the recorded UTC instant — shown beside local time where exactness matters. */
export function formatUtc(ms) {
  if (!isKnown(ms)) return UNKNOWN;
  return new Date(ms).toISOString();
}

/**
 * '(UTC−7)' / '(UTC+5:30)' / '(UTC)'. The ONE producer of the axis label
 * string: every tzLabel in the app delegates
 * here. `offsetMinutes` is minutes EAST of UTC; NaN renders '(UTC?)'.
 */
export function tzOffsetLabel(offsetMinutes) {
  if (!Number.isFinite(offsetMinutes)) return '(UTC?)';
  if (offsetMinutes === 0) return '(UTC)';
  const sign = offsetMinutes < 0 ? MINUS : '+';
  const a = Math.abs(offsetMinutes);
  const h = Math.floor(a / 60), m = a % 60;
  return `(UTC${sign}${h}${m ? ':' + pad2(m) : ''})`;
}

/** '(UTC−7)' for the zone in effect at `ms`. Printed once per axis (DESIGN §2). */
export function tzLabel(ms) {
  const off = -new Date(isKnown(ms) ? ms : Date.now()).getTimezoneOffset(); // minutes east of UTC
  return tzOffsetLabel(off);
}

/** Durations: '2h 14m' (DESIGN §2 wording), '3.4s', '812ms'. Real 0 -> '0s'. */
export function formatDuration(ms) {
  if (!isKnown(ms)) return UNKNOWN;
  const neg = ms < 0;
  const v = Math.abs(ms);
  let s;
  if (v === 0) s = '0s';
  else if (v < 1000) s = `${Math.round(v)}ms`;
  else if (v < 60000) s = `${(v / 1000).toFixed(1)}s`;
  else if (v < 3600000) {
    const m = Math.floor(v / 60000), sec = Math.round((v % 60000) / 1000);
    s = sec ? `${m}m ${sec}s` : `${m}m`;
  } else if (v < 86400000) {
    const h = Math.floor(v / 3600000), m = Math.round((v % 3600000) / 60000);
    s = m ? `${h}h ${m}m` : `${h}h`;
  } else {
    const day = Math.floor(v / 86400000), h = Math.round((v % 86400000) / 3600000);
    s = h ? `${day}d ${h}h` : `${day}d`;
  }
  return neg ? MINUS + s : s;
}

/* ------------------------------------------------------------------ *
 * bytes, shares
 * ------------------------------------------------------------------ */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(n) {
  if (!isKnown(n)) return UNKNOWN;
  if (n === 0) return '0 B';
  const neg = n < 0;
  let v = Math.abs(n), i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  let s = i === 0 ? String(Math.round(v)) : (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${neg ? '-' : ''}${s} ${BYTE_UNITS[i]}`;
}

export function formatPercent(part, whole, dp = 1) {
  if (!isKnown(part) || !isKnown(whole) || whole === 0) return UNKNOWN;
  return `${((part / whole) * 100).toFixed(dp)}%`;
}

/** 'N of M (93.6%)' — the denominator discipline of DESIGN §7 / SPEC §9. */
export function formatOf(part, whole, { unit = '' } = {}) {
  if (!isKnown(part) || !isKnown(whole)) return UNKNOWN;
  const u = unit ? ' ' + unit : '';
  return `${formatInt(part)} of ${formatInt(whole)}${u}`;
}

export function pluralize(n, one, many) {
  return `${formatInt(n)} ${n === 1 ? one : (many || one + 's')}`;
}

// Client twin of server/parse.mjs head() — the
// cut is at max-1 UTF-16 code UNITS, so a 4-byte character straddling it left
// a lone surrogate before the '…'. Back off one unit when the last kept unit
// is a high surrogate; the `> max` branch guarantees the string continues, so
// such a unit is necessarily half of a split pair.
export function truncate(s, max = 220) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  const cut = max - 1;
  const c = s.charCodeAt(cut - 1);
  return s.slice(0, (c >= 0xd800 && c <= 0xdbff) ? cut - 1 : cut) + '…';
}

/* ------------------------------------------------------------------ *
 * tiny DOM helpers  (no innerHTML anywhere in this codebase)
 * ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

function classString(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter(Boolean).join(' ');
  return Object.keys(v).filter((k) => v[k]).join(' ');
}

function applyProps(node, props, ns) {
  if (!props) return;
  for (const key of Object.keys(props)) {
    const val = props[key];
    if (val === null || val === undefined || val === false) continue;
    if (key === 'class' || key === 'className') {
      const c = classString(val);
      if (c) node.setAttribute('class', c);
    } else if (key === 'text') {
      node.appendChild(node.ownerDocument
        ? node.ownerDocument.createTextNode(String(val))
        : document.createTextNode(String(val)));
    } else if (key === 'dataset') {
      for (const dk of Object.keys(val)) node.setAttribute('data-' + dk, String(val[dk]));
    } else if (key.startsWith('on') && typeof val === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (val === true) {
      node.setAttribute(key, '');
    } else if (!ns && (key === 'value' || key === 'checked')) {
      node[key] = val;
    } else {
      node.setAttribute(key, String(val));
    }
  }
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) { appendChildren(node, child); continue; }
    if (typeof child === 'object' && (child.nodeType || child.appendChild)) { node.appendChild(child); continue; }
    node.appendChild(document.createTextNode(String(child)));
  }
}

/** h('div', {class:'x', onclick:fn}, 'text', childNode, [more]) -> Element */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props, false);
  appendChildren(node, children);
  return node;
}

/** SVG flavour of h(). Geometry attributes are the ONE place inline values live. */
export function hs(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props, true);
  appendChildren(node, children);
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, ...children) {
  clear(node);
  appendChildren(node, children);
  return node;
}

export function on(node, type, fn, opts) {
  node.addEventListener(type, fn, opts);
  return () => node.removeEventListener(type, fn, opts);
}

/* ------------------------------------------------------------------ *
 * value nodes — the unknown/zero discipline, as DOM
 * ------------------------------------------------------------------ */

/** '—' with its reason attached. NEVER call this for a real zero. */
export function unknownNode(reason) {
  return h('span', { class: 'lens-unknown', title: reason || 'not recorded' }, UNKNOWN);
}

/**
 * valueNode(v, fmt, reason) — one place where the house rule is applied:
 * unknown -> '—' + reason; anything else (including 0) -> its formatting.
 */
export function valueNode(v, fmt, reason, cls) {
  if (!isKnown(v)) return unknownNode(reason);
  return h('span', { class: cls || null }, (fmt || String)(v));
}

export function usdNode(tcu, reason) {
  if (!isKnown(tcu)) return unknownNode(reason || 'no cost recorded for this scope');
  return h('span', { class: 'lens-num lens-num--usd' }, formatUsd(tcu));
}

export function tokenNode(n, reason) {
  if (!isKnown(n)) return unknownNode(reason || 'not recorded');
  return h('span', { class: 'lens-num lens-num--tok' }, formatTokens(n));
}

export function timeNode(ms, { short = false, reason } = {}) {
  if (!isKnown(ms)) return unknownNode(reason || 'no timestamp recorded');
  return h('time', { class: 'lens-time', datetime: formatUtc(ms), title: `${formatUtc(ms)} (recorded UTC)` },
    short ? formatLocalShort(ms) : formatLocalTime(ms));
}

export function durationNode(ms, reason) {
  if (!isKnown(ms)) return unknownNode(reason || 'fewer than two recorded timestamps');
  return h('span', { class: 'lens-num lens-num--dur' }, formatDuration(ms));
}

/**
 * '—' pip at a final width, for chrome-first loading (DESIGN §7).
 * `size` is one of the documented width tokens: usd | tok | span | count | wide.
 * It is a placeholder for a value that is not yet known — never a zero.
 */
export function pip(size) {
  return h('span', {
    class: ['lens-pip', size ? `lens-pip--${size}` : null],
    'aria-hidden': 'true',
    title: 'not loaded yet',
  }, UNKNOWN);
}
