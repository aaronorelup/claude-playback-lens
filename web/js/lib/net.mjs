// web/js/lib/net.mjs — the drill views' one door to the server: the kit()
// bundle of group-E foundation modules, plus the raw-byte and JSON-write
// fetch helpers that api.mjs does not carry itself.

import { formatUsd } from '../format.mjs';
import { api, sse, isPending, apiUrl as buildApiUrl } from '../api.mjs';
import { rowsPane } from '../components/rows.mjs';
import { jsonview } from '../components/jsonview.mjs';
import { costfigure } from '../components/costfigure.mjs';
import { vtable } from '../components/vtable.mjs';

const KIT = { api, sse, isPending, rowsPane, jsonview, costfigure, vtable, formatUsd };

/** The group E foundation, as one object. Async purely so that every drill
 *  view reads the foundation through a single shape. */
export async function kit() { return KIT; }

/** Absolute same-origin URL for a server route (api.mjs owns the encoding). */
export function apiUrl(path, params) { return buildApiUrl(path, params); }

/** Raw (non-JSON) body fetch; optional byte Range. `/api/file` serves bytes. */
export async function fetchRaw(path, params, { rangeBytes = null, signal } = {}) {
  const headers = {};
  if (rangeBytes) headers.Range = `bytes=0-${rangeBytes - 1}`;
  const res = await fetch(apiUrl(path, params), { headers, signal });
  if (!res.ok && res.status !== 206) {
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    throw {
      status: res.status,
      code: body?.error?.code ?? `http-${res.status}`,
      message: body?.error?.message ?? res.statusText,
    };
  }
  const text = await res.text();
  const cr = res.headers.get('content-range');
  let total = null;
  if (cr) { const mm = /\/(\d+)$/.exec(cr); if (mm) total = Number(mm[1]); }
  else { const cl = res.headers.get('content-length'); if (cl) total = Number(cl); }
  return { text, status: res.status, bytes: text.length, total, partial: res.status === 206 };
}

/** PUT/POST a JSON body (api() carries the method and the error envelope).
 *  Takes an optional `signal` so a view can obey the STALE-RENDER RULE
 *  ("MUST pass { signal: ctx.signal } to every fetch") for its writes too. */
export async function sendJson(path, body, method = 'PUT', { signal } = {}) {
  return api(path, null, { method, body: body ?? {}, signal });
}
