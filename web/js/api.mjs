// web/js/api.mjs — the one door to the server (SPEC §9).
//
// Contract (BUILD-CONTRACTS group E):
//   api(path, params)  -> parsed JSON; throws {status, code, message}
//                         409 not-indexed-yet is NOT thrown — it returns
//                         { pending: { retryAfterMs, bytesIndexed, bytesTotal } }
//                         so a view can render its determinate loading state.
//   sse(path, params, handlers)  -> { close() }   SPEC §9 event vocabulary
//   pricing()          -> shared/pricing.mjs, imported once and cached
//
// Error envelope (SPEC §9): every failure is `{ error: { code, message, detail? } }`.
// No 2xx response ever carries an `error` key; advisories ride `problems[]`.

import { setPricingModule } from './format.mjs';

/** Thrown for every non-2xx that is not a 409 pending. */
export class ApiError extends Error {
  constructor({ status, code, message, detail, path }) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.path = path;
  }
  /** DESIGN §0: 404 resolves upward with a banner; 400/403 never do. */
  get resolvesUpward() { return this.status === 404; }
}

/** Pure: build a URL for a route + params. Null/undefined params are dropped. */
export function apiUrl(path, params) {
  const p = String(path || '').startsWith('/') ? path : '/' + path;
  const qs = toQuery(params);
  return qs ? `${p}?${qs}` : p;
}

export function toQuery(params) {
  if (!params) return '';
  if (typeof params === 'string') return params.replace(/^\?/, '');
  if (typeof URLSearchParams !== 'undefined' && params instanceof URLSearchParams) return params.toString();
  const usp = new URLSearchParams();
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) { for (const item of v) usp.append(key, String(item)); continue; }
    usp.append(key, String(v));
  }
  return usp.toString();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read the 409 denominators wherever the server chose to hang them. */
export function readPending(payload, status) {
  const err = (payload && payload.error) || {};
  const det = err.detail || {};
  const src = [det, err, payload || {}];
  const pick = (k) => { for (const o of src) if (o && o[k] !== undefined) return o[k]; return undefined; };
  return {
    status: status || 409,
    code: err.code || 'not-indexed-yet',
    message: err.message || 'the index is still building',
    retryAfterMs: num(pick('retryAfterMs')) ?? 1000,
    bytesIndexed: num(pick('bytesIndexed')),
    bytesTotal: num(pick('bytesTotal')),
    sessionsDone: num(pick('sessionsDone')),
    sessionsOf: num(pick('of')) ?? num(pick('sessionsOf')),
  };
}

/** True for the 409 not-indexed-yet shape returned (never thrown) by api().
 *  A healthy /api/index payload carries its OWN `pending[]` ARRAY of
 *  not-yet-summarised sessions (SPEC §9) — and `typeof [] === 'object'`, so
 *  the array must be excluded or every healthy index renders "building
 *  forever" (integration fix; regression pinned in tests/web-api.test.mjs). */
export function isPending(result) {
  const p = result && typeof result === 'object' ? result.pending : null;
  return !!(p && typeof p === 'object' && !Array.isArray(p));
}

/** Pure: turn a fetch Response + parsed body into a result or an ApiError. */
export function interpret({ status, ok, statusText, payload, path }) {
  if (status === 204) return null;                       // /api/index?since=N, unchanged
  if (status === 409) return { pending: readPending(payload, status) };
  if (ok) return payload;
  const err = (payload && payload.error) || {};
  throw new ApiError({
    status,
    code: err.code || `http-${status}`,
    message: err.message || statusText || `HTTP ${status}`,
    detail: err.detail,
    path,
  });
}

/**
 * GET (or method) a JSON route.
 * @returns parsed JSON, `null` for 204, or a pending object for 409.
 */
export async function api(path, params, { signal, method = 'GET', body, headers } = {}) {
  const url = apiUrl(path, params);
  const init = {
    method,
    signal,
    headers: Object.assign({ accept: 'application/json' }, headers || {}),
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    if (cause && cause.name === 'AbortError') throw cause;
    throw new ApiError({ status: 0, code: 'network', message: `cannot reach the local server (${url})`, path: url });
  }
  let payload = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
  }
  return interpret({ status: res.status, ok: res.ok, statusText: res.statusText, payload, path: url });
}

/**
 * api() that keeps re-polling while the server answers 409 not-indexed-yet.
 * `onPending(pending)` is called before every wait so the view can paint its
 * determinate progress (bytesIndexed / bytesTotal — never a spinner).
 */
export async function apiUntilReady(path, params, { signal, onPending, maxWaitMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now();
  for (;;) {
    const out = await api(path, params, { signal });
    if (!isPending(out)) return out;
    if (onPending) onPending(out.pending);
    if (Date.now() - started > maxWaitMs) return out;
    await sleep(Math.max(250, Math.min(5000, out.pending.retryAfterMs || 1000)), signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(signal.reason || new Error('aborted')); return; }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
    }
  });
}

/* ------------------------------------------------------------------ *
 * SSE  (SPEC §9 vocabulary: progress · match · skip · problem · invariant
 *       · done · error; comment heartbeat every 15s; server closes after done)
 * ------------------------------------------------------------------ */

export const SSE_EVENTS = ['progress', 'pending', 'match', 'skip', 'problem', 'invariant', 'done', 'error'];

/**
 * sse(path, params, handlers) -> { close(), get url(), get closed() }
 * Handlers receive the parsed JSON payload of their event.
 * `handlers.error` also receives transport failures as
 * `{ code:'stream-error', message }` so a view never hangs on a dead stream.
 */
export function sse(path, params, handlers = {}) {
  const url = apiUrl(path, params);
  let closed = false;
  const source = new EventSource(url);

  const close = () => {
    if (closed) return;
    closed = true;
    try { source.close(); } catch { /* already closed */ }
  };

  for (const name of SSE_EVENTS) {
    source.addEventListener(name, (ev) => {
      if (closed) return;
      // A transport-level failure also fires as type 'error' but carries NO
      // payload — that case belongs to the transport listener below, which
      // reports {code:'stream-error'} instead of a bare null.
      if (name === 'error' && !(ev && typeof ev.data === 'string' && ev.data.length)) return;
      let data = null;
      if (ev && typeof ev.data === 'string' && ev.data.length) {
        try { data = JSON.parse(ev.data); } catch { data = { raw: ev.data }; }
      }
      const fn = handlers[name];
      if (typeof fn === 'function') {
        try { fn(data, ev); } catch (e) { reportHandlerError(handlers, name, e); }
      }
      // `done` AND `error` are terminal in this app's SSE vocabulary (SPEC §9:
      // the server closes after either). Closing here stops EventSource's
      // automatic reconnect from re-issuing a failed full-corpus scan every
      // ~3s forever.
      if (name === 'done' || name === 'error') close();
    });
  }

  source.addEventListener('error', () => {
    // EventSource's own transport error (distinct from `event: error` above).
    // Close UNCONDITIONALLY: whatever state the source is in, auto-reconnect
    // would replay the whole scan — the view owns the retry decision.
    if (closed) return;
    closed = true;
    try { source.close(); } catch { /* already closed */ }
    if (typeof handlers.error === 'function') {
      handlers.error({ code: 'stream-error', message: 'the event stream closed unexpectedly' });
    }
  });

  return {
    close,
    get url() { return url; },
    get closed() { return closed; },
    get readyState() { return source.readyState; },
  };
}

function reportHandlerError(handlers, name, e) {
  if (typeof handlers.error === 'function') {
    handlers.error({ code: 'handler-failed', message: `${name} handler threw: ${e && e.message}` });
  } else {
    console.error(`[lens] sse ${name} handler failed`, e);
  }
}

/* ------------------------------------------------------------------ *
 * shared/pricing.mjs — imported ONCE, cached, and handed to format.mjs
 * ------------------------------------------------------------------ */

let _pricingUrl = new URL('../../shared/pricing.mjs', import.meta.url).href;
let _pricingPromise = null;

/** Override where shared/pricing.mjs is served from (default: /shared/pricing.mjs). */
export function setPricingUrl(url) { _pricingUrl = url; _pricingPromise = null; }

/**
 * The pricing module (SPEC §6 single source of truth), dynamically imported once.
 * Resolves to the module; rejects only if the server does not serve it — callers
 * degrade to "rate table unavailable" and print recorded token totals only.
 */
export function pricing() {
  if (!_pricingPromise) {
    _pricingPromise = import(/* @vite-ignore */ _pricingUrl).then((mod) => {
      setPricingModule(mod);
      return mod;
    });
  }
  return _pricingPromise;
}

/** Non-throwing form: resolves to the module or to null. */
export async function pricingOrNull() {
  try { return await pricing(); } catch { return null; }
}
