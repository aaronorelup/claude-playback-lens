// web/js/views/l3/svg.mjs — the lane Gantt's SVG: per-lane bars with queued
// hatching and state glyphs, the shared time axis, and the collapsed group's
// exact-occupancy strip. Geometry constants for the three-column layout
// (label | track | glyph) live here and nowhere else.
//
// CONTRACT-DEVIATION: the lane Gantt draws its own SVG instead of going
// through components/timeline.mjs. DESIGN §3 L3 requires per-lane features the
// contracted `timeline(el, {lanes, marks, axis, gutter})` shape has no slot
// for: a hatched queued segment drawn ONLY when queuedAt is recorded, an end
// glyph chosen from the recorded state signature (with its source in the
// tooltip), the `— cached` and `⌂ worktree` tags, indentation by recorded
// spawnDepth, and per-group collapse to an occupancy strip. It still obeys
// DESIGN §2's grammar — spans from two recorded timestamps, ticks from one,
// no invented width, no magnitude in geometry, local time, every mark a link.
// The same applies to L4's event strip. If timeline() later grows these
// slots, both should move.

import { s } from '../../lib/dom.mjs';
import { fmtLocalTime, fmtDur, tzLabel, truncate } from '../../lib/fmt.mjs';
import { routes } from '../../lib/links.mjs';
import { agentGlyph, agentTags } from './state.mjs';
import { laneLabel, occupancySegments } from './lanes.mjs';

export const LANE_H = 20;
export const LANE_LABEL_W = 300;
export const TRACK_W = 760;
export const GLYPH_W = 150;

export function xOf(ms, bounds) {
  if (!bounds || bounds.span <= 0) return 0;
  return ((ms - bounds.t0) / bounds.span) * TRACK_W;
}

export function laneSvg(lanes, bounds, { slug, sid }) {
  const height = Math.max(LANE_H, lanes.length * LANE_H + 6);
  const width = LANE_LABEL_W + TRACK_W + GLYPH_W;
  const svg = s('svg', {
    class: 'lens-lanes__svg', width: '100%', height: String(height),
    viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMinYMin meet', role: 'group',
  });
  // Hatch pattern for the queued segment (recorded queuedAt→startedAt only).
  svg.appendChild(s('defs', {}, s('pattern', {
    id: 'lens-hatch', width: '6', height: '6', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  }, s('rect', { width: '3', height: '6', class: 'lens-lanes__hatchbar' }))));

  lanes.forEach((ag, i) => {
    const y = i * LANE_H + 3;
    const indent = Math.max(0, Number(ag.spawnDepth ?? 1) - 1) * 14;
    const g = s('g', { class: 'lens-lane' });

    const label = laneLabel(ag);
    g.appendChild(s('a', { href: routes.agent(slug, sid, ag.agentId), class: 'lens-lane__labellink' },
      s('text', {
        x: String(6 + indent), y: String(y + LANE_H - 7), class: 'lens-lane__label',
        text: truncate(label, 40),
      }, s('title', { text: `${label}\nagentId ${ag.agentId}${ag.spawnDepth !== null ? `\nspawnDepth ${ag.spawnDepth} (recorded)` : ''}` }))));

    // Queued segment — ONLY when both endpoints are recorded (SPEC §4).
    if (ag.queuedAt !== null && ag.progStartedAt !== null && ag.progStartedAt > ag.queuedAt) {
      const x0 = LANE_LABEL_W + xOf(ag.queuedAt, bounds);
      const x1 = LANE_LABEL_W + xOf(ag.progStartedAt, bounds);
      g.appendChild(s('rect', {
        x: String(x0), y: String(y + 3), width: String(Math.max(1, x1 - x0)), height: String(LANE_H - 9),
        class: 'lens-lane__queued', fill: 'url(#lens-hatch)',
      }, s('title', { text: `queued ${fmtLocalTime(ag.queuedAt)} → started ${fmtLocalTime(ag.progStartedAt)} (workflowProgress, recorded)` })));
    }

    // The bar itself — first/last timestamp of the agent's own transcript.
    if (ag.firstAt !== null && ag.lastAt !== null) {
      const x0 = LANE_LABEL_W + xOf(ag.firstAt, bounds);
      const x1 = LANE_LABEL_W + xOf(ag.lastAt, bounds);
      const inverted = ag.lastAt < ag.firstAt;
      if (inverted) {
        // DESIGN §2: end<start renders a ⚠ tick showing both timestamps.
        g.appendChild(s('text', {
          x: String(LANE_LABEL_W + xOf(ag.firstAt, bounds)), y: String(y + LANE_H - 7), class: 'lens-lane__warn', text: '⚠',
        }, s('title', { text: `end before start — first ${fmtLocalTime(ag.firstAt)} · last ${fmtLocalTime(ag.lastAt)} (both recorded)` })));
      } else {
        g.appendChild(s('rect', {
          x: String(x0), y: String(y + 3), width: String(Math.max(1.5, x1 - x0)), height: String(LANE_H - 9),
          class: `lens-lane__bar lens-lane__bar--${agentGlyph(ag).code}`,
        }, s('title', { text: `${fmtLocalTime(ag.firstAt)} → ${fmtLocalTime(ag.lastAt)} · wall ${fmtDur(ag.lastAt - ag.firstAt)} (first/last timestamp of its own transcript, SPEC §4)` })));
      }
    } else {
      const at = ag.firstAt ?? ag.lastAt ?? ag.progStartedAt ?? ag.queuedAt;
      if (at !== null && at !== undefined) {
        // One recorded timestamp = a tick. No invented width (DESIGN §2).
        g.appendChild(s('rect', {
          x: String(LANE_LABEL_W + xOf(at, bounds)), y: String(y + 3), width: '2', height: String(LANE_H - 9),
          class: 'lens-lane__tick',
        }, s('title', { text: `one recorded timestamp (${fmtLocalTime(at)}) — a tick, not a span` })));
      } else {
        g.appendChild(s('text', { x: String(LANE_LABEL_W + 2), y: String(y + LANE_H - 7), class: 'lens-lane__none', text: '— no timestamp recorded on this transcript' }));
      }
    }

    // End glyph + tags.
    const gl = agentGlyph(ag);
    const gx = LANE_LABEL_W + TRACK_W + 8;
    g.appendChild(s('text', { x: String(gx), y: String(y + LANE_H - 7), class: `lens-lane__glyph lens-lane__glyph--${gl.code}`, text: gl.glyph },
      s('title', { text: `${gl.label}${gl.source ? ` · source: ${gl.source}` : ' · no manifest entry and no journal entry records a state'}` })));
    let tx = gx + 16;
    for (const tag of agentTags(ag)) {
      g.appendChild(s('text', { x: String(tx), y: String(y + LANE_H - 7), class: `lens-lane__tag lens-lane__tag--${tag.key}`, text: tag.text },
        s('title', { text: `${tag.title}${tag.note ? `\n${tag.note}` : ''}` })));
      tx += tag.text.length * 6 + 8;
    }
    svg.appendChild(g);
  });
  return svg;
}

export function axisStrip(bounds) {
  const width = LANE_LABEL_W + TRACK_W + GLYPH_W;
  const svg = s('svg', { class: 'lens-lanes__axis', width: '100%', height: '22', viewBox: `0 0 ${width} 22` });
  if (!bounds) return svg;
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = bounds.t0 + (bounds.span * i) / ticks;
    const x = LANE_LABEL_W + (TRACK_W * i) / ticks;
    svg.appendChild(s('line', { x1: String(x), y1: '14', x2: String(x), y2: '20', class: 'lens-axis__tick' }));
    svg.appendChild(s('text', {
      x: String(x), y: '11', class: 'lens-axis__label', 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle',
      text: fmtLocalTime(t, { date: i === 0 }),
    }));
  }
  svg.appendChild(s('text', { x: String(LANE_LABEL_W - 6), y: '11', class: 'lens-axis__tz', 'text-anchor': 'end', text: `(${tzLabel(bounds.t0)})` }));
  return svg;
}

export function occupancyStrip(agents, bounds) {
  // DESIGN §2 — magnitude is NEVER encoded in geometry. The strip draws the
  // exact ±1 occupancy segments as `bin` primitives: fixed-height outlined
  // blocks, each LABELLED with its exact count; the max lives in the text
  // gutter (a per-group-scaled column chart would be a bar chart in disguise).
  const t0 = bounds?.t0 ?? 0, t1 = bounds?.t1 ?? 0;
  const occ = occupancySegments(agents, t0, t1);
  const max = occ.max;
  const width = LANE_LABEL_W + TRACK_W + GLYPH_W;
  const svg = s('svg', { class: 'lens-occupancy', width: '100%', height: '34', viewBox: `0 0 ${width} 34` });
  const BIN_Y = 6, BIN_H = 20;   // one fixed height for every bin
  for (const seg of occ.segments) {
    if (!seg.n) continue;
    const x0 = LANE_LABEL_W + xOf(seg.start, bounds);
    const x1 = LANE_LABEL_W + xOf(seg.end, bounds);
    const w = Math.max(1.5, x1 - x0);
    svg.appendChild(s('rect', {
      x: String(x0), y: String(BIN_Y), width: String(w), height: String(BIN_H),
      class: 'lens-occupancy__bin',
    }, s('title', { text: `${seg.n} concurrent agent${seg.n === 1 ? '' : 's'} · ${fmtLocalTime(seg.start)} → ${fmtLocalTime(seg.end)}` })));
    if (w >= 14) {
      svg.appendChild(s('text', {
        x: String((x0 + x1) / 2), y: String(BIN_Y + BIN_H - 6), 'text-anchor': 'middle',
        class: 'lens-occupancy__count', text: String(seg.n),
      }));
    }
  }
  svg.appendChild(s('text', {
    x: String(LANE_LABEL_W - 6), y: '20', class: 'lens-occupancy__max', 'text-anchor': 'end',
    text: `max ${max} concurrent`,
  }, occ.pointOnly ? s('title', { text: `${occ.pointOnly} agent(s) record one timestamp only — no width, excluded from the ±1 arithmetic and said so here` }) : null));
  return svg;
}
