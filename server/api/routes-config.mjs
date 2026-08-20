// server/api/routes-config.mjs — /api/config (GET + PUT) and
// /api/validate-dir. The one theme throughout: ACTIVE vs SAVED are two
// different facts. Saving rewrites config.json but does NOT re-point the
// running indexer (the index layer closes over projectsDir, and the /api/file,
// /api/image and /api/lines containment guards read ctx.projectsDir — a
// security boundary), so every payload here names which directory is which
// and whether a restart is pending.

import path from 'node:path';
import { httpError } from '../errors.mjs';
import { sendJson } from '../http.mjs';
import { readBody } from './params.mjs';
import { sameDir } from './fileref.mjs';

export function registerConfigRoutes({ G, PUT, P }, ctx) {
  /** A path typed just now (a request body): resolved the way the shell would. */
  function absOf(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    if (ctx.config && typeof ctx.config.expandPath === 'function') return ctx.config.expandPath(raw);
    return path.resolve(raw.trim());
  }

  /**
   * A path read OUT of config.json: resolved exactly the way a restart would
   * resolve it — resolveProjectsDir anchors a config-sourced relative to
   * config.json's own directory — or the "saved" row would print one
   * directory and the next boot read another.
   */
  function absOfSaved(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    if (ctx.config && typeof ctx.config.expandPath === 'function') {
      const base = typeof ctx.config.configDir === 'function' ? ctx.config.configDir() : null;
      return ctx.config.expandPath(raw, base);
    }
    return path.resolve(raw.trim());
  }

  G('/api/config', async (_req, res) => {
    const cfg = ctx.config && ctx.config.loadConfig ? await ctx.config.loadConfig() : {};
    // Ship BOTH the string config.json literally contains and the directory it
    // resolves to. Collapsed into one pre-resolved field, the row labelled
    // "saved in config.json" would print a path config.json does not contain,
    // and pendingRestart would compare two identically-derived values — the
    // page can only disclose a substitution it is told about.
    const savedProjectsDirRaw = cfg && typeof cfg.projectsDir === 'string' && cfg.projectsDir.trim()
      ? cfg.projectsDir
      : null;
    const savedProjectsDir = absOfSaved(cfg && cfg.projectsDir);
    const activeProjectsDir = ctx.projectsDir ?? null;
    const activeSource = ctx.projectsDirSource ?? null;
    sendJson(res, 200, {
      // What THIS process is serving, and why.
      activeProjectsDir,
      activeSource,
      // The literal string in config.json. null = config.json names no
      // projects dir. (This is the field that is actually "saved in
      // config.json"; the one below is what it resolves to.)
      savedProjectsDirRaw,
      // What that string resolves to, the way the next boot will resolve it.
      savedProjectsDir,
      // true only when the two genuinely differ; false when the saved value is
      // absent (nothing is pending), never a guess.
      pendingRestart: savedProjectsDir === null ? false : !sameDir(savedProjectsDir, activeProjectsDir),
      // A saved value that --projects / CLAUDE_PROJECTS outranks will not be
      // used even after a restart (SPEC §9 precedence) — say so rather than
      // let the UI promise a restart that cannot help.
      savedOutrankedBy: activeSource === 'arg' ? '--projects' : activeSource === 'env' ? 'CLAUDE_PROJECTS' : null,
      cacheDir: ctx.cacheDir ?? null,
      // legacy alias, kept for compatibility: always the ACTIVE dir
      projectsDir: activeProjectsDir,
      projectsDirSource: activeSource,
      config: cfg ?? {},
      pricingVersion: ctx.pricing?.PRICING_VERSION ?? null,
      problems: [],
    });
  });

  PUT('/api/config', async (req, res) => {
    if (!ctx.config || !ctx.config.validateDir) throw httpError(503, 'indexer-down', 'config layer is not wired');
    const body = await readBody(req);
    if (!body || typeof body.projectsDir !== 'string' || !body.projectsDir) {
      throw httpError(400, 'bad-param', 'body must carry a projectsDir string');
    }
    const preview = await ctx.config.validateDir(body.projectsDir);
    if (!preview || preview.ok !== true) {
      throw httpError(400, 'invalid-dir', 'projectsDir failed validation', preview ?? null);
    }
    const savedProjectsDir = preview.dir ?? absOf(body.projectsDir);
    // Persist the RESOLVED path, never the raw string the user typed:
    // saveConfig merges its object into config.json verbatim, and
    // resolveProjectsDir re-expands whatever is stored on EVERY boot — so a
    // relative input ("C:", "corpus", ".") would name a different directory
    // each time the server was launched from a different cwd, silently.
    // Resolving once, here, makes config.json cwd-independent forever.
    // `preview.dir` is validateDir's own resolved path — the very directory
    // whose counts the user just approved.
    //
    // saveConfig returns {ok, path, config, problem} — the Problem (SPEC §9,
    // the cache-write-failed record reworded to name the config file) exists
    // precisely so this route can disclose a write that did not land (a
    // read-only dir, ENOSPC, a tmp collision) instead of claiming saved:true
    // with problems:[] whatever happened.
    const saveRes = await ctx.config.saveConfig({ projectsDir: savedProjectsDir });
    const savedOk = saveRes && saveRes.ok === true;
    const activeProjectsDir = ctx.projectsDir ?? null;
    sendJson(res, 200, {
      saved: savedOk,
      // The write landed on disk; it did NOT take effect here. Saying so is
      // the whole point — POST /api/reindex does not rescue it either.
      applied: false,
      activeProjectsDir,
      // When the write FAILED nothing reached config.json, so there is no saved
      // directory to name and no restart that would read one — naming the
      // attempted path here would promise a restart that cannot deliver it.
      savedProjectsDir: savedOk ? savedProjectsDir : null,
      pendingRestart: savedOk ? !sameDir(savedProjectsDir, activeProjectsDir) : false,
      // A fact about THIS process's precedence (SPEC §9), true whether or not
      // the write landed — so it is reported unconditionally.
      savedOutrankedBy: ctx.projectsDirSource === 'arg' ? '--projects'
        : ctx.projectsDirSource === 'env' ? 'CLAUDE_PROJECTS' : null,
      preview,
      problems: savedOk ? [] : [saveRes.problem],
    });
  });

  P('/api/validate-dir', async (req, res) => {
    if (!ctx.config || !ctx.config.validateDir) throw httpError(503, 'indexer-down', 'config layer is not wired');
    const body = await readBody(req);
    if (!body || typeof body.dir !== 'string') throw httpError(400, 'bad-param', 'body must carry a dir string');
    const preview = await ctx.config.validateDir(body.dir);
    // Forward the problems validateDir attached: on the failure paths they
    // carry the one non-generic fact (`dir-unreadable` with the real OS
    // error, e.g. 'Could not read <path> (EPERM).') — a blanket empty array
    // here would assert "nothing went wrong" over a record the function just
    // made. [] stays the shape when there is genuinely nothing.
    sendJson(res, 200, {
      ...preview,
      problems: Array.isArray(preview && preview.problems) ? preview.problems : [],
    });
  });
}
