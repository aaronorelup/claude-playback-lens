// server/api/bands.mjs — day-band math: local-day labels with numeric sort
// keys, the band accumulator, the per-day turn walk, and the row/ledgerLite
// band contributions. All local-time, all clock-skew-tolerant.

import { problem } from '../errors.mjs';
import { DAY_WALK_CAP } from '../limits.mjs';
import { isAgentFile, priceRowTcu, bucketTcu } from './costs.mjs';

export function localDateOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The 'YYYY-MM-DD' key is a LABEL and a LOOKUP KEY. It is not an ordering:
// the year is not zero-padded (nor could it usefully be — '10000-01-01'
// still sorts below '9999-12-31' padded, and a negative year pads to garbage),
// so a clock-skew timestamp from year 99 or year 50000 makes string comparison
// disagree with the calendar. Every band therefore carries a NUMERIC key derived
// from the same recorded day, and every ordering and loop termination below runs
// on that number.
//
// dateOfDay rebuilds a Date from the label without JS's legacy two-digit-year
// remap: `new Date(99, 5, 15)` is 1999, but setFullYear(99) is year 99.
// lastIndexOf keeps a leading '-' (a BC year) attached to the year component.
export function dateOfDay(day, hour = 12) {
  const s = String(day);
  const i = s.lastIndexOf('-');
  const j = s.lastIndexOf('-', i - 1);
  const y = Number(s.slice(0, j));
  const m = Number(s.slice(j + 1, i));
  const dd = Number(s.slice(i + 1));
  const d = new Date(2000, (m || 1) - 1, dd || 1, hour); // safe pivot year
  d.setFullYear(y);
  return d;
}

// Local start-of-day ms of a 'YYYY-MM-DD' label. Built off a NOON anchor so a
// DST transition at local midnight cannot move it into the neighbouring day;
// setHours then normalises a midnight that does not exist to the day's real
// first instant. Monotone in the calendar day, which is all the sort needs.
export function dayStartMsOf(day) {
  const d = dateOfDay(day, 12);
  d.setHours(0, 0, 0, 0);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null; // unknown, never a fabricated 0
}

// The band accumulator. Exported (with finishBands) on the public api.mjs
// seam — the accumulator and the day walk are the two halves of the
// clock-skew handling and are pinned directly by tests.
export function makeBands() {
  const bands = new Map(); // localDate -> band
  const get = (day) => {
    let b = bands.get(day);
    if (!b) {
      bands.set(day, b = {
        localDate: day,
        startMs: dayStartMsOf(day), // numeric sort key (SPEC §9 dayBands)
        turnCount: 0,
        tokens: { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 },
        usd: 0, sessionsTouched: new Set(),
      });
    }
    return b;
  };
  return { bands, get };
}

export function bandAddTokens(b, t) {
  b.tokens.input += t.input || 0; b.tokens.output += t.output || 0;
  b.tokens.cache5m += t.cache5m || 0; b.tokens.cache1h += t.cache1h || 0;
  b.tokens.cacheFlat += t.cacheFlat || 0; b.tokens.cacheRead += t.cacheRead || 0;
}

// Local NOON of a ms instant. NOON-anchored day stepping cannot skip or repeat
// a day even in timezones whose DST transition lands at local midnight (a fixed
// 24 h step can jump over a 23 h local day; a midnight anchor can land twice on
// a 25 h one).
function noonMsOf(ms) {
  const d = new Date(ms);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

// A recorded span is walked in MILLISECONDS, never by reconstructing and
// string-comparing day labels. One turn bar cannot legitimately span
// DAY_WALK_CAP days; a span that does is a recorded clock-skew artefact, and
// the walk stops and SAYS SO rather than blocking the event loop for minutes.
export function finishBands(acc, turnBars, problems = null) {
  let cappedBars = 0;
  for (const bar of turnBars) {
    if (bar.at == null) continue;
    const a = bar.at;
    if (!Number.isFinite(a)) {
      // A bar whose start is not an instant has no span to walk. It still
      // counts in whatever band its own label produced, if one exists — the
      // walk is what is undefined here, not the bar.
      const nb = acc.bands.get(localDateOf(a));
      if (nb) nb.turnCount += 1;
      continue;
    }
    const z = Number.isFinite(bar.endedAt) && bar.endedAt >= a ? bar.endedAt : a;
    // count the turn ONCE in every distinct local calendar day its bar
    // touches (SPEC §9: Σ over bands >= distinct turns — the surplus is
    // exactly the midnight crossings; the L0 header counts distinct bars).
    // Iterating calendar days — not 24 h steps — is what makes same-day bars
    // count once and DST transitions exact.
    const endNoon = noonMsOf(z);
    const cursor = new Date(noonMsOf(a));
    let steps = 0;
    for (;;) {
      const b = acc.bands.get(localDateOf(cursor.getTime()));
      if (b) b.turnCount += 1;
      if (cursor.getTime() >= endNoon) break;
      if (++steps > DAY_WALK_CAP) { cappedBars += 1; break; }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  if (cappedBars > 0 && problems) {
    problems.push(problem('day-span-capped', {
      severity: 'warning', scope: 'store',
      message: `${cappedBars} turn bar(s) span more than ${DAY_WALK_CAP} local calendar days between their recorded start and end; the per-day turn walk stopped at the cap, so those bars are counted in fewer day bands than their recorded span touches.`,
      affects: 'aggregates', count: cappedBars,
    }));
  }
  return [...acc.bands.values()]
    // numeric, newest first — never the label. A band whose label cannot be
    // resolved to an instant has an UNKNOWN position and sorts last, the same
    // rule every table in this app applies to an unknown sort key.
    .sort((x, y) => {
      if (x.startMs === y.startMs) return 0;
      if (x.startMs === null) return 1;
      if (y.startMs === null) return -1;
      return y.startMs - x.startMs;
    })
    .map((b) => ({ ...b, sessionsTouched: b.sessionsTouched.size }));
}

// billed rows of one session -> band contributions (server host's LOCAL day of
// each row's `at`, SPEC §9; a turn crossing midnight splits by its rows).
export function bandsFromRows(ctx, acc, sessionKey, sessionId, rows, canonicalOf) {
  for (const row of rows) {
    if (row.synthetic || row.at == null) continue;
    if (row.embeddedSidechain === true) continue; // §3: disclosed channel, not band money
    const contestable = !isAgentFile(row.file ?? '');
    const canon = contestable && canonicalOf ? canonicalOf.get(row.msgId) : undefined;
    if (canon !== undefined && canon !== sessionId) continue; // R2: billed elsewhere
    if (row.billedElsewhere) continue;
    const b = acc.get(localDateOf(row.at));
    bandAddTokens(b, row);
    b.usd += priceRowTcu(ctx, row);
    b.sessionsTouched.add(sessionKey);
  }
}

// ledgerLite -> band contributions without a session parse: dupRows are real
// rows (local day computed here from their recorded `at`); buckets carry the
// localDate they were tallied under at index time (summary.mjs, same host).
export function bandsFromLite(ctx, acc, sessionKey, sessionId, lite, canonicalOf) {
  bandsFromRows(ctx, acc, sessionKey, sessionId, lite.dupRows ?? [], canonicalOf);
  for (const bk of lite.buckets ?? []) {
    if (!bk || bk.synthetic || bk.localDate == null) continue;
    const b = acc.get(bk.localDate);
    bandAddTokens(b, bk.tokens ?? {});
    b.usd += bucketTcu(ctx, bk);
    b.sessionsTouched.add(sessionKey);
  }
}
