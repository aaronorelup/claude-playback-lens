// server/http.mjs — HTTP server shell (group D).
// Binds 127.0.0.1 only; rejects foreign Host headers with 403 (SPEC §9
// security). Hand-rolled router + SSE helper with 15 s comment heartbeats.

import http from 'node:http';
import { HttpError, errorBody } from './errors.mjs';
import { DEFAULT_PORT, SSE_HEARTBEAT_MS } from './limits.mjs';

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let h = String(hostHeader).trim().toLowerCase();
  // strip a trailing :port (bracketed IPv6 keeps its brackets)
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return false;
    h = h.slice(0, end + 1);
  } else {
    const colon = h.indexOf(':');
    if (colon !== -1) h = h.slice(0, colon);
  }
  return ALLOWED_HOSTNAMES.has(h);
}

// Cross-site request gate (defence beside the Host check): a drive-by page on
// another origin can hit 127.0.0.1 with the browser setting Host itself, so
// the Host gate alone does not stop it. Browsers stamp such requests with
// `Sec-Fetch-Site: cross-site` (and send an Origin on non-GET); requests from
// the app itself are `same-origin`, and direct navigations / non-browser
// clients (curl, node fetch) carry neither header — those stay allowed.
export function originAllowed(headers) {
  const sfs = headers['sec-fetch-site'];
  if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') return false;
  const origin = headers.origin;
  if (origin !== undefined && origin !== 'null') {
    try {
      const u = new URL(String(origin));
      if (!hostAllowed(u.host)) return false;
    } catch { return false; }
  } else if (origin === 'null') {
    return false; // opaque origin (sandboxed / file:) is not the app
  }
  return true;
}

export function sendJson(res, status, body, extraHeaders = null) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders ?? {}),
  });
  res.end(text);
}

export function sendError(res, err, extraHeaders = null) {
  const status = err instanceof HttpError ? err.status : 500;
  sendJson(res, status, errorBody(err instanceof HttpError ? err : { code: 'internal', message: 'internal error' }), extraHeaders);
}

export function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end();
}

// ---------------------------------------------------------------- router

export function createRouter() {
  const routes = []; // { method, segs: [{lit}|{name}], handler }

  function add(method, pattern, handler) {
    const segs = pattern.split('/').filter(Boolean).map((s) =>
      s.startsWith(':') ? { name: s.slice(1) } : { lit: s });
    routes.push({ method, segs, handler });
  }

  /** Decode the path once. Malformed percent-encoding (`%zz`) is a client
   *  typo, not a server bug: failure -> null -> no match -> 404, never an
   *  uncaught URIError turned into a 500. */
  function decodeParts(pathname) {
    try {
      return pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    } catch {
      return null;
    }
  }

  function matchRoute(r, decoded) {
    if (r.segs.length !== decoded.length) return null;
    const params = {};
    for (let i = 0; i < decoded.length; i++) {
      const seg = r.segs[i];
      if (seg.lit !== undefined) { if (seg.lit !== decoded[i]) return null; }
      else params[seg.name] = decoded[i];
    }
    return params;
  }

  function match(method, pathname) {
    const decoded = decodeParts(pathname);
    if (decoded === null) return null;
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchRoute(r, decoded);
      if (params) return { handler: r.handler, params };
    }
    return null;
  }

  /** Every method registered for this exact path, in registration order and
   *  de-duplicated. Used to answer 405 + `Allow` instead of a misleading 404
   *  for a path that plainly EXISTS under another method — a 404 there says
   *  "no such resource", which is not the recorded truth. */
  function methodsFor(pathname) {
    const decoded = decodeParts(pathname);
    if (decoded === null) return [];
    const out = [];
    for (const r of routes) {
      if (out.includes(r.method)) continue;
      if (matchRoute(r, decoded)) out.push(r.method);
    }
    return out;
  }

  return { add, match, methodsFor };
}

// ---------------------------------------------------------------- SSE

// Opens an SSE stream. Heartbeat is a comment line every `heartbeatMs`
// (SPEC §9: comment heartbeat every 15 s); the server closes after `done`.
export function sseOpen(res, { heartbeatMs = SSE_HEARTBEAT_MS } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write(': ok\n\n');
  let closed = false;
  const hb = setInterval(() => {
    if (!closed) { try { res.write(': hb\n\n'); } catch { /* closed */ } }
  }, heartbeatMs);
  if (hb.unref) hb.unref();

  const stream = {
    get closed() { return closed; },
    event(name, data) {
      if (closed) return;
      try {
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { closed = true; }
    },
    comment(text) {
      if (closed) return;
      try { res.write(`: ${String(text).replace(/\n/g, ' ')}\n\n`); } catch { closed = true; }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      try { res.end(); } catch { /* already gone */ }
    },
    onClientClose(fn) { res.on('close', fn); },
  };
  res.on('close', () => { closed = true; clearInterval(hb); });
  return stream;
}

// ---------------------------------------------------------------- server

// handle(req, res, { pathname, query, params }) — api handlers may throw
// HttpError. `fallback(req, res, pathname)` serves statics; returns true if
// it handled the request.
export function createHttpServer({ router, fallback = null, checkHost = true }) {
  const server = http.createServer(async (req, res) => {
    try {
      if (checkHost && !hostAllowed(req.headers.host)) {
        sendError(res, new HttpError(403, 'host-not-allowed',
          `Host header ${JSON.stringify(req.headers.host ?? '')} is not a local address`));
        return;
      }
      if (checkHost && !originAllowed(req.headers)) {
        sendError(res, new HttpError(403, 'cross-site-forbidden',
          'cross-site browser requests are rejected (Sec-Fetch-Site/Origin); open the app at its own URL'));
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;
      const m = router.match(req.method, pathname);
      if (m) {
        await m.handler(req, res, { pathname, query: url.searchParams, params: m.params });
        return;
      }
      if (pathname.startsWith('/api/')) {
        // A path that plainly EXISTS under another method is not "no such
        // route" — 404 there is a false statement about the resource.
        // Answer 405 and NAME the methods it does have. This is also why HEAD
        // is not blanket-aliased to the GET handler on /api/: a headers-only
        // probe of /api/session/:slug/:id would otherwise trigger a full
        // session parse. Deliberately NOT CORS preflight handling — the
        // cross-site rejection above is a boundary, and this 405 carries no
        // Access-Control-* header, so it grants a foreign origin nothing.
        const allowed = router.methodsFor(pathname);
        if (allowed.length) {
          sendError(res,
            new HttpError(405, 'method-not-allowed',
              `${req.method} is not supported for ${pathname}; this route answers ${allowed.join(', ')}`),
            { Allow: allowed.join(', ') });
          return;
        }
        sendError(res, new HttpError(404, 'unknown-route', `no route for ${req.method} ${pathname}`));
        return;
      }
      // HEAD serves GET's headers with no body. Node suppresses the
      // body for a HEAD response itself (_hasBody), so server/static.mjs needs
      // no change and the headers come out byte-identical to GET's.
      if (fallback && (req.method === 'GET' || req.method === 'HEAD')) {
        const served = await fallback(req, res, pathname);
        if (served) return;
      }
      sendError(res, new HttpError(404, 'not-found', `not found: ${pathname}`));
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else { try { res.end(); } catch { /* ignore */ } }
    }
  });
  return server;
}

export function listen(server, { port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      // A post-listen server 'error' must be logged, never an uncaught
      // exception that kills the process (the reject listener above is gone).
      server.on('error', (err) => {
        console.error(`[lens] http server error: ${err && err.message}`);
      });
      resolve(server.address());
    });
  });
}
