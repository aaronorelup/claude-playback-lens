/**
 * L3 — one turn: lanes, orchestration tree, timetable.
 * DESIGN §3 (L3), SPEC §7 (agent states, attribution), SPEC §4 (bounds).
 *
 * FAÇADE. The implementation lives in web/js/views/l3/: recorded-state
 * signatures and agent normalisation (state.mjs), the pure lane/tree models
 * (lanes.mjs), the SVG drawing (svg.mjs) and the page itself (turnpage.mjs).
 * This module re-exports the whole historical surface, so every import path —
 * l2's phase reader, l4's glyphs, tests, the router's module list — keeps
 * resolving here unchanged.
 */

export {
  STATE_GLYPHS, stateSignature, agentGlyph, agentTags, phaseLabelOf, normalizeAgent,
} from './l3/state.mjs';
export {
  classifyRun, hasNextTurn, AUTO_COLLAPSE_AGENTS, buildLanes, laneBounds,
  occupancySegments, cyclicAgentIds, buildTree, laneLabel, parseSel,
} from './l3/lanes.mjs';
export { renderTurn, routeList, register } from './l3/turnpage.mjs';
