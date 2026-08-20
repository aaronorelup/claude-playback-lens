// server/api/fileref.mjs — path guards for every file-ish route. Owns the
// SPEC §9 rel grammar (session-relative, mem/<name>, frag/<slug>/<rel>), the
// FileTable membership check, and the win32-aware path comparisons.

import path from 'node:path';
import { httpError } from '../errors.mjs';

export const IS_WIN = process.platform === 'win32';

// Every file-ish route resolves inside projectsDir AND appears in the
// current FileTable; POSIX rel, case-insensitive compare on win32; no `..`
// ever (SPEC §9 security).
const BAD_SEG = new Set(['', '.', '..']);

export function assertCleanRel(rel) {
  if (typeof rel !== 'string' || rel === '') throw httpError(403, 'path-forbidden', 'empty rel');
  if (rel.includes('\\') || rel.includes(':') || rel.startsWith('/')) {
    throw httpError(403, 'path-forbidden', 'rel must be POSIX-relative with no drive or backslash');
  }
  for (const seg of rel.split('/')) {
    if (BAD_SEG.has(seg)) throw httpError(403, 'path-forbidden', 'rel contains a forbidden segment');
  }
}

// Win32-aware directory equality — never a raw string compare (the same case
// rule tableLookup applies to FileTable keys: one case rule per platform).
export function sameDir(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return IS_WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

const tableIndexCache = new WeakMap(); // fileTable -> Map<lowerKey, key>
export function tableLookup(fileTable, rel) {
  if (fileTable.has(rel)) return rel;
  if (!IS_WIN) return null;
  let idx = tableIndexCache.get(fileTable);
  if (!idx) {
    idx = new Map();
    for (const k of fileTable.keys()) idx.set(k.toLowerCase(), k);
    tableIndexCache.set(fileTable, idx);
  }
  return idx.get(rel.toLowerCase()) ?? null;
}

// Resolves the /api/file rel grammar: session-relative rel, or mem/<name>
// (id omitted), or frag/<otherSlug>/<relpath>. Returns { abs, tableRel }.
export function resolveFileRef(ctx, { slug, id, rel }) {
  assertCleanRel(rel);
  if (slug) assertCleanRel(slug);
  if (id) assertCleanRel(id);
  const fileTable = ctx.index.fileTable();
  const candidates = [];
  if (rel.startsWith('frag/')) {
    candidates.push(rel.slice('frag/'.length)); // frag/<otherSlug>/<relpath>
  } else if (rel.startsWith('mem/')) {
    if (!slug) throw httpError(403, 'path-forbidden', 'mem/ rel requires a project slug');
    candidates.push(`${slug}/memory/${rel.slice('mem/'.length)}`);
  } else if (id) {
    candidates.push(`${slug}/${id}/${rel}`);
    if (rel === `${id}.jsonl`) candidates.push(`${slug}/${rel}`); // the main transcript
  } else {
    candidates.push(`${slug}/${rel}`); // project-level file, id omitted
  }
  for (const cand of candidates) {
    if (cand.split('/').some((seg) => BAD_SEG.has(seg))) continue;
    const key = tableLookup(fileTable, cand);
    if (key === null) continue;
    const abs = path.resolve(ctx.projectsDir, ...key.split('/'));
    const root = path.resolve(ctx.projectsDir);
    const a = IS_WIN ? abs.toLowerCase() : abs;
    const r = IS_WIN ? root.toLowerCase() : root;
    if (a !== r && !a.startsWith(r + path.sep)) {
      throw httpError(403, 'path-forbidden', 'resolved path escapes the projects directory');
    }
    return { abs, tableRel: key };
  }
  throw httpError(403, 'path-forbidden', 'path is not in the current file table');
}

// Store-relative rel -> the session-relative spelling of SPEC §9's /api/file
// & /api/image grammar — the server's own locators must pass its own guard
// (store-relative rels 403).
export function sessionRelOf(slug, id, relFromProjects) {
  const rel = String(relFromProjects ?? '');
  if (rel === `${slug}/${id}.jsonl`) return `${id}.jsonl`;
  const prefix = `${slug}/${id}/`;
  if (rel.startsWith(prefix)) return rel.slice(prefix.length);
  if (!rel.includes('/')) return rel; // already session-relative
  return `frag/${rel}`; // cross-project fragment file
}
