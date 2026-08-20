// server/api/session-lookup.mjs — index-availability gates (503), the
// pending→409 conversion, and the slug/id → session resolution every scoped
// route shares, including scope canonicalisation.

import { httpError, PendingError } from '../errors.mjs';
import { RETRY_AFTER_MS } from '../limits.mjs';
import { IS_WIN } from './fileref.mjs';

export function requireIndex(ctx) {
  requireIndexLayer(ctx);
  if (!ctx.index.workerAlive()) throw httpError(503, 'indexer-down', 'indexer worker is not running');
}

// /api/index and /api/reindex must answer while the indexer is DOWN:
// problems[] is only reachable through /api/index (a blanket 503 there makes
// the failure undiagnosable — the worker's own crash note is written to a
// payload nothing could fetch), and /api/reindex is the one exposed recovery
// action, so gating it on a live worker would 503 before it could revive
// anything. Both use this layer-only gate and degrade honestly instead:
// status.state reads 'failed' and the problems say why.
export function requireIndexLayer(ctx) {
  if (!ctx.index) throw httpError(503, 'indexer-down', 'index layer is not wired');
}

export function pendingTo409(e) {
  if (e instanceof PendingError || (e && e.name === 'PendingError')) {
    return httpError(409, 'not-indexed-yet', 'session is not indexed yet', {
      retryAfterMs: e.retryAfterMs ?? RETRY_AFTER_MS,
      bytesIndexed: e.bytesIndexed ?? null,
      bytesTotal: e.bytesTotal ?? null,
    });
  }
  return e;
}

// Slug comparison: case-insensitive on win32, exact elsewhere — the same rule
// tableLookup applies to FileTable keys (one case rule per platform).
export function slugEq(a, b) {
  if (a === b) return true;
  return IS_WIN && typeof a === 'string' && typeof b === 'string'
    && a.toLowerCase() === b.toLowerCase();
}

export function findSession(ctx, slug, id) {
  // cards are keyed by BARE sessionId — the one keying convention (SPEC §2)
  const card = ctx.index.cards().get(id);
  if (card && slugEq(card.slug, slug)) return card;
  const entry = ctx.index.sessions().find((s) => slugEq(s.slug, slug) && s.id === id);
  if (!entry) throw httpError(404, 'unknown-session', `no session ${slug}/${id}`);
  if (card) return card; // id matches, slug from an alternate spelling — the entry proves the pair
  const st = ctx.index.status();
  throw pendingTo409(new PendingError({
    retryAfterMs: RETRY_AFTER_MS, bytesIndexed: st.bytesIndexed, bytesTotal: st.bytesTotal,
  }));
}

/**
 * Resolve a scope to its sessions, and CANONICALISE the scope's slug in place.
 *
 * Matching honours slugEq (case-insensitive on win32), but the parsed scope
 * object is forwarded verbatim to consumers that do their OWN `===` matching
 * (find.mjs's session filter, buildPathA's inScopeKey, audit.mjs, the index
 * layer's ensureParsed/ensureModel) — so loosening the comparison here alone
 * would turn an honest 404 into a 200 with `matches: 0`, a false real-zero
 * for a scan that covered nothing. So: match with slugEq, then rewrite
 * scope.slug to the matched entry's canonical spelling. Every downstream
 * `===` then compares against the spelling the store actually uses. `scope`
 * is a fresh object per request (parseScope builds it from the query string),
 * so mutating it cannot leak across requests.
 */
export function scopeSessionList(ctx, scope) {
  const sessions = ctx.index.sessions();
  if (scope.kind === 'store') return sessions;
  if (scope.kind === 'project') {
    const list = sessions.filter((s) => slugEq(s.slug, scope.slug));
    const proj = ctx.index.projects().find((p) => slugEq(p.slug, scope.slug));
    if (list.length === 0 && !proj) {
      throw httpError(404, 'unknown-project', `no project ${scope.slug}`);
    }
    scope.slug = list[0]?.slug ?? proj.slug;
    return list;
  }
  const one = sessions.filter((s) => slugEq(s.slug, scope.slug) && s.id === scope.id);
  if (one.length === 0) throw httpError(404, 'unknown-session', `no session ${scope.slug}/${scope.id}`);
  scope.slug = one[0].slug;
  return one;
}
