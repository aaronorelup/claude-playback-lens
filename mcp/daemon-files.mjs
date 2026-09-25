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
import { fileURLToPath } from 'node:url';

export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function daemonIdentity() {
  const projectsArg = (() => {
    const i = process.argv.indexOf('--projects');
    return i >= 0 ? process.argv[i + 1] ?? '' : '';
  })();
  return JSON.stringify([
    PKG_DIR.toLowerCase(),
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
