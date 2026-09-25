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
import { fileURLToPath } from 'node:url';

export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

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

export function daemonPaths() {
  const dir = process.env.LENS_STATE_DIR || path.join(os.homedir(), '.claude', 'playback-lens', 'run');
  const key = crypto.createHash('sha1').update(daemonIdentity()).digest('hex').slice(0, 12);
  return {
    dir,
    key,
    lock: path.join(dir, `daemon-${key}.lock`),
    info: path.join(dir, `daemon-${key}.json`),
    log: path.join(dir, `daemon-${key}.log`),
  };
}
