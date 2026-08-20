// tests/stubs/store — a stand-in for server/scan.mjs (group B), so the worker
// protocol can be tested without a 1.15 GB corpus and without group B existing.
//
// The "corpus" is a JSON file at $LENS_TEST_WORLD: { files: [{rel,size,mtimeMs}] }.
// The test mutates that file to simulate a session changing on disk.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function scanStore(_projectsDir) {
  const world = JSON.parse(await readFile(process.env.LENS_TEST_WORLD, 'utf8'));
  const ft = new Map();
  for (const f of world.files) ft.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs });
  ft.tookMs = 1;
  return ft;
}

export function groupSessions(fileTable) {
  const sessions = new Map();
  const projects = new Map();

  for (const [rel, st] of fileTable) {
    const parts = rel.split('/');
    const slug = parts[0];
    if (!projects.has(slug)) projects.set(slug, { slug, sessionIds: new Set(), memoryFiles: [], bytes: 0 });
    const proj = projects.get(slug);
    proj.bytes += st.size;

    let id = null;
    let isMain = false;
    if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
      id = parts[1].slice(0, -6);
      isMain = true;
    } else if (parts.length > 2) {
      id = parts[1];
    }
    if (!id) continue;

    let s = sessions.get(id);
    if (!s) {
      s = { id, slug, mainRel: null, files: [], bytes: 0, fragmentDirs: [] };
      sessions.set(id, s);
    }
    if (isMain) {
      s.mainRel = rel;
      s.slug = slug; // owning project = the dir holding the main .jsonl
    }
    s.files.push(rel);
    s.bytes += st.size;
    proj.sessionIds.add(id);
  }

  return {
    projects: Array.from(projects.values()).map((p) => ({ ...p, sessionIds: Array.from(p.sessionIds) })),
    sessions: Array.from(sessions.values()),
  };
}

export function fingerprint(sessionFiles) {
  const h = createHash('sha1');
  for (const f of sessionFiles) h.update(`${f.rel}\u0000${f.size}\u0000${f.mtimeMs}\n`);
  return h.digest('hex');
}
