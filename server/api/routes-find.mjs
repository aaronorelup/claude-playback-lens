// server/api/routes-find.mjs — /api/find, the SSE search stream. Validates
// the query (regex syntax + backtracking shape) and 404s the scope BEFORE the
// stream opens, then hands off to server/find.mjs.

import { httpError } from '../errors.mjs';
import { sseOpen } from '../http.mjs';
import { runFind } from '../find.mjs';
import { SSE_HEARTBEAT_MS } from '../limits.mjs';
import { parseScope, catastrophicShape } from './scope.mjs';
import { strParam } from './params.mjs';
import { requireIndex, scopeSessionList } from './session-lookup.mjs';

export function registerFindRoutes({ G }, ctx) {
  G('/api/find', async (req, res, { query }) => {
    requireIndex(ctx);
    const q = strParam(query, 'q', { required: true });
    const re = query.get('re') === '1';
    const caseSensitive = query.get('case') === '1';
    const scope = parseScope(query.get('scope'));
    if (re) {
      try { new RegExp(q); } catch (e) { throw httpError(400, 'bad-regex', `invalid regex: ${e.message}`); }
      const shape = catastrophicShape(q);
      if (shape) {
        // resource guard, not inference: exponential-backtracking shapes
        // hard-hang the single-threaded server (sync exec cannot be aborted)
        throw httpError(400, 'bad-regex',
          `regex rejected: ${shape} can backtrack exponentially and would hang the scan — rewrite without nesting/stacking unbounded quantifiers`);
      }
    }
    scopeSessionList(ctx, scope); // 404 before the stream opens
    const stream = sseOpen(res, { heartbeatMs: ctx.heartbeatMs ?? SSE_HEARTBEAT_MS });
    const ac = new AbortController();
    stream.onClientClose(() => ac.abort());
    try {
      await runFind({
        projectsDir: ctx.projectsDir,
        sessions: ctx.index.sessions(),
        fileTable: ctx.index.fileTable(),
        q, re, caseSensitive,
        after: query.get('after'),
        scope,
        emit: (ev, data) => stream.event(ev, data),
        signal: ac.signal,
      });
    } catch (e) {
      stream.event('error', { code: 'find-failed', message: String(e && e.message) });
    }
    stream.close(); // server closes after done (SPEC §9)
  });
}
