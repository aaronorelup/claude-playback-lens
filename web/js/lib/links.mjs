// web/js/lib/links.mjs — hash-link builders and the SPEC §9 scope grammar.
// Every internal link the drill views draw goes through routes/linkTo, so
// every segment is percent-encoded exactly once (DESIGN §0).

import { formatLocator } from './locator.mjs';

/** '#/p/<slug>/s/<sid>/t/3?sel=x' — every segment percent-encoded (DESIGN §0). */
export function linkTo(segments, query) {
  const parts = (Array.isArray(segments) ? segments : [segments])
    .filter((x) => x !== null && x !== undefined && x !== '');
  const base = '#/' + parts.map((p) => encodeURIComponent(String(p))).join('/');
  const qs = queryString(query);
  return qs ? `${base}?${qs}` : base;
}

export function queryString(query) {
  if (!query) return '';
  const u = new URLSearchParams();
  const src = query instanceof URLSearchParams ? query.entries() : Object.entries(query);
  for (const [k, v] of src) {
    if (v === null || v === undefined || v === '') continue;
    u.set(k, String(v));
  }
  return u.toString();
}

export const routes = {
  store: () => linkTo([]),
  project: (slug, q) => linkTo(['p', slug], q),
  session: (slug, sid, q) => linkTo(['p', slug, 's', sid], q),
  turn: (slug, sid, idx, q) => linkTo(['p', slug, 's', sid, 't', idx], q),
  agent: (slug, sid, agentId, q) => linkTo(['p', slug, 's', sid, 'a', agentId], q),
  event: (slug, sid, agentId, line, bi, q) =>
    linkTo(['p', slug, 's', sid, 'a', agentId, 'e', formatLocator(line, bi)], q),
  workflow: (slug, sid, runId, q) => linkTo(['p', slug, 's', sid, 'w', runId], q),
  inventory: (slug, sid, q) => linkTo(['p', slug, 's', sid, 'inv'], q),
  sessionFile: (slug, sid, rel, q) => linkTo(['p', slug, 's', sid, 'x', ...String(rel).split('/')], q),
  projectFile: (slug, rel, q) => linkTo(['p', slug, 'x', ...String(rel).split('/')], q),
  memory: (slug, name, q) => linkTo(['p', slug, 'mem', name], q),
  find: (q) => linkTo(['find'], q),
  audit: (q) => linkTo(['audit'], q),
  settings: () => linkTo(['settings']),
};

/** SPEC §9 scope grammar. */
export function scopeOf(slug, sid, extra) {
  if (extra?.agentId) return `agent:${slug}/${sid}/${extra.agentId}`;
  if (extra?.turnIdx !== undefined && extra?.turnIdx !== null) return `turn:${slug}/${sid}/${extra.turnIdx}`;
  if (sid) return `session:${slug}/${sid}`;
  if (slug) return `project:${slug}`;
  return 'store';
}
