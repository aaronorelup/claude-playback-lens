// tests/parse-turns.test.mjs — rule R-T on real fixtures, preamble handling,
// bounds ledger (turn end excludes queue-operation/system/attachment/isMeta),
// torn-line counting (group B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanStore, groupSessions } from '../server/scan.mjs';
import { parseSession } from '../server/parse.mjs';

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reader', 'store');

let grouped = null;
async function entry(id) {
  if (!grouped) grouped = groupSessions(await scanStore(STORE));
  const s = grouped.sessions.find((x) => x.id === id);
  assert.ok(s, `fixture session ${id}`);
  return s;
}
const parse = async (id) => parseSession(await entry(id), { projectsDir: STORE });

test('R-T partitions a real multi-turn main transcript exactly', async () => {
  const expected = JSON.parse(await fsp.readFile(path.join(STORE, 'C--fx-projB', 'multiturn.expected.json'), 'utf8'));
  const m = await parse(expected.id);
  const turns = m.main.turns;
  assert.equal(turns.length, expected.turnCount + 1, 'openers + preamble');
  assert.equal(turns[0].preamble, true);
  assert.equal(turns[0].openerLine, null, 'preamble has no opener');
  const openerLines = turns.filter((t) => !t.preamble).map((t) => t.openerLine);
  assert.deepEqual(openerLines, expected.openers, 'openers at the recorded 1-based lines');
  turns.forEach((t, i) => assert.equal(t.idx, i, 'idx is the sole addressable index'));
  for (const t of turns.slice(1)) {
    assert.ok(t.at != null, `turn ${t.idx} opener has a timestamp`);
    assert.ok(t.endAt != null && t.endAt >= t.at, `turn ${t.idx} end >= start`);
  }
  // partition: rowRanges are contiguous and cover every row exactly once
  let next = 0;
  for (const t of turns) {
    if (t.rowRange === null) continue;
    assert.equal(t.rowRange[0], next, `turn ${t.idx} starts where the previous ended`);
    assert.ok(t.rowRange[1] >= t.rowRange[0]);
    next = t.rowRange[1] + 1;
  }
  assert.equal(next, m.main.rows.length, 'every row belongs to exactly one turn');
  assert.equal(m.inventory.counts.tornLines, 0, 'real corpus fixture has zero torn lines');
});

test('a <command-message> opener with NO origin opens the session (slash-command turn)', async () => {
  const expected = JSON.parse(await fsp.readFile(path.join(STORE, 'C--fx-projB', 'slash.expected.json'), 'utf8'));
  const m = await parse(expected.id);
  const turns = m.main.turns;
  assert.ok(turns.length >= 2, 'the slash opener is a real turn');
  assert.equal(turns[1].openerLine, expected.openerLine, 'opener at the recorded line (research: L3)');
  // origin-less scaffolding (<command-name>, <local-command-stdout>) must NOT open turns:
  // the prefix contains several origin-less string user events but only ONE opener line <= 12
  const before = turns.filter((t) => !t.preamble && t.openerLine <= expected.lineCount);
  assert.equal(before.length, 1, 'scaffolding adds no phantom turns');
});

test('bounds ledger: turn end is the max over CONVERSATION rows only', async () => {
  const m = await parse('55555555-5555-4555-8555-555555555555');
  const turns = m.main.turns;
  assert.equal(turns.length, 2);
  const t1 = turns[1];
  assert.equal(t1.at, Date.parse('2026-08-01T10:00:00.000Z'));
  assert.equal(t1.endAt, Date.parse('2026-08-01T10:02:00.000Z'),
    'late queue-operation (18:00), system (19:00) and attachment (19:30) rows do NOT extend the turn');
  // the skewed rows still exist as rows (displayed, just not bounds)
  const kinds = m.main.rows.map((r) => r.kind);
  assert.ok(kinds.includes('queue-operation'));
  assert.ok(kinds.some((k) => k.startsWith('system:')));
  assert.ok(kinds.some((k) => k.startsWith('attachment:')));
  // preamble captured the two pre-opener queue-operations
  assert.equal(turns[0].rowRange[0], 0);
  assert.ok(turns[0].rowRange[1] >= 1);
});

test('a torn line is a located Problem, contributes zero, and never crashes the parse', async () => {
  const m = await parse('66666666-6666-4666-8666-666666666666');
  const torn = m.inventory.problems.filter((p) => p.code === 'torn-line');
  assert.equal(torn.length, 1);
  assert.equal(torn[0].line, 2, '1-based line number');
  assert.ok(torn[0].byteOffset > 0);
  assert.ok(torn[0].bytes > 0);
  assert.equal(m.inventory.counts.tornLines, 1);
  assert.equal(m.inventory.counts.events, 2, 'the torn line contributes zero events');
  assert.deepEqual(m.main.rows.map((r) => r.line), [1, 3], 'good lines on both sides parsed');
});

test('metadata snapshots become latest-value+count, never rows; queue-operation IS a row', async () => {
  const expected = JSON.parse(await fsp.readFile(path.join(STORE, 'C--fx-projB', 'multiturn.expected.json'), 'utf8'));
  const m = await parse(expected.id);
  const rowKinds = new Set(m.main.rows.map((r) => r.kind));
  for (const k of ['last-prompt', 'ai-title', 'custom-title', 'mode', 'pr-link', 'frame-link']) {
    assert.ok(!rowKinds.has(k) && !rowKinds.has(`unknown:${k}`), `${k} is not a row kind`);
  }
  const meta = m.main.meta;
  const perType = m.inventory.perType;
  if (perType['ai-title']) assert.equal(meta.aiTitle.count, perType['ai-title']);
  if (perType['last-prompt']) {
    assert.equal(meta.lastPrompt.count, perType['last-prompt']);
    assert.ok(meta.lastPrompt.leafLine != null, 'leafUuid resolves in-file (resolved after the full pass)');
  }
  if (perType['queue-operation']) {
    assert.equal(m.main.rows.filter((r) => r.kind === 'queue-operation').length, perType['queue-operation']);
  }
  // heads respect the cap
  for (const r of m.main.rows) assert.ok(r.head.length <= 220, 'head <= 220 chars');
});
