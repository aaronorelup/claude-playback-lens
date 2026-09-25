// tests/mcp/file-prompts.test.mjs — the 2026-09-25 field report from a work
// machine, turned into tests:
//
//  * a Windows path search (`AaronO\README.md`) returned "0 matches … a real
//    zero" because raw lines store each backslash twice;
//  * a search for part of a name matched the username in every line's cwd;
//  * the session doing the searching crowded the results;
//  * "when was this file first written?" had no tool;
//  * full prompt text for a date range had no tool.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { waitReady } from './helpers.mjs';

const textOf = (r) => r.content.map((c) => c.text ?? '').join('\n');
const SLUG = 'C--Users-zeduser-proj';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CWD = 'C:\\Users\\zeduser\\proj';
let root;
let engine;

const J = (o) => JSON.stringify({ cwd: CWD, gitBranch: 'main', ...o });
const user = (sid, uuid, at, content, extra = {}) => J({ type: 'user', sessionId: sid, uuid, timestamp: at, message: { role: 'user', content }, ...extra });
const call = (sid, uuid, at, id, name, input) => J({ type: 'assistant', sessionId: sid, uuid, timestamp: at, message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } });
const result = (sid, uuid, at, id, text) => J({ type: 'user', sessionId: sid, uuid, timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-fp-'));
  const dir = path.join(root, SLUG);
  await fsp.mkdir(dir, { recursive: true });
  const readme = 'C:\\Users\\AaronO\\README.md';
  await fsp.writeFile(path.join(dir, `${A}.jsonl`), [
    user(A, 'a1', '2026-09-20T09:00:00.000Z', 'create a readme for the project'),
    call(A, 'a2', '2026-09-20T09:00:05.000Z', 'tu1', 'Write', { file_path: readme, content: '# hi' }),
    result(A, 'a3', '2026-09-20T09:00:06.000Z', 'tu1', 'File created'),
    user(A, 'a4', '2026-09-21T10:00:00.000Z', 'now move it into docs'),
    call(A, 'a5', '2026-09-21T10:00:05.000Z', 'tu2', 'PowerShell', { command: `Move-Item "${readme}" "C:\\Users\\AaronO\\docs\\"` }),
    result(A, 'a6', '2026-09-21T10:00:06.000Z', 'tu2', ''),
  ].join('\n') + '\n');
  await fsp.writeFile(path.join(dir, `${B}.jsonl`), [
    user(B, 'b1', '2026-09-22T08:00:00.000Z', 'what is in C:/Users/AaronO/README.md now?'),
    call(B, 'b2', '2026-09-22T08:00:05.000Z', 'tu3', 'Bash', { command: 'rm "C:/Users/AaronO/README.md"' }),
  ].join('\n') + '\n');

  process.env.CLAUDE_PROJECTS = root;
  process.env.LENS_CACHE_DIR = path.join(root, '.cache');
  process.env.LENS_PRICING_FILE = path.join(root, 'pricing.json');
  const { createEngine } = await import('../../mcp/engine.mjs');
  engine = await createEngine({ mode: 'test' });
  await waitReady(engine.ctx);
});

after(async () => {
  if (engine) await engine.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

test('a Windows path with backslashes is found (stored doubled in the raw JSON)', async () => {
  const t = textOf(await engine.invoke('lens_search', { q: 'AaronO\\README.md', kinds: ['tool_use'] }));
  assert.match(t, /\b3 matches\b/, t);
  assert.ok(!t.includes('real zero'));
});

test('either slash finds the same path', async () => {
  const fwd = textOf(await engine.invoke('lens_search', { q: 'AaronO/README.md', kinds: ['tool_use'] }));
  assert.match(fwd, /\b3 matches\b/, fwd);
});

test('the default search ignores line metadata (a username in every cwd); metadata:true restores it', async () => {
  const content = textOf(await engine.invoke('lens_search', { q: 'zeduser' }));
  assert.match(content, /\b0 matches\b/, content);
  const meta = textOf(await engine.invoke('lens_search', { q: 'zeduser', metadata: true }));
  assert.match(meta, /incl\. line metadata/);
  assert.ok(!/\b0 matches\b/.test(meta), meta);
});

test('the calling session is skipped by default, and said so', async () => {
  const t = textOf(await engine.invoke('lens_search', { q: 'AaronO\\README.md' }, { sessionId: B }));
  assert.match(t, /skipping this session bbbbbbbb/);
  assert.ok(!t.includes(B), 'no hit from the calling session');
  const all = textOf(await engine.invoke('lens_search', { q: 'AaronO\\README.md', include_current_session: true }, { sessionId: B }));
  assert.ok(all.includes(B));
});

test('lens_file: oldest first, first write, move and delete classified from the commands', async () => {
  const t = textOf(await engine.invoke('lens_file', { path: 'AaronO\\README.md' }));
  assert.match(t, /3 events: 1 write · 1 move · 1 delete/, t);
  assert.match(t, /first write:\s+2026-09-20 09:00 UTC — write via Write in aaaaaaaa/);
  assert.match(t, /last change:\s+2026-09-22 08:00 UTC — delete via Bash in bbbbbbbb/);
  const order = [...t.matchAll(/^(2026-09-\d\d \d\d:\d\d)\s+(\w+)/gm)].map((m) => m[2]);
  assert.deepEqual(order, ['write', 'move', 'delete']);
});

test('lens_file: a path nothing touched is an honest zero with a way forward', async () => {
  const t = textOf(await engine.invoke('lens_file', { path: 'no\\such\\file.txt' }));
  assert.match(t, /real zero for that coverage/);
});

test('lens_prompts: every prompt in full, oldest first, grouped by session', async () => {
  const t = textOf(await engine.invoke('lens_prompts', {}));
  assert.match(t, /3 prompts found/);
  const iCreate = t.indexOf('create a readme for the project');
  const iMove = t.indexOf('now move it into docs');
  const iWhat = t.indexOf('what is in C:/Users/AaronO/README.md now?');
  assert.ok(iCreate > 0 && iCreate < iMove && iMove < iWhat, t);
  assert.ok(!t.includes('File created'), 'tool results are not prompts');
});

test('lens_prompts: a date window and a contains filter', async () => {
  const t = textOf(await engine.invoke('lens_prompts', { since: '2026-09-21', until: '2026-09-21' }));
  assert.match(t, /1 prompt found/);
  assert.match(t, /now move it into docs/);
  const c = textOf(await engine.invoke('lens_prompts', { contains: 'readme' }));
  assert.match(c, /2 prompts found/);
});
