/**
 * L5 — one event / one block.   DESIGN §3 (L5), §0 (route grammar), SPEC §8.
 *
 * FAÇADE. The implementation lives in web/js/lib/ (the drill-views shared kit
 * — DOM builders, format wrappers, links, the dotted-bi grammar, block
 * enumeration, page chrome, text bodies) and web/js/views/l5/ (the event page
 * itself). This module re-exports the whole historical surface, so every
 * import path — sibling views, tests, the router's module list — keeps
 * resolving here unchanged.
 */

export { kit, apiUrl, fetchRaw, sendJson } from '../lib/net.mjs';
export { api, sse, isPending } from '../api.mjs';
export { formatUsd, replace, isKnown } from '../format.mjs';
export { filtersFromQuery } from '../components/scope.mjs';

export { h, s, clear, unknown, a, section, factList, kindChip, simpleTable, copyButton } from '../lib/dom.mjs';
export {
  num, toMs, fmtInt, fmtBytes, fmtDur, fmtLocalTime, tzLabel, truncate,
  spanProps, spanCell, shortId,
} from '../lib/fmt.mjs';
export { linkTo, queryString, routes, scopeOf } from '../lib/links.mjs';
export { parseBi, formatBi, parseLocator, formatLocator, copyLocator, biToPath } from '../lib/locator.mjs';
export {
  blockKind, eventKind, enumerateBlocks, findBlock, siblingBlocks,
  extractSpillRefs, recordedB64, attributeBlob,
} from '../lib/blocks.mjs';
export {
  noteRender, renderCount, mountCrumbs, statHeader, handle404, costCell,
  page, errorCard, pendingCard, progressBar, table, registerSiblings, siblingPager,
} from '../lib/chrome.mjs';
export {
  getPref, setPref, escapeHtml, renderMarkdown, textBody, rawJson, safeStringify,
} from '../lib/text.mjs';

export { resolveAgentFile, renderEvent, routeList, register } from './l5/page.mjs';
