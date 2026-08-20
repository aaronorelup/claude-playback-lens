// server/scan.mjs — store walk and session grouping (SPEC §2, §9).
//
// Store facts this module encodes (measured, docs/research/_digest.md):
// - <projectsDir>/<slug>/<sessionId>.jsonl is a main transcript; a session is
//   keyed by sessionId ALONE. A <sessionId>/ directory in ANY project whose
//   sessionId has a main .jsonl elsewhere unions into that session (2 of 85
//   sessions span 2–3 project dirs). A truly orphaned fragment dir (no main
//   anywhere) attaches to the project dir that physically holds it, disclosed.
// - Session -> project = the dir holding the main .jsonl (85/85 unique).
// - memory/*.md are project-level files.
// - NEVER writes into the projects folder.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The one canonical session-id predicate: strict 8-4-4-4-12 UUID, matched
// case-insensitively, normalised to lowercase where captured. audit.mjs keeps
// its own textual copy (Path B independence) — a fixture test pins that the
// two classify identically.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// scanStore(projectsDir) -> FileTable: Map<relFromProjectsDir(POSIX), {size, mtimeMs}>
// Extra properties on the returned Map (additive):
//   .tookMs    — wall time of the walk
//   .problems  — [{code:'dir-unreadable'|'file-unreadable', severity, scope, file, message, affects, count}]
// Rel keys use POSIX separators; on win32 lookups should compare case-insensitively
// (SPEC §9 rel grammar) — keys are stored as found on disk.
// ---------------------------------------------------------------------------
export async function scanStore(projectsDir) {
  const t0 = Date.now();
  const table = new Map();
  const problems = [];
  const root = path.resolve(projectsDir);

  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      problems.push({
        code: 'dir-unreadable', severity: 'warning', scope: relDir ? 'project' : 'store',
        file: relDir || '.', message: `readdir failed: ${err.code || err.message}`,
        affects: 'aggregates', count: 1,
      });
      return;
    }
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(path.join(absDir, ent.name), rel);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(path.join(absDir, ent.name));
          table.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
        } catch (err) {
          problems.push({
            code: 'file-unreadable', severity: 'warning', scope: 'file',
            file: rel, message: `stat failed: ${err.code || err.message}`,
            affects: 'aggregates', count: 1,
          });
        }
      } else {
        // Symlinks/junctions: DISCLOSE, DO NOT FOLLOW. readdir(withFileTypes)
        // does not resolve links, so a symlink/junction Dirent answers false
        // to both isDirectory() and isFile() — left unhandled it would vanish
        // from the store with no card AND no Problem, while the two
        // neighbouring failure modes above (dir-unreadable, file-unreadable)
        // both disclose.
        //
        // Following the link is deliberately NOT done. resolveFileRef
        // (server/api/fileref.mjs) enforces containment by string-prefix on the
        // FileTable key and never realpaths, so tabling entries reached through
        // a junction whose target lives outside the store would let /api/file
        // and /api/image stream arbitrary out-of-tree files while passing the
        // guard; and walking needs cycle detection (a junction pointing at an
        // ancestor loops here forever). Following would require an
        // fsp.realpath containment check per entry plus a visited-realpath set,
        // and only then.
        problems.push({
          code: 'unclassified-file', severity: 'note', scope: 'file', file: rel,
          message: ent.isSymbolicLink()
            ? 'symlink/junction skipped (not followed)'
            : 'non-regular directory entry skipped',
          affects: 'display', count: 1,
        });
      }
    }
  }

  await walk(root, '');
  table.tookMs = Date.now() - t0;
  table.problems = problems;
  return table;
}

// ---------------------------------------------------------------------------
// groupSessions(fileTable) ->
//   { projects: [{ slug, sessionIds, memoryFiles, bytes }],
//     sessions: [{ id, slug, mainRel|null, files:[rel], bytes, fragmentDirs:[{slug, rel}] }],
//     problems: [Problem] }   // additive third key
//
// All rel paths are projectsDir-relative POSIX (same keys as the FileTable).
// fragmentDirs lists, per session, every <sessionId>/ directory that lives under
// a project other than the owning one (case a), or — for a true orphan — every
// holding dir beyond the assigned one (case b). files[] always contains the
// union of the session's files across all fragment dirs.
// ---------------------------------------------------------------------------
export function groupSessions(fileTable) {
  const problems = [];
  // slug -> project accumulator
  const projects = new Map();
  // sessionId -> { mains: [{slug, rel}], dirs: Map<slug, rel[]> }
  const sess = new Map();

  const proj = (slug) => {
    let p = projects.get(slug);
    if (!p) { p = { slug, sessionIds: [], memoryFiles: [], bytes: 0 }; projects.set(slug, p); }
    return p;
  };
  const sessOf = (id) => {
    let s = sess.get(id);
    if (!s) { s = { mains: [], dirs: new Map() }; sess.set(id, s); }
    return s;
  };

  for (const [rel, info] of fileTable) {
    const slash = rel.indexOf('/');
    if (slash === -1) {
      // file at the projects root: none observed; count it nowhere but disclose
      problems.push({
        code: 'unclassified-file', severity: 'note', scope: 'store', file: rel,
        message: 'file directly under projectsDir', affects: 'display', count: 1,
      });
      continue;
    }
    const slug = rel.slice(0, slash);
    const rest = rel.slice(slash + 1);
    const p = proj(slug);
    p.bytes += info.size;

    const restSlash = rest.indexOf('/');
    if (restSlash === -1) {
      // <slug>/<name> — a main transcript iff <uuid>.jsonl
      const m = /^(.+)\.jsonl$/.exec(rest);
      if (m && UUID_RE.test(m[1])) {
        sessOf(m[1].toLowerCase()).mains.push({ slug, rel });
      } else {
        problems.push({
          code: 'unclassified-file', severity: 'note', scope: 'project', slug, file: rel,
          message: 'unrecognised project-level file', affects: 'display', count: 1,
        });
      }
      continue;
    }
    const top = rest.slice(0, restSlash);
    if (top === 'memory') {
      p.memoryFiles.push(rel);
      continue;
    }
    if (UUID_RE.test(top)) {
      const id = top.toLowerCase();
      const s = sessOf(id);
      let list = s.dirs.get(slug);
      if (!list) { list = []; s.dirs.set(slug, list); }
      list.push(rel);
      continue;
    }
    problems.push({
      code: 'unclassified-file', severity: 'note', scope: 'project', slug, file: rel,
      message: `unrecognised path under project: ${rest}`, affects: 'display', count: 1,
    });
  }

  const sessions = [];
  for (const [id, s] of sess) {
    let mainRel = null;
    let owner = null;
    if (s.mains.length > 0) {
      // 85/85 unique in this corpus; a duplicate id across projects is disclosed
      // and resolved deterministically (lexicographically smallest slug).
      const sorted = [...s.mains].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      mainRel = sorted[0].rel;
      owner = sorted[0].slug;
      if (sorted.length > 1) {
        problems.push({
          code: 'session-duplicate-id', severity: 'warning', scope: 'session', id,
          message: `main transcript for ${id} exists in ${sorted.length} projects; owned by ${owner} (lexicographic rule)`,
          affects: 'aggregates', count: sorted.length,
        });
      }
    } else {
      // true orphan fragment: assign to the (lexicographically smallest) holding project
      owner = [...s.dirs.keys()].sort()[0];
      problems.push({
        code: 'session-fragment', severity: 'note', scope: 'session', slug: owner, id,
        message: 'fragment, no main transcript anywhere in the store',
        affects: 'display', count: 1,
      });
    }

    const files = [];
    const fragmentDirs = [];
    let bytes = 0;
    for (const m of s.mains) {
      files.push(m.rel);
      bytes += fileTable.get(m.rel)?.size ?? 0;
    }
    for (const [slug, rels] of s.dirs) {
      for (const rel of rels) {
        files.push(rel);
        bytes += fileTable.get(rel)?.size ?? 0;
      }
      // A session-dir under a project other than the owning one is a fragment
      // dir (case a union, or the extra holders of an orphan). The orphan case
      // itself is signalled by mainRel === null, not by this list.
      if (slug !== owner) fragmentDirs.push({ slug, rel: `${slug}/${id}` });
    }
    files.sort();
    sessions.push({ id, slug: owner, mainRel, files, bytes, fragmentDirs });
    proj(owner).sessionIds.push(id);
  }

  sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const projectList = [...projects.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of projectList) { p.sessionIds.sort(); p.memoryFiles.sort(); }
  return { projects: projectList, sessions, problems };
}

// ---------------------------------------------------------------------------
// fingerprint(sessionFiles) — sha1 hex over the sorted (rel, size, mtimeMs) tuples
// of a session's whole file tree (SPEC §9 cache & liveness).
// ---------------------------------------------------------------------------
export function fingerprint(sessionFiles) {
  const rows = [...sessionFiles]
    .map((f) => `${f.rel}\u0000${f.size}\u0000${f.mtimeMs}`)
    .sort();
  const h = createHash('sha1');
  for (const r of rows) h.update(r, 'utf8');
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// readMemoryMeta(absPath) — additive helper (SPEC §8 memory files): parses YAML
// frontmatter far enough to extract metadata.originSessionId. Returns
// { originSessionId: string|null }. No YAML dependency: the recorded frontmatter
// is simple `key: value` lines; anything unparseable yields null (unknown, not 0).
// ---------------------------------------------------------------------------
export async function readMemoryMeta(absPath) {
  let text;
  try {
    text = await fsp.readFile(absPath, 'utf8');
  } catch {
    return { originSessionId: null };
  }
  if (!text.startsWith('---')) return { originSessionId: null };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { originSessionId: null };
  const fm = text.slice(0, end);
  const m = /originSessionId:\s*["']?([0-9a-f-]{36})["']?/i.exec(fm);
  return { originSessionId: m ? m[1].toLowerCase() : null };
}
