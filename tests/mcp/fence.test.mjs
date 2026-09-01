// tests/fence.test.mjs — the dependency fence (SPEC §5.1, acceptance §9.2).
//
// This repo exists because of one decision: the MCP SDK and zod are real
// dependencies, and the lens is not allowed to acquire them. The principle as
// the owner restated it:
//
//   The viewer is dependency-free. The MCP adapter is not.
//   Nothing the viewer runs imports the adapter.
//
// That is a property of a DIFFERENT repo on disk, which is exactly why it
// needs a test rather than a promise: nothing in the lens's own suite fails
// when someone adds `import { z } from 'zod'` to server/api.mjs, and nothing
// here fails either — until this file does. The failure mode it guards is not
// hypothetical: `node lens.mjs` on a fresh clone, with no npm and no
// node_modules, is the whole distribution story of the lens.
//
// The fence has two halves and both are checked:
//
//   1. no file the viewer runs names `@modelcontextprotocol`, `zod`, or this
//      repo in an import,
//   2. the lens repo root carries NO package.json and NO node_modules — the
//      absence is the property; a package.json declaring zero dependencies
//      would already have changed what `node lens.mjs` means.
//
// The lens is located through src/lens-link.mjs's own findLensDir(), the same
// ladder the production server walks (--lens > LENS_DIR > sibling probe).
// Hardcoding the path would make this test pass on the author's machine and
// silently scan nothing anywhere else — and a fence test that scans nothing is
// worse than no fence test, because it reports success.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { findLensDir, MCP_DIR } from '../src/lens-link.mjs';

// The roots the viewer actually runs, per SPEC §5.1. `docs/`, `claude/` and
// every .md in the repo are exempt: prose ABOUT the dependency is not the
// dependency, and this spec's own §5.1 names `zod` a dozen times.
const SCAN_ROOTS = ['lens.mjs', 'server', 'shared', 'web', 'tests'];

const SCAN_EXTS = new Set(['.mjs', '.js']);

// Directories never worth descending into. The lens has no node_modules — the
// second half of this test proves it — but a developer's stray install, a
// .git objects tree or a populated .cache would otherwise cost seconds and
// produce findings about files the viewer does not run.
//
// `tests/fixtures/` is NOT skipped: it holds real .mjs the suite imports
// (make-store.mjs, the module stubs), and those run under `node lens.mjs`'s
// dependency budget like everything else.
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'coverage']);

// ------------------------------------------------------------------ locating

// Resolved once, at module load, so a failure to locate the lens is reported
// by every test in this file rather than being swallowed into an empty scan.
const found = findLensDir(process.argv.slice(2), process.env);
const LENS_DIR = found.dir;

function requireLens() {
  assert.ok(
    LENS_DIR,
    'the dependency fence cannot be checked because the lens repo was not found. '
    + 'findLensDir tried:\n  '
    + found.tried.join('\n  ')
    + '\nSet LENS_DIR to the directory containing lens.mjs and re-run. '
    + 'This is a FAILURE, not a skip: a fence test that scans nothing reports success while the fence is down.',
  );
  return LENS_DIR;
}

// ------------------------------------------------------------------ scanning

/** Every .mjs/.js file under one of the scan roots, absolute. */
async function sourceFiles(lensDir) {
  const out = [];
  for (const rel of SCAN_ROOTS) {
    const abs = path.join(lensDir, rel);
    let st;
    try { st = await fsp.stat(abs); } catch { continue; }
    if (st.isFile()) {
      if (SCAN_EXTS.has(path.extname(abs))) out.push(abs);
    } else if (st.isDirectory()) {
      await walk(abs, out);
    }
  }
  return out;
}

async function walk(dir, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(abs, out);
    } else if (e.isFile() && SCAN_EXTS.has(path.extname(e.name))) {
      out.push(abs);
    }
  }
}

/**
 * Every module specifier a file imports, in any of the four spellings Node
 * accepts: `from '…'`, bare `import '…'`, `import('…')` and `require('…')`.
 *
 * Specifiers rather than a raw content grep, deliberately. The raw grep the
 * spec sketches would also fire on the comment in a lens source file
 * explaining why it must never import zod — turning the act of documenting
 * the fence into a way to break it.
 */
function specifiersOf(src) {
  const specs = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,          // import x from 'y' / export * from 'y'
    /\bimport\s+['"]([^'"]+)['"]/g,        // import 'y'
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,   // import('y')
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,  // require('y')
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** The reason a specifier is forbidden, or null. */
function violationOf(spec) {
  if (spec === '@modelcontextprotocol' || spec.startsWith('@modelcontextprotocol/')) {
    return 'imports the MCP SDK';
  }
  if (spec === 'zod' || spec.startsWith('zod/')) {
    return 'imports zod';
  }
  // Reaching across into this repo drags its dependency tree along with it.
  if (/claude-playback-lens-mcp/i.test(spec)) {
    return 'imports the MCP adapter repo';
  }
  return null;
}

// ------------------------------------------------------------------ tests

test('the lens repo is locatable — otherwise this whole file proves nothing', () => {
  const dir = requireLens();
  assert.ok(fs.statSync(path.join(dir, 'lens.mjs')).isFile(),
    `${dir} was accepted as the lens but holds no lens.mjs`);
  assert.notEqual(path.resolve(dir), path.resolve(MCP_DIR),
    'the located "lens" is this repo — the fence would be checking the adapter against itself');
});

test('the scan actually reaches the files the viewer runs', async () => {
  const dir = requireLens();
  const files = await sourceFiles(dir);

  // A fence test whose glob quietly matched nothing is the failure this
  // assertion exists to prevent, so the shape of the corpus is pinned: every
  // scan root that exists must have contributed, and lens.mjs itself must be
  // in the list.
  assert.ok(files.includes(path.join(dir, 'lens.mjs')), 'lens.mjs is scanned');
  for (const rel of ['server', 'shared', 'web', 'tests']) {
    const root = path.join(dir, rel);
    if (!fs.existsSync(root)) continue;
    assert.ok(files.some((f) => f.startsWith(root + path.sep)),
      `${rel}/ exists but contributed no .mjs/.js file to the scan`);
  }
  assert.ok(files.length > 50,
    `only ${files.length} source files were scanned — the walk is not reaching the repo`);
});

test('no file the viewer runs imports the MCP SDK, zod, or this repo', async () => {
  const dir = requireLens();
  const files = await sourceFiles(dir);

  const violations = [];
  for (const file of files) {
    const src = await fsp.readFile(file, 'utf8');
    for (const spec of specifiersOf(src)) {
      const why = violationOf(spec);
      if (why) violations.push(`${path.relative(dir, file)} ${why} ('${spec}')`);
    }
  }

  assert.deepEqual(violations, [],
    'The lens must stay runnable with `node lens.mjs` and an empty node_modules.\n'
    + 'These files break the fence (SPEC §5.1):\n  '
    + violations.join('\n  '));
});

test('the lens repo root carries no package.json and no node_modules', () => {
  const dir = requireLens();

  // The ABSENCE is the property. A package.json declaring zero dependencies
  // would already have changed what the lens is: `npm install` becomes a step
  // a reader expects, `node lens.mjs` stops being the whole story, and the
  // next dependency has somewhere obvious to land.
  assert.equal(fs.existsSync(path.join(dir, 'package.json')), false,
    `${dir}/package.json exists — the lens is meant to have none (SPEC §5.1). `
    + 'A package.json belongs in the MCP repo, which is where the dependencies are.');

  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false,
    `${dir}/node_modules exists — nothing the lens runs may need an install step.`);

  // …and no lockfile smuggled in without its manifest.
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) {
    assert.equal(fs.existsSync(path.join(dir, name)), false,
      `${dir}/${name} exists — the lens declares no dependencies to lock.`);
  }
});

test('the fence is guarding something: THIS repo does depend on both', async () => {
  // If the MCP server ever stopped needing the SDK and zod, the three tests
  // above would keep passing while proving nothing anyone cares about. This
  // one fails instead, so the fence is re-examined rather than left standing
  // over an empty field.
  const pkg = JSON.parse(await fsp.readFile(path.join(MCP_DIR, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(Object.keys(deps).some((d) => d.startsWith('@modelcontextprotocol/')),
    'this repo no longer depends on the MCP SDK — re-read SPEC §5.1 before deleting the fence');
  assert.ok('zod' in deps,
    'this repo no longer depends on zod — re-read SPEC §5.1 before deleting the fence');
});
