// server/config.mjs — where the projects folder comes from, and config.json.
//
// Precedence (SPEC §9): --projects → CLAUDE_PROJECTS → config.json →
// ~/.claude/projects. The winner AND its source are returned together, because
// the source is printed at startup and shown in the UI — "we are reading X
// because you typed it" is a different statement from "because we guessed".
//
// config.json lives next to the app (the project dir, not the corpus). It is
// written with the same atomic discipline as the index cache: a config write
// that loses a race must never leave a half-file behind.
//
// CONTRACT-DEVIATION (additive only): BUILD-CONTRACTS lists resolveProjectsDir /
// loadConfig / saveConfig / validateDir. All keep their signatures; optional
// trailing parameters were added for testability (an injected config object, an
// explicit appDir) and extra helpers are exported. atomicWriteFile is imported
// from index-store.mjs — the contract gives it no module of its own and group C
// owns both files.

import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFile, sweepStaleTmpFiles, APP_DIR } from './index-store.mjs';
import { WALK_FILE_CAP, WALK_MS_CAP } from './limits.mjs';

export const CONFIG_FILENAME = 'config.json';

/** The last-resort projects dir. */
export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Where config.json lives. LENS_CONFIG_DIR overrides the app dir (tests, portable installs). */
export function configDir(env = process.env, appDir = APP_DIR) {
  const override = env && typeof env.LENS_CONFIG_DIR === 'string' ? env.LENS_CONFIG_DIR.trim() : '';
  return override ? path.resolve(override) : appDir;
}

export function configPath(env = process.env, appDir = APP_DIR) {
  return path.join(configDir(env, appDir), CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` and make absolute. Everything handed to fs is absolute.
 *
 * `base` anchors a RELATIVE input to a named directory instead of the
 * process's current working directory. It is passed for exactly one source —
 * config.json — because a string persisted in a file must not mean a different
 * directory depending on how the process happened to be launched. `--projects`
 * and CLAUDE_PROJECTS are typed in a shell and MUST keep resolving against the
 * cwd, which is what the person typing them expects, so they pass no base.
 * An absolute input is unaffected either way.
 */
export function expandPath(p, base = null) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (!s) return null;
  // Strip surrounding quotes — pasted Windows paths often arrive quoted.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
    if (!s) return null;
  }
  // A LONE trailing quote survives shell escaping of `--projects "C:\...\"`
  // (the trailing backslash escapes the closing quote). `"` is illegal in
  // Windows paths and `'` never ends a real path — strip it.
  if (s.endsWith('"') || s.endsWith("'")) {
    s = s.slice(0, -1).trim();
    if (!s) return null;
  }
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  // On Windows a BARE drive spec is not the drive root — path.resolve('C:')
  // resolves against the process's current directory ON THAT DRIVE, so "C:"
  // (one missing backslash, an extremely natural way to type "the C: drive")
  // would silently mean wherever the server happened to be launched from.
  // Guarded by separator, because on POSIX `C:` is a legal RELATIVE directory
  // name and appending a backslash there would be the regression, not the fix.
  if (path.sep === '\\' && /^[a-zA-Z]:$/.test(s)) s += '\\';
  // Only a genuinely relative string can drift, and only then is the base
  // consulted.
  if (base && !path.isAbsolute(s)) return path.resolve(base, s);
  return path.resolve(s);
}

/**
 * Read `--projects <dir>` / `--projects=<dir>` out of an argv array.
 * The whole array is scanned, so a full process.argv or a slice both work.
 */
export function parseProjectsArg(argv = process.argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a === '--projects' || a === '-p') {
      const next = argv[i + 1];
      if (typeof next === 'string' && next && !next.startsWith('--')) return next;
      return null;
    }
    if (a.startsWith('--projects=')) {
      const v = a.slice('--projects='.length);
      return v || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const SOURCE_LABEL = {
  arg: '--projects command-line flag',
  env: 'CLAUDE_PROJECTS environment variable',
  config: 'config.json',
  default: 'default (~/.claude/projects)',
};

function winner(raw, source, base = null) {
  return { dir: expandPath(raw, base), raw, source, sourceLabel: SOURCE_LABEL[source] };
}

/**
 * Resolve the projects dir and say where the answer came from.
 *
 * @param {string[]} [argv]
 * @param {object} [env]
 * @param {object|null} [config] pass an object (or null) to skip reading config.json
 * @returns {{dir:string, raw:string, source:'arg'|'env'|'config'|'default', sourceLabel:string}}
 */
export function resolveProjectsDir(argv = process.argv, env = process.env, config = undefined, appDir = APP_DIR) {
  const fromArg = parseProjectsArg(argv);
  if (fromArg && fromArg.trim()) return winner(fromArg, 'arg');

  const fromEnv = env && typeof env.CLAUDE_PROJECTS === 'string' ? env.CLAUDE_PROJECTS.trim() : '';
  if (fromEnv) return winner(fromEnv, 'env');

  const cfg = config === undefined ? loadConfigSync(env, appDir) : config;
  const fromCfg =
    cfg && typeof cfg === 'object' && typeof cfg.projectsDir === 'string' ? cfg.projectsDir.trim() : '';
  // A config-sourced RELATIVE path is anchored to config.json's own
  // directory. PUT /api/config persists the resolved path, so only an entry
  // saved by hand is relative at all — and for those, re-resolving against
  // the process cwd on every boot would let the same persisted string name a
  // different corpus depending on how the app was started
  // (`expandPath('corpus')` is C:\Users\corpus from one cwd and
  // C:\Users\me\work\corpus from another). Anchoring closes that class
  // deterministically and WITHOUT writing anything: migrating on load would
  // cement whatever the cwd happened to be at one accidental launch, turning a
  // recoverable misconfiguration into a permanent one written by the app
  // unasked — and would make a boot path a config writer, which this module
  // deliberately is not (config.json is written only on an explicit save).
  // Under both shipped launchers the cwd already IS the app dir (start.bat
  // `cd /d "%~dp0"`, start.sh `cd "$(dirname "$0")"`), so this is a no-op on
  // the documented path and changes behaviour only on the already-broken one.
  if (fromCfg) return winner(fromCfg, 'config', configDir(env, appDir));

  return winner(DEFAULT_PROJECTS_DIR, 'default');
}

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

const EMPTY_CONFIG = Object.freeze({});

/** Synchronous read used by resolveProjectsDir at startup. Never throws. */
export function loadConfigSync(env = process.env, appDir = APP_DIR) {
  try {
    const text = readFileSync(configPath(env, appDir), 'utf8');
    const obj = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : { ...EMPTY_CONFIG };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

/**
 * Read config.json. A missing or corrupt file yields `{}` — config is a
 * convenience, never a precondition for starting.
 */
export async function loadConfig(env = process.env, appDir = APP_DIR) {
  try {
    const text = await fsp.readFile(configPath(env, appDir), 'utf8');
    const obj = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : { ...EMPTY_CONFIG };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

/**
 * Merge `obj` over the current config and write it atomically.
 * @returns {Promise<{ok:boolean, path:string, config:object, problem:object|null}>}
 */
export async function saveConfig(obj, env = process.env, appDir = APP_DIR) {
  const file = configPath(env, appDir);
  const current = await loadConfig(env, appDir);
  const next = { ...current, ...(obj && typeof obj === 'object' ? obj : {}) };
  const res = await atomicWriteFile(file, JSON.stringify(next, null, 2) + '\n');
  // atomicWriteFile's intermediate is unique per write, so a crash between
  // open and rename leaves a distinct `config.json.tmp-*` that must be swept.
  // config.json is written only on an explicit save, so its sweep rides that
  // save rather than a boot path. Never fatal.
  try { await sweepStaleTmpFiles(path.dirname(file), { baseName: path.basename(file) }); }
  catch { /* janitorial */ }
  return {
    ok: res.ok,
    path: file,
    config: next,
    problem: res.ok ? null : { ...res.problem, message: res.problem.message.replace('cache file', 'config file') },
  };
}

// ---------------------------------------------------------------------------
// validateDir — the setup-screen preview
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One owner for the failure vocabulary. `reason` is the machine-readable key;
 * `message` is the prose that goes with it, set HERE so client and server
 * share one vocabulary — a client-side fallback sentence would flatten four
 * distinct reasons into one, and could assert "not readable" about a path the
 * server successfully stat'd (a file) or about the empty string, which is not
 * a path at all.
 */
export const REASON_MESSAGE = Object.freeze({
  empty: 'type a path first',
  missing: 'no such path exists',
  'not-a-directory': 'that path is a file, not a folder',
  unreadable: 'that path exists but could not be read',
});
const STAT_CONCURRENCY = 32; // parallel stat() calls per drain batch

/**
 * Cheap stat-walk preview of a candidate projects dir.
 *
 * A "project" is any immediate subdirectory. A "session" is any session id seen
 * as `<project>/<uuid>.jsonl` or as a `<project>/<uuid>/` directory — the union
 * across projects, because one session's files can be scattered across up to
 * three project dirs (SPEC §2) and must not be counted twice.
 *
 * House rule: when the dir cannot be read, the counts are `null`, never 0.
 *
 * @returns {Promise<{ok:boolean, dir:string, reason:string|null,
 *   projects:number|null, sessions:number|null, bytes:number|null,
 *   files:number|null, truncated:boolean, tookMs:number, problems:object[]}>}
 */
export async function validateDir(dir) {
  const started = Date.now();
  const abs = expandPath(dir);
  const base = {
    ok: false,
    dir: abs,
    reason: null,
    // the prose that goes with `reason`; null on the success path, the same
    // as `reason` itself.
    message: null,
    projects: null,
    sessions: null,
    bytes: null,
    files: null,
    truncated: false,
    tookMs: 0,
    problems: [],
  };

  if (!abs) {
    return { ...base, reason: 'empty', message: REASON_MESSAGE.empty, tookMs: Date.now() - started };
  }

  let st;
  try {
    st = await fsp.stat(abs);
  } catch (err) {
    const reason = err && err.code === 'ENOENT' ? 'missing' : 'unreadable';
    return {
      ...base,
      reason,
      message: REASON_MESSAGE[reason],
      tookMs: Date.now() - started,
      problems: [dirProblem(abs, err)],
    };
  }
  if (!st.isDirectory()) {
    return { ...base, reason: 'not-a-directory', message: REASON_MESSAGE['not-a-directory'], tookMs: Date.now() - started };
  }

  let top;
  try {
    top = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err) {
    return { ...base, reason: 'unreadable', message: REASON_MESSAGE.unreadable, tookMs: Date.now() - started, problems: [dirProblem(abs, err)] };
  }

  const problems = [];
  const sessionIds = new Set();
  let projects = 0;
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const deadline = started + WALK_MS_CAP;

  const pending = []; // absolute file paths awaiting stat

  async function drain(force) {
    if (!force && pending.length < STAT_CONCURRENCY) return;
    while (pending.length) {
      const batch = pending.splice(0, STAT_CONCURRENCY);
      const sizes = await Promise.all(
        batch.map((p) =>
          fsp.stat(p).then(
            (s) => (s.isFile() ? s.size : 0),
            () => 0,
          ),
        ),
      );
      for (const n of sizes) bytes += n;
      if (!force) break;
    }
  }

  async function walk(absDir) {
    if (files >= WALK_FILE_CAP || Date.now() > deadline) {
      truncated = true;
      return;
    }
    let ents;
    try {
      ents = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      problems.push(dirProblem(absDir, err));
      return;
    }
    for (const e of ents) {
      const full = path.join(absDir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        if (truncated) return;
      } else if (e.isFile()) {
        files += 1;
        pending.push(full);
        await drain(false);
        if (files >= WALK_FILE_CAP) {
          truncated = true;
          return;
        }
      }
    }
  }

  for (const e of top) {
    // The same cap guard walk() applies to every NESTED file must also bound
    // the loose files sitting in the candidate dir's own top level — without
    // it, one wrong folder (a 600k-loose-file root) hands a single
    // /api/validate-dir an unbounded stat storm, and there is no request
    // timeout above this. It sits at the TOP of the loop so the deadline can
    // also stop a root full of SUBDIRECTORIES one readdir earlier; past the
    // budget the answer is truncated:true either way. Date.now() per entry is
    // ~20-30ns, under 10ms at the cap, so no sampling is needed. Note this
    // bounds the top-level scan, not the clock end to end: walk() tests the
    // deadline only at directory entry, so a single nested dir of ~250k files
    // runs to the FILE cap regardless of elapsed time. `break`, never
    // `return` — the trailing drain(true) has to run so `bytes` covers
    // everything that was counted.
    if (files >= WALK_FILE_CAP || Date.now() > deadline) {
      truncated = true;
      break;
    }
    if (!e.isDirectory()) {
      if (e.isFile()) {
        files += 1;
        pending.push(path.join(abs, e.name));
        // Drain as we go (walk() does the same): keeps `pending` at one batch
        // instead of letting a huge top level accumulate an O(n^2) splice in
        // the final drain(true).
        await drain(false);
        if (files >= WALK_FILE_CAP) {
          truncated = true;
          break;
        }
      }
      continue;
    }
    projects += 1;
    const projDir = path.join(abs, e.name);
    let kids;
    try {
      kids = await fsp.readdir(projDir, { withFileTypes: true });
    } catch (err) {
      problems.push(dirProblem(projDir, err));
      continue;
    }
    for (const k of kids) {
      if (k.isFile() && k.name.toLowerCase().endsWith('.jsonl')) {
        const id = k.name.slice(0, -'.jsonl'.length);
        if (UUID_RE.test(id)) sessionIds.add(id.toLowerCase());
      } else if (k.isDirectory() && UUID_RE.test(k.name)) {
        sessionIds.add(k.name.toLowerCase());
      }
    }
    await walk(projDir);
    if (truncated) break;
  }
  await drain(true);

  return {
    ok: true,
    dir: abs,
    reason: null,
    message: null,
    projects,
    sessions: sessionIds.size,
    bytes,
    files,
    truncated,
    tookMs: Date.now() - started,
    problems,
  };
}

function dirProblem(file, err) {
  return {
    code: 'dir-unreadable',
    severity: 'warning',
    scope: 'store',
    file,
    message: `Could not read ${file}${err && err.code ? ` (${err.code})` : ''}.`,
    affects: 'aggregates',
    count: 1,
  };
}
