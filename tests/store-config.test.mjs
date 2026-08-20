// tests/store-config.test.mjs — projectsDir precedence, config.json, validateDir.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveProjectsDir,
  parseProjectsArg,
  expandPath,
  loadConfig,
  loadConfigSync,
  saveConfig,
  validateDir,
  configPath,
  DEFAULT_PROJECTS_DIR,
} from '../server/config.mjs';

let TMP;
before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-config-'));
});
after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

let n = 0;
const freshDir = async (name = 'd') => {
  const d = path.join(TMP, `${name}${n++}`);
  await fsp.mkdir(d, { recursive: true });
  return d;
};

describe('parseProjectsArg', () => {
  test('accepts both --projects X and --projects=X, anywhere in argv', () => {
    assert.equal(parseProjectsArg(['node', 'lens.mjs', '--projects', 'C:\\a']), 'C:\\a');
    assert.equal(parseProjectsArg(['--projects=C:\\b', '--port', '7777']), 'C:\\b');
    assert.equal(parseProjectsArg(['--port', '7777']), null);
    assert.equal(parseProjectsArg(['--projects', '--port']), null, 'a bare flag is not a path');
  });
});

describe('resolveProjectsDir precedence', () => {
  const ARG = 'C:\\from-arg';
  const ENV = 'C:\\from-env';
  const CFG = 'C:\\from-config';

  test('1. --projects beats everything', () => {
    const r = resolveProjectsDir(['--projects', ARG], { CLAUDE_PROJECTS: ENV }, { projectsDir: CFG });
    assert.equal(r.source, 'arg');
    assert.equal(r.dir, path.resolve(ARG));
    assert.match(r.sourceLabel, /--projects/);
  });

  test('2. CLAUDE_PROJECTS beats config.json', () => {
    const r = resolveProjectsDir([], { CLAUDE_PROJECTS: ENV }, { projectsDir: CFG });
    assert.equal(r.source, 'env');
    assert.equal(r.dir, path.resolve(ENV));
  });

  test('3. config.json beats the default', () => {
    const r = resolveProjectsDir([], {}, { projectsDir: CFG });
    assert.equal(r.source, 'config');
    assert.equal(r.dir, path.resolve(CFG));
  });

  test('4. otherwise ~/.claude/projects', () => {
    const r = resolveProjectsDir([], {}, null);
    assert.equal(r.source, 'default');
    assert.equal(r.dir, DEFAULT_PROJECTS_DIR);
  });

  test('config.json is genuinely read from disk when no override is injected', async () => {
    const appDir = await freshDir('app');
    const env = { LENS_CONFIG_DIR: appDir };
    await fsp.writeFile(configPath(env), JSON.stringify({ projectsDir: CFG }));

    assert.deepEqual(loadConfigSync(env), { projectsDir: CFG });
    const r = resolveProjectsDir([], env);
    assert.equal(r.source, 'config');
    assert.equal(r.dir, path.resolve(CFG));
  });

  test('empty strings do not win a level', () => {
    const r = resolveProjectsDir(['--projects', ''], { CLAUDE_PROJECTS: '   ' }, { projectsDir: '' });
    assert.equal(r.source, 'default');
  });
});

describe('expandPath', () => {
  test('expands ~, strips pasted quotes, returns absolute', () => {
    assert.equal(expandPath('~'), os.homedir());
    assert.equal(expandPath('~/.claude/projects'), path.join(os.homedir(), '.claude', 'projects'));
    assert.equal(expandPath('"C:\\My Projects\\x"'), path.resolve('C:\\My Projects\\x'));
    assert.equal(expandPath('   '), null);
    assert.equal(expandPath(null), null);
  });
});

describe('config.json load/save', () => {
  test('missing and corrupt files both read as {} — config is never a precondition', async () => {
    const appDir = await freshDir('app');
    const env = { LENS_CONFIG_DIR: appDir };
    assert.deepEqual(await loadConfig(env), {});
    await fsp.writeFile(configPath(env), '{ not json');
    assert.deepEqual(await loadConfig(env), {});
    assert.deepEqual(loadConfigSync(env), {});
  });

  test('saveConfig merges, writes atomically, leaves no .tmp', async () => {
    const appDir = await freshDir('app');
    const env = { LENS_CONFIG_DIR: appDir };
    await saveConfig({ projectsDir: 'C:\\one', theme: 'dark' }, env);
    const res = await saveConfig({ projectsDir: 'C:\\two' }, env);

    assert.equal(res.ok, true);
    assert.deepEqual(await loadConfig(env), { projectsDir: 'C:\\two', theme: 'dark' });
    const entries = await fsp.readdir(appDir);
    assert.deepEqual(entries, ['config.json'], 'no config.json.tmp survives');
  });
});

describe('validateDir', () => {
  /**
   * A tiny synthetic store. Session 11111111 lives in proj-a but has a fragment
   * dir in proj-b — the union rule (SPEC §2) must count it once, not twice.
   */
  async function buildTree() {
    const root = await freshDir('store');
    const S1 = '11111111-1111-4111-8111-111111111111';
    const S2 = '22222222-2222-4222-8222-222222222222';
    const S3 = '33333333-3333-4333-8333-333333333333';
    const w = async (rel, bytes) => {
      const abs = path.join(root, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, 'x'.repeat(bytes));
    };
    await w(`proj-a/${S1}.jsonl`, 10);
    await w(`proj-a/${S2}.jsonl`, 20);
    await w(`proj-a/${S2}/subagents/agent-a0123456789abcde.jsonl`, 30);
    await w(`proj-a/${S2}/subagents/agent-a0123456789abcde.meta.json`, 5);
    await w('proj-a/memory/notes.md', 7);
    await w(`proj-b/${S3}.jsonl`, 40);
    await w(`proj-b/${S1}/workflows/scripts/x-wf_12345678-abc.js`, 9);
    return root;
  }

  test('counts projects, distinct sessions and bytes on a synthetic tree', async () => {
    const root = await buildTree();
    const v = await validateDir(root);
    assert.equal(v.ok, true);
    assert.equal(v.reason, null);
    assert.equal(v.projects, 2);
    assert.equal(v.sessions, 3, 'the cross-project fragment unions into one session');
    assert.equal(v.files, 7);
    assert.equal(v.bytes, 10 + 20 + 30 + 5 + 40 + 7 + 9);
    assert.equal(v.truncated, false);
    assert.deepEqual(v.problems, []);
  });

  test('a missing dir is not ok and reports null counts, never 0', async () => {
    const v = await validateDir(path.join(TMP, 'nope-not-here'));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing');
    assert.equal(v.projects, null);
    assert.equal(v.sessions, null);
    assert.equal(v.bytes, null);
  });

  test('a file where a directory was expected', async () => {
    const f = path.join(await freshDir(), 'a-file');
    await fsp.writeFile(f, 'x');
    const v = await validateDir(f);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-a-directory');
    assert.equal(v.sessions, null);
  });

  test('an empty but valid dir is ok with real zeros', async () => {
    const v = await validateDir(await freshDir('empty'));
    assert.equal(v.ok, true);
    assert.equal(v.projects, 0);
    assert.equal(v.sessions, 0);
    assert.equal(v.bytes, 0);
  });

  test('non-UUID .jsonl files are not counted as sessions', async () => {
    const root = await freshDir('odd');
    await fsp.mkdir(path.join(root, 'proj'), { recursive: true });
    await fsp.writeFile(path.join(root, 'proj', 'notes.jsonl'), 'x');
    const v = await validateDir(root);
    assert.equal(v.projects, 1);
    assert.equal(v.sessions, 0);
    assert.equal(v.files, 1);
  });
});
