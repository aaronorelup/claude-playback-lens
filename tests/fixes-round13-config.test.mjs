// tests/fixes-round13-config.test.mjs — the round-13 CONFIG regressions.
//
// Split from tests/fixes-round13.test.mjs (which owns R13-D1) because these
// need to move the process's working directory to prove their point, and the
// D1 fixtures run real indexers beside them.
//
//   R13-D2 (server/config.mjs resolveProjectsDir/expandPath,
//           server/api.mjs GET /api/config, web/js/views/settings.mjs)
//       R12-F2 made PUT /api/config persist the RESOLVED directory — true only
//       of saves made AFTER it. Nothing rewrites or flags an entry already on
//       disk, and resolveProjectsDir re-resolved whatever raw string it found
//       against the process's CURRENT cwd on every boot, so one persisted
//       string named a different corpus depending on how the app was launched
//       (executed: `expandPath('corpus')` is C:\Users\corpus from one cwd and
//       C:\Users\userx\projects\corpus from another).
//
//       Two halves, and the rejected third. (1) A config-sourced RELATIVE path
//       is now anchored to config.json's own directory — no write, nothing
//       cemented, and a no-op under both shipped launchers, which already pin
//       the cwd to the app dir. (2) GET /api/config ships the RAW string
//       beside its resolution: the settings row labelled "saved in
//       config.json", sourced to "config.json", printed the pre-resolved value
//       — a path config.json does not contain — and pendingRestart compared
//       two identically-derived values, so it was structurally false for every
//       config-sourced win. (3) REJECTED: migrating on load. Re-saving the
//       boot-time resolution would cement whatever the cwd happened to be at
//       one accidental `node lens.mjs` from the wrong directory, turning a
//       recoverable misconfiguration into a permanent one written by the app
//       unasked — and would make a boot path a config writer, which
//       server/config.mjs deliberately is not.
//
//   R13-F2 (server/config.mjs validateDir, web/js/views/settings.mjs)
//       validateDir has always recorded exactly WHY a candidate directory
//       failed, in `reason` ∈ {empty, missing, unreadable, not-a-directory},
//       and never shipped prose to go with it. settings.mjs read
//       `res.message` — a field the server never sent — so its `??` fallback
//       always won and all four reasons rendered the identical sentence
//       "that path is not a readable Claude projects folder.", which
//       additionally ASSERTS "not readable" about a path the server had just
//       successfully stat'd and read (a file), and about the empty string,
//       which is not a path at all.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  expandPath, resolveProjectsDir, validateDir, configDir, REASON_MESSAGE,
} from '../server/config.mjs';
import { buildCtx, startServer, getJson } from './fixtures/api/helpers.mjs';

const WIN = path.sep === '\\';

/* ==================================================================== R13-D2 */

describe('R13-D2 — a config-sourced RELATIVE path is anchored to config.json, not to the cwd', () => {
  const APP = path.resolve(os.tmpdir(), 'lens-r13-appdir');

  /** Run `fn` with the process cwd somewhere else, and always put it back. */
  const at = (dir, fn) => {
    const before = process.cwd();
    try { process.chdir(dir); return fn(process.cwd()); }
    finally { process.chdir(before); }
  };

  test('R13-D2: the same persisted string names the same directory from two different cwds', () => {
    const a = at(os.tmpdir(), () => resolveProjectsDir([], {}, { projectsDir: 'corpus' }, APP));
    const b = at(os.homedir(), () => resolveProjectsDir([], {}, { projectsDir: 'corpus' }, APP));
    assert.equal(a.dir, b.dir,
      'this used to be a different corpus per launch — the exact drift the finding executed');
    assert.equal(a.dir, path.join(APP, 'corpus'),
      'anchored to the directory config.json itself lives in');
    assert.equal(a.source, 'config');
    assert.equal(a.raw, 'corpus', 'and the raw string is still reported as itself');
  });

  test('R13-D2: the other relative spellings are anchored too', () => {
    const dot = at(os.tmpdir(), () => resolveProjectsDir([], {}, { projectsDir: '.' }, APP));
    assert.equal(dot.dir, path.resolve(APP));
    const up = at(os.homedir(), () => resolveProjectsDir([], {}, { projectsDir: path.join('..', 'x') }, APP));
    assert.equal(up.dir, path.resolve(APP, '..', 'x'));
  });

  test('R13-D2: --projects and CLAUDE_PROJECTS still resolve against the CWD — they are typed in a shell', () => {
    const arg = at(os.tmpdir(), (cwd) => ({ r: resolveProjectsDir(['--projects', 'corpus'], {}, null, APP), cwd }));
    assert.equal(arg.r.dir, path.resolve(arg.cwd, 'corpus'),
      'a flag typed at a prompt means "relative to where I am standing"; anchoring it would be the regression');
    const env = at(os.tmpdir(), (cwd) => ({ r: resolveProjectsDir([], { CLAUDE_PROJECTS: 'corpus' }, null, APP), cwd }));
    assert.equal(env.r.dir, path.resolve(env.cwd, 'corpus'));
  });

  test('R13-D2: LENS_CONFIG_DIR moves the anchor with the config file', () => {
    const elsewhere = path.resolve(os.tmpdir(), 'lens-r13-cfgdir');
    const r = at(os.homedir(), () => resolveProjectsDir([], { LENS_CONFIG_DIR: elsewhere }, { projectsDir: 'corpus' }, APP));
    assert.equal(r.dir, path.join(elsewhere, 'corpus'));
    assert.equal(configDir({ LENS_CONFIG_DIR: elsewhere }, APP), elsewhere);
  });

  test('R13-D2: a bare drive spec stored in config.json still resolves to the drive root', { skip: WIN ? false : 'Windows drive specs' }, () => {
    const before = process.cwd();
    try {
      process.chdir(os.homedir());
      const drive = resolveProjectsDir([], {}, { projectsDir: 'C:' }, APP);
      assert.equal(drive.dir, path.resolve('C:\\'),
        'R12-F2 fixed the bare drive spec retroactively; anchoring must not undo it');
    } finally { process.chdir(before); }
  });
});

describe('R13-D2 — GET /api/config round-trips the RAW string beside its resolution', () => {
  const APP = path.resolve(os.tmpdir(), 'lens-r13-cfg-app');
  const ACTIVE = path.resolve(os.tmpdir(), 'lens-r13-cfg-active');
  let ctx, srv, stored;

  before(async () => {
    // The REAL expandPath, so the stub cannot paper over the defect.
    ctx = await buildCtx({
      config: {
        loadConfig: async () => (stored === undefined ? {} : { projectsDir: stored }),
        expandPath,
        configDir: () => APP,
      },
    });
    ctx.projectsDir = ACTIVE;
    ctx.projectsDirSource = 'config';
    srv = await startServer(ctx);
  });
  after(async () => { await srv?.close(); });

  test('R13-D2: the saved row reports what config.json LITERALLY holds', async () => {
    stored = 'corpus';
    const r = await getJson(`${srv.url}/api/config`);
    assert.equal(r.status, 200);
    assert.equal(r.body.savedProjectsDirRaw, 'corpus',
      'the page can only disclose a substitution it is told about — this field did not exist');
    assert.equal(r.body.savedProjectsDir, path.join(APP, 'corpus'),
      'and the resolution beside it is the one the NEXT BOOT will use, anchored to config.json');
    assert.notEqual(r.body.savedProjectsDirRaw, r.body.savedProjectsDir,
      'the two are genuinely different facts for a relative entry — that is the whole finding');
  });

  test('R13-D2: pendingRestart can finally be TRUE for a config-sourced relative entry', async () => {
    stored = 'corpus';
    const r = await getJson(`${srv.url}/api/config`);
    assert.equal(r.body.pendingRestart, true,
      'it compared two identically-derived values and was structurally false');
    assert.equal(r.body.activeProjectsDir, ACTIVE);
  });

  test('R13-D2: an ABSOLUTE entry round-trips identically on both fields, and nothing is pending', async () => {
    stored = ACTIVE;
    const r = await getJson(`${srv.url}/api/config`);
    assert.equal(r.body.savedProjectsDirRaw, ACTIVE);
    assert.equal(r.body.savedProjectsDir, ACTIVE);
    assert.equal(r.body.pendingRestart, false);
  });

  test('R13-D2: no entry at all is null on both, never an invented path', async () => {
    stored = undefined;
    const r = await getJson(`${srv.url}/api/config`);
    assert.equal(r.body.savedProjectsDirRaw, null);
    assert.equal(r.body.savedProjectsDir, null);
    assert.equal(r.body.pendingRestart, false);
  });
});

/* ==================================================================== R13-F2 */

describe('R13-F2 — validateDir ships the prose that goes with its recorded reason', () => {
  test('R13-F2: each of the four failure reasons carries its OWN message', async () => {
    const empty = await validateDir('');
    assert.equal(empty.reason, 'empty');
    assert.equal(empty.message, 'type a path first');

    const missing = await validateDir(path.join(os.tmpdir(), 'lens-r13-definitely-not-here-xyz'));
    assert.equal(missing.reason, 'missing');
    assert.equal(missing.message, 'no such path exists');

    const file = path.join(os.tmpdir(), `lens-r13-a-file-${process.pid}.txt`);
    await fsp.writeFile(file, 'not a folder\n', 'utf8');
    try {
      const notDir = await validateDir(file);
      assert.equal(notDir.reason, 'not-a-directory');
      assert.equal(notDir.message, 'that path is a file, not a folder');
      assert.doesNotMatch(notDir.message, /readable/,
        'the old sentence asserted "not readable" about a path the server had just successfully read');
    } finally { await fsp.rm(file, { force: true }); }

    // Four recorded reasons, four sentences — the defect was that they all
    // rendered as one.
    assert.equal(new Set(Object.values(REASON_MESSAGE)).size, 4);
    assert.deepEqual(Object.keys(REASON_MESSAGE).sort(),
      ['empty', 'missing', 'not-a-directory', 'unreadable'],
      'the vocabulary covers exactly the reasons validateDir can record');
  });

  test('R13-F2: the success path reports reason null AND message null', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r13-okdir-'));
    try {
      const ok = await validateDir(dir);
      assert.equal(ok.ok, true);
      assert.equal(ok.reason, null);
      assert.equal(ok.message, null, 'a success has no failure prose — null, not an empty string');
      assert.equal(ok.dir, dir);
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  });

  test('R13-F2: the missing/unreadable paths still attach the real OS error the page now shows', async () => {
    const r = await validateDir(path.join(os.tmpdir(), 'lens-r13-definitely-not-here-xyz'));
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0].message, /Could not read/);
    assert.match(r.problems[0].message, /ENOENT/,
      'the page prints this beside the reason — an EPERM on a REAL directory is the case no generic sentence diagnoses');
  });

  test('R13-F2: a failure still reports the RESOLVED dir, which the page now prints on the failure branch too', async () => {
    const r = await validateDir('lens-r13-relative-nonsense');
    assert.equal(r.ok, false);
    assert.ok(path.isAbsolute(r.dir),
      'failure is where "what you typed is not what the server resolved" bites hardest');
  });
});

describe('R13-F2 — POST /api/validate-dir forwards what validateDir recorded', () => {
  let ctx, srv;
  before(async () => {
    ctx = await buildCtx({ config: { validateDir } });
    srv = await startServer(ctx);
  });
  after(async () => { await srv?.close(); });

  const post = (dir) => getJson(`${srv.url}/api/validate-dir`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  });

  test('R13-F2: the handler ships `message` beside `reason`', async () => {
    const file = path.join(os.tmpdir(), `lens-r13-http-file-${process.pid}.txt`);
    await fsp.writeFile(file, 'not a folder\n', 'utf8');
    try {
      const r = await post(file);
      assert.equal(r.status, 200);
      assert.equal(r.body.reason, 'not-a-directory');
      assert.equal(r.body.message, 'that path is a file, not a folder',
        'the settings page reads res.message; the server never used to send one');
      assert.equal(typeof r.body.dir, 'string', 'and the resolved dir, which the failure branch now prints');
    } finally { await fsp.rm(file, { force: true }); }
  });

  test('R13-F2: the handler no longer BLANKS the problems validateDir attached', async () => {
    const r = await post(path.join(os.tmpdir(), 'lens-r13-http-definitely-not-here-xyz'));
    assert.equal(r.body.reason, 'missing');
    assert.equal(r.body.problems.length, 1,
      'the handler hardcoded `problems: []`, asserting "nothing went wrong" over a record it had just been handed');
    assert.match(r.body.problems[0].message, /Could not read/);
    assert.equal(r.body.problems[0].code, 'dir-unreadable');
  });

  test('R13-F2: a clean success still ships an empty problems array, not a missing key', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-r13-http-ok-'));
    try {
      const r = await post(dir);
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.problems, []);
      assert.equal(r.body.message, null);
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  });
});
