// web/js/lib/links.mjs — hash-link builders, the SPEC §9 scope grammar, and
// the `returnTo` return-state mechanism.
// Every internal link the drill views draw goes through routes/linkTo, so
// every segment is percent-encoded exactly once (DESIGN §0).

import { formatLocator } from './locator.mjs';
import { parseHash } from '../router/pattern.mjs';
import { currentHash } from '../router.mjs';

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

/* ====================================================== return-state ==
 * A drill link out of a list-like view carries `returnTo=<encoded hash>`, so
 * the landing page can offer a labelled way back to the exact view state the
 * reader left (DESIGN §0 keeps unknown query params by construction, so the
 * router needs no change).
 *
 * DEPTH IS BOUNDED AT ONE. Building a new `returnTo` strips any `returnTo`
 * already on the hash being encoded AND any already on the target, so a hash
 * can never nest a chain of encoded hashes inside itself.
 */

/** The same hash with any `returnTo` param removed. Everything else survives. */
export function stripReturn(hash) {
  const raw = String(hash ?? '');
  const q = raw.indexOf('?');
  if (q === -1) return raw;
  const params = new URLSearchParams(raw.slice(q + 1));
  if (!params.has('returnTo')) return raw;
  params.delete('returnTo');
  const rest = params.toString();
  return rest ? `${raw.slice(0, q)}?${rest}` : raw.slice(0, q);
}

/**
 * withReturn('#/p/a/s/b/a/main/e/12.0') -> the same href carrying the hash the
 * reader is standing on as `returnTo`. Never nests: both sides are stripped.
 */
export function withReturn(href, fromHash = currentHash()) {
  const target = stripReturn(String(href ?? ''));
  const from = stripReturn(String(fromHash ?? ''));
  if (!from || from === '#' || target === from) return target;
  return `${target}${target.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(from)}`;
}

/** The hash a landing page should go back to, or null when none was carried. */
export function returnHref(ctxOrQuery) {
  const query = ctxOrQuery && ctxOrQuery.query !== undefined ? ctxOrQuery.query : ctxOrQuery;
  const raw = query && typeof query.get === 'function' ? query.get('returnTo') : null;
  if (!raw) return null;
  let hash;
  try { hash = decodeURIComponent(raw); } catch { hash = raw; }
  hash = String(hash).trim();
  if (!hash) return null;
  // Only ever an in-app hash: a returnTo that is not one is not followed.
  if (!hash.startsWith('#')) return null;
  return stripReturn(hash);
}

/**
 * A label for a return hash, derived from the ROUTE SHAPE alone — the segments
 * and the `?v` view key, nothing else. Never infers anything about content.
 */
export function describeHash(hash) {
  const raw = String(hash ?? '');
  if (!raw || raw === '#' || raw === '#/') return 'the store';
  const { segments, query } = parseHash(raw);
  const seg = segments.map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const view = query.get('v');
  const withView = (base) => (view ? `${base} ${view}` : base);
  const short = (id) => (String(id).length > 8 ? String(id).slice(0, 8) : String(id));

  if (!seg.length) return 'the store';
  if (seg[0] === 'find') {
    const q = query.get('q');
    return q ? `find results for “${q}”` : 'find';
  }
  if (seg[0] === 'audit') return seg.length > 1 ? `the audit of ${seg.slice(1).join('/')}` : 'the audit';
  if (seg[0] === 'settings') return 'settings';
  if (seg[0] === 'p') {
    const slug = seg[1];
    if (seg.length === 2) return withView(`project ${slug}`);
    if (seg[2] === 'mem') return `memory ${seg.slice(3).join('/')}`;
    if (seg[2] === 'x') return `file ${seg.slice(3).join('/')}`;
    if (seg[2] === 's') {
      const sid = seg[3];
      if (seg.length === 4) return withView(`session ${short(sid)}`);
      switch (seg[4]) {
        case 'inv': return `the inventory of session ${short(sid)}`;
        case 'x': return `file ${seg.slice(5).join('/')}`;
        case 't': return withView(`turn ${seg[5]}`);
        case 'w': return `workflow run ${seg[5]}`;
        case 'a': {
          const agent = seg[5] === 'main' ? 'the main thread' : `agent ${short(seg[5])}`;
          if (seg[6] === 'e') return `event ${seg[7]}`;
          return withView(agent);
        }
        default: break;
      }
    }
  }
  return raw;
}

/** The back control's target and its label: `{ href, label }` or null. */
export function returnTarget(ctxOrQuery) {
  const href = returnHref(ctxOrQuery);
  return href ? { href, label: describeHash(href) } : null;
}

/** SPEC §9 scope grammar. */
export function scopeOf(slug, sid, extra) {
  if (extra?.agentId) return `agent:${slug}/${sid}/${extra.agentId}`;
  if (extra?.turnIdx !== undefined && extra?.turnIdx !== null) return `turn:${slug}/${sid}/${extra.turnIdx}`;
  if (sid) return `session:${slug}/${sid}`;
  if (slug) return `project:${slug}`;
  return 'store';
}
