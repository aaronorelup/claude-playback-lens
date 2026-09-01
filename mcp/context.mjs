// src/context.mjs — build the `ctx` object the lens's API handlers consume.
//
// `createApi(router, ctx)` documents its ctx contract at the top of the lens's
// server/api/index.mjs. lens.mjs builds that object in its `main()`; this file
// builds the same one, from the same modules, so the handlers cannot tell the
// difference between a request that arrived over HTTP and one dispatched
// in-process by src/dispatch.mjs.
//
// The only deliberate divergences from lens.mjs main() are listed here so they
// stay visible:
//
//  * No port probe, no HTTP listen, no browser open — this process serves
//    stdio, not a socket.
//  * The cache directory defaults to <this repo>/.cache instead of the lens's
//    own .cache (see CACHE ISOLATION below).
//  * Progress messages go to stderr. lens.mjs uses console.log; on stdio that
//    would corrupt the JSON-RPC stream.

import path from 'node:path';
import fsp from 'node:fs/promises';

// Bumped whenever a tool's input schema or its rendered output shape changes.
// Reported by lens_status so an agent (or a future session reading a cached
// transcript) can tell whether its mental model of this surface is stale.
// This is not the npm version and not the lens's APP_VERSION.
//
//   1 → 2 (2026-08-23): lens_usage's declared default `limit` fell 20 → 10. A
//   declared default is part of the input schema an agent reads, so changing it
//   is a surface change even though no argument stopped being accepted.
export const TOOLS_VERSION = 2;

/**
 * createContext({ lens, lensDir, mcpDir }) -> ctx
 *
 * `lens` is the bundle from src/lens-link.mjs. `lensDir` is the lens repo root
 * (webDir/sharedDir are resolved against it). `mcpDir` is this repo's root and
 * is used only for the default cache location.
 *
 * The caller must `await ctx.index.start()` before dispatching anything; this
 * function does not start the indexer, because the caller wants to log around
 * that step.
 */
export async function createContext({ lens, lensDir, mcpDir }) {
  // The same module set lens.mjs loads, through the lens's own resolver. A
  // module that fails to load arrives as null and degrades exactly the same
  // capability it degrades in the lens (503 envelopes on index-backed routes)
  // rather than preventing startup.
  const mods = {
    pricing: await lens.core.tryImport('shared/pricing.mjs'),
    ledger: await lens.core.tryImport('server/ledger.mjs'),
    jsonl: await lens.core.tryImport('server/jsonl.mjs'),
    parse: await lens.core.tryImport('server/parse.mjs'),
    scan: await lens.core.tryImport('server/scan.mjs'),
    summary: await lens.core.tryImport('server/summary.mjs'),
    config: await lens.core.tryImport('server/config.mjs'),
    store: await lens.core.tryImport('server/index-store.mjs'),
    lru: await lens.core.tryImport('server/lru.mjs'),
  };
  const missing = Object.entries(mods).filter(([, m]) => !m).map(([k]) => k);
  if (missing.length) {
    process.stderr.write(`[lens-mcp] lens modules unavailable: ${missing.join(', ')} (degraded)\n`);
  }

  // Corpus location comes from the lens's own ladder — --projects >
  // CLAUDE_PROJECTS > config.json > ~/.claude/projects. Duplicating that
  // precedence here would create a second answer to "where is the corpus",
  // and lens_status reports the winner, so the two answers would have to be
  // reconciled by the reader. resolveProjects reads process.argv/process.env
  // directly, which is why this process forwards neither.
  const { dir: projectsDir, source: projectsDirSource } = await lens.core.resolveProjects(mods);
  try {
    const st = await fsp.stat(projectsDir);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    process.stderr.write(`[lens-mcp] corpus ${projectsDir} does not exist or is not a directory\n`);
  }

  // CACHE ISOLATION. SPEC §9: "a cache dir belongs to one running instance" —
  // two processes sharing one cache dir double the scan and overwrite each
  // other's index.json. The lens UI, when open, is that one instance. So
  // unless the operator has explicitly chosen a cache directory, this process
  // claims its own inside the MCP repo and never contends with the UI's
  // writer. This is set BEFORE ensureCacheDir(), which reads the same env var.
  if (!process.env.LENS_CACHE_DIR) {
    process.env.LENS_CACHE_DIR = path.join(mcpDir, '.cache');
  }

  // Cache dir via the lens's documented ladder (LENS_CACHE_DIR -> <app>/.cache
  // -> %LOCALAPPDATA% -> tmp), probing writability. Without group C the plain
  // default below serves.
  let cacheDir = process.env.LENS_CACHE_DIR || path.join(mcpDir, '.cache');
  if (mods.store && typeof mods.store.ensureCacheDir === 'function') {
    try {
      const r = await mods.store.ensureCacheDir();
      if (r && r.dir) cacheDir = r.dir;
      else if (r && r.problem) process.stderr.write(`[lens-mcp] ${r.problem.message}\n`);
    } catch { /* keep the fallback */ }
  }

  const index = lens.core.createIndexState({ projectsDir, cacheDir, mods });

  return {
    appName: lens.core.APP_NAME,
    appVersion: lens.core.APP_VERSION,
    projectsDir,
    projectsDirSource,
    cacheDir,
    // Static-file roots. No route this server dispatches serves a static file,
    // but /api/config reports both paths, and reporting a fabricated path
    // would be a false statement about this process. They are the real ones.
    webDir: path.join(lensDir, 'web'),
    sharedDir: path.join(lensDir, 'shared'),
    pricing: mods.pricing,
    ledger: mods.ledger,
    jsonl: mods.jsonl,
    config: mods.config,
    index,
  };
}
