// server/errors.mjs — error envelope + Problem factory (group D).
// SPEC §9: all failures return { error: { code, message, detail? } } as JSON;
// no 2xx response ever carries an `error` key.

import { RETRY_AFTER_MS } from './limits.mjs';

export class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function httpError(status, code, message, detail) {
  return new HttpError(status, code, message, detail);
}

// Thrown by index accessors while a session is not yet indexed (SPEC §9: 409
// not-indexed-yet carries retryAfterMs + the same byte denominators as the R2
// pending state). api.mjs converts this to the 409 envelope.
export class PendingError extends Error {
  constructor({ retryAfterMs = RETRY_AFTER_MS, bytesIndexed = null, bytesTotal = null } = {}) {
    super('not indexed yet');
    this.name = 'PendingError';
    this.retryAfterMs = retryAfterMs;
    this.bytesIndexed = bytesIndexed;
    this.bytesTotal = bytesTotal;
  }
}

export function errorBody(err) {
  const code = err && err.code ? String(err.code) : 'internal';
  const message = err && err.message ? String(err.message) : 'internal error';
  const body = { error: { code, message } };
  if (err && err.detail !== undefined) body.error.detail = err.detail;
  return body;
}

const PROBLEM_CODES = new Set([
  'dir-unreadable', 'file-unreadable', 'torn-line', 'unknown-event-type',
  'unclassified-file', 'session-fragment', 'session-duplicate-id',
  'model-unpriced', 'cache-ttl-unrecorded', 'tier-assumed', 'usage-reconcile',
  'indexer-crashed', 'cache-corrupt', 'cache-write-failed', 'worker-exit',
  'prefix-only', 'dangling-origin-session', 'unreferenced-spill',
  'duplicate-message-id',
  // line 1 of a file may legitimately carry a UTF-8 BOM, which every reader
  // strips before JSON.parse. That strip is the one transform the raw-line
  // inspector performs on the recorded bytes, so it is disclosed rather than
  // done silently (severity note, affects nothing).
  'bom-stripped',
  // a turn bar whose recorded start/end span more calendar days than the
  // day-band walk will iterate. The walk stops at the cap, so the bar is
  // counted in fewer bands than its span touches — a bounded, disclosed
  // undercount instead of an unbounded synchronous loop.
  'day-span-capped',
  // index.json changed on disk while it was being read (another process
  // writing the same cache dir), so the bytes we hold are a torn snapshot of a
  // file that may be healthy right now. Distinct from `cache-corrupt` in the
  // one way that matters: the file is KEPT, not deleted.
  'cache-busy',
]);

// Problem factory (SPEC §9 Problem shape). Unknown codes are allowed and
// render as the raw string per SPEC; they are flagged with knownCode:false
// nowhere — the shape stays exactly the documented one.
export function problem(code, fields = {}) {
  const p = {
    code: String(code),
    severity: fields.severity ?? 'warning',
    scope: fields.scope ?? 'store',
    message: fields.message ?? String(code),
    affects: fields.affects ?? 'display',
    count: fields.count ?? 1,
  };
  for (const k of ['slug', 'id', 'agentId', 'runId', 'file', 'line', 'byteOffset', 'bytes']) {
    if (fields[k] !== undefined) p[k] = fields[k];
  }
  void PROBLEM_CODES; // closed enum kept for reference/tests
  return p;
}

export { PROBLEM_CODES };
