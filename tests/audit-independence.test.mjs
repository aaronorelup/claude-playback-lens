// SPEC §10 independence: server/audit.mjs must never import server/jsonl.mjs,
// server/parse.mjs, or server/ledger.mjs. Its one shared module is
// shared/pricing.mjs (disclosed). Verified against the source text so a
// future edit cannot quietly re-couple the two paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, '..', 'server', 'audit.mjs');

// A real import cannot live in a comment — strip comments before scanning so
// the module may still DOCUMENT its independence contract in prose.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '')
    .replace(/([^:'"])\/\/[^\n]*$/gm, '$1');
}

function importSpecifiers(code) {
  const specs = [];
  for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of code.matchAll(/new URL\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  return specs;
}

test('audit.mjs never imports jsonl.mjs, parse.mjs, or ledger.mjs', async () => {
  const code = stripComments(await fsp.readFile(AUDIT, 'utf8'));
  const specs = importSpecifiers(code);
  assert.ok(specs.length > 0, 'import scan found specifiers');
  for (const s of specs) {
    assert.ok(!/(?:^|\/)jsonl\.mjs$/.test(s), `forbidden import: ${s}`);
    assert.ok(!/(?:^|\/)parse\.mjs$/.test(s), `forbidden import: ${s}`);
    assert.ok(!/(?:^|\/)ledger\.mjs$/.test(s), `forbidden import: ${s}`);
  }
  // belt and braces: the names must not appear in any import-ish position in code
  assert.ok(!/import[^\n]*(jsonl|parse|ledger)\.mjs/.test(code), 'no import line references a forbidden module');
});

test('audit.mjs imports only node builtins plus shared/pricing.mjs', async () => {
  const code = stripComments(await fsp.readFile(AUDIT, 'utf8'));
  const specs = importSpecifiers(code);
  for (const s of specs) {
    const ok = s.startsWith('node:') || /(^|\/)shared\/pricing\.mjs$/.test(s);
    assert.ok(ok, `unexpected import in Path B: ${s} (the one shared import is shared/pricing.mjs)`);
  }
});

test('audit.mjs does not use node:readline (U+2028/U+2029 hazard, SPEC §1)', async () => {
  const code = stripComments(await fsp.readFile(AUDIT, 'utf8'));
  assert.ok(!code.includes('readline'), 'never node:readline');
});
