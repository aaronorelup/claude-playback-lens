// server/api/params.mjs — query-parameter readers and the JSON body reader.
// The one validation vocabulary every route shares: missing-param, bad-param,
// body-too-large, bad-json.

import { httpError } from '../errors.mjs';
import { BODY_LIMIT_BYTES } from '../limits.mjs';

export function intParam(query, name, { def = null, min = null, max = null, required = false } = {}) {
  const raw = query.get(name);
  if (raw === null || raw === '') {
    if (required) throw httpError(400, 'missing-param', `missing required param: ${name}`);
    return def;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw httpError(400, 'bad-param', `param ${name} must be an integer, got ${JSON.stringify(raw)}`);
  if (min !== null && n < min) throw httpError(400, 'bad-param', `param ${name} must be >= ${min}`);
  if (max !== null && n > max) return max; // caps clamp, they do not reject
  return n;
}

export function strParam(query, name, { required = false } = {}) {
  const raw = query.get(name);
  if ((raw === null || raw === '') && required) throw httpError(400, 'missing-param', `missing required param: ${name}`);
  return raw ?? null;
}

export async function readBody(req, { limit = BODY_LIMIT_BYTES } = {}) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(400, 'body-too-large', 'request body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw httpError(400, 'bad-json', 'request body is not valid JSON'); }
}
