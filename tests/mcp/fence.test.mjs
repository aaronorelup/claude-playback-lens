// tests/mcp/fence.test.mjs — the dependency fence, restated for the merged repo.
//
// BEFORE THE MERGE the MCP server lived in its own repository and its fence
// test asserted a property of THIS one: "the lens repo has no package.json and
// no node_modules." That invariant died with commit 42840ef, which moved the
// MCP server in here — the root now has both, by design, because the npm
// package ships the engine.
//
// What the merge traded it for, and what this file exists to keep honest:
//
//     THE VIEWER RUNS ON AN EMPTY node_modules.
//
// The engine (lens.mjs, server/, shared/) and the web UI (web/js/) import
// nothing but node: builtins and each other. Only mcp/ may reach for a
// package — the MCP SDK and zod — because only the MCP server is ever
// installed from npm. `node lens.mjs` must work on a machine that has never
// run `npm install`: clone, double-click, done. That promise is the whole
// reason the viewer is dependency-free, and it is invisible on a developer's
// machine, where node_modules is always populated and a stray `import 'zod'`
// in server/ would simply resolve and work.
//
// TWO LAYERS, because neither is sufficient alone:
//
//   LAYER 1 — static import-graph proof. Reads every engine and web file and
//   classifies every module specifier it can see. Complete over the whole
//   tree and instant, including code paths no test ever executes. Blind to
//   specifiers that are computed at runtime rather than written down.
//
//   LAYER 2 — proof by simulation. Copies the engine and the web UI into a
//   temp directory with NO node_modules anywhere above it, drops a two-line
//   corpus beside it, boots `node lens.mjs --port 0` from the copy and asks
//   /api/hello. Executes only the boot path, but it executes it for real: a
//   bare specifier anywhere on that path is an unresolvable import and the
//   child dies. This is the layer that actually reproduces the user's machine.
//
// The meta-guard (LAYER 1b) is why layer 1 is trustworthy: it runs the same
// scanner over mcp/, where the forbidden packages ARE imported, and fails if
// it cannot see them. A fence that has silently stopped matching anything
// passes forever; this one has to prove it can still spot its own quarry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

// The dependency-free half of the repo, as posix-ish relative paths.
const ENGINE_ROOTS = ['lens.mjs', 'server', 'shared', 'web/js'];
// The half that is allowed to have dependencies — and the meta-guard's target.
const MCP_ROOT = 'mcp';

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'fixtures']);
const CODE_EXT = new Set(['.mjs', '.js']);

// The packages the merge specifically put within arm's reach. The general rule
// below already forbids every bare specifier; these are named so a violation
// reads as the failure it is rather than as a generic one.
const QUARANTINED = ['@modelcontextprotocol', 'zod'];

// ---------------------------------------------------------------- scanner

// Every way this codebase names a module. Each pattern's group 2 is the
// specifier (or, for a template-literal dynamic import, its literal prefix).
//
// The gap in the `static` pattern excludes quotes and `;` deliberately: that
// is what stops it running past a bare `import './x.mjs';` and mistaking the
// next `from '…'` — including one inside an ordinary string, of which web/js
// has several — for that statement's specifier.
const PATTERNS = [
  ['static', /(?:^|[\r\n])[ \t]*(?:import|export)\b[^;'"`]{0,600}?\bfrom[ \t]*(['"])([^'"\n]+)\1/g],
  ['bare', /(?:^|[\r\n])[ \t]*import[ \t]*(['"])([^'"\n]+)\1/g],
  ['dynamic', /\bimport[ \t]*\([ \t]*(['"`])([^'"`\n$]*)/g],
  ['require', /\brequire[ \t]*\([ \t]*(['"])([^'"\n]+)\1/g],
];

/** Every module specifier written as a literal in `source`, with its kind. */
export function collectSpecifiers(source) {
  const found = [];
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(source)); ) {
      const spec = m[2];
      // A fully computed dynamic import (`import(url)`, `import(`${x}`)`)
      // leaves nothing to classify. Layer 2 is what covers those.
      if (spec === '') continue;
      found.push({ kind, spec });
    }
  }
  return found;
}

/** node: builtin or repo-relative — the only two kinds the viewer may use. */
function isSelfContained(spec) {
  return spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
}

/** Every .mjs/.js file under `rel`, which may itself be a file. */
async function codeFilesUnder(rel) {
  const abs = path.join(REPO_ROOT, rel);
  const st = await fsp.stat(abs);
  if (st.isFile()) return CODE_EXT.has(path.extname(abs)) ? [abs] : [];
  const out = [];
  const walk = async (dir) => {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await walk(path.join(dir, ent.name));
      } else if (ent.isFile() && CODE_EXT.has(path.extname(ent.name))) {
        out.push(path.join(dir, ent.name));
      }
    }
  };
  await walk(abs);
  return out;
}

/** [{ file, kind, spec }] for every literal specifier under the given roots. */
async function scanRoots(roots) {
  const rows = [];
  const perRoot = new Map();
  for (const root of roots) {
    const files = await codeFilesUnder(root);
    perRoot.set(root, files);
    for (const file of files) {
      const src = await fsp.readFile(file, 'utf8');
      for (const s of collectSpecifiers(src)) {
        rows.push({ file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'), ...s });
      }
    }
  }
  return { rows, perRoot };
}

// -------------------------------------------------- LAYER 1: the fence

test('fence L1: the engine and the web UI import only node: builtins and each other', async () => {
  const { rows, perRoot } = await scanRoots(ENGINE_ROOTS);

  const offenders = rows.filter((r) => !isSelfContained(r.spec));
  assert.deepEqual(
    offenders.map((r) => `${r.file} -> ${r.spec} (${r.kind})`),
    [],
    'the viewer must run on an empty node_modules: no bare package specifiers ' +
    'are allowed outside mcp/',
  );

  // Named, so the failure says which promise broke.
  for (const pkg of QUARANTINED) {
    const hits = rows.filter((r) => r.spec === pkg || r.spec.startsWith(`${pkg}/`));
    assert.deepEqual(
      hits.map((r) => `${r.file} -> ${r.spec}`), [],
      `${pkg} belongs to mcp/ alone — it is an npm dependency and the viewer has none`,
    );
  }

  // ---- anti-vacuity. A scanner that walked nothing also finds no offenders.
  const scanned = [...perRoot.values()].flat();
  assert.ok(
    scanned.some((f) => path.basename(f) === 'lens.mjs' && path.dirname(f) === REPO_ROOT),
    'lens.mjs itself must have been scanned',
  );
  for (const [root, files] of perRoot) {
    assert.ok(files.length >= 1, `root ${root} contributed no files — did it move?`);
  }
  assert.ok(scanned.length > 50, `expected >50 engine/web files, scanned ${scanned.length}`);
  assert.ok(rows.length > 100, `expected >100 specifiers, found ${rows.length}`);
});

test('fence L1b (meta-guard): the same scanner DOES see the packages mcp/ imports', async () => {
  const { rows, perRoot } = await scanRoots([MCP_ROOT]);
  assert.ok(perRoot.get(MCP_ROOT).length >= 1, 'mcp/ contributed no files');

  const specs = rows.map((r) => r.spec);
  assert.ok(
    specs.some((s) => s.startsWith('@modelcontextprotocol')),
    'the scanner found no @modelcontextprotocol import in mcp/ — either the SDK ' +
    'moved or the scanner has stopped matching, and layer 1 is now vacuous',
  );
  assert.ok(
    specs.includes('zod'),
    'the scanner found no zod import in mcp/ — see above; a fence that cannot ' +
    'see its own quarry proves nothing',
  );
  // Both of those are exactly what isSelfContained() rejects, so the classifier
  // and the extractor are both demonstrably live.
  assert.ok(rows.filter((r) => !isSelfContained(r.spec)).length >= 2);
});

test('fence L1c: the classifier rejects a planted import (synthetic sources)', () => {
  const planted = [
    ["import { z } from 'zod';", 'zod'],
    ['import { McpServer } from "@modelcontextprotocol/server";', '@modelcontextprotocol/server'],
    ["const { z } = await import('zod');", 'zod'],
    ["const z = require('zod');", 'zod'],
    ["import 'zod';", 'zod'],
    ["export { z } from 'zod';", 'zod'],
    ["import {\n  a,\n  b,\n} from 'zod';", 'zod'],
  ];
  for (const [src, spec] of planted) {
    const specs = collectSpecifiers(src).map((s) => s.spec);
    assert.ok(specs.includes(spec), `not extracted from: ${JSON.stringify(src)}`);
    assert.equal(isSelfContained(spec), false, `${spec} must be classified as a package`);
  }

  // …and does not fire on the shapes the engine legitimately uses, including
  // the `'from '` string literals in web/js that a looser regex trips over.
  const clean = [
    ["import path from 'node:path';", 'node:path'],
    ["import { createApi } from './server/api.mjs';", './server/api.mjs'],
    ["await import(`./views/${name}.mjs`)", './views/'],
  ];
  for (const [src, spec] of clean) {
    const specs = collectSpecifiers(src).map((s) => s.spec);
    assert.ok(specs.includes(spec), `not extracted from: ${JSON.stringify(src)}`);
    assert.equal(isSelfContained(spec), true, `${spec} must be classified as self-contained`);
  }
  const decoys = [
    "el('span', 'from ', fmt(span.from), ' to ', fmt(span.to));",
    "text += 'paths from ' + n;",
    'await import(pathToFileURL(p).href)',
    'await import(moduleUrl("scan"))',
  ];
  for (const src of decoys) {
    const bad = collectSpecifiers(src).filter((s) => !isSelfContained(s.spec));
    assert.deepEqual(bad, [], `false positive on: ${JSON.stringify(src)}`);
  }
});

// ------------------------------------- LAYER 2: boot without node_modules

const BOOT_MS = 15000;
const SLUG = 'C--fence-proj';
const SID = '33333333-3333-4333-8333-333333333333';

/** Two sessions of two lines each. The point is that the server BOOTS and
 *  scans something real, not that any figure comes out right — the ledger has
 *  a hundred tests of its own. Rows come from the engine's fixture builder so
 *  they stay shaped like the corpus if the schema moves. */
async function writeCorpus(dir) {
  const fx = await import('../fixtures/api/make-store.mjs');
  const user = fx.makeUser('C:/fence/proj');
  const session = (sid, tag) => [
    user({ sid, uuid: `${tag}-u1`, at: '2026-08-01T00:00:00.000Z', text: 'hello' }),
    fx.asstStd({ sid, uuid: `${tag}-a1`, at: '2026-08-01T00:00:01.000Z', msgId: `msg_${tag}`, text: 'hi' }),
  ].join('\n') + '\n';
  await fsp.mkdir(path.join(dir, SLUG), { recursive: true });
  await fsp.writeFile(path.join(dir, SLUG, `${SID}.jsonl`), session(SID, 'F1'), 'utf8');
  const sid2 = SID.replace(/3/g, '4');
  await fsp.writeFile(path.join(dir, SLUG, `${sid2}.jsonl`), session(sid2, 'F2'), 'utf8');
}

test('fence L2: node lens.mjs boots and answers /api/hello with no node_modules in scope', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-fence-'));
  const app = path.join(root, 'app');
  const corpus = path.join(root, 'projects');
  const cache = path.join(root, 'cache');
  let child = null;

  try {
    // The simulation is only a proof if nothing above the copy can satisfy a
    // bare specifier. Node walks every ancestor looking for node_modules, so
    // check them rather than assume: a stray package directory in a parent of
    // the temp dir would turn this test into a rubber stamp.
    for (let d = app; ; ) {
      assert.ok(
        !fs.existsSync(path.join(d, 'node_modules')),
        `${d}\\node_modules exists — the temp tree is not isolated and this ` +
        'test cannot prove anything; remove it or point TMPDIR elsewhere',
      );
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }

    await fsp.mkdir(app, { recursive: true });
    await fsp.mkdir(cache, { recursive: true });
    // Exactly what package.json's "files" ships plus web/ — and NOT
    // node_modules, which is the entire point.
    for (const entry of ['server', 'shared', 'web']) {
      await fsp.cp(path.join(REPO_ROOT, entry), path.join(app, entry), { recursive: true });
    }
    await fsp.cp(path.join(REPO_ROOT, 'lens.mjs'), path.join(app, 'lens.mjs'));
    assert.equal(fs.existsSync(path.join(app, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(app, 'package.json')), false);
    await writeCorpus(corpus);

    // Scrub the inherited resolution path: NODE_PATH could name a global
    // package dir, NODE_OPTIONS could preload one, and CLAUDE_PROJECTS would
    // silently redirect the corpus.
    const env = { ...process.env, LENS_CACHE_DIR: cache, NODE_PATH: '' };
    delete env.NODE_OPTIONS;
    delete env.CLAUDE_PROJECTS;

    child = spawn(
      process.execPath,
      [path.join(app, 'lens.mjs'), '--serve', '--port', '0', '--projects', corpus],
      { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let out = '';
    let err = '';
    let exited = null;
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    // `--port 0` lets the OS choose, so the port is discovered from the line
    // lens.mjs prints after listen() — the only place the real number exists.
    const deadline = Date.now() + BOOT_MS;
    let port = null;
    while (Date.now() < deadline) {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) { port = Number(m[1]); break; }
      // An import that cannot resolve kills the child; fail now, not in 15s.
      if (exited) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const transcript = `\n--- child stdout ---\n${out}\n--- child stderr ---\n${err}`;
    assert.equal(exited, null, `lens.mjs exited during boot${transcript}`);
    assert.ok(port, `lens.mjs never announced a URL within ${BOOT_MS}ms${transcript}`);

    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const hello = await res.json();
    assert.equal(hello.app, 'Claude Playback Lens');
    assert.match(String(hello.version), /^\d+\.\d+\.\d+$/);
    assert.equal(typeof hello.pid, 'number');

    // Nothing may have gone wrong quietly: a module the engine tries and fails
    // to load is reported on stderr by tryImport rather than thrown.
    assert.equal(err.trim(), '', `lens.mjs wrote to stderr${transcript}`);
    assert.equal(/failed to load|waiting on parallel-build modules/.test(out), false, transcript);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const dead = new Promise((r) => child.once('exit', r));
      child.kill();
      // Never leave an orphan holding a port, and never hang the suite on one.
      await Promise.race([dead, new Promise((r) => setTimeout(r, 3000))]);
    }
    // Windows can still hold the copied files for a beat after the child dies.
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch((e) => { t.diagnostic(`temp cleanup failed: ${e.message}`); });
  }
});
