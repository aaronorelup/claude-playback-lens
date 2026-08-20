// tests/web-fixes-round18.test.mjs — named regressions for the round-18 fix
// pass, browser side.
//
//   R18-A1 (web/js/views/l0.mjs sourceKeyOf, plus eight sibling sites)
//       Composite Map keys across this repo were joined with a RAW U+0000
//       byte committed literally into the source. The delimiter CHOICE is
//       right — NUL cannot appear in a slug, session id, path or line number,
//       so the fields cannot re-partition and R8-PROB-2's source census stays
//       exact. The REPRESENTATION was wrong. A raw NUL renders as a plain
//       space in file-viewer tooling, and ripgrep classifies a file holding
//       one as binary: a repo-wide `rg` then drops it SILENTLY — exit 0, no
//       warning, no line. 63% of l0.mjs (54,700 of 84,571 bytes, including
//       collapseProblems itself and both SOURCE_CAP sites) was unsearchable,
//       and the same blindness was live in server/scan.mjs, server/summary.mjs,
//       jsonview.mjs, timeline.mjs and vtable.mjs.
//
//       The fix rewrites all 17 bytes across 9 files as the \u0000 escape —
//       byte-identical at runtime, zero behaviour change — and pins it here
//       three ways. The BOUNDARY tests prove the delimiter is load-bearing:
//       two sources that differ only in where a space falls must stay 2, and
//       they collapse to 1 under any printable delimiter. The GUARD tests are
//       the part that makes it stick — a per-site comment cannot stop the next
//       author from reading the line through a tool that shows a space and
//       retyping a space, but a byte scan of every tracked file can.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { collapseProblems } = await import('../web/js/views/l0.mjs');
const { fingerprint } = await import('../server/scan.mjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NUL = String.fromCharCode(0);
const ESCAPE = String.fromCharCode(92) + 'u0000'; // the six SOURCE characters

/* =================================================== R18-A1 — boundary */

// Two sources whose id/file fields differ only in WHICH SIDE of the boundary a
// space sits on. Under the NUL delimiter the keys differ; under a space — or
// any other printable character that can legally occur in an id or a path —
// they are character-for-character identical:
//
//     'AAAA notes' + ' ' + 'file.txt'  ===  'AAAA' + ' ' + 'notes file.txt'
//
// so the second source is swallowed by collapseProblems' `seen` Set and
// sourceCount reports 1 for a row that two distinct sessions produced. That is
// R8-PROB-2's census making a claim the records do not support. Verified to
// fail at 1 under a space delimiter and pass at 2 under NUL.
const boundary = (id, file) => ({
  code: 'torn-line', severity: 'error', scope: 'session',
  id, file, message: 'one torn line', affects: 'aggregates', count: 1,
});

test('R18-A1 — sources differing only at a delimiter boundary stay DISTINCT', () => {
  const rows = collapseProblems([
    boundary('AAAA notes', 'file.txt'),
    boundary('AAAA', 'notes file.txt'),
  ]);
  assert.equal(rows.length, 1, 'identical code+scope still collapses to one row');
  assert.equal(rows[0].sourceCount, 2,
    'a printable delimiter hashes these two identities equal and UNDER-counts the census');
  assert.deepEqual(rows[0].sources, [
    { id: 'AAAA notes', file: 'file.txt' },
    { id: 'AAAA', file: 'notes file.txt' },
  ], 'both contributors survive, in encounter order');
});

test('R18-A1 — the same boundary case across the slug/id pair', () => {
  const mk = (slug, id) => ({
    code: 'workflow-call-unresolved', severity: 'note', scope: 'session',
    slug, id, message: 'names wf_1', affects: 'nothing', count: 1,
  });
  const rows = collapseProblems([mk('proj a', 'AAAA'), mk('proj', 'a AAAA')]);
  assert.equal(rows[0].sourceCount, 2);
});

test('R18-A1 — the escape is the same byte at runtime that the raw form was', () => {
  // The no-behaviour-change claim, proved through an exported consumer of the
  // delimiter rather than asserted. server/scan.mjs fingerprint() joins
  // rel/size/mtimeMs with the escape; rebuilding the same digest here with an
  // explicitly constructed U+0000 must match byte for byte.
  const files = [
    { rel: 'a.jsonl', size: 10, mtimeMs: 1 },
    { rel: 'b.jsonl', size: 20, mtimeMs: 2 },
  ];
  const h = createHash('sha1');
  for (const r of files.map((f) => [f.rel, f.size, f.mtimeMs].join(NUL)).sort()) h.update(r, 'utf8');
  assert.equal(fingerprint(files), h.digest('hex'));
});

/* ====================================================== R18-A1 — guard */

// Read the tracked file list from git so the scan follows the repo instead of
// a hand-maintained list that rots, and scan the BYTES — the entire point is
// that this byte is invisible to anything that decodes and renders text.
function trackedFiles() {
  let out;
  try {
    out = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { maxBuffer: 1 << 28 });
  } catch (err) {
    assert.fail('R18-A1 guard needs `git ls-files` to enumerate tracked files: ' + err.message);
  }
  return out.toString('utf8').split(NUL).filter(Boolean);
}

// Formats that legitimately contain NUL. Empty in practice today — every
// tracked file in this repo is text — but listed so that adding an icon later
// does not turn this guard into a spurious failure someone deletes.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf',
  '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf',
]);

test('R18-A1 GUARD — no tracked source file contains a raw U+0000 byte', () => {
  const offenders = [];
  let scanned = 0;
  for (const rel of trackedFiles()) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    let buf;
    try { buf = readFileSync(path.join(REPO, rel)); } catch { continue; }
    scanned += 1;
    const at = [];
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0) at.push(i);
    if (at.length) offenders.push(rel + ' @ byte ' + at.join(', '));
  }

  // Not vacuous. A guard that quietly scanned nothing — git absent, tree
  // relocated, -z output parsed wrong — would pass forever while defending
  // nothing, which is the same failure mode as the bug it guards against.
  assert.ok(scanned > 150,
    'the scan must actually cover the tree — only ' + scanned + ' files were read');

  assert.deepEqual(offenders, [],
    'A raw NUL byte makes ripgrep skip the rest of the file SILENTLY in a repo-wide ' +
    'search, and every file viewer renders it as a plain space. Write the delimiter ' +
    'as the ' + ESCAPE + ' escape instead: identical byte at runtime, visible to tools. ' +
    'See the invariant note at sourceKeyOf in web/js/views/l0.mjs.');
});

// Every app/test site that held a raw NUL before this fix, and how many
// delimiters it held. The counts sum to 13 — the exact number of bytes
// converted. (Two retired research scripts also held 4 between them; they
// were dropped from this list when the scripts were deleted.)
const SITES = [
  ['web/js/views/l0.mjs', 3],                        // sourceKeyOf
  ['server/scan.mjs', 2],                            // fingerprint
  ['server/summary.mjs', 1],                         // filesByKey
  ['web/js/components/jsonview.mjs', 1],             // pathKey
  ['web/js/components/timeline.mjs', 1],             // bin key
  ['web/js/components/vtable.mjs', 3],               // unknown-group sentinel
  ['tests/stubs/store/scan.mjs', 2],                 // fingerprint stub
];

// Comment lines do not count. This file's own prose mentions the escape, and so
// does the invariant note in l0.mjs — if those counted, deleting the delimiter
// from the CODE would still leave the guard green, which is exactly the kind of
// silent pass this whole finding is about.
function escapesInCode(src) {
  let n = 0;
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    n += line.split(ESCAPE).length - 1;
  }
  return n;
}

test('R18-A1 GUARD — the seven converted sites still hold the escape, not a space', () => {
  // The byte scan above catches a regression TO THE RAW BYTE. This catches the
  // other direction: someone reading the escape and 'simplifying' it to a real
  // space, which leaves no NUL for the scan to find and silently re-opens the
  // collision the boundary tests describe.
  //
  // The bound is >=, not ==, on purpose: adding a new NUL-delimited key is
  // fine and must not fail this test. LOSING one is what it defends.
  let total = 0;
  for (const [rel, want] of SITES) {
    const n = escapesInCode(readFileSync(path.join(REPO, rel), 'utf8'));
    total += n;
    assert.ok(n >= want,
      rel + ' holds ' + n + ' ' + ESCAPE + ' delimiters in code, expected at least ' + want +
      ' — a delimiter was removed or downgraded to a printable character');
  }
  assert.ok(total >= 13, 'all 13 converted delimiters must survive; found ' + total);
});

