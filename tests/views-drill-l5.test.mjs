/**
 * L5 + the drill kit: the dotted-`bi` grammar (SPEC §8), block enumeration and
 * twin pairing, the three recorded spill-reference forms, and the display
 * rules of house rule 3 (the disclosure chips and the sum footnote belong to
 * components/chips.mjs and components/statbar.mjs — one implementation each,
 * per SPEC §9's drift rule).
 *
 * The view modules import the group E foundation, which is DOM-free at module
 * scope, so they load cleanly under node:test with no DOM and no server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBi, formatBi, parseLocator, formatLocator, copyLocator, biToPath,
  blockKind, eventKind, enumerateBlocks, findBlock, siblingBlocks,
  extractSpillRefs, fmtInt, fmtBytes, fmtDur, toMs, truncate, num, spanProps,
  renderMarkdown, escapeHtml, queryString,
} from '../web/js/views/l5.mjs';

/* ------------------------------------------------------------ bi grammar */

test('parseBi accepts exactly the four recorded forms', () => {
  assert.deepEqual(parseBi('3'), { kind: 'content', i: 3, j: null });
  assert.deepEqual(parseBi('2.11'), { kind: 'content-nested', i: 2, j: 11 });
  assert.deepEqual(parseBi('r'), { kind: 'sidecar', i: null, j: null });
  assert.deepEqual(parseBi('r.4'), { kind: 'sidecar-index', i: null, j: 4 });
});

test('parseBi rejects everything else rather than inventing an address', () => {
  for (const bad of ['', null, undefined, 'x', '1.2.3', 'r.r', '-1', '1.', '.1', 'R', 'r.-1', '1.2.']) {
    assert.equal(parseBi(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('formatBi round-trips every parseBi result', () => {
  for (const bi of ['0', '3', '2.11', 'r', 'r.4']) {
    assert.equal(formatBi(parseBi(bi)), bi);
    assert.equal(formatBi(bi), bi, 'a valid string passes through');
  }
  assert.equal(formatBi(null), null);
  assert.equal(formatBi('nope'), null);
  assert.equal(formatBi({ kind: 'content', i: -1 }), null);
});

test('parseLocator splits on the first dot AFTER the line number (SPEC §8)', () => {
  assert.deepEqual(parseLocator('412'), { line: 412, bi: null });
  assert.deepEqual(parseLocator('412.2'), { line: 412, bi: '2' });
  assert.deepEqual(parseLocator('412.2.11'), { line: 412, bi: '2.11' });
  assert.deepEqual(parseLocator('412.r'), { line: 412, bi: 'r' });
  assert.deepEqual(parseLocator('412.r.4'), { line: 412, bi: 'r.4' });
});

test('parseLocator enforces 1-based lines and rejects malformed tails', () => {
  assert.equal(parseLocator('0'), null, 'line 0 does not exist — lines are 1-based (SPEC §1)');
  assert.equal(parseLocator('-3'), null);
  assert.equal(parseLocator('abc'), null);
  assert.equal(parseLocator('12.'), null);
  assert.equal(parseLocator('12.zz'), null);
  assert.equal(parseLocator(''), null);
  assert.equal(parseLocator(null), null);
});

test('formatLocator / parseLocator round-trip', () => {
  for (const [line, bi] of [[1, null], [412, '2'], [412, '2.11'], [7, 'r'], [7, 'r.0']]) {
    const loc = formatLocator(line, bi);
    assert.deepEqual(parseLocator(loc), { line, bi });
  }
  assert.equal(formatLocator(0, null), null);
  assert.equal(formatLocator(5, 'bogus'), '5', 'an unusable block index is dropped, never guessed at');
});

test('copyLocator is the user-verifiable file:line[.bi] form', () => {
  assert.equal(copyLocator('subagents/agent-a1.jsonl', 412, '2.11'), 'subagents/agent-a1.jsonl:412.2.11');
  assert.equal(copyLocator('main.jsonl', 3, null), 'main.jsonl:3');
});

test('biToPath maps each form to its JSON path', () => {
  assert.deepEqual(biToPath('3'), ['message', 'content', 3]);
  assert.deepEqual(biToPath('2.11'), ['message', 'content', 2, 'content', 11]);
  assert.deepEqual(biToPath('r'), ['toolUseResult']);
  assert.deepEqual(biToPath('r.4'), ['toolUseResult', 4]);
  assert.equal(biToPath('nope'), null);
});

/* ------------------------------------------------------- block kinds */

test('blockKind and eventKind stay inside the SPEC §3 closed vocabulary', () => {
  assert.equal(blockKind({ type: 'text' }), 'text');
  assert.equal(blockKind({ type: 'thinking' }), 'thinking');
  assert.equal(blockKind({ type: 'tool_use' }), 'tool_use');
  assert.equal(blockKind({ type: 'tool_result' }), 'tool_result');
  assert.equal(blockKind({ type: 'image' }), 'image');
  assert.equal(blockKind({ type: 'fallback' }), 'fallback');
  assert.equal(blockKind({ type: 'wormhole' }), 'unknown:wormhole', 'unknown types surface, never crash');

  assert.equal(eventKind({ type: 'user', origin: { kind: 'human' } }), 'prompt');
  assert.equal(eventKind({ type: 'user' }), 'user');
  assert.equal(eventKind({ type: 'attachment', attachment: { type: 'diagnostics' } }), 'attachment:diagnostics');
  assert.equal(eventKind({ type: 'system', subtype: 'api_error' }), 'system:api_error');
  assert.equal(eventKind({ type: 'queue-operation' }), 'queue-operation');
  assert.equal(eventKind({ type: 'martian' }), 'unknown:martian');
});

/* ------------------------------------------------- block enumeration */

test('enumerateBlocks addresses assistant content blocks by index', () => {
  const ev = {
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Read' }] },
  };
  const blocks = enumerateBlocks(ev);
  assert.deepEqual(blocks.map((b) => b.bi), ['0', '1', '2']);
  assert.deepEqual(blocks.map((b) => b.kind), ['thinking', 'text', 'tool_use']);
  assert.deepEqual(blocks[2].path, ['message', 'content', 2]);
});

test('enumerateBlocks descends into tool_result content with <i>.<j>', () => {
  const ev = {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result', tool_use_id: 't1',
        content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { media_type: 'image/png' } }],
      }],
    },
  };
  const blocks = enumerateBlocks(ev);
  assert.deepEqual(blocks.map((b) => b.bi), ['0', '0.0', '0.1']);
  assert.equal(blocks[2].kind, 'image');
  assert.equal(blocks[2].parentBi, '0');
  assert.deepEqual(blocks[2].path, ['message', 'content', 0, 'content', 1]);
});

test('a string body is addressed by line only — no fabricated block index', () => {
  const blocks = enumerateBlocks({ type: 'user', origin: { kind: 'human' }, message: { content: 'do the thing' } });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].bi, null);
  assert.equal(blocks[0].kind, 'prompt');
  assert.match(blocks[0].note, /no block index/);
});

test('toolUseResult takes r and r.<j>, and the bare-string form is noted', () => {
  const arr = enumerateBlocks({ type: 'user', message: { content: [] }, toolUseResult: [{ type: 'text', text: 'a' }, { type: 'image' }] });
  assert.deepEqual(arr.map((b) => b.bi), ['r.0', 'r.1']);

  const obj = enumerateBlocks({ type: 'user', message: { content: [] }, toolUseResult: { filePath: '/x' } });
  assert.deepEqual(obj.map((b) => b.bi), ['r']);
  assert.equal(obj[0].kind, 'tool_result');

  const str = enumerateBlocks({ type: 'user', message: { content: [] }, toolUseResult: 'it failed' });
  assert.equal(str[0].bi, 'r');
  assert.match(str[0].note, /bare-string/);
});

test('image twins are paired and disclosed, never silently deduped', () => {
  const ev = {
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x' }, { type: 'image', source: {} }] }] },
    toolUseResult: { file: { base64: '' } },          // stripped by the reader; the KEY is the discriminator
  };
  const blocks = enumerateBlocks(ev);
  const sidecar = blocks.find((b) => b.bi === 'r');
  const copy = blocks.find((b) => b.bi === '0.1');
  assert.equal(sidecar.kind, 'image', 'toolUseResult.file.base64 is an image path (SPEC §8)');
  assert.equal(sidecar.twinOf, '0.1');
  assert.equal(copy.twin, 'r');
});

test('findBlock and siblingBlocks drive the [ / ] pager', () => {
  const ev = { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }] } };
  const blocks = enumerateBlocks(ev);
  assert.equal(findBlock(blocks, '1').node.text, 'b');
  assert.equal(findBlock(blocks, '9'), null);

  const mid = siblingBlocks(blocks, '1');
  assert.equal(mid.prev.bi, '0');
  assert.equal(mid.next.bi, '2');
  assert.equal(mid.index, 1);
  assert.equal(mid.total, 3);

  const first = siblingBlocks(blocks, '0');
  assert.equal(first.prev, null);
  const last = siblingBlocks(blocks, '2');
  assert.equal(last.next, null);

  const absent = siblingBlocks(blocks, '77');
  assert.equal(absent.index, -1);
});

/* --------------------------------------------------------- spill refs */

test('extractSpillRefs finds all three recorded forms and names each', () => {
  const text = [
    '<persisted-output>C:\\Users\\x\\tool-results\\big.txt</persisted-output>',
    '[Binary content (image/png, 1.2 MB) also saved to /tmp/shot.png]',
  ].join('\n');
  const refs = extractSpillRefs(text, { persistedOutputPath: '/var/out/structured.json' });
  const byForm = Object.fromEntries(refs.map((r) => [r.form, r.path]));
  assert.equal(byForm['persisted-output banner'], 'C:\\Users\\x\\tool-results\\big.txt');
  assert.equal(byForm['binary-content note'], '/tmp/shot.png');
  assert.equal(byForm['toolUseResult.persistedOutputPath'], '/var/out/structured.json');
  assert.equal(refs.find((r) => r.form === 'binary-content note').mime, 'image/png');
});

test('extractSpillRefs finds nothing in ordinary text', () => {
  assert.deepEqual(extractSpillRefs('just some output', null), []);
  assert.deepEqual(extractSpillRefs(null, null), []);
});

/* ------------------------------------------------------- display rules */

test('house rule 3: a zero is 0 and an unknown is null-with-a-reason, never the same', () => {
  assert.equal(fmtInt(0), '0');
  assert.equal(fmtInt(null), null);
  assert.equal(fmtInt(undefined), null);
  assert.equal(fmtInt(29741), '29,741');
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(null), null);
  assert.equal(fmtDur(null), null);
});

test('fmtDur never invents precision it does not have', () => {
  assert.equal(fmtDur(0), '0s');
  assert.equal(fmtDur(812), '812ms');
  assert.equal(fmtDur(2500), '2.5s');
  assert.equal(fmtDur(65000), '1m 5s');
  assert.equal(fmtDur(3600000 + 4 * 60000 + 12000), '1h 4m');
});

test('toMs accepts both recorded timestamp encodings', () => {
  assert.equal(toMs(1755400000000), 1755400000000);
  assert.equal(toMs('2026-08-17T07:07:59.000Z'), Date.parse('2026-08-17T07:07:59.000Z'));
  assert.equal(toMs(null), null);
  assert.equal(toMs('not a date'), null);
});

test('spanProps refuses to build a span from fewer than two timestamps', () => {
  assert.deepEqual(spanProps(1000, 4000, 'wall'), { label: 'wall', ms: 3000, from: 1000, to: 4000 });
  const one = spanProps(1000, null);
  assert.equal(one.ms, null);
  assert.match(one.reason, /only one timestamp recorded/);
  const none = spanProps(null, null);
  assert.equal(none.ms, null);
  assert.match(none.reason, /no timestamp recorded/);
});

test('num() never turns a missing value into a real zero', () => {
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num(''), null);
  assert.equal(num(false), null, 'Number(false) is 0 — a boolean is not a recorded count');
  assert.equal(num(0), 0, 'a real zero survives');
  assert.equal(num('42'), 42);
});

test('truncate and queryString behave', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(queryString({ q: 'x', empty: '', nul: null, n: 0 }), 'q=x&n=0');
  assert.equal(queryString(null), '');
});

/* ------------------------------------------------------------ markdown */

test('markdown rendering escapes first and never passes HTML through', () => {
  const html = renderMarkdown('# Head\n\n<script>alert(1)</script>\n\n- a\n- b\n\n`code` and **bold**');
  assert.match(html, /<h1>Head<\/h1>/);
  assert.ok(!html.includes('<script>'), 'raw HTML must be escaped, not executed');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<li>a<\/li>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('markdown links are limited to http(s)', () => {
  const html = renderMarkdown('[x](javascript:alert(1)) and [y](https://example.com)');
  assert.ok(!/href="javascript:/i.test(html), 'a javascript: URL must never become an href');
  assert.ok(html.includes('[x](javascript:alert(1))'), 'it stays inert escaped text instead');
  assert.match(html, /<a href="https:\/\/example.com"/);
});

test('escapeHtml covers the five characters that matter', () => {
  assert.equal(escapeHtml('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
});
