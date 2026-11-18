// mcp/daemon-files.mjs — where the shared daemon's lock/info/log files live,
// and the identity that decides which daemon a forwarder may talk to.
//
// Identity = this package's own directory + every input that changes WHAT the
// engine reads (corpus, cache dir, rate file, --projects). Two forwarders with
// the same identity share one daemon; a test run pointed at a fixture corpus,
// or a second installed version, gets its own and can never answer from the
// wrong index.

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const DEFAULT_IDLE_MS = 15 * 60 * 1000;
// The --http service's port. The viewer UI uses 8791; this is the next one.
// The plugin's .mcp.json and ensure-service hook use the same default.
export const DEFAULT_HTTP_PORT = 8792;

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fingerprint of the code itself: the newest mtime among the engine and
// server sources. An npm upgrade already lands in a new directory (so a new
// identity), but a checkout edited in place keeps its path — without this, a
// forwarder would keep talking to a daemon still running the old code until
// that daemon idled out.
function codeFingerprint() {
  let newest = 0;
  for (const sub of ['mcp', 'mcp/tools', 'server', 'server/api', 'shared']) {
    let names = [];
    try { names = fs.readdirSync(path.join(PKG_DIR, sub)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.mjs')) continue;
      try { newest = Math.max(newest, fs.statSync(path.join(PKG_DIR, sub, n)).mtimeMs); } catch { /* raced */ }
    }
  }
  return String(Math.floor(newest));
}

export function daemonIdentity() {
  const projectsArg = (() => {
    const i = process.argv.indexOf('--projects');
    return i >= 0 ? process.argv[i + 1] ?? '' : '';
  })();
  return JSON.stringify([
    PKG_DIR.toLowerCase(),
    codeFingerprint(),
    process.env.CLAUDE_PROJECTS ?? '',
    process.env.LENS_CACHE_DIR ?? '',
    process.env.LENS_PRICING_FILE ?? '',
    projectsArg,
  ]);
}

function stateDir() {
  return process.env.LENS_STATE_DIR || path.join(os.homedir(), '.claude', 'playback-lens', 'run');
}

/**
 * The --http service's record: one per machine (per state dir), not per
 * identity — the port is machine-wide, so whichever install serves it is
 * THE service. Read by plugin/hooks/ensure-service.mjs to restart it.
 */
export function servicePaths() {
  const dir = stateDir();
  return { dir, info: path.join(dir, 'service.json'), log: path.join(dir, 'service.log') };
}

export function daemonPaths() {
  const dir = stateDir();
  const key = crypto.createHash('sha1').update(daemonIdentity()).digest('hex').slice(0, 12);
  return {
    dir,
    key,
    lock: path.join(dir, `daemon-${key}.lock`),
    info: path.join(dir, `daemon-${key}.json`),
    log: path.join(dir, `daemon-${key}.log`),
  };
}

export function httpPort() {
  const n = Number.parseInt(process.env.LENS_MCP_PORT ?? '', 10);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : DEFAULT_HTTP_PORT;
}

/** Describe who holds a port: another lens service, or something else. */
export function portOwner(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not ours */ }
        resolve(j && j.app === 'claude-playback-lens'
          ? `a Playback Lens service (pid ${j.pid}, ${j.version}) already serves it`
          : 'held by some other program');
      });
    });
    req.on('error', () => resolve('held by some other program'));
    req.on('timeout', () => req.destroy());
  });
}
