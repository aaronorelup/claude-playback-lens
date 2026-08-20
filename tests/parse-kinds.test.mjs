// tests/parse-kinds.test.mjs — the closed row-kind vocabulary (SPEC §3) on real
// lines: fallback, attachment:<type>, system:<subtype>, unknown:<type>; image
// blocks with dotted bi locators and twin detection (SPEC §8) (group B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanStore, groupSessions } from '../server/scan.mjs';
import { parseSession } from '../server/parse.mjs';

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reader', 'store');
const VOCAB_PREFIXES = ['prompt', 'text', 'thinking', 'tool_use', 'tool_result', 'image', 'fallback', 'attachment', 'system', 'queue-operation', 'unknown'];

let grouped = null;
async function parse(id) {
  if (!grouped) grouped = groupSessions(await scanStore(STORE));
  const s = grouped.sessions.find((x) => x.id === id);
  assert.ok(s, `fixture session ${id}`);
  return parseSession(s, { projectsDir: STORE });
}

test('kind classification on real lines, incl. fallback and attachment:<type>', async () => {
  const m = await parse('44444444-4444-4444-8444-444444444444');
  const rows = m.main.rows;
  const kinds = rows.map((r) => r.kind);

  assert.equal(rows[0].kind, 'queue-operation');
  assert.ok(kinds.some((k) => k.startsWith('attachment:') && k.length > 'attachment:'.length), 'attachment carries its recorded type');
  assert.ok(kinds.some((k) => k.startsWith('system:') && k.length > 'system:'.length), 'system carries its recorded subtype');
  assert.ok(kinds.includes('thinking'));
  assert.ok(kinds.includes('tool_use'));
  assert.ok(kinds.includes('tool_result'));
  assert.ok(kinds.includes('fallback'), 'the rare fallback block (2 in the corpus) classifies');
  assert.ok(kinds.includes('unknown:future-event-kind'), 'unknown event types surface, never crash');
  assert.equal(m.inventory.problems.filter((p) => p.code === 'unknown-event-type').length, 1);

  // every kind is inside the closed vocabulary (prefix before ':')
  for (const k of kinds) {
    const prefix = k.includes(':') ? k.slice(0, k.indexOf(':')) : k;
    assert.ok(VOCAB_PREFIXES.includes(prefix), `kind ${k} in vocabulary`);
  }

  const fb = rows.find((r) => r.kind === 'fallback');
  assert.ok(fb.extra.from && fb.extra.to, 'fallback records the recorded from/to models');

  // tri-state is_error: only === true is an error
  for (const r of rows.filter((x) => x.kind === 'tool_result')) {
    assert.equal(typeof r.extra.isError, 'boolean');
  }
});

test('image blocks: dotted bi locators, sidecar twins render once, magic-byte sniff', async () => {
  const m = await parse('77777777-7777-4777-8777-777777777777');
  const images = m.inventory.images;

  // line 1: tool_result block image (bi "0.1") + toolUseResult sidecar (bi "r"), identical payload
  const block = images.find((im) => im.line === 1 && im.bi === '0.1');
  const sidecar = images.find((im) => im.line === 1 && im.bi === 'r');
  assert.ok(block, 'nested tool_result image at <i>.<j>');
  assert.ok(sidecar, 'sidecar image at r');
  assert.equal(block.mediaType, 'image/png', 'recorded media_type');
  assert.equal(sidecar.twin, true, 'sidecar marked as the twin — rendered once, noted');
  assert.equal(block.twin, false);
  assert.equal(sidecar.mediaType, 'image/png', 'sniffed from base64 magic bytes (no media_type recorded on this shape)');
  assert.ok(sidecar.b64Length >= 500, 'stripped payload length recorded');

  // line 2: pasted image in a human prompt at message.content[0] -> bi "0"
  const pasted = images.find((im) => im.line === 2);
  assert.equal(pasted.bi, '0');
  assert.equal(pasted.mediaType, 'image/webp');

  // rows: image row for the block copy; a prompt row for the pasted text
  const rows = m.main.rows;
  assert.ok(rows.some((r) => r.line === 1 && r.kind === 'image' && r.bi === '0.1'));
  assert.ok(rows.some((r) => r.line === 2 && r.kind === 'prompt'));
  assert.equal(m.inventory.counts.images, 2, 'twins counted once');
  assert.equal(m.inventory.counts.imageBlocks, 3, 'all blocks inventoried');
});

test('files-view sources are tool-name-keyed; spill banners extract paths', async () => {
  const m = await parse('44444444-4444-4444-8444-444444444444');
  for (const f of m.inventory.filesLedger) {
    assert.ok(['read', 'write', 'edit', 'search', 'sidecar'].includes(f.op));
    assert.ok(typeof f.path === 'string' && f.path.length > 0);
    assert.ok(f.line >= 1);
  }
  for (const s of m.inventory.spills) {
    assert.ok(['banner', 'structured', 'binary'].includes(s.form));
  }
});

test('assistantLines carry usage + locators for the ledger, without content bulk', async () => {
  // group A's preferred {file, line, event} wrapper (report 2 note 1; the
  // integration seam fix — buildSessionLedger reads el.event directly)
  const m = await parse('44444444-4444-4444-8444-444444444444');
  assert.ok(m.assistantLines.length >= 3);
  for (const al of m.assistantLines) {
    assert.ok(al.file && al.line >= 1);
    assert.ok(['main', 'agent'].includes(al.tier));
    assert.equal(al.event.type, 'assistant', 'wrapper carries the raw-event shape the ledger reads');
    assert.ok(al.event.message.usage !== undefined, 'usage present (measured: 100% of assistant events carry one)');
    assert.equal(al.event.message.content, undefined, 'content deliberately omitted (CONTRACT-DEVIATION note in parse.mjs)');
    assert.ok(al.event.timestamp === null || typeof al.event.timestamp === 'string', 'raw timestamp string retained for the ledger');
  }
  // fixture main is real corpus lines: every line has message.id and model
  assert.ok(m.assistantLines.every((al) => al.event.message.id && al.event.message.model));
});
