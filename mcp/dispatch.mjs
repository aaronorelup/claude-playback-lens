// mcp/dispatch.mjs — in-process dispatch of the lens's own HTTP handlers.
//
// This is the load-bearing decision of the whole server, so the reason is
// recorded here rather than in a ticket.
//
// The lens's payload builders (buildIndexView, rowsForScope, cardAggInto,
// workflowCostOf, sessionAgentProjection) are closures defined inside
// createApi's body. They close over the memo objects that carry the R2
// canonical-resolution cache — the de-duplication of one message.id across
// forked and resumed sessions. They are not exported and cannot be exported
// without hoisting them out of that closure.
//
// So this module does not reimplement anything. It builds the router the same
// way lens.mjs does, registers the same createApi against the same ctx, and
// then dispatches synthetic requests through it with a capturing fake
// response. The consequence is the property this server exists to have: the
// numbers an agent reads here came out of the same handler, the same memos and
// the same rate table as the numbers the browser UI shows. There is no second
// implementation that could drift.
//
// The handlers touch only res.writeHead / res.write / res.end / res.headersSent
// / res.on, so the fake below is complete for every route this server calls.
//
// Cost: the JSON is serialised by the handler and parsed back here. On the
// largest payload (/api/index) that is a few MB once per call, dwarfed by the
// index build itself.
//
// NOT dispatched through here: GET /api/find and GET /api/audit are SSE. Their
// underlying functions (runFind, runAudit) are top-level exports of the lens
// taking an `emit` callback, so tools that need them call them directly.

/**
 * createDispatcher(lens, ctx) -> async call(method, pathname, query = {})
 *
 * Resolves to `{ status, json, headers }`. It does not throw for any
 * HTTP-level outcome: a 404, a 405, a 409 and a 500 all come back as values,
 * because a tool handler has to render them, and an exception is not
 * something a model can act on. It DOES propagate a genuine programming error
 * out of the fake response plumbing, which is not an HTTP outcome.
 *
 * The status/body mapping below mirrors createHttpServer in the lens's
 * server/http.mjs exactly:
 *
 *   handler throws HttpError  -> { status: err.status, json: errorBody(err) }
 *   handler throws otherwise  -> { status: 500, json: errorBody({code:'internal'}) }
 *   no route, /api/ path,
 *     path exists under other
 *     methods                 -> { status: 405, json: …, headers: { Allow } }
 *   no route, /api/ path      -> { status: 404, code 'unknown-route' }
 *   no route, other path      -> { status: 404, code 'not-found' }
 *
 * errorBody's envelope is nested: { error: { code, message, detail? } }. A
 * PendingError never reaches here as an exception — createApi converts it to
 * an HttpError(409, 'not-indexed-yet') with detail
 * { retryAfterMs, bytesIndexed, bytesTotal } at its own route seam, so a 409
 * arrives through the ordinary HttpError path above.
 *
 * The host-header and cross-site gates in createHttpServer are deliberately
 * NOT reproduced: they exist to reject requests that crossed a network
 * boundary, and nothing here crosses one.
 */
export function createDispatcher(lens, ctx) {
  const { createRouter } = lens.http;
  const { createApi } = lens.api;
  const { HttpError, errorBody } = lens.errors;

  const router = createRouter();
  createApi(router, ctx); // identical registration to lens.mjs

  return async function call(method, pathname, query = {}) {
    const m = router.match(method, pathname);
    if (!m) return noRoute(router, method, pathname, HttpError, errorBody);

    const search = new URLSearchParams(query);
    // A minimal request. The handlers read `method` and `url`; the `host`
    // header is present because a handler that logged it would otherwise see
    // undefined. No body is supplied — every route this server calls is a GET.
    const req = { method, url: pathname, headers: { host: '127.0.0.1' } };

    let status = 200;
    let headers = {};
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead(s, h) {
        status = s;
        if (h) headers = { ...h };
        this.headersSent = true;
        return this;
      },
      write(c) { if (c) chunks.push(Buffer.from(c)); return true; },
      end(c) { if (c) chunks.push(Buffer.from(c)); return this; },
      // The handlers register a 'close' listener for client disconnects. There
      // is no client and no socket here, so nothing can ever fire.
      on() { return this; },
      once() { return this; },
      removeListener() { return this; },
    };

    try {
      await m.handler(req, res, { pathname, query: search, params: m.params });
    } catch (e) {
      // Same branch order as createHttpServer's catch: a handler that already
      // wrote headers keeps whatever it wrote (it cannot be re-answered).
      if (res.headersSent) return finish(status, headers, chunks);
      if (e instanceof HttpError || (e && e.name === 'HttpError')) {
        return { status: e.status, json: errorBody(e), headers: {} };
      }
      return {
        status: 500,
        json: errorBody({ code: 'internal', message: 'internal error' }),
        headers: {},
      };
    }
    return finish(status, headers, chunks);
  };
}

function finish(status, headers, chunks) {
  const body = Buffer.concat(chunks).toString('utf8');
  // 204 and any other empty response yield json: null — an absent body is not
  // the same fact as `{}`, and callers test for null.
  let json = null;
  if (body) {
    try { json = JSON.parse(body); }
    catch { json = null; }
  }
  return { status, json, headers };
}

// Reproduces createHttpServer's no-match branch. A path that plainly exists
// under another method answers 405 and names the methods it does have; a 404
// there would be a false statement about the resource.
function noRoute(router, method, pathname, HttpError, errorBody) {
  if (pathname.startsWith('/api/')) {
    const allowed = router.methodsFor(pathname);
    if (allowed.length) {
      const err = new HttpError(405, 'method-not-allowed',
        `${method} is not supported for ${pathname}; this route answers ${allowed.join(', ')}`);
      return { status: 405, json: errorBody(err), headers: { Allow: allowed.join(', ') } };
    }
    const err = new HttpError(404, 'unknown-route', `no route for ${method} ${pathname}`);
    return { status: 404, json: errorBody(err), headers: {} };
  }
  // Off /api/ the lens falls back to the static handler before answering 404.
  // This server has no static surface, so the 404 is immediate — same code and
  // message the lens uses when the static handler declines.
  const err = new HttpError(404, 'not-found', `not found: ${pathname}`);
  return { status: 404, json: errorBody(err), headers: {} };
}
