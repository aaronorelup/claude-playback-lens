#!/usr/bin/env node
// scripts/check-release.mjs — runs before every `npm publish` (prepublishOnly).
//
// The npm package and the Claude Code plugin ship from this one repo but reach
// users by two different roads: npx picks up a new npm release on its own,
// while the plugin (and the skill inside it) updates only when Claude Code sees
// a NEW plugin version in the marketplace on GitHub. A publish that skips the
// plugin bump — or publishes before the bump is pushed — leaves every user
// running new tools under an old skill. This check refuses that publish.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const sh = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim();

const pkg = read('package.json').version;
const plugin = read('plugin/.claude-plugin/plugin.json').version;
const market = (read('.claude-plugin/marketplace.json').plugins || []).find((p) => p.name === 'playback-lens')?.version;

const problems = [];
if (plugin !== pkg) problems.push(`plugin/.claude-plugin/plugin.json is ${plugin}, package.json is ${pkg}`);
if (market !== pkg) problems.push(`.claude-plugin/marketplace.json lists playback-lens ${market}, package.json is ${pkg}`);
if (!process.env.LENS_RELEASE_SKIP_GIT) {
  try {
    if (sh('git status --porcelain')) problems.push('the working tree has uncommitted changes');
    sh('git fetch -q origin main');
    const head = sh('git rev-parse HEAD');
    const remote = sh('git rev-parse origin/main');
    if (head !== remote) problems.push('HEAD is not what origin/main has — push first, so the plugin version users are sent to exists on GitHub');
  } catch (e) {
    problems.push(`git check failed: ${e.message.split('\n')[0]}`);
  }
}

if (problems.length) {
  process.stderr.write(`\nrefusing to publish ${pkg}:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\nUse: npm run release -- <version>\n\n`);
  process.exit(1);
}
process.stdout.write(`release check ok: package, plugin and marketplace all ${pkg}; HEAD is on origin/main\n`);
