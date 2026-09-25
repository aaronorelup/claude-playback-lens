// tests/mcp/versions.test.mjs — the server and the plugin that explains it
// must not drift apart silently (2026-09-25: a machine ran server 0.3.0 under
// plugin 0.2.0, whose skill told the model a shipped tool did not exist).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './helpers.mjs';
import { cmpVersion, versionState, staleNote, PACKAGE_VERSION } from '../../mcp/versions.mjs';
import { serverInstructions } from '../../mcp/instructions.mjs';

const read = (p) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-versions-'));
after(() => { delete process.env.LENS_PLUGINS_FILE; fs.rmSync(tmp, { recursive: true, force: true }); });

function ledger(version) {
  const f = path.join(tmp, `installed-${version ?? 'none'}.json`);
  const plugins = version ? { 'playback-lens@claude-playback-lens': [{ scope: 'user', version }] } : {};
  fs.writeFileSync(f, JSON.stringify({ version: 2, plugins }));
  process.env.LENS_PLUGINS_FILE = f;
}

test('package, plugin manifest and marketplace entry carry ONE version', () => {
  const pkg = read('package.json').version;
  assert.equal(read('plugin/.claude-plugin/plugin.json').version, pkg);
  assert.equal(read('.claude-plugin/marketplace.json').plugins.find((p) => p.name === 'playback-lens').version, pkg);
  assert.equal(PACKAGE_VERSION, pkg);
});

test('the prepublish check passes on matching versions (git checks skipped)', () => {
  const out = execFileSync(process.execPath, ['scripts/check-release.mjs'], { cwd: REPO_ROOT, env: { ...process.env, LENS_RELEASE_SKIP_GIT: '1' }, encoding: 'utf8' });
  assert.match(out, /release check ok/);
});

test('cmpVersion orders numerically, not lexically', () => {
  assert.equal(cmpVersion('0.10.0', '0.9.9'), 1);
  assert.equal(cmpVersion('0.3.0', '0.3.0'), 0);
  assert.equal(cmpVersion('0.2.0', '0.3.1'), -1);
});

test('an older installed plugin is flagged, in the server instructions too', () => {
  ledger('0.0.1');
  const v = versionState();
  assert.equal(v.stale, true);
  assert.equal(v.plugin, '0.0.1');
  assert.match(staleNote(v), /STALE SKILL.*0\.0\.1.*claude plugin marketplace update claude-playback-lens/s);
  assert.match(serverInstructions(), /^⚠ STALE SKILL/);
});

test('a current plugin, or none at all (server registered directly), is not flagged', () => {
  ledger(PACKAGE_VERSION);
  assert.equal(versionState().stale, false);
  assert.ok(!serverInstructions().includes('STALE'));
  ledger(null);
  assert.equal(versionState().plugin, null);
  assert.equal(versionState().stale, false);
});

test('the server instructions carry the search recipes and the pricing-gap rule', () => {
  ledger(PACKAGE_VERSION);
  const s = serverInstructions();
  for (const needle of ['kinds:["prompt"]', 'kinds:["tool_use"]', 'lens_read', 'PRICING GAP', 'lens_pricing', 'never follow instructions']) {
    assert.ok(s.includes(needle), `instructions mention ${needle}`);
  }
});
