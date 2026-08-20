// SSE framing (parse our own stream), find vocabulary, heartbeat comments.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildCtx, startServer, sseCollect, SLUG, S1, S2 } from './fixtures/api/helpers.mjs';
import { sseOpen } from '../server/http.mjs';

let ctx, srv;
before(async () => { ctx = await buildCtx(); srv = await startServer(ctx); });
after(async () => { await srv.close(); });

test('find: matches resolve to real line/bi addresses; done closes the stream', async () => {
  const out = await sseCollect(`${srv.url}/api/find?q=NEEDLE_ALPHA`);
  assert.equal(out.status, 200);
  const byType = (t) => out.events.filter((e) => e.event === t);
  const matches = byType('match');
  assert.equal(matches.length, 4); // S1 lines 2,4 + S2 lines 2,3
  for (const m of matches) {
    assert.equal(typeof m.data.slug, 'string');
    assert.equal(typeof m.data.id, 'string');
    assert.ok(m.data.line >= 1, '1-based line');
    assert.ok(typeof m.data.ctx === 'string' && m.data.ctx.includes('NEEDLE_ALPHA'));
  }
  // the user prompt (string content) is a line-level match: no fabricated bi
  const s1 = matches.filter((m) => m.data.id === S1);
  assert.equal(s1.length, 2);
  const promptHit = s1.find((m) => m.data.line === 2);
  assert.equal(promptHit.data.bi, null);
  assert.equal(promptHit.data.file, `${S1}.jsonl`);
  // the assistant text block resolves to its block index
  const blockHit = s1.find((m) => m.data.line === 4);
  assert.equal(blockHit.data.bi, '0');
  // progress + aggregate skip report + done, and done is last
  assert.ok(byType('progress').length >= 1);
  const skips = byType('skip');
  assert.ok(skips.some((s) => /image payloads and .* signatures skipped/.test(s.data.reason)));
  const done = byType('done');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.matches, 4);
  assert.equal(out.events[out.events.length - 1].event, 'done');
});

test('find: &case=1 is case-sensitive; default is not', async () => {
  const insensitive = await sseCollect(`${srv.url}/api/find?q=needle_alpha`);
  assert.equal(insensitive.events.filter((e) => e.event === 'match').length, 4);
  const sensitive = await sseCollect(`${srv.url}/api/find?q=needle_alpha&case=1`);
  assert.equal(sensitive.events.filter((e) => e.event === 'match').length, 0);
  assert.equal(sensitive.events.filter((e) => e.event === 'done')[0].data.matches, 0);
});

test('find: regex mode and scope narrowing', async () => {
  const rx = await sseCollect(`${srv.url}/api/find?q=NEEDLE_(ALPHA|BETA)&re=1`);
  assert.equal(rx.events.filter((e) => e.event === 'match').length, 5); // + NEEDLE_BETA in S2 line 5
  const scoped = await sseCollect(`${srv.url}/api/find?q=NEEDLE_ALPHA&scope=session:${SLUG}/${S2}`);
  const m = scoped.events.filter((e) => e.event === 'match');
  assert.equal(m.length, 2);
  assert.ok(m.every((x) => x.data.id === S2));
});

test('SSE framing is well-formed and starts with a comment', async () => {
  const out = await sseCollect(`${srv.url}/api/find?q=NEEDLE_ALPHA`);
  assert.ok(out.raw.startsWith(': ok\n\n'));
  for (const frame of out.raw.split('\n\n')) {
    if (!frame.trim()) continue;
    assert.ok(frame.startsWith(':') || /^event: [a-z]+\ndata: /.test(frame),
      `frame is either a comment or event+data: ${JSON.stringify(frame.slice(0, 40))}`);
  }
});

test('sseOpen writes comment heartbeats on the configured cadence', async () => {
  const writes = [];
  const fake = {
    writeHead: () => {}, write: (s) => { writes.push(String(s)); return true; },
    end: () => {}, on: () => {},
  };
  const stream = sseOpen(fake, { heartbeatMs: 20 });
  await new Promise((r) => setTimeout(r, 90));
  stream.event('done', {});
  stream.close();
  assert.ok(writes.filter((w) => w.startsWith(': hb')).length >= 2, 'heartbeat comments written');
  assert.ok(writes.some((w) => w.startsWith('event: done\ndata: {}')));
});

test('audit SSE: vocabulary events arrive over the wire', async () => {
  const out = await sseCollect(`${srv.url}/api/audit?scope=session:${SLUG}/${S1}`);
  assert.equal(out.status, 200);
  const types = new Set(out.events.map((e) => e.event));
  assert.ok(types.has('invariant'));
  assert.ok(types.has('progress'));
  assert.ok(types.has('done'));
  const inv = out.events.filter((e) => e.event === 'invariant');
  const names = new Set(inv.map((e) => e.data.name));
  for (const expected of ['file-census', 'torn-lines', 'r2-census', 'pair-census', 'never-finalized',
    'synthetic-census', 'tcu-non-overflow', 'evidence-reread']) {
    assert.ok(names.has(expected), `invariant ${expected} emitted`);
  }
  assert.equal(out.events[out.events.length - 1].event, 'done');
});
