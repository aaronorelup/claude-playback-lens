// tests/fixes-round16.test.mjs — named regressions for the round-16 fix pass.
//
//   R16-D1 (web/js/views/l4.mjs — ?v=raw virtualisation, web/styles.css)
//       The CONTRACT-DEVIATION note added in b3b9fc6 claimed FOUR inline
//       geometries in the raw view were "data". Two of them were constants:
//       the viewport's `height:640px;overflow:auto;position:relative` and the
//       per-row `height:18px`. Both moved to the stylesheet, scoped to the
//       virtualised view (`.lens-raw--virt`, `.lens-raw__line--virt`) because
//       bare `.lens-raw` / `.lens-raw__line` are shared with inv.mjs's
//       non-virtualised file listing.
//
//       Moving the row height is only safe while the CSS value and the JS
//       constant agree: RAW_LINE_H is the divisor in
//       `viewport.scrollTop / RAW_LINE_H` (first-visible line) and the
//       multiplier in `scrollTop = (n - 1) * RAW_LINE_H` (jump-to-line), the
//       spacer height and the window block's top. If the stylesheet drifts to
//       a different px height, nothing throws — jump-to-line just lands on the
//       wrong row and the painted window sits off its spacer offset. This test
//       is the pin that makes that drift a red suite instead of a silent bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { RAW_LINE_H } from '../web/js/views/l4.mjs';

test('R16-D1: the virtualised row height in styles.css IS RAW_LINE_H (drift breaks jump-to-line silently)', async () => {
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const rule = /\.lens-raw__line--virt\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'web/styles.css must declare .lens-raw__line--virt — it is what sizes the virtualised rows');
  const decls = rule[1].replace(/\/\*[\s\S]*?\*\//g, '').split(';');
  const px = decls
    .map((d) => /^\s*height\s*:\s*(\d+(?:\.\d+)?)px\s*$/.exec(d))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  assert.equal(px.length, 1,
    '.lens-raw__line--virt must set exactly one explicit px height — not a relative one, and not two that let the cascade pick a different value than this test reads');
  assert.equal(px[0], RAW_LINE_H,
    'the stylesheet row height and l4.mjs RAW_LINE_H are one value; they drifted apart');
});
