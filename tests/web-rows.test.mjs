// tests/web-rows.test.mjs — the SPEC §3 closed row-kind vocabulary and `?k`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { KIND_VOCAB, kindPrefix, matchKinds, kindCensus, PAGE_SIZE } from '../web/js/components/rows.mjs';
import { biToPath, pathToBi, pathRelation, normalisePath, typeOf } from '../web/js/components/jsonview.mjs';

test('the row-kind vocabulary is the closed SPEC §3 list', () => {
  assert.deepEqual(KIND_VOCAB, [
    'prompt', 'text', 'thinking', 'tool_use', 'tool_result', 'image', 'fallback',
    'attachment', 'system', 'queue-operation', 'unknown',
  ]);
  assert.equal(PAGE_SIZE, 300);
});

test('`?k` matches on the prefix before ":"', () => {
  assert.equal(kindPrefix('attachment:edited_text_file'), 'attachment');
  assert.equal(kindPrefix('system:api_error'), 'system');
  assert.equal(kindPrefix('tool_use'), 'tool_use');

  assert.equal(matchKinds('attachment:task_reminder', 'attachment'), true, 'k=attachment selects all kinds');
  assert.equal(matchKinds('system:api_error', 'system'), true);
  assert.equal(matchKinds('system:api_error', 'attachment'), false);
  assert.equal(matchKinds('tool_use', 'tool_use,system'), true);
  assert.equal(matchKinds('text', ''), true, 'no filter selects everything');
  assert.equal(matchKinds('text', 'nonsense'), false, 'unknown values are preserved and simply do not match');
  assert.equal(matchKinds('attachment:x', ['attachment']), true);
});

test('the kind census counts exactly, in vocabulary order', () => {
  const rows = [
    { kind: 'tool_use' }, { kind: 'text' }, { kind: 'tool_use' },
    { kind: 'attachment:task_reminder' }, { kind: 'system:api_error' }, { kind: 'zzz:future' },
  ];
  const census = kindCensus(rows);
  assert.deepEqual(census, [
    { kind: 'text', count: 1 },
    { kind: 'tool_use', count: 2 },
    { kind: 'attachment:task_reminder', count: 1 },
    { kind: 'system:api_error', count: 1 },
    { kind: 'zzz:future', count: 1 },
  ]);
});

test('SPEC §8: the dotted block locator maps to a real JSON path, or to null', () => {
  assert.deepEqual(biToPath('2'), ['message', 'content', 2]);
  assert.deepEqual(biToPath('2.3'), ['message', 'content', 2, 'content', 3]);
  assert.deepEqual(biToPath('r'), ['toolUseResult']);
  assert.deepEqual(biToPath('r.3'), ['toolUseResult', 3]);
  assert.equal(biToPath('nonsense'), null, 'an unaddressable bi is null, never a fabricated path');
  assert.equal(biToPath(null), null);
  assert.equal(biToPath(''), null);
});

test('the inverse builds copy-locators only where the path is addressable', () => {
  assert.equal(pathToBi(['message', 'content', 2]), '2');
  assert.equal(pathToBi(['message', 'content', 2, 'content', 3]), '2.3');
  assert.equal(pathToBi(['toolUseResult']), 'r');
  assert.equal(pathToBi(['toolUseResult', 3]), 'r.3');
  assert.equal(pathToBi(['message', 'usage', 'input_tokens']), null);
  assert.equal(pathToBi('r'), null);
});

test('a highlighted path lights its ancestors on the way down', () => {
  const target = ['message', 'content', 2, 'content', 3];
  assert.equal(pathRelation([], target), 'ancestor');
  assert.equal(pathRelation(['message'], target), 'ancestor');
  assert.equal(pathRelation(['message', 'content', 2], target), 'ancestor');
  assert.equal(pathRelation(target, target), 'exact');
  assert.equal(pathRelation(['message', 'usage'], target), 'none');
  assert.equal(pathRelation(['message', 'content', 2, 'content', 3, 'text'], target), 'none');
  assert.equal(pathRelation(['a'], null), 'none');
});

test('normalisePath accepts an array path or a dotted bi', () => {
  assert.deepEqual(normalisePath('2.3'), ['message', 'content', 2, 'content', 3]);
  assert.deepEqual(normalisePath(['a', 'b']), ['a', 'b']);
  assert.equal(normalisePath(null), null);
});

test('typeOf distinguishes null and array from object', () => {
  assert.equal(typeOf(null), 'null');
  assert.equal(typeOf([]), 'array');
  assert.equal(typeOf({}), 'object');
  assert.equal(typeOf('x'), 'string');
  assert.equal(typeOf(0), 'number');
  assert.equal(typeOf(false), 'boolean');
});
