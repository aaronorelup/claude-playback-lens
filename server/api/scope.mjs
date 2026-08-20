// server/api/scope.mjs — the scope grammar shared by every scoped route
// (parseScope/scopeString), plus the catastrophic-backtracking pre-check for
// user-supplied find regexes. Nothing here touches the index or the disk.

import { httpError } from '../errors.mjs';

// scope=store | project:<slug> | session:<slug>/<id> | turn:<slug>/<id>/<idx>
// | agent:<slug>/<id>/<agentId> — components percent-encoded (SPEC §9).
export function parseScope(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'store') return { kind: 'store' };
  const s = String(raw);
  const colon = s.indexOf(':');
  if (colon === -1) throw httpError(400, 'bad-scope', `unparseable scope: ${s}`);
  const kind = s.slice(0, colon);
  let parts;
  try {
    parts = s.slice(colon + 1).split('/').map((p) => decodeURIComponent(p));
  } catch {
    throw httpError(400, 'bad-scope', `scope components are not valid percent-encoding: ${s}`);
  }
  if (parts.some((p) => p === '')) throw httpError(400, 'bad-scope', `empty scope component: ${s}`);
  const need = (n) => {
    if (parts.length !== n) throw httpError(400, 'bad-scope', `scope ${kind}: expected ${n} component(s), got ${parts.length}`);
  };
  switch (kind) {
    case 'project': need(1); return { kind, slug: parts[0] };
    case 'session': need(2); return { kind, slug: parts[0], id: parts[1] };
    case 'turn': {
      need(3);
      const idx = Number(parts[2]);
      if (!Number.isInteger(idx) || idx < 0) throw httpError(400, 'bad-scope', `turn idx must be a non-negative integer: ${parts[2]}`);
      return { kind, slug: parts[0], id: parts[1], idx };
    }
    case 'agent': need(3); return { kind, slug: parts[0], id: parts[1], agentId: parts[2] };
    default: throw httpError(400, 'bad-scope', `unknown scope kind: ${kind}`);
  }
}

export function scopeString(scope) {
  switch (scope.kind) {
    case 'store': return 'store';
    case 'project': return `project:${encodeURIComponent(scope.slug)}`;
    case 'session': return `session:${encodeURIComponent(scope.slug)}/${encodeURIComponent(scope.id)}`;
    case 'turn': return `turn:${encodeURIComponent(scope.slug)}/${encodeURIComponent(scope.id)}/${scope.idx}`;
    case 'agent': return `agent:${encodeURIComponent(scope.slug)}/${encodeURIComponent(scope.id)}/${encodeURIComponent(scope.agentId)}`;
    default: return 'store';
  }
}

// Catastrophic-backtracking shape pre-check for user-supplied find regexes
// (SEC: a sync rx.exec cannot be aborted; an exponential pattern hangs the
// single-threaded server). Conservative by design: an unbounded quantifier
// applied to a group whose body itself contains an unbounded quantifier is
// rejected. Returns a human-readable shape name, or null when acceptable.
export function catastrophicShape(src) {
  let s = String(src);
  s = s.replace(/\\./g, 'x');            // escaped chars are plain atoms
  s = s.replace(/\[[^\]]*\]/g, 'C');     // character classes are plain atoms
  const hasQuantAtDepth = [false];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') { hasQuantAtDepth.push(false); continue; }
    if (ch === ')') {
      const inner = hasQuantAtDepth.pop() ?? false;
      const rest = s.slice(i + 1);
      const unbounded = /^([+*]|\{\d+,\})/.test(rest);
      if (inner && unbounded) return 'an unbounded quantifier over a group that itself contains an unbounded quantifier';
      if (hasQuantAtDepth.length) {
        hasQuantAtDepth[hasQuantAtDepth.length - 1] =
          hasQuantAtDepth[hasQuantAtDepth.length - 1] || inner || unbounded;
      }
      continue;
    }
    if (ch === '+' || ch === '*') { hasQuantAtDepth[hasQuantAtDepth.length - 1] = true; continue; }
    if (ch === '{' && /^\{\d+,\}/.test(s.slice(i))) hasQuantAtDepth[hasQuantAtDepth.length - 1] = true;
  }
  return null;
}
