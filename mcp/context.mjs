// mcp/context.mjs — import the engine, and build the `ctx` object the lens's
// API handlers consume.
//
// `createApi(router, ctx)` documents its ctx contract at the top of the lens's
// server/api/index.mjs. lens.mjs builds that object in its `main()`; this file
// builds the same one, from the same modules, so the handlers cannot tell the
// difference between a request that arrived over HTTP and one dispatched
// in-process by mcp/dispatch.mjs.
//
// The engine is IN-PACKAGE, one directory up. Every module below is a static
// relative import, which is the whole point of the KAN-126 merge: there is no
// ladder, no probe, no environment override, and therefore no way for this
// server to be pointed at an engine of a different version than the one it
// ships with. A broken import here is an ordinary module-load error and the
// process dies with node's own message naming the file — which is a better
// diagnostic than any ladder ever produced.
//
// The only deliberate divergences from lens.mjs main() are listed here so they
// stay visible:
//
//  * No port probe, no HTTP listen, no browser open — this process serves
//    stdio, not a socket.
//  * The cache directory defaults to <repo root>/.cache/mcp instead of the
//    lens UI's own <repo root>/.cache (see CACHE ISOLATION below).
//  * Progress messages go to stderr. lens.mjs uses console.log; on stdio that
//    would corrupt the JSON-RPC stream.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- the engine
//
// Importing lens.mjs is safe: its main() is guarded by `invokedDirectly`, so
// loading it as a module registers nothing and starts nothing.
import * as core from '../lens.mjs';
import * as api from '../server/api.mjs';
import * as http from '../server/http.mjs';
import * as errors from '../server/errors.mjs';
import * as find from '../server/find.mjs';
import * as ledger from '../server/ledger.mjs';
import * as jsonl from '../server/jsonl.mjs';
import * as parse from '../server/parse.mjs';
import * as scan from '../server/scan.mjs';
import * as summary from '../server/summary.mjs';
import * as config from '../server/config.mjs';
import * as store from '../server/index-store.mjs';
import * as lru from '../server/lru.mjs';
import * as limits from '../server/limits.mjs';
import * as lookup from '../server/api/session-lookup.mjs';
import * as pricing from '../shared/pricing.mjs';

export const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The repo root — the engine's own directory, one up from mcp/. */
export const REPO_ROOT = path.resolve(MCP_DIR, '..');

/**
 * The engine bundle every tool and the dispatcher receive. Same keys the
 * two-repo build produced, so nothing downstream had to change when the
 * ladder that used to assemble it went away:
 *
 *   core    lens.mjs            createIndexState, tryImport, resolveProjects,
 *                               APP_NAME, APP_VERSION
 *   api     server/api.mjs      createApi, parseScope, scopeString
 *   http    server/http.mjs     createRouter
 *   errors  server/errors.mjs   HttpError, PendingError, errorBody
 *   find    server/find.mjs     runFind (called directly — /api/find is SSE)
 *   ledger  server/ledger.mjs   emptyCostAgg and the aggregation rules
 *   pricing shared/pricing.mjs  formatUsd, PRICING_VERSION
 *   store   server/index-store.mjs  INDEX_VERSION, ensureCacheDir
 *   lookup  server/api/session-lookup.mjs
 *                               scopeSessionList — the 404-before-the-scan gate
 *                               AND the win32 slug canonicalisation that makes
 *                               a case-variant slug resolve instead of scanning
 *                               nothing and reporting a truthful-looking zero.
 *                               server/api.mjs does not re-export it, and
 *                               lens_search calls runFind directly rather than
 *                               through the router, so it must arrive here.
 *   limits  server/limits.mjs   FIND_MATCH_CAP and the rest of the tunables.
 *                               A tool that prints a cap to the agent must
 *                               print the number the scan actually used, and a
 *                               literal copied into a tool file stops being
 *                               that number the day the lens retunes it.
 *
 * jsonl/parse/scan/summary/config/lru are not on this bundle because no tool
 * reads them directly; they reach the handlers through `mods` below, which is
 * the shape createIndexState and resolveProjects expect.
 */
export const lens = { core, api, http, errors, find, ledger, pricing, store, lookup, limits };

// The module set lens.mjs hands to createIndexState/resolveProjects. In the
// lens these arrive through tryImport and a missing one degrades a capability
// (503 envelopes on index-backed routes) rather than preventing startup. In
// package they are static imports: a missing one is a load error before this
// object is ever built, so there is nothing left to degrade.
const mods = { pricing, ledger, jsonl, parse, scan, summary, config, store, lru };

// Bumped whenever a tool's input schema or its rendered output shape changes.
// Reported by lens_status so an agent (or a future session reading a cached
// transcript) can tell whether its mental model of this surface is stale.
// This is not the npm version and not the lens's APP_VERSION.
//
//   1 → 2 (2026-08-23): lens_usage's declared default `limit` fell 20 → 10. A
//   declared default is part of the input schema an agent reads, so changing it
//   is a surface change even though no argument stopped being accepted.
//   2 → 3 (2026-09-24): lens_read and lens_pricing added; lens_search gained
//   kinds / tool / since / until / distinct / context_chars and a kind:tool
//   column; cost tools lead with a PRICING GAP banner while a model is unrated.
//   3 → 4 (2026-09-25): lens_prompts and lens_file added; lens_search matches
//   paths with either slash and through JSON escaping, searches message content
//   only by default (metadata:true restores envelope matching), and skips the
//   calling session (include_current_session:true restores it).
export const TOOLS_VERSION = 4;

/**
 * createContext() -> ctx
 *
 * The caller must `await ctx.index.start()` before dispatching anything; this
 * function does not start the indexer, because the caller wants to log around
 * that step.
 */
export async function createContext() {
  // Corpus location comes from the lens's own ladder — --projects >
  // CLAUDE_PROJECTS > config.json > ~/.claude/projects. Duplicating that
  // precedence here would create a second answer to "where is the corpus",
  // and lens_status reports the winner, so the two answers would have to be
  // reconciled by the reader. resolveProjects reads process.argv/process.env
  // directly, which is why this process forwards neither.
  const { dir: projectsDir, source: projectsDirSource } = await core.resolveProjects(mods);
  try {
    const st = await fsp.stat(projectsDir);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    process.stderr.write(`[lens-mcp] corpus ${projectsDir} does not exist or is not a directory\n`);
  }

  // CACHE ISOLATION. SPEC §9: "a cache dir belongs to one running instance" —
  // two processes sharing one cache dir double the scan and overwrite each
  // other's index.json. The lens UI, when open, is that one instance, and
  // in-package it writes <repo root>/.cache. So unless the operator has
  // explicitly chosen a cache directory, this process claims a WRITER DIR OF
  // ITS OWN one level down — <repo root>/.cache/mcp — still inside the
  // gitignored .cache/, and never contending with the UI's writer. This is set
  // BEFORE ensureCacheDir(), which reads the same env var.
  if (!process.env.LENS_CACHE_DIR) {
    process.env.LENS_CACHE_DIR = path.join(REPO_ROOT, '.cache', 'mcp');
  }

  // Cache dir via the lens's documented ladder (LENS_CACHE_DIR -> <app>/.cache
  // -> %LOCALAPPDATA% -> tmp), probing writability.
  let cacheDir = process.env.LENS_CACHE_DIR;
  try {
    const r = await store.ensureCacheDir();
    if (r && r.dir) cacheDir = r.dir;
    else if (r && r.problem) process.stderr.write(`[lens-mcp] ${r.problem.message}\n`);
  } catch { /* keep the fallback */ }

  const index = core.createIndexState({ projectsDir, cacheDir, mods });

  return {
    appName: core.APP_NAME,
    appVersion: core.APP_VERSION,
    projectsDir,
    projectsDirSource,
    cacheDir,
    // Static-file roots. No route this server dispatches serves a static file,
    // but /api/config reports both paths, and reporting a fabricated path
    // would be a false statement about this process. They are the real ones,
    // and in-package they are real in a way they were not before: this is the
    // same checkout the UI serves them from.
    webDir: path.join(REPO_ROOT, 'web'),
    sharedDir: path.join(REPO_ROOT, 'shared'),
    pricing,
    ledger,
    jsonl,
    config,
    index,
  };
}
