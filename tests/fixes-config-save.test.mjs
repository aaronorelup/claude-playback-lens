// tests/fixes-config-save.test.mjs — named regression for the config-save
// disclosure fix. (Topic-named like fixes-audit/fixes-records-api because the
// numbered round slots are taken by main's own fix passes.)
//
//   R9-F1-COLLATERAL (found while validating round-9's R9-F1, filed separately)
//       PUT /api/config awaited ctx.config.saveConfig(...), DISCARDED the
//       returned {ok, path, config, problem}, and unconditionally answered
//       {saved:true, problems:[]}. saveConfig builds that problem object
//       (config.mjs, the cache-write-failed record reworded to "config file")
//       precisely so the caller can disclose it — so any write failure (a
//       read-only dir, ENOSPC, a tmp collision) made the API claim it saved a
//       setting it did not save, with an empty problems array. A silent-absence
//       lie on a supported route, in one process, with no second instance
//       required (repro: 60 rounds of two concurrent saveConfig calls in one
//       process -> 58/120 failures, all invisible through the route). The route
//       must answer saved:res.ok and carry res.problem in problems[] when the
//       write failed.
//
//       Ported onto main's round-10/12/13 envelope: the response now also
//       carries applied / activeProjectsDir / savedProjectsDir / pendingRestart
//       / savedOutrankedBy, and R12-F2 persists the RESOLVED preview.dir rather
//       than the raw body string. savedProjectsDir and pendingRestart describe
//       the SAVE, so on a failed write they must not name a directory or
//       promise a restart either — asserted below.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as config from '../server/config.mjs';
import { buildCtx, startServer, getJson } from './fixtures/api/helpers.mjs';

let TMP;
before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-cfgsave-'));
});
after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

/** The REAL config module, its env pinned to a per-test LENS_CONFIG_DIR — the
 *  same injection seam server/config.mjs documents for testability. The route
 *  under test is the real one (real createApi over a real HTTP server); only
 *  where config.json lands is redirected. */
function realConfigAt(configDir) {
  const env = { LENS_CONFIG_DIR: configDir };
  return {
    validateDir: config.validateDir,
    expandPath: config.expandPath,
    configDir: () => config.configDir(env),
    loadConfig: () => config.loadConfig(env),
    saveConfig: (obj) => config.saveConfig(obj, env),
  };
}

function putConfig(url, projectsDir) {
  return getJson(`${url}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectsDir }),
  });
}

describe('R9-F1-COLLATERAL: PUT /api/config must not claim saved:true on a failed write', () => {
  test('a failing write answers saved:false and discloses the problem', async () => {
    // LENS_CONFIG_DIR occupied by a FILE: configPath resolves to
    // <file>/config.json, so the real atomicWriteFile fails opening the tmp
    // file — a genuine failed write through the real saveConfig, no stubs.
    const blocked = path.join(TMP, 'not-a-dir');
    await fsp.writeFile(blocked, 'i am a file, not a directory\n');
    const goodProjects = path.join(TMP, 'projects-a');
    await fsp.mkdir(goodProjects, { recursive: true });

    const ctx = await buildCtx({ config: realConfigAt(blocked) });
    const srv = await startServer(ctx);
    try {
      const r = await putConfig(srv.url, goodProjects);

      assert.equal(r.status, 200, 'a disclosed failure is not a transport error');
      assert.equal(r.body.saved, false, 'the write failed — the route must not claim it saved');
      assert.equal(r.body.preview?.ok, true, 'envelope shape kept: preview still present');
      assert.equal(r.body.problems.length, 1, 'the failure must be disclosed, never an empty problems array');

      // SPEC §9 Problem shape, as built by saveConfig (config.mjs).
      const p = r.body.problems[0];
      assert.equal(p.code, 'cache-write-failed');
      assert.equal(p.severity, 'warning');
      assert.equal(p.scope, 'store');
      assert.match(p.message, /config file/, 'saveConfig rewords the record to name the config file');
      assert.equal(typeof p.file, 'string');
      assert.equal(p.count, 1);
      assert.ok('affects' in p);

      // Round-10/12 envelope, on the failure path: these two fields describe
      // the SAVE. Nothing was persisted, so there is no saved directory to name
      // and no restart that would read one.
      assert.equal(r.body.applied, false, 'R10-F2: a save never takes effect in this process');
      assert.equal(r.body.savedProjectsDir, null,
        'naming the attempted path here would state a directory config.json does not contain');
      assert.equal(r.body.pendingRestart, false,
        'a failed write leaves nothing pending — a restart would read the same directory');
      assert.equal(r.body.activeProjectsDir, ctx.projectsDir,
        'what this process is serving is unchanged and still reported');

      // And the claim is true: nothing was persisted.
      await assert.rejects(fsp.stat(path.join(blocked, 'config.json')));
    } finally {
      await srv.close();
    }
  });

  test('a successful write still answers saved:true with problems:[] and actually persists', async () => {
    const configDir = path.join(TMP, 'config-ok');
    await fsp.mkdir(configDir, { recursive: true });
    const goodProjects = path.join(TMP, 'projects-b');
    await fsp.mkdir(goodProjects, { recursive: true });

    const ctx = await buildCtx({ config: realConfigAt(configDir) });
    const srv = await startServer(ctx);
    try {
      const r = await putConfig(srv.url, goodProjects);

      assert.equal(r.status, 200);
      assert.equal(r.body.saved, true);
      assert.deepEqual(r.body.problems, []);
      assert.equal(r.body.preview?.ok, true);
      assert.equal(r.body.applied, false);

      // R12-F2: what is persisted is the RESOLVED preview.dir, not the raw body
      // string — and the envelope tells the page exactly what landed on disk.
      const resolved = r.body.preview.dir;
      assert.equal(resolved, config.expandPath(goodProjects), 'validateDir resolves the candidate itself');
      assert.equal(r.body.savedProjectsDir, resolved, 'the page is told exactly what landed on disk');

      // saved:true must mean SAVED: the file exists and round-trips the value.
      const onDisk = JSON.parse(await fsp.readFile(path.join(configDir, 'config.json'), 'utf8'));
      assert.equal(onDisk.projectsDir, resolved, 'the resolved directory is what config.json now holds');
      assert.equal(onDisk.projectsDir, r.body.savedProjectsDir, 'and it is exactly what the envelope claimed');

      // pendingRestart is a real comparison against the ACTIVE dir, which the
      // fixture ctx points at a different (private store) root.
      assert.equal(r.body.activeProjectsDir, ctx.projectsDir);
      assert.equal(r.body.pendingRestart, true,
        'the saved directory is not the one this instance is reading — a restart is genuinely pending');
    } finally {
      await srv.close();
    }
  });
});
