// web/js/lib/fmt.mjs — the drill views' null-preserving value readers and
// format wrappers. Values are formatted by format.mjs so every altitude prints
// alike; these wrappers differ in ONE way, deliberately: they return `null`
// for an unknown instead of the bare '—', so the caller must supply the reason
// that goes with it (house rule 3). Never let a missing value reach a
// formatter as 0.

import {
  formatInt, formatBytes, formatDuration, formatLocalTime, formatClock,
  tzLabel as formatTz, truncate as formatTruncate, unknownNode,
} from '../format.mjs';

/** A recorded number, or null. Number(null) and Number('') are both 0 — never use them here. */
export function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Recorded timestamps arrive as ms-epoch numbers or ISO-8601 strings. */
export function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

export function fmtInt(n) { const v = num(n); return v === null ? null : formatInt(v); }
export function fmtBytes(n) { const v = num(n); return v === null ? null : formatBytes(v); }
export function fmtDur(ms) { const v = num(ms); return v === null ? null : formatDuration(v); }

export function fmtLocalTime(at, { date = true, ms = false } = {}) {
  const v = num(at);
  if (v === null) return null;
  let out = date ? formatLocalTime(v) : formatClock(v);
  // `ms: true` appends real sub-second precision — never a silent no-op.
  if (ms) out += `.${String(((v % 1000) + 1000) % 1000).padStart(3, '0')}`;
  return out;
}

/** `(UTC−7)`, printed once per view (DESIGN §2). Parentheses included. */
export function tzLabel(at = Date.now()) { return formatTz(at); }

export function truncate(str, n = 220) {
  if (str === null || str === undefined) return '';
  return formatTruncate(String(str), n);
}

/**
 * The statbar's span cell wants { ms, from, to, label, reason } — a span needs
 * TWO recorded timestamps, and says which one is missing when it cannot have one.
 */
export function spanProps(from, to, label = 'span') {
  const a0 = num(from), b0 = num(to);
  if (a0 === null && b0 === null) return { label, ms: null, reason: 'no timestamp recorded for this scope' };
  if (a0 === null || b0 === null) return { label, ms: null, reason: 'only one timestamp recorded — a span needs two' };
  return { label, ms: b0 - a0, from: a0, to: b0 };
}

/** In-body span cell (a DOM node rather than statbar props). */
export function spanCell(from, to) {
  const p = spanProps(from, to);
  return p.ms === null ? unknownNode(p.reason) : document.createTextNode(formatDuration(p.ms));
}

export function shortId(id, n = 8) {
  if (!id) return '';
  const str = String(id);
  return str.length <= n ? str : str.slice(0, n);
}
