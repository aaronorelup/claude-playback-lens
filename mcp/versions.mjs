// mcp/versions.mjs — which versions are in play, and whether they agree.
//
// Three things version separately and can drift:
//
//   package   this npm package (claude-playback-lens-mcp). The plugin runs it
//             with an unpinned `npx -y`, so it updates on its own.
//   engine    lens.mjs APP_VERSION — the viewer/engine line (3.x). Not the
//             package version; printed beside it so nobody mistakes one for
//             the other.
//   plugin    the installed Claude Code plugin that carries the skill. It
//             updates only when Claude Code refreshes the marketplace, so it
//             can lag the package — the skill then describes an older tool
//             surface than the one the model sees.
//
// The server cannot update the plugin, but it can notice the lag and say so
// where the model reads it: the server instructions and lens_status.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGE_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version; }
  catch { return null; }
})();

export const PLUGIN_ID = 'playback-lens@claude-playback-lens';
export const UPDATE_CMD = 'claude plugin marketplace update claude-playback-lens && claude plugin update playback-lens@claude-playback-lens, then restart Claude';
export const UPDATE_HINT = 'run `claude plugin marketplace update claude-playback-lens` then `claude plugin update playback-lens@claude-playback-lens` in a terminal (or /plugin → Installed → playback-lens → Update now), then restart Claude. To never see this again: /plugin → Marketplaces → claude-playback-lens → Enable auto-update';

/** "0.10.2" > "0.9.9" */
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The installed plugin's version, from Claude Code's own install ledger
 * (~/.claude/plugins/installed_plugins.json), or null when the plugin is not
 * installed (the server was registered directly, e.g. `claude mcp add`).
 * LENS_PLUGINS_FILE overrides the path (tests).
 */
export function installedPluginVersion() {
  const file = process.env.LENS_PLUGINS_FILE || path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = (j && j.plugins && j.plugins[PLUGIN_ID]) || [];
    const vs = entries.map((e) => e && e.version).filter(Boolean);
    if (!vs.length) return null;
    return vs.sort(cmpVersion)[vs.length - 1];
  } catch { return null; }
}

/**
 * -> { package, plugin, stale } — stale when an installed plugin is older than
 * this package. The plugin and package are released in lockstep (same version
 * number), so "older" means the skill text predates this server.
 */
export function versionState() {
  const plugin = installedPluginVersion();
  const stale = !!(plugin && PACKAGE_VERSION && cmpVersion(plugin, PACKAGE_VERSION) < 0);
  return { package: PACKAGE_VERSION, plugin, stale };
}

export function staleNote(v = versionState()) {
  if (!v.stale) return null;
  return `⚠ STALE SKILL: the installed playback-lens plugin (which carries the /playback-lens:usage skill) is ${v.plugin}, older than this server (${v.package}). Where that skill disagrees with these tools or their descriptions, the tools are right. Tell the user once: ${UPDATE_HINT}.`;
}
