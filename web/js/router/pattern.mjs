// web/js/router/pattern.mjs — the route-pattern grammar and hash/URL helpers
// (DESIGN §0), pure: parse a hash, compile a pattern, match segments, resolve
// to the nearest registered ancestor, and build encoded hrefs. No shell, no
// window — everything here is testable without a DOM.
//
// ROUTE PATTERN GRAMMAR (DESIGN §0)
//   '/p/:slug/s/:sid'          — ':name' matches ONE segment, decodeURIComponent'd
//   '/p/:slug/s/:sid/x/*rel'   — '*name' consumes the REMAINDER, each segment
//                                decoded separately, joined with '/'.
//                                Also exposed as params.<name>Segments (array).
//   '/p/:slug/s/:sid/x'        — a pattern ENDING in the literal 'x' is
//                                auto-expanded to 'x/*rel' (DESIGN §0's
//                                "x consumes the remainder").
//   '…/e'  or  '…/e/:eventRef' — the L5 tail. Whichever form you write, the
//                                match yields params.line (1-based integer) and
//                                params.bi (dotted block path or null), split on
//                                the FIRST '.' after the line number (SPEC §8).

export function splitPath(path) {
  return String(path || '').split('/').filter((s) => s.length > 0);
}

/** '#/p/a/s/b?v=table' -> { path:'/p/a/s/b', segments:[…], query:URLSearchParams } */
export function parseHash(hash) {
  let raw = String(hash || '');
  if (raw.startsWith('#')) raw = raw.slice(1);
  if (!raw.startsWith('/')) raw = '/' + raw;
  const qIdx = raw.indexOf('?');
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const search = qIdx === -1 ? '' : raw.slice(qIdx + 1);
  return {
    path,
    segments: splitPath(path),          // still percent-encoded
    query: new URLSearchParams(search),
    search,
  };
}

export function compilePattern(pattern) {
  const raw = splitPath(pattern);
  const segs = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const last = i === raw.length - 1;
    if (s.startsWith('*')) {
      segs.push({ kind: 'rest', name: s.slice(1) || 'rel' });
    } else if (s.startsWith(':') && s.endsWith('*')) {
      // ':rel*' is accepted as a synonym for '*rel' — both mean "the remainder".
      segs.push({ kind: 'rest', name: s.slice(1, -1) || 'rel' });
    } else if (s.startsWith(':')) {
      segs.push({ kind: 'param', name: s.slice(1) });
    } else if (last && s === 'x') {
      // DESIGN §0 — `x` consumes the remainder of the hash.
      segs.push({ kind: 'lit', name: 'x' });
      segs.push({ kind: 'rest', name: 'rel' });
    } else if (last && s === 'e') {
      segs.push({ kind: 'lit', name: 'e' });
      segs.push({ kind: 'param', name: 'eventRef' });
    } else {
      segs.push({ kind: 'lit', name: s });
    }
  }
  const hasRest = segs.some((s) => s.kind === 'rest');
  // specificity: literals beat params beat remainders; longer beats shorter.
  let score = 0;
  for (const s of segs) score += s.kind === 'lit' ? 100 : s.kind === 'param' ? 10 : 1;
  return { pattern, segs, hasRest, score, length: segs.length };
}

function decode(seg) {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/** Match compiled pattern against ENCODED hash segments -> params | null. */
export function matchCompiled(compiled, segments) {
  const { segs, hasRest } = compiled;
  if (!hasRest && segments.length !== segs.length) return null;
  if (hasRest && segments.length < segs.length) return null;   // remainder needs ≥1 segment
  const params = Object.create(null);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind === 'lit') {
      if (decode(segments[i]) !== s.name) return null;
    } else if (s.kind === 'param') {
      params[s.name] = decode(segments[i]);
    } else {
      const rest = segments.slice(i).map(decode);
      params[s.name] = rest.join('/');
      params[s.name + 'Segments'] = rest;
      break;
    }
  }
  return finishParams(params);
}

export function matchRoute(pattern, segments) {
  return matchCompiled(compilePattern(pattern), segments);
}

/**
 * SPEC §8 — `e/<line>[.<bi>]`. The line number is everything before the FIRST
 * '.', the block path is everything after it (itself dotted: '4', '4.5',
 * 'r', 'r.3'). 1-based lines, as an editor shows them.
 */
export function splitEventRef(ref) {
  const s = String(ref === null || ref === undefined ? '' : ref);
  const dot = s.indexOf('.');
  const linePart = dot === -1 ? s : s.slice(0, dot);
  const biPart = dot === -1 ? null : s.slice(dot + 1);
  const line = /^[0-9]+$/.test(linePart) ? Number(linePart) : null;
  return {
    line: line && line >= 1 ? line : null,
    bi: biPart === null || biPart === '' ? null : biPart,
    raw: s,
    valid: !!(line && line >= 1),
  };
}

function finishParams(params) {
  if (params.eventRef !== undefined) {
    const { line, bi, valid, raw } = splitEventRef(params.eventRef);
    params.line = line;
    params.bi = bi;
    params.eventRefValid = valid;
    params.eventRefRaw = raw;
  }
  if (params.idx !== undefined) {
    params.idxNum = /^[0-9]+$/.test(params.idx) ? Number(params.idx) : null;
  }
  return params;
}

/** All ancestor segment-lists of a hash, nearest first, ending with []. */
export function ancestorsOf(segments) {
  const out = [];
  for (let n = segments.length - 1; n >= 0; n--) out.push(segments.slice(0, n));
  return out;
}

/**
 * Resolve encoded segments against a compiled route table.
 * -> { pattern, params, fallback:null | { requested, resolved, reason } }
 */
export function resolveRoute(segments, table) {
  const direct = bestMatch(segments, table);
  if (direct) return { pattern: direct.pattern, params: direct.params, fallback: null };
  for (const anc of ancestorsOf(segments)) {
    const m = bestMatch(anc, table);
    if (m) {
      return {
        pattern: m.pattern,
        params: m.params,
        fallback: {
          requested: '#/' + segments.join('/'),
          resolved: '#/' + anc.join('/'),
          reason: 'no page is registered for that address',
        },
      };
    }
  }
  return {
    pattern: null,
    params: Object.create(null),
    fallback: {
      requested: '#/' + segments.join('/'),
      resolved: '#/',
      reason: 'no routes are registered at all',
    },
  };
}

export function bestMatch(segments, table) {
  let best = null;
  for (const entry of table) {
    const params = matchCompiled(entry.compiled, segments);
    if (!params) continue;
    if (!best || entry.compiled.score > best.score) {
      best = { pattern: entry.pattern, params, score: entry.compiled.score };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * link builders
 * ------------------------------------------------------------------ */

/**
 * href('p', slug, 's', sid) -> '#/p/<enc>/s/<enc>'
 * A trailing plain object becomes the query string (null/'' entries dropped).
 * EVERY internal link in this app is a real <a href> built with this.
 */
export function href(...parts) {
  let query = null;
  const segs = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === null || p === undefined || p === '') continue;
    if (i === parts.length - 1 && typeof p === 'object' && !Array.isArray(p)) { query = p; continue; }
    if (Array.isArray(p)) { for (const s of p) if (s !== null && s !== undefined && s !== '') segs.push(enc(s)); continue; }
    segs.push(enc(p));
  }
  let out = '#/' + segs.join('/');
  const qs = queryString(query);
  if (qs) out += '?' + qs;
  return out;
}

function enc(s) { return encodeURIComponent(String(s)); }

export function queryString(query) {
  if (!query) return '';
  const usp = query instanceof URLSearchParams ? query : new URLSearchParams();
  if (!(query instanceof URLSearchParams)) {
    for (const k of Object.keys(query)) {
      const v = query[k];
      if (v === null || v === undefined || v === '') continue;
      usp.set(k, String(v));
    }
  }
  const s = usp.toString();
  return s;
}

/** Same hash, different query params. Unknown existing params are preserved. */
export function withQuery(hash, changes) {
  const { path, query } = parseHash(hash);
  for (const k of Object.keys(changes || {})) {
    const v = changes[k];
    if (v === null || v === undefined || v === '') query.delete(k);
    else query.set(k, String(v));
  }
  const qs = query.toString();
  return '#' + path + (qs ? '?' + qs : '');
}
