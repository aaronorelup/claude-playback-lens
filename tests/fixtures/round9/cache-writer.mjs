// tests/fixtures/round9/cache-writer.mjs — a REAL second process for R9-F1.
//
// Two OS processes pointed at one cache dir is the finding's exact shape (two
// instances of the same install with different --port share <app>/.cache by
// default). This child drives the app's own unmodified atomicWriteFile at the
// shared index.json and reports what it saw; the test runs two of these plus a
// reader and asserts nobody had to lie about a write that worked.
//
// argv: <cacheDir> <tag> <count> <padChars> <outFile> [fixedTmp]
//
// `fixedTmp` passes the pre-R9-F1 intermediate name (`index.json.tmp`) through
// atomicWriteFile's existing tmpSuffix option, so the test can run the same
// storm both ways and show the collision it removed.

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const [cacheDir, tag, countRaw, padRaw, outFile, fixedTmp] = process.argv.slice(2);
const count = Number(countRaw);
const pad = tag.repeat(Number(padRaw));
const writeOpts = fixedTmp === 'fixed-tmp' ? { tmpSuffix: '.tmp' } : {};

const storeUrl = pathToFileURL(path.join(HERE, '..', '..', '..', 'server', 'index-store.mjs')).href;
const { atomicWriteFile, indexPath, INDEX_VERSION } = await import(storeUrl);

const dest = indexPath(cacheDir);
const out = { tag, pid: process.pid, ok: 0, fail: 0, codes: {}, tmpPaths: 0, distinctTmp: 0, firstTmp: null, errors: [] };
const tmpSeen = new Set();

for (let i = 0; i < count; i += 1) {
  const payload = JSON.stringify({
    indexVersion: INDEX_VERSION,
    writtenAt: Date.now(),
    projectsDir: null,
    cardCount: 1,
    cards: [{ id: `${tag}-${String(i).padStart(4, '0')}`, fingerprint: `fp-${tag}-${i}`, pad }],
  });
  const res = await atomicWriteFile(dest, payload, writeOpts);
  out.tmpPaths += 1;
  tmpSeen.add(res.tmpPath);
  if (!out.firstTmp) out.firstTmp = res.tmpPath;
  if (res.ok) out.ok += 1;
  else {
    out.fail += 1;
    const code = (res.error && res.error.code) || 'unknown';
    out.codes[code] = (out.codes[code] || 0) + 1;
    if (out.errors.length < 5 && res.error) {
      out.errors.push({
        code, attempts: res.attempts, unlinkedDest: res.unlinkedDest,
        syscall: res.error.syscall, message: String(res.error.message).slice(0, 300),
      });
    }
  }
}
out.distinctTmp = tmpSeen.size;
writeFileSync(outFile, JSON.stringify(out), 'utf8');
