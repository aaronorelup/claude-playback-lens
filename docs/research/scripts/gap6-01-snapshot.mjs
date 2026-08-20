// gap6-01-snapshot.mjs — PIN the live corpus.
// Writes gap6-manifest.json: every .jsonl file with the byte length it had at
// snapshot time. All later gap6-* scripts read ONLY up to that offset, so every
// number in gap-6.md refers to one identical snapshot of a corpus that is still
// being appended to.
import fs from 'node:fs';
import { walkJsonl, MANIFEST, ROOT } from './gap6-lib.mjs';

const t0 = Date.now();
const files = walkJsonl();
const snapshot = {
  snapshotUtc: new Date().toISOString(),
  root: ROOT,
  files,
  totals: {
    files: files.length,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    byTier: {},
  },
};
for (const f of files) {
  const t = snapshot.totals.byTier[f.tier] ||= { files: 0, bytes: 0 };
  t.files++; t.bytes += f.bytes;
}
fs.writeFileSync(MANIFEST, JSON.stringify(snapshot, null, 1));
console.log('snapshot', snapshot.snapshotUtc, 'files', files.length, 'bytes', snapshot.totals.bytes,
  'in', Date.now() - t0, 'ms');
console.log(JSON.stringify(snapshot.totals.byTier, null, 1));
const projects = new Set(files.map(f => f.project));
const sessions = new Set(files.map(f => f.session).filter(Boolean));
console.log('projects', projects.size, 'sessions', sessions.size);
