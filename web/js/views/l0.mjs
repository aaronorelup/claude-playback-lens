// web/js/views/l0.mjs — L0 (the store) + the shared view helpers L1/L2 import.
// Group F. DESIGN §3 L0, §1 (three fixed bands), §2 (timeline grammar),
// §4 (tables), §7 (loading/liveness), §10 (edge cases). SPEC §9 payloads.
//
// CONTRACT-DEVIATION: BUILD-CONTRACTS says "no inline styles except SVG
// geometry". Three data-driven geometries here are set inline because their
// value IS the datum and cannot live in a stylesheet: the project legend swatch
// colour, the composition bar's flex-grow (a recorded block-kind count), and the
// image contact sheet's tile sizes / grid columns. Everything else is classed.
//
// House rule: display recorded values only. Unknown renders `—` + a reason,
// zero renders `0`, never the same glyph. Every number here comes from the API;
// the only client-side arithmetic is (a) display formatting and (b) summing
// server-provided children into a subtotal the design asks for (month rows,
// column-sum footers, Σ filtered) — never re-deriving a figure from tokens.

import { defineRoute as importedDefineRoute, href, navigate, showReloadBar } from '../router.mjs';
import { api, pricing, isPending } from '../api.mjs';
import { formatBytes, formatUsd as formatUsdShared, formatUsdLocal, tzOffsetLabel, h as sharedH } from '../format.mjs';
import { vtable } from '../components/vtable.mjs';
import { timeline, MARK_CAP } from '../components/timeline.mjs';
import { scopeString } from '../components/scope.mjs';

/* ===========================================================================
   1. Pure helpers — calendars, formatting, band assembly, badges, tables.
   Everything in this section is side-effect free and covered by
   tests/views-overview-l0.test.mjs.
   =========================================================================== */

export const MS_DAY = 86400000;

const pad2 = (n) => String(n).padStart(2, '0');

/** Fixed-offset calendar; `offsetMinutes` is minutes EAST of UTC. Used by tests
 *  and by any caller that must be timezone-deterministic. */
export function makeCalendar(offsetMinutes) {
  const off = offsetMinutes * 60000;
  return {
    offsetMinutes,
    offsetMinutesAt() { return offsetMinutes; },
    key(ms) {
      const d = new Date(ms + off);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    },
    dayStartMs(key) { return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) - off; },
    timeOfDay(ms) {
      const d = new Date(ms + off);
      return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
    },
  };
}

/** The host's local calendar — the one the UI actually uses (DESIGN §2:
 *  "local time always"), and the same rule the server buckets dayBands by
 *  (SPEC §9: server host's local calendar day). */
export const hostCalendar = {
  offsetMinutesAt(ms) { return -new Date(Number.isFinite(ms) ? ms : Date.now()).getTimezoneOffset(); },
  key(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  },
  dayStartMs(key) {
    return new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10), 0, 0, 0, 0).getTime();
  },
  timeOfDay(ms) { const d = new Date(ms); return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() }; },
};

export function dayKeyToUtcMs(key) {
  return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
}
export function addDays(key, n) {
  const d = new Date(dayKeyToUtcMs(key) + n * MS_DAY);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
/** Calendar days from `a` to `b` (both 'YYYY-MM-DD'); exact, DST-proof. */
export function daysBetween(a, b) { return Math.round((dayKeyToUtcMs(b) - dayKeyToUtcMs(a)) / MS_DAY); }
export function monthKey(key) { return key.slice(0, 7); }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(mk) { return `${MONTHS[+mk.slice(5, 7) - 1]} ${mk.slice(0, 4)}`; }

const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayLabel(key) {
  const d = new Date(dayKeyToUtcMs(key));
  return `${WDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

/** DESIGN §2: axis labelled `(UTC−7)` once. offsetMinutes = minutes east of
 *  UTC. Delegates to format.mjs's ONE producer of the label string (helper
 *  unification 2026-08-17). */
export function tzLabel(offsetMinutes) {
  return tzOffsetLabel(offsetMinutes);
}

// ---- number / value formatting (display only) ----------------------------

export function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const neg = n < 0;
  const s = String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : '') + s;
}

/** Null-preserving wrapper over format.mjs formatBytes (÷1024 — one
 *  recorded total must never render two ways on one screen). */
export function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return formatBytes(n);
}

export function fmtSpan(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  if (ms === 0) return '0';
  const neg = ms < 0; let v = Math.abs(ms);
  const d = Math.floor(v / MS_DAY); v -= d * MS_DAY;
  const h = Math.floor(v / 3600000); v -= h * 3600000;
  const m = Math.floor(v / 60000); v -= m * 60000;
  const s = Math.floor(v / 1000); const rest = v - s * 1000;
  let out;
  if (d) out = `${d}d ${h}h`;
  else if (h) out = `${h}h ${m}m`;
  else if (m) out = `${m}m ${s}s`;
  else if (s) out = `${s}s`;
  else out = `${rest}ms`;
  return (neg ? '−' : '') + out;
}

export function fmtClock(ms, cal = hostCalendar) {
  if (!Number.isFinite(ms)) return null;
  const t = cal.timeOfDay(ms);
  return `${pad2(t.h)}:${pad2(t.m)}:${pad2(t.s)}`;
}
export function fmtStamp(ms, cal = hostCalendar) {
  if (!Number.isFinite(ms)) return null;
  return `${cal.key(ms)} ${fmtClock(ms, cal)}`;
}

export const TCU_PER_USD_FALLBACK = 2e9;
/** SPEC §6 display rule — DELEGATED to format.mjs's formatUsdLocal: ONE
 *  money formatter app-wide, so no two cells can disagree at the
 *  sub-threshold boundary or on half-boundary rounding. Null-preserving. */
export function formatUsdTcu(tcu, tcuPerUsd = TCU_PER_USD_FALLBACK) {
  if (tcu === null || tcu === undefined || !Number.isFinite(tcu)) return null;
  return formatUsdLocal(tcu, tcuPerUsd);
}

/** The `usd` field is an object at CostAgg level and (per SPEC §9 dayBands) may
 *  be a bare integer-tcu total. Accept both; anything else is not recorded. */
export function usdTotal(usd) {
  if (typeof usd === 'number' && Number.isFinite(usd)) return usd;
  if (usd && typeof usd === 'object' && Number.isFinite(usd.total)) return usd.total;
  return null;
}

export const TOKEN_FIELDS = ['input', 'output', 'cache5m', 'cache1h', 'cacheFlat', 'cacheRead'];
export function emptyTokens() {
  return { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };
}
export function addTokens(a, b) {
  const out = a ? { ...emptyTokens(), ...a } : emptyTokens();
  if (!b) return out;
  for (const f of TOKEN_FIELDS) out[f] = (out[f] || 0) + (Number.isFinite(b[f]) ? b[f] : 0);
  return out;
}
/** DESIGN §1: tokens never collapse to one figure — in · out · cache-w · cache-r.
 *  cache-w = 5m + 1h + flat (SPEC §9: usd.cacheWrite prices flat at the 5m rate). */
export function tokens4(t) {
  if (!t) return null;
  const g = (k) => (Number.isFinite(t[k]) ? t[k] : 0);
  return { input: g('input'), output: g('output'), cacheWrite: g('cache5m') + g('cache1h') + g('cacheFlat'), cacheRead: g('cacheRead') };
}
export function sumTokensMap(byModel) {
  if (!byModel || typeof byModel !== 'object') return null;
  let t = emptyTokens(), any = false;
  for (const v of Object.values(byModel)) {
    if (!v) continue;
    t = addTokens(t, v.tokens && typeof v.tokens === 'object' ? v.tokens : v);
    any = true;
  }
  return any ? t : null;
}

// ---- query params --------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateKey(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return new Date(dayKeyToUtcMs(s)).getUTCDate() === d;
}

/** DESIGN §0 `from`/`to`. Unparseable values are reported, never silently
 *  reinterpreted (and never dropped from the URL — DESIGN §0 preserves params). */
export function parseRange(query) {
  const get = (k) => (query && typeof query.get === 'function' ? query.get(k) : (query ? query[k] : null));
  const raw = { from: get('from'), to: get('to') };
  const invalid = [];
  let from = null, to = null;
  if (raw.from != null && raw.from !== '') { if (isDateKey(raw.from)) from = raw.from; else invalid.push({ param: 'from', value: raw.from }); }
  if (raw.to != null && raw.to !== '') { if (isDateKey(raw.to)) to = raw.to; else invalid.push({ param: 'to', value: raw.to }); }
  if (from && to && from > to) { invalid.push({ param: 'from/to', value: `${from} > ${to}` }); from = null; to = null; }
  return { from, to, active: !!(from || to), invalid };
}

export function inRange(localDate, range) {
  if (!range || !range.active) return true;
  if (range.from && localDate < range.from) return false;
  if (range.to && localDate > range.to) return false;
  return true;
}

export function rangeClause(range) {
  if (!range || !range.active) return null;
  if (range.from && range.to) return `${range.from} → ${range.to}`;
  if (range.from) return `${range.from} → (no end)`;
  return `(no start) → ${range.to}`;
}

/** Build a hash URL preserving every param the app does not own (DESIGN §0). */
export function withQuery(base, query, changes) {
  const p = new URLSearchParams(query ? query.toString() : '');
  for (const [k, v] of Object.entries(changes || {})) {
    if (v === null || v === undefined || v === '') p.delete(k); else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

// ---- badges (DESIGN §3 L1; the seven recorded conditions) -----------------

export const BADGE_ORDER = ['fragment', 'forked', 'no-reply', 'retried', 'running', 'cached', 'live'];
export const BADGE_LABEL = {
  fragment: 'fragment', forked: 'forked', 'no-reply': 'no reply', retried: 'retried',
  running: 'running', cached: 'cached', live: 'live',
};
export const BADGE_TITLE = {
  fragment: 'a session dir with no sibling .jsonl — SPEC §2',
  forked: 'member of an R2 fork group — the shared events are billed in the canonical session',
  'no-reply': "the final turn's slice contains zero assistant message.id groups",
  retried: 'the run has more journal `started` entries than manifest agents',
  running: 'a journal `started` with no `result`',
  cached: 'workflowProgress cached:true',
  live: 'the file is growing on disk',
};

function normBadgeKey(k) {
  return String(k).trim().toLowerCase().replace(/[\s_]+/g, '-')
    .replace(/^noreply$/, 'no-reply').replace(/^no-replies$/, 'no-reply');
}

/** DESIGN §3: there is NO `lost agents` badge — enumeration is closed and the
 *  provable zero lives in the inventory census instead. If a payload ever
 *  carries one it is dropped here and reported by `dropped`. */
export function deriveBadges(card) {
  if (!card) return [];
  const seen = new Map();
  const dropped = [];
  const push = (rawKey) => {
    const key = normBadgeKey(rawKey);
    if (key === 'lost-agents' || key === 'lostagents') { dropped.push(rawKey); return; }
    if (!key || seen.has(key)) return;
    seen.set(key, {
      key,
      label: BADGE_LABEL[key] || String(rawKey),
      title: BADGE_TITLE[key] || 'recorded on this session card; not one of the seven designed badges',
      known: !!BADGE_LABEL[key],
    });
  };
  const b = card.badges;
  if (Array.isArray(b)) for (const x of b) push(typeof x === 'string' ? x : (x && (x.key || x.name)) || '');
  else if (b && typeof b === 'object') for (const [k, v] of Object.entries(b)) { if (v) push(k); }
  if (card.state === 'live') push('live');
  if (card.state === 'fragment') push('fragment');
  const out = [...seen.values()].sort((x, y) => {
    const ix = BADGE_ORDER.indexOf(x.key), iy = BADGE_ORDER.indexOf(y.key);
    if (ix === iy) return x.key < y.key ? -1 : 1;
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  });
  out.dropped = dropped;
  return out;
}

// ---- day bands (DESIGN §3 L0; gutters EXCLUSIVELY from `dayBands`) --------

/** Split one turnBar across the local calendar days it covers (SPEC §9: a turn
 *  crossing local midnight splits rather than double-counting). A bar with no
 *  recorded end is a tick — no invented width (DESIGN §2). */
export function splitBarAcrossDays(bar, cal = hostCalendar) {
  const at = Number.isFinite(bar && bar.at) ? bar.at : null;   // null/'' must not read as 0
  if (at === null) return [];
  const end = Number.isFinite(bar.endedAt) ? bar.endedAt : null;
  if (end === null || end <= at) {
    return [{ localDate: cal.key(at), startMs: at, endMs: null, tick: true, clippedStart: false, clippedEnd: false, bar }];
  }
  const out = [];
  let day = cal.key(at), segStart = at, guard = 0;
  while (guard++ < 400) {
    const dayEnd = cal.dayStartMs(addDays(day, 1));
    const segEnd = Math.min(end, dayEnd);
    out.push({
      localDate: day, startMs: segStart, endMs: segEnd, tick: false,
      clippedStart: segStart > at, clippedEnd: segEnd < end, bar,
    });
    if (segEnd >= end) break;
    day = addDays(day, 1);
    segStart = dayEnd;
  }
  return out;
}

/** Assemble the L0/L1 band model. Gutter figures come only from `dayBands`;
 *  a day that has bars but no dayBand entry gets a null gutter with a reason. */
export function assembleBands({ dayBands = [], turnBars = [] } = {}, opts = {}) {
  const cal = opts.cal || hostCalendar;
  const range = opts.range || { active: false };
  const slugFilter = opts.slugs && opts.slugs.length ? new Set(opts.slugs) : null;
  const byDate = new Map();

  for (const db of dayBands || []) {
    if (!db || !db.localDate || !inRange(db.localDate, range)) continue;
    byDate.set(db.localDate, {
      kind: 'band', localDate: db.localDate,
      gutter: {
        turnCount: Number.isFinite(db.turnCount) ? db.turnCount : null,
        tokens: db.tokens || null,
        usd: usdTotal(db.usd),
        sessionsTouched: db.sessionsTouched === undefined ? null : db.sessionsTouched,
        recorded: true,
      },
      segments: [],
    });
  }

  for (const bar of turnBars || []) {
    if (slugFilter && !slugFilter.has(bar.slug)) continue;
    for (const seg of splitBarAcrossDays(bar, cal)) {
      if (!inRange(seg.localDate, range)) continue;
      let band = byDate.get(seg.localDate);
      if (!band) {
        band = {
          kind: 'band', localDate: seg.localDate,
          gutter: { turnCount: null, tokens: null, usd: null, sessionsTouched: null, recorded: false,
            reason: 'no day band recorded for this date in /api/index — the gutter shows only server-computed day totals' },
          segments: [],
        };
        byDate.set(seg.localDate, band);
      }
      band.segments.push(seg);
    }
  }

  const bands = [...byDate.values()].sort((a, b) => (a.localDate < b.localDate ? 1 : a.localDate > b.localDate ? -1 : 0));
  for (const b of bands) b.segments.sort((x, y) => x.startMs - y.startMs);
  return bands;
}

/** Sum server-provided day figures. `partialDays` counts bands whose gutter was
 *  never recorded, so a subtotal can say what it does not cover. */
export function sumBands(bands) {
  let turnCount = null, usd = null, tokens = null, partialDays = 0;
  const sessions = new Set(); let sessionsAreIds = true, sawSessions = false;
  for (const b of bands || []) {
    const g = b && b.gutter;
    if (!g || !g.recorded) { partialDays++; continue; }
    if (Number.isFinite(g.turnCount)) turnCount = (turnCount || 0) + g.turnCount;
    if (Number.isFinite(g.usd)) usd = (usd || 0) + g.usd;
    if (g.tokens) tokens = addTokens(tokens || emptyTokens(), g.tokens);
    if (g.sessionsTouched != null) {
      sawSessions = true;
      if (Array.isArray(g.sessionsTouched)) for (const s of g.sessionsTouched) sessions.add(s);
      else sessionsAreIds = false;
    }
  }
  return {
    days: (bands || []).length, turnCount, tokens, usd, partialDays,
    // A per-day session COUNT cannot be summed without double-counting; only an
    // id list can be unioned. Say so rather than print a wrong number.
    sessionsTouched: sawSessions && sessionsAreIds ? sessions.size : null,
    sessionsReason: sawSessions && !sessionsAreIds
      ? 'sessionsTouched is recorded as a per-day count; summing it would double-count sessions active on more than one day'
      : (sawSessions ? null : 'not recorded'),
  };
}

/** DESIGN §3 L0: `— N days —` gap separators AND month separator rows carrying
 *  month subtotals. Newest-first; a month row sits directly above its bands. */
export function withSeparators(bands) {
  const rows = [];
  const monthTotals = new Map();
  for (const b of bands) {
    const mk = monthKey(b.localDate);
    if (!monthTotals.has(mk)) monthTotals.set(mk, []);
    monthTotals.get(mk).push(b);
  }
  let prev = null;
  for (const b of bands) {
    if (prev) {
      const gap = daysBetween(b.localDate, prev.localDate) - 1;
      if (gap >= 1) rows.push({ kind: 'gap', days: gap, newer: prev.localDate, older: b.localDate, label: `— ${gap} ${gap === 1 ? 'day' : 'days'} —` });
    }
    const mk = monthKey(b.localDate);
    if (!prev || monthKey(prev.localDate) !== mk) {
      rows.push({ kind: 'month', month: mk, label: monthLabel(mk), subtotal: sumBands(monthTotals.get(mk)) });
    }
    rows.push(b);
    prev = b;
  }
  return rows;
}

/** Contiguous runs of band rows, so each run shares one timeline mount and the
 *  separator rows stay real DOM rows between them. */
export function bandRuns(rows) {
  const runs = []; let cur = null;
  for (const r of rows) {
    if (r.kind === 'band') { if (!cur) { cur = { kind: 'run', bands: [] }; runs.push(cur); } cur.bands.push(r); }
    else { runs.push(r); cur = null; }
  }
  return runs;
}

/** Day bands share ONE 24-hour axis, so a mark is drawn at its recorded time of
 *  day on its own band. This maps a recorded instant onto that shared axis; the
 *  recorded date and time are printed in the mark's own title, never inferred
 *  from the projected coordinate. */
export function projectToAxis(ms, dayStartMs, axisFromMs) {
  if (!Number.isFinite(ms) || !Number.isFinite(dayStartMs) || !Number.isFinite(axisFromMs)) return null;
  return axisFromMs + Math.max(0, Math.min(MS_DAY, ms - dayStartMs));
}

// ---- project identity + palette (DESIGN §2 colour semantics) --------------

export const PROJECT_PALETTE = ['#7aa2f7', '#7bc47f', '#e0af68', '#f07178', '#bb9af7', '#56b6c2',
  '#f7768e', '#9ece6a', '#ff9e64', '#2ac3de', '#c0caf5', '#d19a66'];
export const PROJECT_OVERFLOW = '#6b7686';

/** Top-12 stable palette + grey overflow. Stable = ranked by recorded turn
 *  count desc, slug asc as tie-break — deterministic across renders. */
export function projectPalette(projects) {
  const ranked = [...(projects || [])].sort((a, b) => {
    const at = Number.isFinite(a.turns) ? a.turns : -1, bt = Number.isFinite(b.turns) ? b.turns : -1;
    if (at !== bt) return bt - at;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const map = new Map();
  ranked.forEach((p, i) => {
    const top = i < PROJECT_PALETTE.length;
    map.set(p.slug, {
      index: top ? i : null,
      color: top ? `var(--lens-proj-${i + 1}, ${PROJECT_PALETTE[i]})` : `var(--lens-proj-overflow, ${PROJECT_OVERFLOW})`,
      overflow: !top,
    });
  });
  return map;
}

/** SPEC §2: the slug is a lossy encoding of cwd — `[\\/:. ]` → `-` (SPACE
 *  included). Re-encoding is how a recorded cwd is matched to a dir name. */
export function slugOfCwd(cwd) {
  return typeof cwd === 'string' && cwd ? cwd.replace(/[\\/:. ]/g, '-') : null;
}

/** The display label is the recorded `cwd` value that re-encodes EXACTLY to the
 *  dir name (verified 22/22 dirs, 85/85 sessions). `cwd` is per-event and varies
 *  within a session, so the rule is the encoding match, never the modal value —
 *  and never an agent's cwd, which would invent phantom projects. */
export function labelFromCards(slug, cards) {
  for (const c of cards || []) if (c && c.cwd && slugOfCwd(c.cwd) === slug) return c.cwd;
  return null;
}

export function projectLabelOf(p, cards) {
  const label = (p && (p.label || p.cwd)) || labelFromCards(p && p.slug, cards);
  if (label) return { text: label, raw: p.slug, reason: null };
  return {
    text: p ? p.slug : '', raw: p ? p.slug : '', reason:
      'no transcript in this dir records a cwd that re-encodes to the dir name (SPEC §2) — showing the raw slug',
  };
}

// ---- index accessors (defensive: /api/index field names beyond SPEC §9's
//      named keys are not pinned by the contract) ---------------------------

export function storeAgg(index) {
  const a = index && (index.agg || index.cost || index.costAgg || index.totals);
  return a && typeof a === 'object' ? a : null;
}
export function cardAgg(card) {
  const a = card && (card.agg || card.cost || card.costAgg);
  return a && typeof a === 'object' ? a : null;
}
export function aggUsd(agg) { return agg ? usdTotal(agg.usd) : null; }
export function aggTokens(agg) { return (agg && agg.tokens) || null; }

export const NO_AGG_REASON = 'no CostAgg recorded on this payload — cost is computed server-side per response (SPEC §9)';

/** The 409 `not-indexed-yet` state, or null. Delegates to api.mjs's
 *  isPending(), which was fixed at integration to exclude the /api/index
 *  payload's own `pending[]` ARRAY (regression in tests/web-api.test.mjs) —
 *  this local workaround is now just the accessor form of the same rule.
 *  INTEGRATION-NOTE: the `typeof isPending` guard keeps this module loadable
 *  by tests/views-overview-*.test.mjs, which strip the foundation imports and
 *  evaluate the module from a data: URL (no DOM, no api.mjs). */
export function pendingOf(res) {
  if (typeof isPending === 'function') return isPending(res) ? res.pending : null;
  const p = res && res.pending;
  if (!p || Array.isArray(p) || typeof p !== 'object') return null;
  return p;
}

export function firstFinite(...vals) { for (const v of vals) if (Number.isFinite(v)) return v; return null; }

/** DESIGN §7 + SPEC §9: every aggregate ships its denominator while building. */
export function indexStatus(index) {
  const s = (index && (index.status || index.scope)) || null;
  const sc = (index && index.scope) || (s && typeof s === 'object' ? s : null) || {};
  const done = firstFinite(sc.sessions, sc.sessionsDone, sc.done, s && s.done);
  const of = firstFinite(sc.of, sc.sessionsTotal, sc.total, s && s.of);
  const bytesDone = firstFinite(sc.bytes, sc.bytesDone, s && s.bytesDone);
  const bytesTotal = firstFinite(sc.ofBytes, sc.bytesTotal, s && s.ofBytes);
  const explicit = index && (index.building === true || (typeof index.status === 'string' && index.status === 'building')
    || (s && s.building === true) || (s && s.state === 'building'));
  const pending = Array.isArray(index && index.pending) ? index.pending : [];
  const building = explicit === true ? true
    : (Number.isFinite(done) && Number.isFinite(of) ? done < of : pending.length > 0);
  return { done, of, bytesDone, bytesTotal, building, pending, version: index ? index.version : undefined };
}

/** "totals over 61 of 85 sessions — indexing…" (DESIGN §3 L0). */
export function denominatorSentence(st) {
  if (!st || !Number.isFinite(st.done) || !Number.isFinite(st.of)) {
    return st && st.building ? 'totals cover the sessions indexed so far — indexing…' : null;
  }
  const base = `totals over ${fmtInt(st.done)} of ${fmtInt(st.of)} sessions`;
  return st.building ? `${base} — indexing…` : base;
}

/** Normalised project rows for `?v=table`, incl. memory-only projects. */
export function projectsFromIndex(index) {
  const cards = (index && index.sessions) || [];
  const bySlug = new Map();
  for (const c of cards) {
    if (!c || !c.slug) continue;
    if (!bySlug.has(c.slug)) bySlug.set(c.slug, []);
    bySlug.get(c.slug).push(c);
  }
  const declared = (index && index.projects) || [];
  const slugs = new Set([...declared.map((p) => p && p.slug).filter(Boolean), ...bySlug.keys()]);
  const rows = [];
  for (const slug of slugs) {
    const p = declared.find((x) => x && x.slug === slug) || { slug };
    const mine = bySlug.get(slug) || [];
    const agg = cardAgg(p);
    const label = projectLabelOf(p, mine);
    const sum = (key, cardKey) => {
      if (Number.isFinite(p[key])) return p[key];
      if (!mine.length) return null;
      let t = 0, any = false;
      for (const c of mine) if (Number.isFinite(c[cardKey])) { t += c[cardKey]; any = true; }
      return any ? t : null;
    };
    let tokens = p.tokens || aggTokens(agg) || null;
    if (!tokens && mine.length) {
      let acc = null;
      for (const c of mine) { const t = c.usageByModel ? sumTokensMap(c.usageByModel) : (c.tokens || null); if (t) acc = addTokens(acc || emptyTokens(), t); }
      tokens = acc;
    }
    const firstAt = Number.isFinite(p.firstAt) ? p.firstAt : minOf(mine.map((c) => c.startedAt));
    const lastAt = Number.isFinite(p.lastAt) ? p.lastAt : maxOf(mine.map((c) => (Number.isFinite(c.endedAt) ? c.endedAt : c.startedAt)));
    const badges = new Map();
    for (const c of mine) for (const b of deriveBadges(c)) badges.set(b.key, (badges.get(b.key) || 0) + 1);
    const sessions = Number.isFinite(p.sessions) ? p.sessions : (Array.isArray(p.sessionIds) ? p.sessionIds.length : mine.length);
    const memoryFiles = Array.isArray(p.memoryFiles) ? p.memoryFiles.length : firstFinite(p.memoryFiles, p.memoryFileCount);
    rows.push({
      slug, label: label.text, labelReason: label.reason,
      sessions, turns: sum('turns', 'turnCount'), agents: sum('agents', 'agentCount'),
      workflows: sum('workflows', 'workflowCount'),
      firstAt, lastAt, bytes: Number.isFinite(p.bytes) ? p.bytes : sum('bytes', 'bytes'),
      tokens, tokensReason: tokens ? null : 'no tokens recorded for this project',
      usd: aggUsd(agg), usdReason: agg ? null : NO_AGG_REASON,
      agg, memoryFiles,
      memoryOnly: sessions === 0,
      badges: [...badges.entries()].map(([key, count]) => ({ key, label: BADGE_LABEL[key] || key, count, title: BADGE_TITLE[key] || '' })),
    });
  }
  rows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (a.slug < b.slug ? -1 : 1));
  return rows;
}
function minOf(xs) { let m = null; for (const x of xs) if (Number.isFinite(x) && (m === null || x < m)) m = x; return m; }
function maxOf(xs) { let m = null; for (const x of xs) if (Number.isFinite(x) && (m === null || x > m)) m = x; return m; }

export function sessionTitleOf(card) {
  if (!card) return { text: '', source: null };
  if (card.customTitle) return { text: card.customTitle, source: 'custom-title' };
  if (card.aiTitle) return { text: card.aiTitle, source: 'ai-title' };
  if (card.title) return { text: card.title, source: 'title' };
  return { text: card.id || '', source: 'sessionId (no title recorded)' };
}

/** Normalised session rows — shared by L0 `?v=sessions` and L1's default table. */
export function sessionRowsFromIndex(index, opts = {}) {
  const cards = (index && index.sessions) || [];
  const range = opts.range || { active: false };
  const cal = opts.cal || hostCalendar;
  const rows = [];
  for (const c of cards) {
    if (opts.slug && c.slug !== opts.slug) continue;
    if (range.active) {
      const at = Number.isFinite(c.startedAt) ? c.startedAt : null;
      if (at === null || !inRange(cal.key(at), range)) continue;
    }
    const agg = cardAgg(c);
    const title = sessionTitleOf(c);
    const tokens = aggTokens(agg) || (c.usageByModel ? sumTokensMap(c.usageByModel) : null) || c.tokens || null;
    rows.push({
      slug: c.slug, id: c.id, state: c.state,
      startedAt: Number.isFinite(c.startedAt) ? c.startedAt : null,
      endedAt: Number.isFinite(c.endedAt) ? c.endedAt : null,
      span: Number.isFinite(c.startedAt) && Number.isFinite(c.endedAt) ? c.endedAt - c.startedAt : null,
      title: title.text, titleSource: title.source,
      turns: firstFinite(c.turnCount), agents: firstFinite(c.agentCount), workflows: firstFinite(c.workflowCount),
      tokens, tokensReason: tokens ? null : 'no usage recorded on this session card',
      usd: aggUsd(agg), usdReason: agg ? null : NO_AGG_REASON, agg,
      bytes: firstFinite(c.bytes), files: firstFinite(c.files), lines: firstFinite(c.lines),
      badges: deriveBadges(c),
      card: c,
    });
  }
  rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return rows;
}

// ---- inventory (DESIGN §3 L0 `?v=inventory`) ------------------------------

/** Identical code+scope Problems collapse to one row carrying `count` (SPEC §9).
 *
 *  The collapse also carries the row's SOURCES — the distinct
 *  {slug,id} (or {file,line}) identities that contributed to it — because the
 *  collapsed row is otherwise anonymous (it keeps the first contributor's
 *  slug/id/message and drops the rest), and the drawer must never assert that
 *  a many-session condition belongs to one session. `sourceCount` is the
 *  distinct total; `sources` is capped, so a 3,000-record row does not ship
 *  3,000 ids. */
const SOURCE_CAP = 25;
// R18-A1: the delimiter is U+0000 and it must STAY U+0000, written as the
// \u0000 escape rather than as a raw NUL byte.
//
// WHY NUL: it cannot occur in a project slug, a session id, a file path or a
// line number, so the four fields can never re-partition across it and the
// key is unambiguous. Any PRINTABLE delimiter breaks that. With a space,
// {id:'AAAA notes', file:'file.txt'} and {id:'AAAA', file:'notes file.txt'}
// build the same key, two distinct sources dedupe to one, and `sourceCount`
// UNDER-counts — which turns R8-PROB-2's exact census into a false claim (a
// row fed by 2 sessions reporting 1) and then links the store drawer to a
// session that did not produce the condition. That is the inference this app
// does not make.
//
// WHY THE ESCAPE AND NOT THE BYTE: a raw NUL renders as a plain space in
// file-viewer tooling and makes ripgrep treat the file as binary, silently
// dropping every later line from repo-wide search results — 63% of this file,
// including collapseProblems itself and both SOURCE_CAP sites, was invisible
// to a repo-wide `rg` for exactly this reason. The next reader sees a
// space, retypes a space, and regresses the census with nothing to catch it.
// tests/web-fixes-round18.test.mjs pins both halves: the boundary collision,
// and a repo-wide byte scan that fails on any raw NUL in tracked source.
function sourceKeyOf(s) {
  return `${s.slug ?? ''}\u0000${s.id ?? ''}\u0000${s.file ?? ''}\u0000${s.line ?? ''}`;
}
function sourceOfProblem(p) {
  const s = {};
  if (p.slug != null) s.slug = p.slug;
  if (p.id != null) s.id = p.id;
  if (p.file != null) s.file = p.file;
  if (p.line != null) s.line = p.line;
  return Object.keys(s).length ? s : null;
}
export function collapseProblems(problems) {
  const out = new Map();
  const seen = new Map(); // key -> Set of source keys
  const take = (row, key, src, declared) => {
    let set = seen.get(key);
    if (!set) { set = new Set(); seen.set(key, set); }
    const k = sourceKeyOf(src);
    if (set.has(k)) return;
    set.add(k);
    // A server-supplied row already counted its own distinct sources; only the
    // capped survivors are visible here, so `declared` is the honest total.
    if (declared == null) row.sourceCount += 1;
    if (row.sources.length < SOURCE_CAP) row.sources.push(src);
  };
  for (const p of problems || []) {
    if (!p) continue;
    const key = `${p.code} ${p.scope || ''}`;
    let row = out.get(key);
    const n = Number.isFinite(p.count) ? p.count : 1;
    if (!row) {
      row = { code: p.code, severity: p.severity || 'note', scope: p.scope || null, affects: p.affects || null, message: p.message || '', count: 0, sources: [], sourceCount: 0, samples: [] };
      out.set(key, row);
    }
    row.count += n;
    row.samples.push(p);
    if (Array.isArray(p.sources)) {
      const declared = Number.isFinite(p.sourceCount) ? p.sourceCount : p.sources.length;
      row.sourceCount += declared;
      for (const s of p.sources) take(row, key, s, declared);
    } else {
      const s = sourceOfProblem(p);
      if (s) take(row, key, s, null);
    }
  }
  return [...out.values()].sort((a, b) => {
    const rank = { error: 0, warning: 1, note: 2 };
    return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || b.count - a.count || (a.code < b.code ? -1 : 1);
  });
}

/** First 8 chars of a session id — the app's short form everywhere else. */
export function shortSessionId(id, n = 8) { return String(id ?? '').slice(0, n); }

/**
 * The store problems drawer's `where` cell.
 *
 * EXACTLY ONE source renders a link to it. More than one renders plain text
 * ("3 sessions") with NO link and no first-one-wins: the store census collapses
 * by code|scope across sessions, so the row's surviving slug/id belongs to the
 * first contributor only, and linking it would tell the reader a three-session
 * condition belongs to one of them. Zero sources renders `—` with its reason,
 * never an empty cell.
 */
export function whereCell(row) {
  const sources = Array.isArray(row && row.sources) ? row.sources : [];
  const n = Number.isFinite(row && row.sourceCount) ? row.sourceCount : sources.length;
  if (n === 0 || sources.length === 0) {
    return h('span', { class: 'lens-unknown', title: 'these records do not name a session or a file', text: '—' });
  }
  const label = (s) => (s.slug && s.id ? `${s.slug} · ${s.id}`
    : s.file != null ? (s.line != null ? `${s.file}:${s.line}` : String(s.file))
      : (s.id != null ? String(s.id) : ''));
  if (n === 1) {
    const s = sources[0];
    if (s.slug && s.id) {
      return h('a', {
        href: sessionHref(s.slug, s.id), class: 'lens-table__link', 'data-lens-drill': '',
        title: label(s), text: shortSessionId(s.id),
      });
    }
    return h('span', { class: 'lens-problems__where', title: label(s), text: label(s) });
  }
  const noun = sources[0].id != null ? 'sessions' : sources[0].file != null ? 'files' : 'records';
  const shown = sources.map(label).join('\n');
  const more = n > sources.length ? `\n… and ${n - sources.length} more` : '';
  return h('span', {
    class: 'lens-problems__where',
    title: `${shown}${more}`,
    text: `${n} ${noun}`,
  });
}

export function buildInventory(index) {
  const cards = (index && index.sessions) || [];
  const projects = (index && index.projects) || [];
  const problems = collapseProblems((index && index.problems) || []);
  const st = indexStatus(index);
  const byCode = (code) => problems.filter((p) => p.code === code).reduce((n, p) => n + p.count, 0);

  let sessionFiles = null, sessionBytes = null;
  for (const c of cards) {
    if (Number.isFinite(c.files)) sessionFiles = (sessionFiles || 0) + c.files;
    if (Number.isFinite(c.bytes)) sessionBytes = (sessionBytes || 0) + c.bytes;
  }
  let projectFiles = null, projectBytes = null;
  for (const p of projects) {
    const n = Array.isArray(p.memoryFiles) ? p.memoryFiles.length : firstFinite(p.memoryFiles, p.memoryFileCount);
    if (Number.isFinite(n)) projectFiles = (projectFiles || 0) + n;
    if (Array.isArray(p.memoryFiles)) {
      for (const m of p.memoryFiles) if (m && Number.isFinite(m.bytes)) projectBytes = (projectBytes || 0) + m.bytes;
    }
  }
  const declaredFound = firstFinite(index && index.filesFound, index && index.files);
  const found = declaredFound != null ? declaredFound
    : (sessionFiles == null && projectFiles == null ? null : (sessionFiles || 0) + (projectFiles || 0));
  const unclassified = firstFinite(index && index.filesUnclassified) ?? byCode('unclassified-file');
  const classified = found == null ? null : found - (Number.isFinite(unclassified) ? unclassified : 0);

  const censusValue = (key, problemCode) => {
    const c = index && index.censuses && index.censuses[key];
    if (Number.isFinite(c)) return { value: c, reason: null };
    if (problemCode) return { value: byCode(problemCode), reason: null, fromProblems: true };
    return { value: null, reason: 'not recorded in /api/index (expected: a server-side census)' };
  };

  // The lost-agents PROVABLE ZERO — the server ships Σ card.lostAgents
  // top-level; failing that, sum the cards when every card records one. Only
  // when neither source exists does the cell read — with its reason.
  const lostAgentsValue = (() => {
    const c = index && index.censuses && index.censuses.lostAgents;
    if (Number.isFinite(c)) return { value: c, reason: null, source: '/api/index censuses.lostAgents' };
    if (Number.isFinite(index && index.lostAgents)) return { value: index.lostAgents, reason: null, source: '/api/index lostAgents (Σ card.lostAgents)' };
    if (cards.length && cards.every((x) => Number.isFinite(x.lostAgents))) {
      return { value: cards.reduce((n, x) => n + x.lostAgents, 0), reason: null, source: 'Σ card.lostAgents over every session card' };
    }
    return {
      value: null,
      reason: cards.length
        ? 'a lostAgents census is not recorded on /api/index or on every session card'
        : 'not recorded in /api/index (expected: a server-side census)',
    };
  })();

  const cache = (index && index.cache) || null;
  return {
    status: st,
    files: {
      found, classified, unclassified: Number.isFinite(unclassified) ? unclassified : null,
      sessionFiles, projectFiles,
      reason: found == null ? 'file counts are not recorded on /api/index' : null,
    },
    bytes: {
      accounted: sessionBytes == null && projectBytes == null ? null : (sessionBytes || 0) + (projectBytes || 0),
      sessionBytes, projectBytes,
      ofBytes: st.bytesTotal,
      reason: sessionBytes == null ? 'byte totals are not recorded on the session cards' : null,
    },
    cache: cache ? {
      entries: firstFinite(cache.entries, cache.cards, cache.count),
      version: cache.indexVersion ?? cache.version ?? null,
      writtenAt: firstFinite(cache.writtenAt, cache.mtimeMs),
      bytes: firstFinite(cache.bytes, cache.size),
      dir: cache.dir || null,
      ok: cache.ok !== false,
    } : null,
    cacheReason: cache ? null : 'cache state is not recorded on /api/index',
    fragments: cards.filter((c) => c.state === 'fragment' || deriveBadges(c).some((b) => b.key === 'fragment'))
      .map((c) => ({ slug: c.slug, id: c.id, otherSessionIds: c.otherSessionIds || [] })),
    duplicateIds: dupIds(cards),
    censuses: [
      { key: 'lostAgents', label: 'lost agents', expected: 0, ...lostAgentsValue },
      { key: 'tornLines', label: 'torn lines', expected: 0, ...censusValue('tornLines', 'torn-line') },
    ],
    problems,
  };
}
function dupIds(cards) {
  const seen = new Map();
  for (const c of cards) {
    if (!c || !c.id) continue;
    if (!seen.has(c.id)) seen.set(c.id, []);
    seen.get(c.id).push(c.slug);
  }
  return [...seen.entries()].filter(([, slugs]) => slugs.length > 1).map(([id, slugs]) => ({ id, slugs }));
}

// ---- band 2 props (components/scope.mjs consumes these) ------------------

/** Returns the PROPS for components/scope.mjs — subject, recorded counts, the
 *  rule by which the set was formed, active filters, and the Σ all / Σ filtered
 *  totals. The wording of the sentence itself belongs to group E. */
export function scopeSentenceL0({ view, st, range, bandCount, tzText, filteredTurns, allTurns, projectFilter, projects, sessions, turns, sigma, dayBandTurnSum }) {
  const rule = {
    timeline: `one bar per recorded turn, bucketed into ${Number.isFinite(bandCount) ? fmtInt(bandCount) : '—'} local calendar ${bandCount === 1 ? 'day' : 'days'} ${tzText || ''}; a turn crossing local midnight is split between days by its rows’ recorded timestamps, and every band-gutter figure is the server’s day total rather than anything re-derived here`,
    table: 'one row per project directory found under the projects dir, including dirs that hold only memory files',
    sessions: 'one row per session, keyed by sessionId — a fragment dir unions into the session that owns that id (SPEC §2)',
    inventory: 'every file the scan found under the projects dir, and what became of it',
  }[view] || null;
  const filters = [];
  if (range && range.active) filters.push({ label: 'date', value: rangeClause(range) });
  if (projectFilter && projectFilter.length) filters.push({ label: 'projects', value: `${projectFilter.length} selected` });
  const extra = [];
  // Both figures are recorded; where they disagree, say so rather than pick one.
  if (view === 'timeline' && Number.isFinite(turns) && Number.isFinite(dayBandTurnSum) && dayBandTurnSum !== turns) {
    extra.push(`the turn count is one per recorded turn bar; the day bands below sum to ${fmtInt(dayBandTurnSum)} because a turn is counted in every local day it touches`);
  }
  const denom = denominatorSentence(st);
  if (denom) extra.push(`the header ${denom}`);
  if (projectFilter && projectFilter.length) extra.push('the legend filter hides other projects’ bars; it does not change the header');
  return {
    subject: 'the store',
    counts: [
      Number.isFinite(turns) ? { n: turns, noun: 'turn' } : null,
      Number.isFinite(sessions) ? { n: sessions, noun: 'session' } : null,
      Number.isFinite(projects) ? { n: projects, noun: 'project' } : null,
    ].filter(Boolean),
    rule, filters,
    totals: (range && range.active && Number.isFinite(filteredTurns) && Number.isFinite(allTurns))
      ? { all: allTurns, filtered: filteredTurns } : undefined,
    sigma: sigma || 'all',
    extra,
  };
}

/* ===========================================================================
   2. DOM helpers shared by L0/L1/L2. Group F owns these three view files only;
   if the integrator prefers, they can move verbatim into a group-E module.
   =========================================================================== */

/** ONE h() for the whole app: this is format.mjs's h, re-exported so
 *  L0/L1/L2 keep their import site. */
export const h = sharedH;
export function clearEl(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
export function replaceEl(el, ...kids) { clearEl(el); for (const k of kids.flat(3)) if (k) el.appendChild(k); return el; }

/** Unknown → `—` + reason (title). Zero → `0`. Never the same glyph. */
export function val(text, reason) {
  if (text === null || text === undefined || text === '') {
    return h('span', { class: 'lens-unknown', title: reason || 'not recorded', text: '—' });
  }
  return h('span', { class: 'lens-val', text: String(text) });
}
export const dash = (reason) => val(null, reason);

export const storeHref = () => href();
export const projectHref = (slug, q) => (q ? href('p', slug, q) : href('p', slug));
export const sessionHref = (slug, id, q) => (q ? href('p', slug, 's', id, q) : href('p', slug, 's', id));
export const turnHref = (slug, id, idx) => href('p', slug, 's', id, 't', String(idx));
export const agentHref = (slug, id, agentId) => href('p', slug, 's', id, 'a', agentId);
export const eventHref = (slug, id, agentId, ref) => href('p', slug, 's', id, 'a', agentId, 'e', ref);
export const workflowHref = (slug, id, runId) => href('p', slug, 's', id, 'w', runId);
export const sessionInvHref = (slug, id) => href('p', slug, 's', id, 'inv');
export const memoryHref = (slug, name) => href('p', slug, 'mem', name);

/** The `?v=` strip. The tab whose key === defaultView drops the param, so it
 *  agrees with the router's `t` cycling (which drops `v` for views[0]). */
export function viewTabs(base, query, tabs, active, defaultView) {
  const nav = h('nav', { class: 'lens-tabs', 'aria-label': 'views' });
  for (const t of tabs) {
    const isActive = active === t.v;
    nav.appendChild(h('a', {
      class: 'lens-tabs__tab' + (isActive ? ' lens-tabs__tab--on' : ''),
      href: withQuery(base, query, { v: t.v === defaultView ? null : t.v }),
      'aria-current': isActive ? 'page' : null, title: t.title || null,
    }, t.label));
  }
  return nav;
}

export function badgeRow(badges) {
  const row = h('span', { class: 'lens-badges' });
  for (const b of badges || []) {
    row.appendChild(h('span', {
      class: `lens-badge lens-badge--${b.key}` + (b.known === false ? ' lens-badge--unknown' : ''),
      title: b.title || '',
    }, b.count ? `${b.label} ×${b.count}` : b.label));
  }
  return row;
}

export function tokenCells(t, reason) {
  const f = tokens4(t);
  if (!f) return [dash(reason || 'no usage recorded')];
  return [
    h('span', { class: 'lens-tok lens-tok--in', title: 'input tokens', text: fmtInt(f.input) }),
    h('span', { class: 'lens-tok__sep', text: '·' }),
    h('span', { class: 'lens-tok lens-tok--out', title: 'output tokens', text: fmtInt(f.output) }),
    h('span', { class: 'lens-tok__sep', text: '·' }),
    h('span', { class: 'lens-tok lens-tok--cw', title: 'cache-write tokens (5m + 1h + flat)', text: fmtInt(f.cacheWrite) }),
    h('span', { class: 'lens-tok__sep', text: '·' }),
    h('span', { class: 'lens-tok lens-tok--cr', title: 'cache-read tokens', text: fmtInt(f.cacheRead) }),
  ];
}

/* ---- pricing (display formatting only) ---------------------------------- */

let PRICING = null;
export async function ensurePricing() {
  if (PRICING) return PRICING;
  try { PRICING = await pricing(); } catch { PRICING = null; }
  return PRICING;
}
export function fmtUsd(tcu) {
  if (tcu === null || tcu === undefined || !Number.isFinite(tcu)) return null;
  if (PRICING && typeof PRICING.formatUsd === 'function') return PRICING.formatUsd(tcu);
  return formatUsdTcu(tcu, (PRICING && PRICING.TCU_PER_USD) || TCU_PER_USD_FALLBACK);
}
export function usdCell(tcu, reason) {
  const s = fmtUsd(tcu);
  return s === null ? dash(reason || NO_AGG_REASON) : h('span', { class: 'lens-num lens-num--usd', text: s });
}

/* ---- view lifecycle: mounts + polling ----------------------------------- */

const S = { timer: null, mounts: [] };

export function resetViewState() {
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  for (const m of S.mounts) { try { if (m && typeof m.destroy === 'function') m.destroy(); } catch { /* a component that cannot unmount must not block navigation */ } }
  S.mounts = [];
}
export function track(m) { if (m) S.mounts.push(m); return m; }

/** Self-healing poll: a stale render context retires its own timer, so leaving
 *  for a group-G view never leaves a poll running under it (DESIGN §7). */
export function schedulePoll(ctx, fn, ms) {
  if (S.timer) clearTimeout(S.timer);
  S.timer = setTimeout(async () => {
    S.timer = null;
    if (ctx && ctx.stale) return;
    try { await fn(); } catch { /* keep the last good render; the next tick retries */ }
  }, ms);
}

/* ---- the three fixed bands (DESIGN §1), mounted through ctx ------------- */

export function mountBands(ctx, { items, up, scope, stat }) {
  ctx.crumbs({ items, up });
  if (up) ctx.registerUp(up.href, up.label);
  ctx.scopeSentence(scope);
  ctx.statbar(stat);
}

/** statbar props per components/statbar.mjs.
 *  `rowsSumToHeader` is the PAYLOAD-level field every aggregate route
 *  ships — it never lives on the CostAgg. */
export function buildStatbarProps({ agg, tokens, span, active, counts, st, scope, at, chipsAgg, pending, rowsSumToHeader, costPanel }) {
  const a = agg || null;
  return {
    pending: !!pending,
    agg: a,
    cost: a ? undefined : { tcu: null, reason: NO_AGG_REASON },
    costPanel: costPanel || undefined,
    tokens: tokens || aggTokens(a) || null,
    span: {
      ms: Number.isFinite(span) ? span : null, label: 'span',
      reason: Number.isFinite(span) ? null : 'fewer than two recorded timestamps in this scope',
    },
    active: {
      ms: Number.isFinite(active) ? active : null,
      reason: Number.isFinite(active) ? null : 'the payload records no union-of-intervals figure',
    },
    counts: counts || [],
    // The disclosure chips describe the whole scope; a filtered subtotal passes
    // null rather than claim a mass it never covered.
    chips: chipsAgg === undefined ? a : chipsAgg,
    scope,
    at: Number.isFinite(at) ? at : undefined,
    footnote: {
      requests: a && Number.isFinite(a.requests) ? a.requests : null,
      rowsSumToHeader: rowsSumToHeader !== undefined ? rowsSumToHeader : null,
      denominator: denominatorSentence(st),
    },
  };
}

/* ---- table helpers (components/vtable.mjs column shape) ----------------- */

export function col(key, label, opts = {}) {
  return Object.assign({ key, label, type: opts.type || 'text' }, opts);
}
export const tokenCols = () => [
  col('tin', 'in', { type: 'tokens', sum: true, reason: 'no usage recorded' }),
  col('tout', 'out', { type: 'tokens', sum: true, reason: 'no usage recorded' }),
  col('tcw', 'cache-w', { type: 'tokens', sum: true, title: 'cache writes: 5m + 1h + flat', reason: 'no usage recorded' }),
  col('tcr', 'cache-r', { type: 'tokens', sum: true, reason: 'no usage recorded' }),
];
export function tokenValues(tokens) {
  const t = tokens4(tokens);
  return { tin: t ? t.input : null, tout: t ? t.output : null, tcw: t ? t.cacheWrite : null, tcr: t ? t.cacheRead : null };
}

export function mountTable(el, props) {
  clearEl(el);
  try { return track(vtable(el, props)); }
  catch (e) {
    el.appendChild(h('div', { class: 'lens-card lens-card--error', text: `table component unavailable: ${e && e.message}` }));
    return null;
  }
}

/* ===========================================================================
   3. L0 rendering
   =========================================================================== */

// Poll cadences (DESIGN §7): fast while the index is building, slow once it
// settles. One place, so the store render and its background poll agree.
const POLL_BUILDING_MS = 1000;
const POLL_SETTLED_MS = 5000;
// Never squeeze a run's mark budget below this when splitting MARK_CAP
// across a page's timeline mounts.
const MIN_BINS_PER_RUN = 100;

const L0_TABS = [
  { v: 'timeline', label: 'timeline' },
  { v: 'table', label: 'projects' },
  { v: 'sessions', label: 'sessions' },
  { v: 'inventory', label: 'inventory' },
];
const L0_VIEWS = L0_TABS.map((t) => t.v);

function parseSlugFilter(query) {
  const raw = query && query.get ? query.get('p') : null;
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function renderStore(ctx) {
  resetViewState();
  const query = ctx.query;
  const requested = query.get('v');
  const view = L0_VIEWS.includes(requested) ? requested : 'timeline';

  ctx.setTitle('the store');
  ctx.crumbs({ items: [{ label: 'the store' }] });
  ctx.registerLevels({ 0: '#/' });
  ctx.registerScope(scopeString('store'));
  ctx.registerViews(L0_TABS.map((t) => ({ key: t.v, label: t.label })));
  ctx.statbar({ pending: true, counts: [] });          // chrome first (DESIGN §7)

  await ensurePricing();
  const index = await api('/api/index', null, { signal: ctx.signal });
  if (ctx.stale) return;
  const pending = pendingOf(index);
  if (pending) {
    ctx.loading({
      label: 'building the index — this page renders as soon as its sessions are summarised',
      bytesDone: pending.bytesIndexed, bytesTotal: pending.bytesTotal,
      done: pending.sessionsDone, of: pending.sessionsOf,
    });
    schedulePoll(ctx, () => renderStore(ctx), pending.retryAfterMs || POLL_BUILDING_MS);
    return;
  }
  ctx.ready();
  paintStore(ctx, index, { view, range: parseRange(query), query });
}

function paintStore(ctx, index, opts) {
  const { view, range, query } = opts;
  const st = indexStatus(index);
  const projects = projectsFromIndex(index);
  const palette = projectPalette(projects);
  const slugs = parseSlugFilter(query);
  const bands = assembleBands(index, { range, slugs });
  const allBands = assembleBands(index, {});
  const filteredSum = sumBands(bands);
  const allSum = sumBands(allBands);
  const sigma = range.active && query.get('sum') === 'filtered' ? 'filtered' : 'all';
  const useFiltered = sigma === 'filtered';
  const agg = storeAgg(index);
  // Turn identity comes from turnBars (one entry per turn, SPEC §9). Day bands
  // are per-day figures: a turn spanning local midnight appears in both, so
  // their turnCounts sum to more than the store's turns. Both are recorded and
  // both are shown — the discrepancy is surfaced, never averaged away.
  const turnCount = countTurnBars(index.turnBars, { range, slugs });
  const allTurnCount = countTurnBars(index.turnBars, {});
  // Turns that touch the range but are only PARTLY inside it — the
  // scope sentence names them so a range count is never read as whole turns.
  const boundaryTurns = range.active ? countBoundaryTurns(index.turnBars, { range, slugs }) : 0;

  for (const bad of range.invalid) {
    ctx.banner(`Ignored ${bad.param}=${bad.value} — that is not a YYYY-MM-DD date. The parameter stays in the URL and is not applied.`, 'warn');
  }
  if (st.building && st.pending.length) {
    ctx.banner(`${fmtInt(st.pending.length)} session${st.pending.length === 1 ? '' : 's'} are not summarised yet — no figures are claimed for them:`,
      'note', pendingList(st.pending));
  }
  // R2 canonicality is only defined against a COMPLETE index — while it
  // is pending, the store header says so (SPEC R2's last sentence).
  const r2 = index.status && index.status.r2;
  if (r2 === 'pending') {
    ctx.banner('R2 fork billing is pending — the index is still building, so duplicate-message groups are not fully resolved and forked sessions\' totals may shift until it finishes · R2', 'warn');
  }

  // Σ filtered is the sum of the server's in-range day bands — child figures
  // added up, never a cost re-derived in the browser from tokens.
  const filteredAgg = useFiltered
    ? { requests: null, tokens: filteredSum.tokens, usd: { total: filteredSum.usd } }
    : null;
  const scope = scopeSentenceL0({
    view, st, range, bandCount: bands.length,
    tzText: tzLabel(hostCalendar.offsetMinutesAt(Date.now())),
    filteredTurns: turnCount, allTurns: allTurnCount,
    projectFilter: slugs, sigma,
    projects: projects.length, sessions: (index.sessions || []).length, turns: allTurnCount,
    dayBandTurnSum: allSum.turnCount,
  });
  scope.onSigma = (next) => navigate(withQuery('#/', query, { sum: next === 'filtered' ? 'filtered' : null }));
  if (range.active && boundaryTurns > 0) {
    scope.extra = [...(scope.extra || []),
      `${fmtInt(turnCount)} turns touch this range; ${fmtInt(boundaryTurns)} are only partly inside it (their in-range day segments are what the bands show)`];
  }
  if (useFiltered) {
    scope.note = `Σ filtered is the sum of the ${fmtInt(filteredSum.days)} day band${filteredSum.days === 1 ? '' : 's'} in range${filteredSum.partialDays ? `, of which ${filteredSum.partialDays} record no day band and add nothing` : ''}; the disclosure chips are shown for Σ all only.`;
  }

  mountBands(ctx, {
    items: [{ label: 'the store' }],
    scope,
    stat: buildStatbarProps({
      agg: useFiltered ? filteredAgg : agg,
      chipsAgg: useFiltered ? null : agg,
      tokens: useFiltered ? filteredSum.tokens : (aggTokens(agg) || allSum.tokens),
      span: spanOf(index.turnBars), active: firstFinite(index.activeMs),
      at: maxAt(index.turnBars), scope: scopeString('store'), st,
      // The server's exact-tcu verdict, straight off the payload. In
      // Σ-filtered mode the header is a client sum of day bands — the server
      // never checked THAT figure, so no verdict is claimed for it.
      rowsSumToHeader: useFiltered ? null : index.rowsSumToHeader,
      // Σ filtered has no per-model breakdown to open — say so instead
      // of a cost panel claiming "No billed requests in this scope."
      costPanel: useFiltered ? {
        enabled: false,
        reason: 'Σ filtered sums the in-range day bands; the per-model breakdown exists for Σ all — switch back to open it.',
      } : undefined,
      counts: [
        { key: 'projects', label: 'projects', value: projects.length, href: withQuery('#/', query, { v: 'table' }) },
        { key: 'sessions', label: 'sessions', value: (index.sessions || []).length, href: withQuery('#/', query, { v: 'sessions' }) },
        // One per recorded turn BAR — identity, so a turn that spans local
        // midnight counts once. Σ dayBands.turnCount counts it in every band it
        // touches and is therefore not a store turn count; see the note below.
        // The cell FOLLOWS the sigma toggle — Σ all headers never mix a
        // range-filtered count in with Σ-all cost/tokens.
        { key: 'turns', label: 'turns', value: useFiltered ? turnCount : allTurnCount, reason: 'no turn bars are recorded in /api/index' },
        { key: 'agents', label: 'agents', value: sumField(index.sessions, 'agentCount'), reason: 'no agent counts are recorded on the session cards' },
        { key: 'bytes', label: 'bytes', value: sumField(index.sessions, 'bytes'), reason: 'no byte totals are recorded on the session cards' },
      ],
    }),
  });

  const root = h('div', { class: 'lens-l0' });
  root.appendChild(viewTabs('#/', query, L0_TABS, view, 'timeline'));
  const body = h('div', { class: 'lens-l0__body' });
  root.appendChild(body);
  replaceEl(ctx.el, root);

  if (view === 'table') paintProjectsTable(body, projects, palette, ctx);
  else if (view === 'sessions') paintSessionsTable(body, index, range, ctx);
  else if (view === 'inventory') paintInventory(body, index, ctx);
  else paintTimeline(body, { bands, palette, projects, query, range });

  schedulePoll(ctx, () => pollIndex(ctx, index, opts), st.building ? POLL_BUILDING_MS : POLL_SETTLED_MS);
}

function pendingList(pending) {
  const ul = h('ul', { class: 'lens-pending__list' });
  for (const p of pending) {
    const slug = typeof p === 'string' ? null : p.slug;
    const id = typeof p === 'string' ? p : (p.id || p.sessionId || '');
    ul.appendChild(h('li', { class: 'lens-pending__item' },
      slug ? h('a', { href: sessionHref(slug, id) }, `${slug} / ${id}`) : String(id)));
  }
  return ul;
}

/** Distinct recorded turns, honouring the same filters the bands use. A turn
 *  split across two day bands is still one turn. */
export function countTurnBars(turnBars, { range, slugs, cal } = {}) {
  const c = cal || hostCalendar;
  const slugSet = slugs && slugs.length ? new Set(slugs) : null;
  const seen = new Set();
  for (const b of turnBars || []) {
    if (!b || !Number.isFinite(b.at)) continue;
    if (slugSet && !slugSet.has(b.slug)) continue;
    if (range && range.active) {
      // a turn is in range if any of its recorded days is
      const days = splitBarAcrossDays(b, c).map((s) => s.localDate);
      if (!days.some((d) => inRange(d, range))) continue;
    }
    seen.add(`${b.slug}/${b.id}/${b.idx}`);
  }
  return seen.size;
}

/** Turns in range whose recorded days are NOT all inside the range —
 *  the boundary-turn clause of the scope sentence. Pure. */
export function countBoundaryTurns(turnBars, { range, slugs, cal } = {}) {
  if (!range || !range.active) return 0;
  const c = cal || hostCalendar;
  const slugSet = slugs && slugs.length ? new Set(slugs) : null;
  const seen = new Set();
  for (const b of turnBars || []) {
    if (!b || !Number.isFinite(b.at)) continue;
    if (slugSet && !slugSet.has(b.slug)) continue;
    const days = splitBarAcrossDays(b, c).map((s) => s.localDate);
    const inside = days.filter((d) => inRange(d, range)).length;
    if (inside > 0 && inside < days.length) seen.add(`${b.slug}/${b.id}/${b.idx}`);
  }
  return seen.size;
}

function sumField(cards, key) {
  let t = null;
  for (const c of cards || []) if (Number.isFinite(c[key])) t = (t || 0) + c[key];
  return t;
}
function spanOf(bars) {
  let lo = null, hi = null;
  for (const b of bars || []) {
    if (Number.isFinite(b.at)) lo = lo === null ? b.at : Math.min(lo, b.at);
    const e = Number.isFinite(b.endedAt) ? b.endedAt : b.at;
    if (Number.isFinite(e)) hi = hi === null ? e : Math.max(hi, e);
  }
  return lo === null || hi === null ? null : hi - lo;
}
function maxAt(bars) {
  let hi = null;
  for (const b of bars || []) if (Number.isFinite(b.at)) hi = hi === null ? b.at : Math.max(hi, b.at);
  return hi;
}

async function pollIndex(ctx, prev, opts) {
  if (ctx.stale) return;
  const st = indexStatus(prev);
  let next;
  // Thread `boot` with `since`: the server's 204 unchanged path requires
  // the {boot, version} PAIR, so a restarted server with a
  // coincidentally-equal version never serves a stale 204.
  try { next = await api('/api/index', { since: prev.version, boot: prev.boot }, { signal: ctx.signal }); }
  catch { schedulePoll(ctx, () => pollIndex(ctx, prev, opts), POLL_SETTLED_MS); return; }
  if (ctx.stale) return;
  const unchanged = next === null || pendingOf(next) || next.version === undefined
    || (next.version === prev.version && next.boot === prev.boot);
  if (unchanged) { schedulePoll(ctx, () => pollIndex(ctx, prev, opts), st.building ? POLL_BUILDING_MS : POLL_SETTLED_MS); return; }
  if (st.building) {
    paintStore(ctx, next, opts);                        // still building: the numbers fill in
  } else {
    // DESIGN §7: never re-render under the reader once the index is settled.
    // The version bumps on every liveness rescan, so only a real change to a
    // session's recorded bytes is worth interrupting the reader for.
    const changed = countChanged(prev.sessions, next.sessions);
    if (changed > 0) {
      // The reload offer belongs to THIS render — a stale ctx must
      // not paint an old snapshot over whatever page the reader is on now.
      showReloadBar(`${fmtInt(changed)} session${changed === 1 ? '' : 's'} changed on disk`, () => {
        if (ctx.stale) return;
        paintStore(ctx, next, opts);
      });
    }
    schedulePoll(ctx, () => pollIndex(ctx, next, opts), POLL_SETTLED_MS);
  }
}
function countChanged(prev, next) {
  const before = new Map((prev || []).map((c) => [`${c.slug}/${c.id}`, c.fingerprint]));
  let n = 0;
  for (const c of next || []) if (before.get(`${c.slug}/${c.id}`) !== c.fingerprint) n++;
  return n;
}

/* ---- L0 default: the day-band timeline --------------------------------- */

function paintTimeline(body, { bands, palette, projects, query, range }) {
  body.appendChild(legend(projects, palette, query, parseSlugFilter(query)));

  const day = query.get('day');
  if (day && isDateKey(day)) { paintDayExpanded(body, { bands, palette, query, day }); return; }

  if (!bands.length) {
    body.appendChild(h('p', { class: 'lens-empty', text: range.active ? 'No turns are recorded in this date range.' : 'No turns are recorded in the store.' }));
    return;
  }
  const list = h('div', { class: 'lens-bands' });
  const runs = bandRuns(withSeparators(bands));
  // One page, ONE gutter scale — a per-run max would invite cross-run
  // bar comparison at silently different scales.
  let pageMaxTurns = null;
  for (const b of bands) {
    const t = b.gutter && b.gutter.turnCount;
    if (Number.isFinite(t)) pageMaxTurns = Math.max(pageMaxTurns ?? 0, t);
  }
  // The ≤MARK_CAP mark budget is per VIEW (DESIGN §2) — split it across this
  // page's timeline mounts instead of granting each mount the full cap.
  const runCount = Math.max(1, runs.filter((r) => r.kind === 'run').length);
  const capPerRun = Math.max(MIN_BINS_PER_RUN, Math.floor(MARK_CAP / runCount));
  for (const run of runs) {
    if (run.kind === 'gap') { list.appendChild(gapRow(run)); continue; }
    if (run.kind === 'month') { list.appendChild(monthRow(run)); continue; }
    list.appendChild(runBlock(run, { palette, query, maxTurns: pageMaxTurns, binsCap: capPerRun }));
  }
  body.appendChild(list);
}

/** DESIGN §2: the ⓘ popover carries SPEC §4's bounds ledger, per view. */
function boundsLedger() {
  return h('div', { class: 'lens-ledger' },
    h('h4', { class: 'lens-ledger__h', text: 'how these bars are bounded (SPEC §4)' }),
    h('ul', { class: 'lens-ledger__list' },
      h('li', { text: 'Turn bar: starts at the opener event’s timestamp; ends at the max timestamp over the turn’s conversation rows only — assistant and user rows, excluding queue-operation, system, attachment and isMeta rows.' }),
      h('li', { text: 'A turn crossing local midnight is split between day bands by its rows’ recorded timestamps, never counted twice.' }),
      h('li', { text: 'Each band is one local calendar day and all bands share one 24-hour axis, so every bar sits at its recorded time of day; the mark’s tooltip carries its full recorded date and time.' }),
      h('li', { text: 'Band gutter figures are the server’s dayBands, bucketed by the host’s local calendar day; nothing in the gutter is re-derived in the browser.' }),
      h('li', { text: 'A bar with only one recorded timestamp renders as a tick — no width is invented.' })));
}

function legend(projects, palette, query, slugs) {
  const on = new Set(slugs);
  const wrap = h('div', { class: 'lens-legend' });
  for (const p of projects) {
    if (p.memoryOnly) continue;
    const c = palette.get(p.slug) || {};
    const next = on.has(p.slug) ? slugs.filter((s) => s !== p.slug) : [...slugs, p.slug];
    wrap.appendChild(h('a', {
      class: 'lens-legend__chip' + (on.has(p.slug) ? ' lens-legend__chip--on' : '') + (c.overflow ? ' lens-legend__chip--overflow' : ''),
      href: withQuery('#/', query, { p: next.join(',') || null }),
      // The affordance always prints; a label reason is APPENDED, never
      // a replacement for the turns count and the click hint.
      title: `${p.turns === null ? 'an unrecorded number of' : fmtInt(p.turns)} turns · click to filter the bars`
        + (p.labelReason ? ` · ${p.labelReason}` : ''),
    }, h('span', { class: 'lens-legend__swatch', style: `background:${c.color || PROJECT_OVERFLOW}` }), p.label));
  }
  if (slugs.length) wrap.appendChild(h('a', { class: 'lens-legend__clear', href: withQuery('#/', query, { p: null }) }, 'clear filter'));
  return wrap;
}

function gapRow(run) {
  return h('div', { class: 'lens-sep lens-sep--gap', title: `no turns are recorded between ${run.older} and ${run.newer}` },
    h('span', { class: 'lens-sep__label', text: run.label }));
}

function monthRow(run) {
  const s = run.subtotal;
  const row = h('div', { class: 'lens-sep lens-sep--month' },
    h('span', { class: 'lens-sep__label', text: run.label }),
    h('span', {
      class: 'lens-sep__stat',
      // The figure IS turn-days (a turn is counted in every local day it
      // touches), so the cell says so — the tooltip carries the arithmetic.
      title: 'the sum of this month’s recorded day-band turn counts; a turn that spans local midnight is counted in every day it touches, so this can exceed the number of distinct turns',
    }, 'turn-days ', val(fmtInt(s.turnCount), 'no day bands are recorded in this month')),
    h('span', { class: 'lens-sep__stat' }, ...tokenCells(s.tokens, 'no usage is recorded in this month')),
    h('span', { class: 'lens-sep__stat' }, usdCell(s.usd, 'no cost is recorded in this month')));
  if (s.partialDays) {
    row.appendChild(h('span', {
      class: 'lens-sep__note',
      title: 'those days have turn bars but no server day-band entry, so they add nothing to this subtotal',
      text: `excludes ${s.partialDays} day${s.partialDays === 1 ? '' : 's'} with no recorded day band`,
    }));
  }
  return row;
}

/** One timeline per contiguous run: lanes are days sharing one 24-hour axis.
 *  `maxTurns` is the PAGE-wide gutter max and `binsCap` the page-split
 *  mark budget — both supplied by paintTimeline, never re-derived. */
function runBlock(run, { palette, query, maxTurns = null, binsCap = MARK_CAP }) {
  const host = h('div', { class: 'lens-bands__run' });
  const axisFrom = hostCalendar.dayStartMs(run.bands[0].localDate);
  const lanes = [], marks = [];
  for (const band of run.bands) {
    const dayStart = hostCalendar.dayStartMs(band.localDate);
    const g = band.gutter;
    lanes.push({
      id: band.localDate,
      label: dayLabel(band.localDate),
      href: withQuery('#/', query, { day: band.localDate }),
      sublabel: bandSublabel(band),
      gutter: { value: g.turnCount, label: 'turns' },
      class: g.recorded ? null : 'lens-timeline__lane--unrecorded',
    });
    for (const seg of band.segments) {
      const b = seg.bar;
      const c = palette.get(b.slug) || {};
      marks.push({
        lane: band.localDate,
        at: projectToAxis(seg.startMs, dayStart, axisFrom),
        end: seg.endMs === null ? null : projectToAxis(seg.endMs, dayStart, axisFrom),
        color: c.color || PROJECT_OVERFLOW,
        href: turnHref(b.slug, b.id, b.idx),
        title: `${b.slug} · turn ${b.idx} · ${fmtStamp(seg.startMs)}`
          + (seg.endMs === null ? ' (one timestamp recorded — drawn as a tick)' : ` → ${fmtClock(seg.endMs)}`)
          + (seg.clippedStart || seg.clippedEnd ? ' · split at local midnight' : ''),
      });
    }
  }
  try {
    track(timeline(host, {
      lanes, marks,
      axis: { from: axisFrom, to: axisFrom + MS_DAY },
      gutter: { max: maxTurns, label: 'turns' },
      binsCap, info: boundsLedger,
      onMark: (m, ev) => { if (m.href) { ev.preventDefault(); navigate(m.href); } },
    }));
  } catch (e) {
    // The bands still render with their recorded gutters if the component fails,
    // so no recorded figure disappears behind a missing dependency.
    host.appendChild(h('div', { class: 'lens-card lens-card--error', text: `timeline component unavailable: ${e && e.message}` }));
    for (const band of run.bands) host.appendChild(fallbackBandRow(band, query));
  }
  return host;
}

function bandSublabel(band) {
  const g = band.gutter;
  if (!g.recorded) return '— no day band recorded';
  const t = tokens4(g.tokens);
  const cost = fmtUsd(g.usd);
  const toks = t ? `${fmtInt(t.input)} · ${fmtInt(t.output)} · ${fmtInt(t.cacheWrite)} · ${fmtInt(t.cacheRead)}` : '—';
  const sess = Array.isArray(g.sessionsTouched) ? g.sessionsTouched.length : (Number.isFinite(g.sessionsTouched) ? g.sessionsTouched : null);
  return `${cost === null ? '—' : cost} · ${toks}${sess === null ? '' : ` · ${fmtInt(sess)} sessions`}`;
}

function fallbackBandRow(band, query) {
  return h('div', { class: 'lens-band' },
    h('a', { class: 'lens-band__date', href: withQuery('#/', query, { day: band.localDate }) }, dayLabel(band.localDate)),
    h('span', { class: 'lens-band__count', text: `${band.segments.length} bar${band.segments.length === 1 ? '' : 's'}` }),
    h('span', { class: 'lens-band__gutter', text: bandSublabel(band) }));
}

/** Click a date → that day expanded: one lane per turn on that day's real axis
 *  (DESIGN §2: no zoom at L0 — a single-day band IS the zoom). */
function paintDayExpanded(body, { bands, palette, query, day }) {
  const band = bands.find((b) => b.localDate === day);
  body.appendChild(h('div', { class: 'lens-dayhead' },
    h('a', { class: 'lens-dayhead__back', href: withQuery('#/', query, { day: null }) }, '↑ all days'),
    h('h2', { class: 'lens-dayhead__title', text: dayLabel(day) }),
    h('span', { class: 'lens-dayhead__stats', text: band ? bandSublabel(band) : '' })));
  if (!band) { body.appendChild(h('p', { class: 'lens-empty', text: `No turns are recorded on ${day}.` })); return; }

  const dayStart = hostCalendar.dayStartMs(day);
  const lanes = [], marks = [];
  band.segments.forEach((seg, i) => {
    const b = seg.bar;
    const c = palette.get(b.slug) || {};
    const id = `${b.id}/${b.idx}#${i}`;
    // No fake gutter — a session id is a label, not a magnitude, so it
    // rides the sublabel; the gutter renders only recorded values on a scale.
    lanes.push({
      id, label: `turn ${b.idx}`, sublabel: `${b.slug} · ${b.id.slice(0, 8)}`, href: turnHref(b.slug, b.id, b.idx),
    });
    marks.push({
      lane: id, at: seg.startMs, end: seg.endMs,
      color: c.color || PROJECT_OVERFLOW, href: turnHref(b.slug, b.id, b.idx),
      title: `${b.slug} · turn ${b.idx} · ${fmtStamp(seg.startMs)}${seg.endMs === null ? ' (one timestamp recorded)' : ` → ${fmtClock(seg.endMs)}`}`,
    });
  });
  const host = h('div', { class: 'lens-day' });
  body.appendChild(host);
  try {
    track(timeline(host, {
      lanes, marks, axis: { from: dayStart, to: dayStart + MS_DAY },
      binsCap: MARK_CAP, info: boundsLedger,
      onMark: (m, ev) => { if (m.href) { ev.preventDefault(); navigate(m.href); } },
    }));
  } catch {
    for (const seg of band.segments) {
      host.appendChild(h('div', { class: 'lens-day__row' },
        h('a', { href: turnHref(seg.bar.slug, seg.bar.id, seg.bar.idx) }, `turn ${seg.bar.idx}`),
        h('span', { class: 'lens-day__slug', text: seg.bar.slug }),
        h('span', { class: 'lens-day__t', text: `${fmtClock(seg.startMs)}${seg.endMs ? '–' + fmtClock(seg.endMs) : ''}` })));
    }
  }
}

/* ---- L0 ?v=table : projects --------------------------------------------- */

function paintProjectsTable(body, projects, palette, ctx) {
  const columns = [
    col('label', 'project', {
      render: (v, row) => h('span', { class: 'lens-projcell', title: row.labelReason || '' },
        h('span', { class: 'lens-projcell__swatch', style: `background:${row.swatch || PROJECT_OVERFLOW}` }),
        h('a', { class: 'lens-projcell__name', href: row._href }, row.label),
        row.memoryOnly
          ? h('span', { class: 'lens-tag', title: 'this project dir holds memory files only — there is no transcript, so there are no statistics to show' },
            `memory only${row.memoryFiles != null ? ` · ${row.memoryFiles} file${row.memoryFiles === 1 ? '' : 's'}` : ''}`)
          : null),
    }),
    col('sessions', 'sessions', { type: 'num', sum: true }),
    col('turns', 'turns', { type: 'num', sum: true, reason: 'no turns are recorded for this project' }),
    col('agents', 'agents', { type: 'num', sum: true, reason: 'no agents are recorded for this project' }),
    col('workflows', 'workflows', { type: 'num', sum: true, reason: 'no workflow runs are recorded for this project' }),
    col('firstAt', 'first activity', { type: 'time', reason: 'no session in this project records a start timestamp' }),
    col('lastAt', 'last activity', { type: 'time', reason: 'no session in this project records an end timestamp' }),
    col('bytes', 'bytes', { type: 'bytes', sum: true, reason: 'no byte total is recorded' }),
    ...tokenCols(),
    col('usd', 'cost', { type: 'money', sum: true, reason: (row) => row.usdReason || NO_AGG_REASON }),
    col('badges', 'badges', { render: (v) => badgeRow(v), sortable: false, filterable: false }),
  ];
  const rows = projects.map((p) => {
    const c = palette.get(p.slug) || {};
    return {
      _href: projectHref(p.slug), swatch: c.color,
      label: p.label, labelReason: p.labelReason,
      sessions: p.sessions, turns: p.turns, agents: p.agents, workflows: p.workflows,
      firstAt: p.firstAt, lastAt: p.lastAt, bytes: p.bytes,
      ...tokenValues(p.tokens),
      usd: p.usd, usdReason: p.usdReason,
      badges: p.badges, memoryOnly: p.memoryOnly, memoryFiles: p.memoryFiles,
    };
  });
  const el = h('div', { class: 'lens-table lens-table--projects' });
  body.appendChild(el);
  const memoryOnly = rows.filter((r) => r.memoryOnly).length;
  mountTable(el, {
    columns, rows, sort: [{ key: 'lastAt', dir: 'desc' }], footerSums: true,
    navHref: (row) => row._href,
    // Memory-only dirs carry designed-null stats; summing them would
    // poison every column to —. The Σ footer covers transcript-bearing rows
    // and names what it excludes.
    footerFilter: (row) => !row.memoryOnly,
    footerNote: memoryOnly
      ? `excludes ${fmtInt(memoryOnly)} memory-only dir${memoryOnly === 1 ? '' : 's'} (no transcript — nothing to sum)`
      : null,
    caption: 'Every project dir under the projects folder, including dirs that hold only memory files: those keep their raw slug and show — for every statistic, because no transcript exists to count.',
    emptyLabel: 'no project dirs found under the projects folder',
  });
  ctx.registerRows(el);
}

/* ---- L0 ?v=sessions : the whole store, one row per session -------------- */

function paintSessionsTable(body, index, range, ctx) {
  const rows = sessionRowsFromIndex(index, { range });
  const el = h('div', { class: 'lens-table lens-table--sessions' });
  body.appendChild(el);
  mountTable(el, sessionsTableProps(rows, { showProject: true }));
  ctx.registerRows(el);
}

/** Shared by L0 ?v=sessions and L1's default table (DESIGN §3). */
export function sessionsTableProps(rows, { showProject } = {}) {
  const columns = [
    col('startedAt', 'started', { type: 'time', reason: 'no start timestamp is recorded on this session' }),
    showProject ? col('slug', 'project', { href: (row) => projectHref(row.slug) }) : null,
    col('title', 'title', { href: (row) => row._href, title: 'custom-title ▸ ai-title ▸ sessionId' }),
    col('turns', 'turns', { type: 'num', sum: true, reason: 'no turn count is recorded' }),
    col('agents', 'agents', { type: 'num', sum: true, reason: 'no agent count is recorded' }),
    col('workflows', 'workflows', { type: 'num', sum: true, reason: 'no workflow count is recorded' }),
    col('span', 'span', { type: 'duration', reason: 'start and end are not both recorded' }),
    ...tokenCols(),
    col('usd', 'cost', { type: 'money', sum: true, reason: (row) => row.usdReason || NO_AGG_REASON }),
    col('bytes', 'bytes', { type: 'bytes', sum: true, reason: 'no byte total is recorded' }),
    col('badges', 'badges', { render: (v) => badgeRow(v), sortable: false, filterable: false }),
  ].filter(Boolean);
  const trows = rows.map((r) => ({
    _href: sessionHref(r.slug, r.id),
    startedAt: r.startedAt, slug: r.slug, title: r.title || r.id, titleSource: r.titleSource,
    turns: r.turns, agents: r.agents, workflows: r.workflows, span: r.span,
    ...tokenValues(r.tokens),
    usd: r.usd, usdReason: r.usdReason, bytes: r.bytes, badges: r.badges,
  }));
  return {
    columns, rows: trows, sort: [{ key: 'startedAt', dir: 'desc' }], footerSums: true,
    navHref: (row) => row._href,
    caption: 'Cost is the server’s CostAgg for that session; where a card carries none the cell says so rather than estimate one.',
    emptyLabel: 'no sessions match',
  };
}

/* ---- L0 ?v=inventory : the corpus ledger -------------------------------- */

function paintInventory(body, index, ctx) {
  const inv = buildInventory(index);
  const grid = h('div', { class: 'lens-inv' });

  grid.appendChild(invBlock('files', [
    ['found', fmtInt(inv.files.found), inv.files.reason],
    ['classified', fmtInt(inv.files.classified), inv.files.reason],
    ['unclassified', fmtInt(inv.files.unclassified), 'no unclassified-file problems are recorded'],
    ['in session trees', fmtInt(inv.files.sessionFiles), 'file counts are not recorded on the session cards'],
    ['project-level (memory)', fmtInt(inv.files.projectFiles), 'project file lists are not recorded on /api/index'],
  ]));

  grid.appendChild(invBlock('bytes', [
    ['accounted', fmtBytes(inv.bytes.accounted), inv.bytes.reason],
    ['in session trees', fmtBytes(inv.bytes.sessionBytes), inv.bytes.reason],
    ['in project-level files', fmtBytes(inv.bytes.projectBytes), 'memory-file byte sizes are not recorded on /api/index'],
    ['scanned', fmtBytes(inv.bytes.ofBytes), 'the indexer has not reported a byte total'],
  ]));

  const cacheBlock = invBlock('cache', inv.cache ? [
    ['entries', fmtInt(inv.cache.entries), 'not recorded'],
    ['index version', inv.cache.version === null ? null : String(inv.cache.version), 'not recorded'],
    ['written', fmtStamp(inv.cache.writtenAt), 'not recorded'],
    ['size', fmtBytes(inv.cache.bytes), 'not recorded'],
    ['dir', inv.cache.dir, 'not recorded'],
  ] : [['cache state', null, inv.cacheReason]]);
  cacheBlock.appendChild(h('button', {
    class: 'lens-btn', type: 'button',
    onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 're-indexing…';
      try {
        await api('/api/reindex', null, { method: 'POST' });
        b.textContent = 're-index started';
        schedulePoll(ctx, () => renderStore(ctx), 800);
      } catch (err) { b.disabled = false; b.textContent = `re-index failed: ${(err && err.message) || err}`; }
    },
  }, 're-index (ignores fingerprints)'));
  grid.appendChild(cacheBlock);

  grid.appendChild(invBlock('expected-zero censuses',
    inv.censuses.map((c) => [c.label, c.value === null ? null : String(c.value), c.reason]),
    (rowEl, i) => {
      const c = inv.censuses[i];
      if (c.value === null) return;
      rowEl.appendChild(c.value === c.expected
        ? h('span', { class: 'lens-inv__ok', title: `expected ${c.expected}, recorded ${c.value}`, text: '✓' })
        : h('span', { class: 'lens-inv__bad', title: `expected ${c.expected}, recorded ${c.value}`, text: '⚠' }));
    }));

  const fragBlock = h('section', { class: 'lens-inv__block' }, h('h3', { class: 'lens-inv__h', text: `fragments (${inv.fragments.length})` }));
  for (const f of inv.fragments) {
    fragBlock.appendChild(h('div', { class: 'lens-inv__row' },
      h('a', { href: sessionHref(f.slug, f.id) }, `${f.slug} / ${f.id}`),
      f.otherSessionIds && f.otherSessionIds.length
        ? h('span', { class: 'lens-inv__note', text: `also present in ${f.otherSessionIds.length} other project dir(s)` }) : null));
  }
  if (!inv.fragments.length) fragBlock.appendChild(h('div', { class: 'lens-inv__row', text: '0' }));
  grid.appendChild(fragBlock);

  const dupBlock = h('section', { class: 'lens-inv__block' }, h('h3', { class: 'lens-inv__h', text: `duplicate-id sessions (${inv.duplicateIds.length})` }));
  for (const d of inv.duplicateIds) dupBlock.appendChild(h('div', { class: 'lens-inv__row', text: `${d.id} — ${d.slugs.join(', ')}` }));
  if (!inv.duplicateIds.length) dupBlock.appendChild(h('div', { class: 'lens-inv__row', text: '0' }));
  grid.appendChild(dupBlock);

  body.appendChild(grid);

  // Problems drawer — `affects` drives the "impacts totals?" column.
  const total = inv.problems.reduce((n, p) => n + p.count, 0);
  const drawer = h('details', { class: 'lens-problems', open: inv.problems.some((p) => p.severity === 'error') || null },
    h('summary', {}, `problems — ${fmtInt(inv.problems.length)} kind${inv.problems.length === 1 ? '' : 's'}, ${fmtInt(total)} record${total === 1 ? '' : 's'}`));
  // DESIGN §4 "one behaviour" — the problems drawer is a vtable like
  // every other table, not a hand-rolled one-off without sort or filter.
  const tableEl = h('div', { class: 'lens-problems__table' });
  mountTable(tableEl, {
    columns: [
      col('code', 'code', { type: 'code' }),
      col('severity', 'severity'),
      col('scope', 'scope', { reason: 'the record does not name a scope' }),
      col('count', 'count', { type: 'num', sum: true }),
      col('affects', 'impacts totals?', {
        reason: 'the record does not say what it affects',
        render: (v) => h('span', { class: `lens-affects lens-affects--${v}` },
          v === 'aggregates' ? 'yes — aggregates' : v === 'display' ? 'display only' : 'no'),
      }),
      col('message', 'message', { sortable: false }),
      // A linked `where`, mirroring the session drawer's own column
      // (views/inv.mjs) — but ONLY when the row names exactly one source. This
      // census collapses by code|scope ACROSS sessions, so a row with three
      // contributors has no single session to point at; linking the first one
      // would be an inference, which is the one thing this app does not do.
      col('where', 'where', {
        sortable: false,
        reason: 'these records do not name a session or a file',
        render: (_v, row) => whereCell(row),
      }),
    ],
    rows: inv.problems.map((p) => ({
      code: p.code, severity: p.severity, scope: p.scope, count: p.count,
      affects: p.affects, message: p.message,
      where: p.sourceCount ? p.sourceCount : null,
      sources: p.sources ?? [], sourceCount: p.sourceCount ?? 0,
    })),
    sort: [{ key: 'severity', dir: 'asc' }],
    footerSums: true,
    emptyLabel: 'none recorded',
  });
  drawer.appendChild(tableEl);
  body.appendChild(drawer);
  body.appendChild(h('p', { class: 'lens-note', text: 'Every figure here is a recorded count. Where /api/index carries no census for one, the cell reads — with the reason rather than a zero the corpus never proved.' }));
}

function invBlock(title, rows, decorate) {
  const sec = h('section', { class: 'lens-inv__block' }, h('h3', { class: 'lens-inv__h', text: title }));
  rows.forEach(([label, text, reason], i) => {
    const r = h('div', { class: 'lens-inv__row' },
      h('span', { class: 'lens-inv__label', text: label }),
      h('span', { class: 'lens-inv__value' }, val(text, reason)));
    if (decorate) decorate(r, i);
    sec.appendChild(r);
  });
  return sec;
}

/* ---- route registration ------------------------------------------------- */

// ONE registration path — router.loadViewModules calls register(defineRoute)
// and the injected argument is honoured; no import-time self-registration.
export function register(defineRoute = importedDefineRoute) { defineRoute('/', renderStore); }

export { renderStore };
