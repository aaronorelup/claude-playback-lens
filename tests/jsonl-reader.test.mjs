// tests/jsonl-reader.test.mjs — \n-only splitting, U+2028, tail holdback,
// offset tables, 1-based lines, stripHeavy (group B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readLines, stripHeavy, buildOffsetTable, readLineAt, readLineRange } from '../server/jsonl.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reader');
const fx = (...p) => path.join(FIX, ...p);

async function collect(absPath) {
  const out = [];
  for await (const L of readLines(absPath)) out.push(L);
  return out;
}

test('U+2028 inside a JSON string does NOT split a line (readline would tear it)', async () => {
  const expected = JSON.parse(await fsp.readFile(fx('lines', 'u2028.expected.json'), 'utf8'));
  const lines = await collect(fx('lines', 'u2028.jsonl'));
  assert.equal(lines.length, expected.lines);
  const seps = (lines[1].text.match(/[\u2028\u2029]/g) || []).length;
  assert.equal(seps, expected.separatorsInLine2, 'line 2 keeps its raw U+2028/U+2029 intact');
  for (const L of lines) assert.doesNotThrow(() => JSON.parse(stripHeavy(L.text).text), `line ${L.line} parses`);
});

test('lines are 1-based and carry correct byteOffset/bytes', async () => {
  const lines = await collect(fx('lines', 'u2028.jsonl'));
  assert.equal(lines[0].line, 1);
  assert.equal(lines[0].byteOffset, 0);
  const raw = await fsp.readFile(fx('lines', 'u2028.jsonl'));
  for (const L of lines) {
    const slice = raw.subarray(L.byteOffset, L.byteOffset + L.bytes).toString('utf8');
    assert.equal(slice, L.text, `line ${L.line} slice round-trips through byteOffset/bytes`);
    assert.equal(raw[L.byteOffset + L.bytes], 0x0a, `line ${L.line} is \\n-terminated`);
  }
});

test('unterminated tail is held back; \\r is stripped from text but counted in bytes', async () => {
  const lines = await collect(fx('lines', 'tail.jsonl'));
  assert.equal(lines.length, 2, 'the partial third line is not yielded');
  assert.ok(!lines[0].text.endsWith('\r'), 'CRLF line 1: \\r stripped from text');
  assert.doesNotThrow(() => JSON.parse(lines[0].text));
  assert.doesNotThrow(() => JSON.parse(lines[1].text));
  // bytes counts the raw content including the \r
  const raw = await fsp.readFile(fx('lines', 'tail.jsonl'));
  assert.equal(raw[lines[0].byteOffset + lines[0].bytes - 1], 0x0d, 'bytes includes the \\r');
});

test('a torn line is exactly one JSON.parse failure, never a crash', async () => {
  const lines = await collect(fx('lines', 'torn.jsonl'));
  assert.equal(lines.length, 3);
  let failures = 0;
  for (const L of lines) {
    try { JSON.parse(stripHeavy(L.text).text); } catch { failures += 1; }
  }
  assert.equal(failures, 1);
});

test('offset table: total, seek-reads, out-of-range null, 1-based windows', async () => {
  const abs = fx('store', 'C--fx-projC', '44444444-4444-4444-8444-444444444444.jsonl');
  const table = await buildOffsetTable(abs);
  const all = await collect(abs);
  assert.equal(table.total, all.length);
  assert.equal(table.offsets[0], 0);
  // every line read via the table equals the streamed line
  for (const L of all) {
    assert.equal(await readLineAt(abs, L.line), L.text, `readLineAt(${L.line})`);
  }
  assert.equal(await readLineAt(abs, 0), null, 'line 0 does not exist (1-based)');
  assert.equal(await readLineAt(abs, table.total + 1), null, 'past-end line is null');
  const win = await readLineRange(abs, table.total - 1, 5);
  assert.equal(win.total, table.total);
  assert.equal(win.count, 2, 'window clamps at end of file');
  assert.equal(win.lines[0], all[table.total - 2].text);
  const empty = await readLineRange(abs, table.total + 5, 3);
  assert.equal(empty.count, 0, 'unsatisfiable window returns count 0 (caller 416s)');
});

test('stripHeavy: base64 >=500 and signatures >=100 replaced with "" and recorded; short values untouched', () => {
  const b64 = 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(600);
  const sig = 'E'.repeat(150);
  const line = `{"a":{"data":"${b64}"},"b":{"base64":"${b64}"},"c":{"signature":"${sig}"},"d":{"data":"short"},"e":{"signature":"${'F'.repeat(50)}"}}`;
  const { text, blobs } = stripHeavy(line);
  const obj = JSON.parse(text);
  assert.equal(obj.a.data, '');
  assert.equal(obj.b.base64, '');
  assert.equal(obj.c.signature, '');
  assert.equal(obj.d.data, 'short', 'short payloads stay');
  assert.equal(obj.e.signature, 'F'.repeat(50), 'sub-threshold signature stays');
  assert.equal(blobs.length, 3);
  assert.deepEqual(blobs.map((b) => b.kind), ['base64', 'base64', 'signature']);
  assert.equal(blobs[0].length, b64.length, 'length recorded per block');
  assert.ok(blobs[0].head.startsWith('iVBOR'), 'head kept for magic-byte sniffing');
  assert.equal(blobs[2].head, null, 'signatures record no head');
});

test('stripHeavy leaves a line without heavy payloads byte-identical', () => {
  const line = '{"type":"user","message":{"content":"plain text with \\"data\\" mentioned"}}';
  const { text, blobs } = stripHeavy(line);
  assert.equal(text, line);
  assert.equal(blobs.length, 0);
});
