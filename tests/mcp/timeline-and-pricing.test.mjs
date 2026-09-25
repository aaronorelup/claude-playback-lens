// tests/mcp/timeline-and-pricing.test.mjs — the 2026-09 repairs.
//
//  1. USER RATES. A model released after the shipped table (as Fable 5.1 was
//     against a table that knew only fable-5) used to vanish from every $ figure. The rate
//     can now be added at runtime, from a cited source, and every cost answer
//     leads with a PRICING GAP banner until it is.
//  2. TIMELINE SEARCH. lens_search can be restricted to the kind of event a
//     hit sits in (the user's own prompts, tool calls, a given tool) and to a
//     date window, with copies in forked sessions collapsed.
//  3. lens_read opens the event at a locator.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import * as pricing from '../../shared/pricing.mjs';
import { createUserPricing } from '../../server/user-pricing.mjs';
import { runFind } from '../../server/find.mjs';
import { unratedModels } from '../../mcp/pricing-gap.mjs';
import { lensFixtures, waitReady } from './helpers.mjs';

const textOf = (r) => r.content.map((c) => c.text ?? '').join('\n');
let scratch;
let engine;
let fx;

before(async () => {
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-fixes-'));
  process.env.LENS_PRICING_FILE = path.join(scratch, 'pricing.json');
  fx = await lensFixtures();
  process.env.CLAUDE_PROJECTS = fx.STORE;
  process.env.LENS_CACHE_DIR = path.join(scratch, 'cache');
  const { createEngine } = await import('../../mcp/engine.mjs');
  engine = await createEngine({ mode: 'test' });
  await waitReady(engine.ctx);
});

after(async () => {
  pricing.setUserRates({});
  if (engine) await engine.close();
  delete process.env.LENS_PRICING_FILE;
  await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

// ------------------------------------------------------------ 1. user rates

test('an unshipped model is unpriced until a user rate exists, then priced and marked user-sourced', () => {
  const row = { model: 'claude-future-9-1', input: 1000, output: 1000, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0, at: Date.parse('2026-09-20T00:00:00Z') };
  assert.equal(pricing.priceRow(row).unpriced, true);
  pricing.setUserRates({ 'future-9-1': [{ from: null, to: null, inputU: 20000, outputU: 100000 }] });
  try {
    const p = pricing.priceRow(row);
    assert.equal(p.unpriced, false);
    assert.equal(p.usd.total, 1000 * 20000 + 1000 * 100000);
    assert.equal(pricing.rateSource('future-9-1'), 'user');
  } finally {
    pricing.setUserRates({});
  }
});

test('setUserRates refuses a key that is not normalised, and a bad table leaves the old one in place', () => {
  pricing.setUserRates({ 'future-9-1': [{ from: null, to: null, inputU: 20000, outputU: 100000 }] });
  assert.throws(() => pricing.setUserRates({ 'claude-future-9-1': [{ from: null, to: null, inputU: 20000, outputU: 100000 }] }), /normalised/);
  assert.throws(() => pricing.setUserRates({ 'x-1': [{ from: null, to: null, inputU: 3, outputU: 5 }] }), /non-integral/);
  assert.equal(pricing.rateSource('future-9-1'), 'user', 'the previous table survived both refusals');
  pricing.setUserRates({});
});

test('the rate file: set needs a source URL, rejects sub-cent input, round-trips, and removes', async () => {
  const up = createUserPricing(pricing);
  await assert.rejects(up.set({ model: 'claude-future-9-1', inputUsdPerMtok: 10, outputUsdPerMtok: 50 }), /source/);
  await assert.rejects(up.set({ model: 'future-9-1', inputUsdPerMtok: 10.005, outputUsdPerMtok: 50, source: 'https://x.test/p' }), /cents|finer/);
  const r = await up.set({ model: 'claude-future-9-1', inputUsdPerMtok: 10, outputUsdPerMtok: 50, source: 'https://x.test/p' });
  assert.equal(r.key, 'future-9-1');
  const onDisk = JSON.parse(fs.readFileSync(process.env.LENS_PRICING_FILE, 'utf8'));
  assert.equal(onDisk.models['future-9-1'][0].inputUsdPerMtok, 10);
  assert.equal(pricing.USER_RATES['future-9-1'][0].inputU, 20000);
  // a price change closes the old interval the day before
  await up.set({ model: 'future-9-1', inputUsdPerMtok: 8, outputUsdPerMtok: 40, source: 'https://x.test/p', from: '2026-10-01' });
  const list = pricing.USER_RATES['future-9-1'];
  assert.equal(list.length, 2);
  assert.equal(list[0].to, '2026-09-30');
  assert.equal(list[1].from, '2026-10-01');
  assert.equal((await up.remove('future-9-1')).removed, true);
  assert.equal(pricing.rateSource('future-9-1'), null);
});

test('cost answers lead with a PRICING GAP banner naming the unrated model, until lens_pricing fixes it', async () => {
  // The fixture records claude-3-opus-20240229, which the shipped table
  // deliberately does not price (R7).
  assert.ok(unratedModels(engine.ctx, pricing).some((g) => g.model === 'claude-3-opus-20240229'));
  const before = textOf(await engine.invoke('lens_usage', { scope: 'store', group_by: 'model' }));
  assert.match(before, /^⚠ PRICING GAP — .*claude-3-opus-20240229/);
  assert.match(before, /lens_pricing \{action:"set"/);

  const list = textOf(await engine.invoke('lens_pricing', {}));
  assert.match(list, /claude-3-opus-20240229\s+→ key "opus-3"/);

  const set = await engine.invoke('lens_pricing', {
    action: 'set', model: 'claude-3-opus-20240229', input_usd_per_mtok: 15, output_usd_per_mtok: 75,
    source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
  });
  assert.notEqual(set.isError, true, textOf(set));

  const afterText = textOf(await engine.invoke('lens_usage', { scope: 'store', group_by: 'model' }));
  assert.ok(!afterText.includes('PRICING GAP'), afterText.slice(0, 400));
  assert.ok(!/unpriced [1-9]/.test(afterText), 'the model is priced now, so nothing is left in the unpriced channel');

  await engine.invoke('lens_pricing', { action: 'remove', model: 'claude-3-opus-20240229' });
  assert.match(textOf(await engine.invoke('lens_usage', { scope: 'store' })), /^⚠ PRICING GAP/);
});

// ------------------------------------------------------------ 2. timeline search

async function tinyStore() {
  const root = path.join(scratch, 'timeline');
  const slug = 'C--proj';
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await fsp.mkdir(path.join(root, slug), { recursive: true });
  const J = (o) => JSON.stringify(o);
  const prompt = { type: 'user', uuid: 'p1', timestamp: '2026-09-10T10:00:00.000Z', message: { role: 'user', content: 'draw Nova with her scythe' } };
  const linesA = [
    J(prompt),
    J({ type: 'user', uuid: 'm1', isMeta: true, timestamp: '2026-09-10T10:00:01.000Z', message: { role: 'user', content: '<system-reminder>Nova canon lives in Notion</system-reminder>' } }),
    J({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-10T10:00:02.000Z', message: { role: 'assistant', model: 'claude-fable-5', content: [
      { type: 'text', text: 'Rendering Nova now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'higgsfield generate video --prompt "Nova" --out C:/out/nova.mp4' } },
    ] } }),
    J({ type: 'user', uuid: 'r1', timestamp: '2026-09-10T10:01:00.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'saved C:/out/nova.mp4' },
    ] } }),
    J({ type: 'assistant', uuid: 'a2', timestamp: '2026-09-11T09:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_2', name: 'PowerShell', input: { command: 'Move-Item C:/out/nova.mp4 D:/library/' } },
    ] } }),
  ];
  // B is a resume of A: it carries a verbatim copy of the prompt line.
  const linesB = [J(prompt), J({ type: 'user', uuid: 'p2', timestamp: '2026-09-12T08:00:00.000Z', message: { role: 'user', content: 'more Nova please' } })];
  const fa = path.join(root, slug, `${A}.jsonl`);
  const fb = path.join(root, slug, `${B}.jsonl`);
  await fsp.writeFile(fa, linesA.join('\n') + '\n');
  await fsp.writeFile(fb, linesB.join('\n') + '\n');
  const fileTable = new Map([
    [`${slug}/${A}.jsonl`, { size: fs.statSync(fa).size, mtimeMs: Date.parse('2026-09-11T09:00:00Z') }],
    [`${slug}/${B}.jsonl`, { size: fs.statSync(fb).size, mtimeMs: Date.parse('2026-09-12T08:00:00Z') }],
  ]);
  const sessions = [
    { slug, id: A, mainRel: `${slug}/${A}.jsonl`, files: [`${slug}/${A}.jsonl`] },
    { slug, id: B, mainRel: `${slug}/${B}.jsonl`, files: [`${slug}/${B}.jsonl`] },
  ];
  return { root, sessions, fileTable };
}

async function find(store, opts) {
  const matches = [];
  let done = null;
  await runFind({ projectsDir: store.root, sessions: store.sessions, fileTable: store.fileTable, emit: (ev, d) => { if (ev === 'match') matches.push(d); if (ev === 'done') done = d; }, ...opts });
  return { matches, done };
}

test('kinds:["prompt"] finds only what the user typed — not meta reminders, not tool calls, not replies', async () => {
  const s = await tinyStore();
  const { matches } = await find(s, { q: 'nova', kinds: ['prompt'] });
  assert.deepEqual(matches.map((m) => m.ctx).sort(), ['draw Nova with her scythe', 'draw Nova with her scythe', 'more Nova please']);
  assert.ok(matches.every((m) => m.kind === 'prompt'));
});

test('distinct collapses a prompt copied into a resumed session', async () => {
  const s = await tinyStore();
  const { matches } = await find(s, { q: 'nova', kinds: ['prompt'], distinct: true });
  assert.equal(matches.length, 2);
});

test('tool_use + tool filter: the higgsfield command, and the session that moved the file', async () => {
  const s = await tinyStore();
  const gen = await find(s, { q: 'higgsfield', kinds: ['tool_use'] });
  assert.equal(gen.matches.length, 1);
  assert.equal(gen.matches[0].tool, 'Bash');
  assert.match(gen.matches[0].ctx, /higgsfield generate video/);

  const moved = await find(s, { q: 'nova.mp4', kinds: ['tool_use'], tool: 'Bash,PowerShell', ctxWidth: 200 });
  assert.equal(moved.matches.length, 2);
  assert.ok(moved.matches.some((m) => m.tool === 'PowerShell' && /Move-Item/.test(m.ctx)));

  assert.equal((await find(s, { q: 'nova.mp4', tool: 'Edit,Write' })).matches.length, 0);
  assert.equal((await find(s, { q: 'nova', tool: 'power*' })).matches.length, 1, 'wildcards, case-insensitive');
});

test('a tool_result is attributed to the tool that produced it', async () => {
  const s = await tinyStore();
  const { matches } = await find(s, { q: 'saved', kinds: ['tool_result'], tool: 'Bash' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].tool, 'Bash');
});

test('since/until window by event timestamp', async () => {
  const s = await tinyStore();
  assert.equal((await find(s, { q: 'nova', kinds: ['prompt'], since: '2026-09-12' })).matches.length, 1);
  assert.equal((await find(s, { q: 'nova', kinds: ['prompt'], until: '2026-09-10', distinct: true })).matches.length, 1);
  assert.equal((await find(s, { q: 'nova', since: '2027-01-01' })).matches.length, 0);
});

test('an unfiltered search shows a typed prompt as text, not as its JSON envelope, and names its kind', async () => {
  const s = await tinyStore();
  const { matches } = await find(s, { q: 'scythe' });
  assert.equal(matches[0].ctx, 'draw Nova with her scythe');
  assert.equal(matches[0].kind, 'prompt');
});

// ------------------------------------------------------------ 3. lens_read

test('lens_read opens the event at a locator, with the next events', async () => {
  const r = await engine.invoke('lens_read', { slug: fx.SLUG, id: fx.S1, file: `${fx.S1}.jsonl`, line: 2, following: 1 });
  assert.notEqual(r.isError, true, textOf(r));
  const t = textOf(r);
  assert.match(t, /\[prompt\]\nNEEDLE_ALPHA please build the thing/);
  assert.match(t, /── L3 · /);
});

test('lens_search filters reach runFind through the tool', async () => {
  const t = textOf(await engine.invoke('lens_search', { q: 'NEEDLE_ALPHA', kinds: ['prompt'] }));
  assert.match(t, /kinds=prompt/);
  assert.match(t, /1 matches/, 'the prompt copied into the fork collapses (distinct defaults on)');
  assert.match(t, /"NEEDLE_ALPHA please build the thing"/);
});
