#!/usr/bin/env node
// ensure-service.mjs — the plugin's SessionStart hook.
//
// The plugin's MCP server is "type": "http": every Claude Code session
// connects to ONE shared Playback Lens service at 127.0.0.1:8792 instead of
// starting a server process of its own. This hook makes sure that service is
// running. It costs one short-lived node process per session start:
//
//   1. the service answers /health, at least as new as this plugin
//                                              -> done (the common case, ~50 ms)
//   2. it answers but is OLDER than this plugin (the plugin just updated)
//                                              -> stop it, then start as below
//   3. the service ran before from an install at least this new
//      (service.json names its node + entry)   -> start that install again
//   4. otherwise                               -> npx -y claude-playback-lens-mcp@<this plugin's version>
//
// Claude Code connects to MCP servers while this hook runs, not after it
// (measured: the connect is refused before the hook finishes), so waiting for
// the service here would only delay the session. A session that finds the
// service down starts without the lens tools; the next session has them. That
// is why `--install-service` starts it at logon.
//
// It prints nothing on stdout (SessionStart stdout would land in the model's
// context) and always exits 0: a hook must never block a session. No
// dependencies — the plugin folder ships no node_modules.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.LENS_MCP_PORT || '', 10) || 8792;
const STATE_DIR = process.env.LENS_STATE_DIR || path.join(os.homedir(), '.claude', 'playback-lens', 'run');

/** -> the service's /health JSON, or null when nothing (of ours) answers. */
function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(j && j.app === 'claude-playback-lens' ? j : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** "0.10.2" vs "0.9.9" -> 1; unknown compares as older. */
function cmp(a, b) {
  const pa = String(a || '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

function pluginVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch { return null; }
}

function start(v) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(STATE_DIR, 'service.log'), 'a');
  const opts = { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: process.env };
  let known = null;
  try { known = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'service.json'), 'utf8')); } catch { /* first run */ }
  if (known && known.entry && fs.existsSync(known.entry) && known.node && fs.existsSync(known.node)
    && (!v || cmp(known.version, v) >= 0)) {
    spawn(known.node, [known.entry, '--http', '--detach'], opts).unref();
  } else {
    const pkg = v ? `claude-playback-lens-mcp@${v}` : 'claude-playback-lens-mcp';
    // npx is a .cmd shim on Windows, so it needs a shell there. --detach makes
    // the service re-launch itself as a plain `node` process and lets this
    // npx chain exit, so no npx or cmd process outlives the start.
    spawn('npx', ['-y', pkg, '--http', '--detach'], { ...opts, shell: process.platform === 'win32' }).unref();
  }
  fs.closeSync(logFd);
}

const want = pluginVersion();
let h = await health();
if (h && want && cmp(h.version, want) < 0) {
  // Older than this plugin: the plugin was updated, the service was not.
  try { process.kill(h.pid); } catch { /* already gone */ }
  const until = Date.now() + 5000;
  while (Date.now() < until && await health()) await new Promise((r) => setTimeout(r, 200));
  h = null;
}
if (!h) {
  try { start(want); } catch { /* never block the session */ }
}
process.exit(0);
