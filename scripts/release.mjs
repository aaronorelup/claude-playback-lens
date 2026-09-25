#!/usr/bin/env node
// scripts/release.mjs — one command for a release: `npm run release -- 0.3.2`
//
// Bumps the npm package, the plugin manifest and the marketplace entry to the
// same version, runs the suite, commits, tags, pushes, and publishes. The push
// happens BEFORE the publish, so by the time npx can fetch the new server, the
// matching plugin (and skill) is already on GitHub for Claude Code to update to.
// npm asks for the authenticator code itself when the account requires it.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (c) => execSync(c, { cwd: ROOT, stdio: 'inherit' });
const out = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim();

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: npm run release -- <major.minor.patch>');
  process.exit(1);
}
if (out('git status --porcelain')) {
  console.error('commit or stash your changes first — a release is cut from a clean tree');
  process.exit(1);
}
if (out('git rev-parse --abbrev-ref HEAD') !== 'main') {
  console.error('releases are cut from main');
  process.exit(1);
}

function setVersion(rel, edit) {
  const file = path.join(ROOT, rel);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(json);
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
setVersion('package.json', (j) => { j.version = version; });
setVersion('plugin/.claude-plugin/plugin.json', (j) => { j.version = version; });
setVersion('.claude-plugin/marketplace.json', (j) => {
  for (const p of j.plugins || []) if (p.name === 'playback-lens') p.version = version;
});
try { run('npm install --package-lock-only --ignore-scripts --no-audit --no-fund'); } catch { /* lockfile refresh is best-effort */ }

run('npm test');
run('git add -A');
run(`git commit -m "release ${version}"`);
run(`git tag v${version}`);
run('git push origin main --follow-tags');
run('npm publish');

console.log(`\nreleased ${version}: npm has the server, GitHub has the plugin.`);
console.log('Machines with marketplace auto-update on get the skill on their next session;');
console.log('others: claude plugin marketplace update claude-playback-lens && claude plugin update playback-lens@claude-playback-lens');
