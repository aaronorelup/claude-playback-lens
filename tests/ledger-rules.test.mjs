// tests/ledger-rules.test.mjs — server/ledger.mjs against real-corpus fixtures:
// R1 (keep-last per message.id per file), R3 (iterations split + field
// provenance), R4 (synthetic), R6 (finalized predicate), R9 (raw speed/tier).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionLedger, aggregate } from '../server/ledger.mjs';
import { priceRow } from '../shared/pricing.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const manifest = JSON.parse(readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));

// fixture lines split on \n ONLY (same reader contract as the corpus)
function loadCase(name) {
  const c = manifest.cases[name];
  assert.ok(c, `fixture case ${name} missing — run: node tests/extract-fixtures.mjs`);
  const parts = readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8').split('\n');
  const texts = parts.slice(0, -1); // terminated file: last element is ''
  assert.equal(texts.length, c.lines.length, `${name}: fixture/manifest line count`);
  return {
    notes: c.notes,
    sourceRel: c.sourceRel,
    lines: texts.map((t, i) => ({ file: c.sourceRel, line: c.lines[i], event: JSON.parse(t) })),
  };
}

// ---------------------------------------------------------------------------
// R1 — per-file dedupe, keep the LAST line in file order
// ---------------------------------------------------------------------------
test('R1 — multi-line agent group: one billed row, last line holds the final values', () => {
  const { lines, notes } = loadCase('r1-agent-multiline');
  // measured corpus invariant: input-side counters byte-identical across the group
  const usages = lines.map((l) => l.event.message.usage);
  for (const u of usages) {
    assert.equal(u.input_tokens, usages[0].input_tokens);
    assert.equal(u.cache_read_input_tokens, usages[0].cache_read_input_tokens);
    assert.equal(u.cache_creation_input_tokens, usages[0].cache_creation_input_tokens);
  }
  const rows = buildSessionLedger(lines);
  assert.equal(rows.length, 1, 'one billed row per API response');
  const row = rows[0];
  assert.equal(row.msgId, notes.msgId);
  assert.equal(row.output, notes.outputPerLine.at(-1)); // 263, not 8
  assert.equal(row.stopReason, notes.stopPerLine.at(-1)); // 'tool_use' — only the last line carries it
  assert.equal(row.line, manifest.cases['r1-agent-multiline'].lines.at(-1), 'locator = the KEPT line');
  assert.equal(row.file, manifest.cases['r1-agent-multiline'].sourceRel);
  assert.equal(row.finalized, true);
  assert.equal(row.synthetic, false);
  assert.equal(row.iterIndex, null, 'length-1 iterations is not a split');
  assert.equal(row.billedElsewhere, null);
});

test('R1 — dedupe is per message.id PER FILE: the same id in two files stays two rows', () => {
  const a = loadCase('r2a-proja-00000001');
  const c = loadCase('r2a-proja-00000002');
  const rows = buildSessionLedger([...a.lines, ...c.lines]);
  assert.equal(rows.length, 2, 'one kept row per file (R2 decides canonicality later, at index level)');
  assert.equal(new Set(rows.map((r) => r.msgId)).size, 1);
  assert.equal(new Set(rows.map((r) => r.file)).size, 2);
});

test('R1 — fallback grouping key is the event uuid when message.id is absent', () => {
  const ev = (uuid, out) => ({
    type: 'assistant',
    uuid,
    timestamp: '2026-08-01T00:00:00.000Z',
    message: { model: 'claude-opus-5', role: 'assistant', stop_reason: null, usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } },
  });
  const rows = buildSessionLedger([
    { file: 'f.jsonl', line: 1, event: ev('u-1', 5) },
    { file: 'f.jsonl', line: 2, event: ev('u-1', 9) },
    { file: 'f.jsonl', line: 3, event: ev('u-2', 3) },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.msgId === 'u-1').output, 9);
  assert.equal(rows.find((r) => r.msgId === 'u-2').output, 3);
});

test('R1 — non-assistant events (metadata, user) are ignored by the ledger', () => {
  const { lines } = loadCase('r2b-projb-resumed'); // opens with 4 untimestamped metadata lines
  const metadataOnly = lines.filter((l) => l.event.type !== 'assistant');
  assert.ok(metadataOnly.length >= 4);
  assert.deepEqual(buildSessionLedger(metadataOnly), []);
});

// ---------------------------------------------------------------------------
// R3 — iterations override: one row per element, exact field provenance
// ---------------------------------------------------------------------------
test('R3 — fallback group 00000003: split into 2 rows with element-level tokens and models', () => {
  const { lines, notes } = loadCase('r3-fallback-00000003');
  const keptLineNo = manifest.cases['r3-fallback-00000003'].lines.at(-1);
  const rows = buildSessionLedger(lines);
  assert.equal(rows.length, 2, 'one billed row per iterations element');
  const [r0, r1] = rows;

  // FROM THE ELEMENT: input, output, cacheRead, cache5m, cache1h, cacheFlat, model
  assert.equal(r0.model, 'claude-fable-5', 'refused first call exists ONLY in iterations[]');
  assert.equal(r0.output, 972);
  assert.equal(r0.cacheRead, 328023);
  assert.equal(r0.cache5m, 0);
  assert.equal(r0.cache1h, 510);
  assert.equal(r0.cacheFlat, 0);
  assert.equal(r0.input, 2);
  assert.equal(r1.model, 'claude-opus-5'); // element.model ?? message.model
  assert.equal(r1.output, 965);
  assert.equal(r1.cacheRead, 274832);
  assert.equal(r1.cache1h, 0);

  // FROM THE KEPT LINE: msgId, at, file, line, stopReason, ttl, speed, serviceTier, synthetic
  const kept = lines.at(-1).event;
  for (const r of rows) {
    assert.equal(r.msgId, notes.msgId);
    assert.equal(r.file, manifest.cases['r3-fallback-00000003'].sourceRel);
    assert.equal(r.line, keptLineNo);
    assert.equal(r.at, Date.parse(kept.timestamp));
    assert.equal(r.stopReason, kept.message.stop_reason);
    assert.equal(r.ttl, 'recorded');
    assert.equal(r.speed, kept.message.usage.speed ?? null);
    assert.equal(r.serviceTier, kept.message.usage.service_tier ?? null);
    assert.equal(r.synthetic, false);
    assert.equal(r.finalized, true);
  }
  assert.equal(r0.iterIndex, 0);
  assert.equal(r1.iterIndex, 1);

  // line-level scalars attach to the FINAL element's row; others get real zeros / null
  assert.equal(r0.webSearch, 0);
  assert.equal(r0.webFetch, 0);
  assert.equal(r0.thinkingTokens, null, 'not recorded per iteration — null, never 0');

  // the split REPAIRS the 5m+1h === flat identity that the top-level merge breaks
  const top = kept.message.usage;
  assert.notEqual(
    top.cache_creation.ephemeral_5m_input_tokens + top.cache_creation.ephemeral_1h_input_tokens,
    top.cache_creation_input_tokens,
    'fixture precondition: top-level usage is the measured inconsistent merge',
  );
  for (const [r, elm] of [[r0, notes.iterations[0]], [r1, notes.iterations[1]]]) {
    assert.equal(r.cache5m + r.cache1h + r.cacheFlat, elm.cache_creation_input_tokens, 'identity holds per billed row');
  }
});

test('R3 — fallback group 00000004: element input repeats on both rows (billed from elements, not top-level)', () => {
  const { lines, notes } = loadCase('r3-fallback-00000004');
  const rows = buildSessionLedger(lines);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, 'claude-fable-5');
  assert.equal(rows[1].model, 'claude-opus-4-8');
  assert.equal(rows[0].input, 2136);
  assert.equal(rows[1].input, 2136);
  assert.equal(rows[0].output, 1245); // absent from top-level usage entirely
  assert.equal(rows[1].output, 1604);
  assert.equal(rows[0].cache1h, 2062);
  assert.equal(rows[1].cache1h, 0);
  assert.equal(notes.topLevelUsage.output_tokens, 1604, 'top-level reports only the fallback call');
});

test('R3 — split-group scalar provenance and the webSearch sum invariant (constructed variant of a real line)', () => {
  // deep-clone the real fallback group and inject nonzero line-level scalars
  const { lines } = loadCase('r3-fallback-00000003');
  const cloned = lines.map((l) => ({ ...l, event: JSON.parse(JSON.stringify(l.event)) }));
  const kept = cloned.at(-1).event;
  kept.message.usage.server_tool_use = { web_search_requests: 3, web_fetch_requests: 2 };
  kept.message.usage.output_tokens_details = { thinking_tokens: 42 };
  const rows = buildSessionLedger(cloned);
  assert.equal(rows[0].webSearch, 0, 'non-final split row: a real zero');
  assert.equal(rows[0].webFetch, 0);
  assert.equal(rows[0].thinkingTokens, null, 'non-final split row: null (not recorded per iteration)');
  assert.equal(rows[1].webSearch, 3, 'final element carries the line-level count');
  assert.equal(rows[1].webFetch, 2);
  assert.equal(rows[1].thinkingTokens, 42);
  // audit invariant: Σ per-row webSearch/webFetch over a split group == the group's top-level count
  assert.equal(rows.reduce((s, r) => s + r.webSearch, 0), 3);
  assert.equal(rows.reduce((s, r) => s + r.webFetch, 0), 2);
});

// ---------------------------------------------------------------------------
// R4 — <synthetic>: usage.iterations === null is the exact discriminator
// ---------------------------------------------------------------------------
test('R4 — synthetic event: bills nothing, excluded from requests, counted separately', () => {
  const { lines, notes } = loadCase('r4-synthetic');
  assert.equal(lines[0].event.message.usage.iterations, null, 'fixture precondition');
  const rows = buildSessionLedger(lines);
  assert.equal(rows.length, 1, 'synthetic rows exist in the ledger (they render as events)');
  const row = rows[0];
  assert.equal(row.synthetic, true);
  assert.equal(row.finalized, false, 'Array.isArray(null) === false');
  assert.equal(row.model, '<synthetic>');
  assert.equal(row.msgId, notes.msgId);
  assert.match(row.msgId, /^[0-9a-f-]{36}$/, 'synthetic message.id is a UUID, not msg_*');
  assert.deepEqual(
    [row.input, row.output, row.cacheRead, row.cache5m, row.cache1h, row.cacheFlat],
    [0, 0, 0, 0, 0, 0],
    'usage is fully shaped but all-zero',
  );
  assert.equal(row.speed, null, 'recorded null (the null|null census pair)');
  assert.equal(row.serviceTier, null);

  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.requests, 0, 'synthetic does NOT count in CostAgg.requests');
  assert.equal(agg.synthetic, 1);
  assert.equal(agg.neverFinalized, 0, 'the synthetic guard on the R6 counter');
  assert.equal(agg.usd.total, 0);
  assert.deepEqual(agg.byModel, {}, 'excluded from per-model billing groups');
});

// ---------------------------------------------------------------------------
// R6 — finalized ≙ Array.isArray(iterations) && length > 0
// ---------------------------------------------------------------------------
test('R6 — never-finalized agent group: stub output billed as recorded, counted in the disclosure', () => {
  const { lines, notes } = loadCase('r6a-never-finalized');
  for (const l of lines) {
    assert.equal(l.event.message.stop_reason, null, 'fixture precondition: every line stop_reason null');
    assert.ok(!('iterations' in l.event.message.usage), 'fixture precondition: no iterations key');
  }
  const rows = buildSessionLedger(lines);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.finalized, false);
  assert.equal(row.synthetic, false);
  assert.equal(row.stopReason, null);
  assert.equal(row.output, notes.outputPerLine.at(-1), 'the recorded stub, never an estimate');
  assert.equal(row.iterIndex, null);
  // R9: speed is ABSENT on never-finalized lines (a finalization marker, not a tier signal)
  assert.ok(!('speed' in lines.at(-1).event.message.usage), 'fixture precondition');
  assert.equal(row.speed, null);
  assert.equal(row.serviceTier, 'standard', 'the ABSENT|standard census pair');

  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.requests, 1, 'never-finalized rows ARE billed rows');
  assert.equal(agg.neverFinalized, 1);
  assert.equal(agg.synthetic, 0);
});

test('R6 — msg_011A00000000000000000002: end_turn with an EMPTY iterations array is NOT finalized', () => {
  const { lines, notes } = loadCase('r6b-empty-iterations');
  const kept = lines.at(-1).event;
  assert.equal(kept.message.stop_reason, 'end_turn', 'fixture precondition: non-null stop_reason');
  assert.deepEqual(kept.message.usage.iterations, [], 'fixture precondition: empty array');
  const rows = buildSessionLedger(lines);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.finalized, false, 'a non-null stop_reason is NOT sufficient (gap-3)');
  assert.equal(row.synthetic, false);
  assert.equal(row.output, 3, 'the recorded stub output (3 tokens for 3,566 chars) is billed as recorded');
  assert.equal(row.stopReason, 'end_turn');
  assert.equal(row.msgId, notes.msgId);
  // billed from the top-level usage fields (iterations empty)
  assert.equal(row.cacheRead, kept.message.usage.cache_read_input_tokens);
  assert.equal(row.cache1h, kept.message.usage.cache_creation.ephemeral_1h_input_tokens);

  const agg = aggregate(rows, { priceRow });
  assert.equal(agg.neverFinalized, 1);
  assert.equal(agg.requests, 1);
});

// ---------------------------------------------------------------------------
// R9 — raw capture on finalized standard lines
// ---------------------------------------------------------------------------
test('R9 — finalized standard line records speed=standard, service_tier=standard raw', () => {
  const { lines } = loadCase('r1-agent-multiline');
  const [row] = buildSessionLedger(lines);
  assert.equal(row.speed, 'standard');
  assert.equal(row.serviceTier, 'standard');
});
