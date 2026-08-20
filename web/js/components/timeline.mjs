// web/js/components/timeline.mjs — DESIGN §2, one timeline grammar.
//
// FOUR PRIMITIVES ONLY:
//   span  two recorded timestamps          (a rect between them)
//   tick  one recorded timestamp           (1px — no invented width, ever)
//   lane  a row of marks with a label and a right stat gutter
//   bin   an outlined block labelled with an EXACT count
//
// Rules this component enforces so views cannot break them:
//   * SVG only; ≤ 2,500 marks per view, enforced by pixel-column binning
//   * LINEAR axis, no gap compression, local time, `(UTC−7)` labelled once
//   * magnitude is NEVER encoded in geometry — it lives in the right stat
//     gutter, fixed scale, max printed
//   * an in-view empty stretch ≥20% of the width is labelled
//     `no events for 2h 14m`
//   * a mark with end < start renders as a ⚠ tick showing BOTH timestamps
//   * every mark is an <a> to its drill route
//   * brush-to-zoom + shift-pan are EPHEMERAL — never written to the URL
//   * the ⓘ popover is a slot the view fills with the SPEC §4 bounds ledger
//
// The geometry maths below is pure and separately tested.

import {
  h, hs, clear, replace, formatDuration, formatLocalTime, formatClock,
  formatLocalDate, formatInt, tzLabel, isKnown, UNKNOWN,
} from '../format.mjs';

export const MARK_CAP = 2500;
export const LANE_H = 22;
export const LANE_GAP = 4;
export const LABEL_W = 190;
export const GUTTER_W = 132;
export const AXIS_H = 26;
export const EMPTY_MIN_FRACTION = 0.2;

/* ------------------------------------------------------------------ *
 * pure geometry
 * ------------------------------------------------------------------ */

/** end < start is a recorded contradiction, never silently repaired. */
export function isInverted(mark) {
  return isKnown(mark.at) && isKnown(mark.end) && mark.end < mark.at;
}

export function markKind(mark) {
  if (isInverted(mark)) return 'inverted';
  return isKnown(mark.end) && mark.end > mark.at ? 'span' : 'tick';
}

/** Bounds over recorded timestamps only. Returns null when nothing is recorded. */
export function computeBounds(marks, axis) {
  if (axis && isKnown(axis.from) && isKnown(axis.to) && axis.to > axis.from) {
    return { from: axis.from, to: axis.to };
  }
  let lo = Infinity, hi = -Infinity;
  for (const m of marks || []) {
    if (isKnown(m.at)) { if (m.at < lo) lo = m.at; if (m.at > hi) hi = m.at; }
    if (isKnown(m.end)) { if (m.end < lo) lo = m.end; if (m.end > hi) hi = m.end; }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (hi === lo) return { from: lo - 30000, to: hi + 30000, degenerate: true };
  return { from: lo, to: hi };
}

/** Linear scale, always. Gap compression is excluded by design (DESIGN §9). */
export function makeScale(from, to, width) {
  const span = Math.max(1, to - from);
  const x = (t) => ((t - from) / span) * width;
  x.invert = (px) => from + (px / Math.max(1, width)) * span;
  x.from = from; x.to = to; x.width = width; x.span = span;
  return x;
}

/**
 * Pixel-column binning (DESIGN §2). Above `cap` marks, marks collapse into
 * per-lane pixel columns carrying an EXACT count. Column width doubles until
 * the bin count fits, so the cap is a hard guarantee.
 * -> { binned, marks, bins, colWidth, dropped:0 }
 */
export function binMarks(marks, { from, to, width, cap = MARK_CAP } = {}) {
  const all = (marks || []).filter((m) => isKnown(m.at));
  if (all.length <= cap) return { binned: false, marks: all, bins: [], colWidth: 1 };
  // An inverted mark (end < start) is a recorded contradiction — its ⚠
  // must survive binning, so inverted marks bypass the bins and stay marks.
  const inverted = all.filter((m) => isInverted(m));
  const list = all.filter((m) => !isInverted(m));
  const x = makeScale(from, to, Math.max(1, width));
  let colWidth = 1;
  let bins = [];
  for (let guard = 0; guard < 24; guard++) {
    const map = new Map();
    for (const m of list) {
      const col = Math.floor(x(m.at) / colWidth);
      const key = `${m.lane || ''}\u0000${col}`;
      let bin = map.get(key);
      if (!bin) {
        bin = { lane: m.lane, col, colWidth, count: 0, from: m.at, to: m.at, href: m.href, kind: 'bin' };
        map.set(key, bin);
      }
      bin.count++;
      if (m.at < bin.from) bin.from = m.at;
      const end = isKnown(m.end) ? m.end : m.at;
      if (end > bin.to) bin.to = end;
      if (!bin.href && m.href) bin.href = m.href;
    }
    bins = [...map.values()];
    if (bins.length <= cap) break;
    colWidth *= 2;
  }
  for (const b of bins) { b.x = b.col * b.colWidth; b.w = b.colWidth; }
  return { binned: true, marks: inverted, bins, colWidth };
}

/**
 * In-view empty stretches ≥ minFraction of the width. Returns the gaps in ms,
 * which the renderer labels `no events for 2h 14m`.
 */
export function emptyStretches(marks, { from, to, minFraction = EMPTY_MIN_FRACTION } = {}) {
  const span = Math.max(1, to - from);
  const points = [];
  for (const m of marks || []) {
    if (!isKnown(m.at)) continue;
    const a = Math.max(from, m.at);
    const b = Math.min(to, isKnown(m.end) && m.end > m.at ? m.end : m.at);
    if (b < from || a > to) continue;
    points.push([a, b]);
  }
  points.sort((p, q) => p[0] - q[0]);
  const gaps = [];
  let cursor = from;
  for (const [a, b] of points) {
    if (a - cursor > span * minFraction) gaps.push({ from: cursor, to: a, ms: a - cursor });
    if (b > cursor) cursor = b;
  }
  if (to - cursor > span * minFraction) gaps.push({ from: cursor, to, ms: to - cursor });
  return gaps;
}

/**
 * Exact ±1 occupancy over recorded intervals — THE one occupancy arithmetic
 * (l2 re-exports it, l3's strip consumes its
 * segments). An interval with one timestamp contributes no width (DESIGN §2:
 * no invented width) and is reported apart. An end at t is processed before a
 * start at t, so back-to-back intervals never double-count the boundary.
 * -> { segments: [{start, end, n}], max, pointOnly }
 */
export function occupancy(intervals) {
  const evs = [];
  let pointOnly = 0;
  for (const iv of intervals || []) {
    const s0 = Number.isFinite(iv && iv.start) ? iv.start : null;   // null must not read as 0
    const e0 = Number.isFinite(iv && iv.end) ? iv.end : null;
    if (s0 === null) continue;
    if (e0 === null || e0 <= s0) { pointOnly++; continue; }
    evs.push({ t: s0, d: 1 });
    evs.push({ t: e0, d: -1 });
  }
  evs.sort((a, b) => a.t - b.t || a.d - b.d);     // an end at t is processed before a start at t
  const segments = [];
  let i = 0, n = 0, prev = null, max = 0;
  while (i < evs.length) {
    const t = evs[i].t;
    if (prev !== null && t > prev) segments.push({ start: prev, end: t, n });
    while (i < evs.length && evs[i].t === t) { n += evs[i].d; i++; }
    if (n > max) max = n;
    prev = t;
  }
  return { segments, max, pointOnly };
}

const TICK_STEPS = [
  1000, 5000, 15000, 30000,
  60000, 5 * 60000, 15 * 60000, 30 * 60000,
  3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000,
  86400000, 2 * 86400000, 7 * 86400000, 14 * 86400000, 28 * 86400000,
];

/** Axis ticks on a linear time scale, at local-time boundaries. */
export function axisTicks(from, to, width, { target = 90 } = {}) {
  const span = Math.max(1, to - from);
  const want = span / Math.max(1, Math.floor(width / target));
  let step = TICK_STEPS[TICK_STEPS.length - 1];
  for (const s of TICK_STEPS) if (s >= want) { step = s; break; }
  const out = [];
  // align to local midnight so day boundaries land exactly
  const base = new Date(from);
  base.setHours(0, 0, 0, 0);
  const dayStep = step >= 86400000;
  if (dayStep) {
    // Day-scale gridlines iterate CALENDAR days (Date arithmetic), not
    // fixed 86,400,000 ms steps — a DST transition day is 23h or 25h long and
    // a fixed step would drift off local midnight for every day after it.
    const days = Math.max(1, Math.round(step / 86400000));
    const d = new Date(base.getTime());
    while (d.getTime() < from) d.setDate(d.getDate() + days);
    while (d.getTime() <= to && out.length < 200) {
      out.push({ at: d.getTime(), label: formatLocalDate(d.getTime()), major: true });
      d.setDate(d.getDate() + days);
    }
    return out;
  }
  let t = base.getTime();
  while (t < from) t += step;
  for (; t <= to && out.length < 200; t += step) {
    out.push({ at: t, label: step >= 3600000 ? formatClock(t, { seconds: false }) : formatClock(t), major: false });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * rendering
 * ------------------------------------------------------------------ */

/**
 * timeline(el, props) -> { update, destroy, setWindow, getWindow, resetWindow }
 *
 * props = {
 *   lanes: [{ id, label, href?, sublabel?, gutter?: { value, label }, class? }],
 *   marks: [{ lane, at, end?, href, label?, title?, color?, kind?, tone? }],
 *   axis:  { from, to },                    // omit to derive from the marks
 *   gutter:{ max, label, format },          // fixed scale, max printed
 *   binsCap: 2500,
 *   zoom: false,                            // brush + shift-pan (L2–L4 only)
 *   info: Node | () => Node,                // ⓘ popover — the bounds ledger
 *   height, width,
 *   onMark(mark, ev),
 *   emptyLabelPrefix: 'no events for',
 * }
 */
export function timeline(el, props) {
  const state = {
    props: props || {},
    window: null,               // ephemeral zoom — never written to the URL
    width: 0,
  };

  const root = h('div', { class: 'lens-timeline' });
  const head = h('div', { class: 'lens-timeline__head' });
  const body = h('div', { class: 'lens-timeline__body' });
  const popover = h('div', { class: 'lens-timeline__info', hidden: true, 'data-lens-layer': 'timeline-info' });
  root.appendChild(head);
  root.appendChild(body);
  root.appendChild(popover);
  el.appendChild(root);

  function lanes() { return state.props.lanes || []; }
  function marks() { return state.props.marks || []; }

  function bounds() {
    if (state.window) return state.window;
    return computeBounds(marks(), state.props.axis);
  }

  function plotWidth() {
    const w = state.props.width || root.clientWidth || 960;
    return Math.max(120, w - LABEL_W - GUTTER_W - 8);
  }

  function drawHead(b) {
    clear(head);
    head.appendChild(h('span', { class: 'lens-timeline__tz', title: 'local time always; the recorded values are UTC' },
      tzLabel(b ? b.from : Date.now())));
    if (b && b.degenerate) {
      // One recorded timestamp is not a 1-minute span — say what the
      // padding is instead of printing invented bounds as if recorded.
      head.appendChild(h('span', { class: 'lens-timeline__range' },
        `one recorded timestamp ${formatLocalTime((b.from + b.to) / 2)} — axis padded ±30s so the mark is visible`));
    } else if (b) {
      head.appendChild(h('span', { class: 'lens-timeline__range' },
        formatLocalTime(b.from), ' → ', formatLocalTime(b.to),
        h('span', { class: 'lens-timeline__range-span' }, ` · ${formatDuration(b.to - b.from)}`)));
    }
    const g = state.props.gutter;
    if (g && isKnown(g.max)) {
      head.appendChild(h('span', { class: 'lens-timeline__gutter-scale' },
        `${g.label || 'gutter'} — fixed scale, max ${(g.format || formatInt)(g.max)}`));
    }
    if (state.window) {
      const reset = h('button', { class: 'lens-btn lens-btn--ghost', type: 'button' }, 'reset zoom');
      reset.addEventListener('click', () => { state.window = null; draw(); });
      head.appendChild(reset);
    }
    if (state.props.info) {
      const btn = h('button', { class: 'lens-timeline__info-btn', type: 'button', 'aria-label': 'How these bars are bounded' }, 'ⓘ');
      btn.addEventListener('click', () => {
        if (!popover.hasAttribute('hidden')) { popover.setAttribute('hidden', ''); return; }
        const content = typeof state.props.info === 'function' ? state.props.info() : state.props.info;
        replace(popover, h('div', { class: 'lens-timeline__info-panel' },
          h('button', { class: 'lens-btn lens-btn--ghost lens-timeline__info-close', type: 'button', onclick: () => popover.setAttribute('hidden', '') }, 'close'),
          content));
        popover.removeAttribute('hidden');
      });
      head.appendChild(btn);
    }
  }

  function draw() {
    const b = bounds();
    drawHead(b);
    clear(body);

    if (!b) {
      body.appendChild(h('p', { class: 'lens-timeline__empty' },
        'No timestamps are recorded for this scope, so there is nothing to place on a time axis.'));
      return;
    }

    const width = plotWidth();
    const laneList = lanes();
    const height = laneList.length * (LANE_H + LANE_GAP) + AXIS_H + 8;
    const svg = hs('svg', {
      class: 'lens-timeline__svg',
      width: String(LABEL_W + width + GUTTER_W),
      height: String(height),
      viewBox: `0 0 ${LABEL_W + width + GUTTER_W} ${height}`,
      role: 'img',
    });

    const x = makeScale(b.from, b.to, width);
    const px = (t) => LABEL_W + x(t);

    // ---- axis (linear, local, labelled once) ---------------------------
    const ticks = axisTicks(b.from, b.to, width);
    const axisG = hs('g', { class: 'lens-timeline__axis' });
    for (const t of ticks) {
      axisG.appendChild(hs('line', {
        class: `lens-timeline__gridline${t.major ? ' lens-timeline__gridline--major' : ''}`,
        x1: String(px(t.at)), x2: String(px(t.at)), y1: '0', y2: String(height - AXIS_H),
      }));
      axisG.appendChild(hs('text', {
        class: 'lens-timeline__axis-label', x: String(px(t.at)), y: String(height - 8), 'text-anchor': 'middle',
      }, t.label));
    }
    svg.appendChild(axisG);

    // ---- empty stretches -------------------------------------------------
    for (const gap of emptyStretches(marks(), { from: b.from, to: b.to })) {
      const mid = (gap.from + gap.to) / 2;
      svg.appendChild(hs('rect', {
        class: 'lens-timeline__gap', x: String(px(gap.from)), y: '0',
        width: String(Math.max(1, x(gap.to) - x(gap.from))), height: String(height - AXIS_H),
      }));
      svg.appendChild(hs('text', {
        class: 'lens-timeline__gap-label', x: String(px(mid)), y: String((height - AXIS_H) / 2), 'text-anchor': 'middle',
      }, `${state.props.emptyLabelPrefix || 'no events for'} ${formatDuration(gap.ms)}`));
    }

    // ---- lanes -----------------------------------------------------------
    const cap = state.props.binsCap || MARK_CAP;
    const binned = binMarks(marks(), { from: b.from, to: b.to, width, cap });
    const byLane = new Map();
    // When binned, inverted marks ride ALONGSIDE the bins (a recorded
    // contradiction's ⚠ must never vanish into a count).
    for (const m of (binned.binned ? [...binned.bins, ...binned.marks] : binned.marks)) {
      const key = m.lane || '';
      if (!byLane.has(key)) byLane.set(key, []);
      byLane.get(key).push(m);
    }

    laneList.forEach((lane, i) => {
      const y = i * (LANE_H + LANE_GAP);
      const g = hs('g', { class: `lens-timeline__lane${lane.class ? ' ' + lane.class : ''}`, 'data-lane': lane.id });
      g.appendChild(hs('rect', {
        class: 'lens-timeline__lane-bg', x: String(LABEL_W), y: String(y), width: String(width), height: String(LANE_H),
      }));
      // label column (+ dim sublabel — facts like the session id belong here,
      // where text is text, never in the gutter as a fake bar)
      const labelNode = hs('text', {
        class: 'lens-timeline__lane-label', x: '0', y: String(y + LANE_H - 7),
      }, truncateLabel(lane.label));
      if (lane.sublabel) {
        labelNode.appendChild(hs('title', null, `${lane.label} · ${lane.sublabel}`));
        labelNode.appendChild(hs('tspan', { class: 'lens-timeline__lane-sublabel', dx: '6' },
          truncateLabel(lane.sublabel)));
      }
      if (lane.href) {
        const a = hs('a', { href: lane.href, class: 'lens-timeline__lane-link' });
        a.appendChild(labelNode);
        g.appendChild(a);
      } else {
        g.appendChild(labelNode);
      }

      for (const m of byLane.get(lane.id) || []) {
        g.appendChild(m.kind === 'bin' ? binNode(m, y, px, b) : markNode(m, y, px, x));
      }

      // right stat gutter — magnitude lives HERE, never in the geometry
      if (lane.gutter) g.appendChild(gutterNode(lane.gutter, y, LABEL_W + width));
      svg.appendChild(g);
    });

    body.appendChild(svg);

    if (binned.binned) {
      body.appendChild(h('p', { class: 'lens-timeline__note' },
        `${formatInt(marks().length)} marks exceed the ${formatInt(cap)}-mark budget, so they are drawn as `
        + `${formatInt(binned.bins.length)} bins — each labelled with its exact count, `
        + `${binned.colWidth === 1 ? 'one pixel column each' : `${binned.colWidth} pixel columns each`}.`));
    }

    // Marks without a recorded timestamp cannot be placed on a time
    // axis — count them and say so instead of dropping them silently.
    const droppedNoTs = (marks() || []).filter((m) => !isKnown(m.at)).length;
    if (droppedNoTs > 0) {
      body.appendChild(h('p', { class: 'lens-timeline__note' },
        `${formatInt(droppedNoTs)} mark${droppedNoTs === 1 ? ' records' : 's record'} no timestamp and cannot be placed on a time axis.`));
    }

    if (state.props.zoom) attachZoom(svg, x, b, width);
  }

  function markNode(m, y, px, x) {
    const kind = markKind(m);
    const title = m.title || defaultTitle(m, kind);

    let shape;
    if (kind === 'inverted') {
      // A recorded contradiction: one glyph, both timestamps in the tooltip.
      shape = hs('text', {
        class: 'lens-timeline__inverted', x: String(px(m.at)), y: String(y + LANE_H - 6), 'text-anchor': 'middle',
      }, '⚠');
    } else if (kind === 'span') {
      const x1 = px(m.at), x2 = px(m.end);
      shape = hs('rect', {
        class: `lens-timeline__span${m.tone ? ' lens-timeline__span--' + m.tone : ''}`,
        x: String(x1), y: String(y + 3), width: String(Math.max(1, x2 - x1)), height: String(LANE_H - 6),
        fill: m.color || null,
      });
    } else {
      shape = hs('line', {
        class: `lens-timeline__tick${m.tone ? ' lens-timeline__tick--' + m.tone : ''}`,
        x1: String(px(m.at)), x2: String(px(m.at)), y1: String(y + 3), y2: String(y + LANE_H - 3),
        stroke: m.color || null,
      });
    }
    shape.appendChild(hs('title', null, title));

    if (!m.href) return shape;
    const a = hs('a', { href: m.href, class: 'lens-timeline__mark-link' });
    a.appendChild(shape);
    if (state.props.onMark) a.addEventListener('click', (ev) => state.props.onMark(m, ev));
    return a;
  }

  function binNode(bin, y, px) {
    // Bins arrive in two recorded shapes — the binner's {from,to,count}
    // and a view-supplied {at,end,count,label} (L2's occupancy segments). Both
    // are DESIGN §2 `bin` primitives; neither may silently render as NaN.
    const from = isKnown(bin.from) ? bin.from : bin.at;
    const to = isKnown(bin.to) ? bin.to : bin.end;
    if (!isKnown(from)) return hs('g', { class: 'lens-timeline__bin' });
    const g = hs('g', { class: 'lens-timeline__bin' });
    const x1 = px(from), x2 = Math.max(x1 + 2, px(isKnown(to) ? to : from));
    const rect = hs('rect', {
      class: 'lens-timeline__bin-rect', x: String(x1), y: String(y + 3),
      width: String(Math.max(2, x2 - x1)), height: String(LANE_H - 6),
    });
    rect.appendChild(hs('title', null, bin.title
      ?? `${formatInt(bin.count)} marks · ${formatLocalTime(from)} → ${isKnown(to) ? formatLocalTime(to) : formatLocalTime(from)}`));
    g.appendChild(rect);
    if (x2 - x1 > 18) {
      g.appendChild(hs('text', {
        class: 'lens-timeline__bin-count', x: String((x1 + x2) / 2), y: String(y + LANE_H - 7), 'text-anchor': 'middle',
      }, bin.label ?? formatInt(bin.count)));
    }
    if (!bin.href) return g;
    const a = hs('a', { href: bin.href });
    a.appendChild(g);
    return a;
  }

  function gutterNode(gutter, y, xStart) {
    // The gutter is a FIXED-SCALE bar (DESIGN §2). With no known max
    // there is no scale, so no track and no bar — a zero-width bar beside a
    // real number would read as "tiny", which is a lie. The value still prints.
    const g = hs('g', { class: 'lens-timeline__gutter' });
    const max = (state.props.gutter && state.props.gutter.max) || gutter.max;
    const hasScale = isKnown(max) && max > 0;
    if (hasScale) {
      const frac = isKnown(gutter.value) ? Math.max(0, Math.min(1, gutter.value / max)) : 0;
      g.appendChild(hs('rect', {
        class: 'lens-timeline__gutter-track', x: String(xStart + 6), y: String(y + 6),
        width: String(GUTTER_W - 60), height: String(LANE_H - 12),
      }));
      if (isKnown(gutter.value)) {
        g.appendChild(hs('rect', {
          class: 'lens-timeline__gutter-bar', x: String(xStart + 6), y: String(y + 6),
          width: String(Math.max(0, (GUTTER_W - 60) * frac)), height: String(LANE_H - 12),
        }));
      }
    }
    const valueText = hs('text', {
      class: 'lens-timeline__gutter-value', x: String(xStart + GUTTER_W - 4), y: String(y + LANE_H - 7), 'text-anchor': 'end',
    }, isKnown(gutter.value) ? (gutter.format || (state.props.gutter && state.props.gutter.format) || formatInt)(gutter.value) : UNKNOWN);
    valueText.appendChild(hs('title', null,
      isKnown(gutter.value)
        ? (hasScale ? `${gutter.label || 'gutter'}` : `${gutter.label || 'gutter'} — no fixed scale: max not recorded, so no bar is drawn`)
        : (gutter.reason || 'not recorded')));
    g.appendChild(valueText);
    return g;
  }

  function defaultTitle(m, kind) {
    if (kind === 'inverted') {
      return `recorded end is before recorded start — start ${formatLocalTime(m.at)}, end ${formatLocalTime(m.end)}`;
    }
    if (kind === 'span') {
      return `${m.label ? m.label + ' · ' : ''}${formatLocalTime(m.at)} → ${formatLocalTime(m.end)} · ${formatDuration(m.end - m.at)}`;
    }
    return `${m.label ? m.label + ' · ' : ''}${formatLocalTime(m.at)} · one recorded timestamp`;
  }

  /* ---- brush-to-zoom + shift-pan: EPHEMERAL, never in the URL ---- */
  function attachZoom(svg, x, b, width) {
    let drag = null;
    const rect = hs('rect', { class: 'lens-timeline__brush', x: '0', y: '0', width: '0', height: '0', hidden: true });
    svg.appendChild(rect);

    svg.addEventListener('mousedown', (ev) => {
      const localX = eventX(ev, svg) - LABEL_W;
      if (localX < 0 || localX > width) return;
      drag = { startX: localX, pan: ev.shiftKey, from: b.from, to: b.to };
      if (!drag.pan) { rect.removeAttribute('hidden'); }
      ev.preventDefault();
    });
    svg.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      const localX = Math.max(0, Math.min(width, eventX(ev, svg) - LABEL_W));
      if (drag.pan) {
        const dt = x.invert(drag.startX) - x.invert(localX);
        state.window = { from: drag.from + dt, to: drag.to + dt };
        draw();
        return;
      }
      const a = Math.min(drag.startX, localX), w = Math.abs(localX - drag.startX);
      rect.setAttribute('x', String(LABEL_W + a));
      rect.setAttribute('width', String(w));
      rect.setAttribute('y', '0');
      rect.setAttribute('height', String(svg.getAttribute('height')));
    });
    const finish = (ev) => {
      if (!drag) return;
      const localX = Math.max(0, Math.min(width, eventX(ev, svg) - LABEL_W));
      if (!drag.pan && Math.abs(localX - drag.startX) > 4) {
        const t0 = x.invert(Math.min(drag.startX, localX));
        const t1 = x.invert(Math.max(drag.startX, localX));
        state.window = { from: t0, to: t1 };
        draw();
      }
      drag = null;
      rect.setAttribute('hidden', '');
    };
    svg.addEventListener('mouseup', finish);
    svg.addEventListener('mouseleave', finish);
    svg.addEventListener('dblclick', () => { state.window = null; draw(); });
  }

  function eventX(ev, svg) {
    if (svg.getBoundingClientRect) {
      const box = svg.getBoundingClientRect();
      return ev.clientX - box.left;
    }
    return ev.offsetX || 0;
  }

  draw();

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      const w = root.clientWidth || 0;
      if (Math.abs(w - state.width) > 8) { state.width = w; draw(); }
    });
    ro.observe(root);
  }

  return {
    update(next) { state.props = Object.assign({}, state.props, next); draw(); },
    setWindow(win) { state.window = win; draw(); },
    getWindow() { return state.window; },
    resetWindow() { state.window = null; draw(); },
    element: root,
    destroy() {
      if (ro) ro.disconnect();
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}

function truncateLabel(s) {
  const t = String(s === null || s === undefined ? '' : s);
  return t.length > 26 ? t.slice(0, 25) + '…' : t;
}

/* ------------------------------------------------------------------ *
 * project identity palette (DESIGN §2: top-12 stable hues + grey overflow)
 * ------------------------------------------------------------------ */

export const PALETTE_SIZE = 12;

/**
 * Stable colour assignment: the caller passes the ranked list of project slugs
 * (the ranking is a recorded quantity — the top 12 keep a hue, everything else
 * is grey). Returns a Map slug -> CSS var reference.
 */
export function projectPalette(rankedSlugs) {
  const map = new Map();
  (rankedSlugs || []).forEach((slug, i) => {
    map.set(slug, i < PALETTE_SIZE ? `var(--lens-p${i + 1})` : 'var(--lens-p-overflow)');
  });
  return map;
}
