// tests/web-fixes-round7.test.mjs — named regressions for the round-7 fix pass,
// browser side. The fake DOM mirrors tests/web-fixes-round5.test.mjs (no
// dependencies allowed).
//
//   R7-UI-1  showReloadBar() called replace() unconditionally, so the bar's
//            three nodes were torn down and rebuilt on EVERY call. L0's 5s poll
//            (and L2's live watcher) re-offer on every tick where the corpus
//            grew — which is BY DESIGN, DESIGN §7 takes that cadence as the
//            baseline — so during live recording the bar remounted under the
//            reader: a keyboard reader who had tabbed to "Reload" lost focus to
//            BODY within 5s, and a click could land on an element replaced
//            between reading the page and clicking it. The fix is idempotence
//            on (visible && same message), NOT a change to the cadence.
//
//   R7-HEAD-SURROGATE-TRUNCATION (client twin)
//            format.mjs truncate() cut at `max - 1` UTF-16 code UNITS, leaving
//            a lone surrogate before the ellipsis when an astral character
//            straddled the cut — the same hazard as server/parse.mjs head(),
//            named in the same round-6 note.

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * fake document (same shape as web-fixes-round5.test.mjs)
 * ------------------------------------------------------------------ */

// The fake DOM itself lives in tests/helpers/fake-dom.mjs (shared by every
// web test file); it is installed here, BEFORE the web modules are imported.
import { doc } from './helpers/fake-dom.mjs';

globalThis.document = doc;

/* ------------------------------------------------------------------ *
 * imports AFTER the fake document exists
 * ------------------------------------------------------------------ */

const { buildShell, showReloadBar, hideReloadBar, getShell } = await import('../web/js/router.mjs');
const { truncate } = await import('../web/js/format.mjs');

const MSG = '1 session changed on disk';

function freshShell() {
  const root = doc.createElement('div');
  buildShell(root);
  hideReloadBar();          // module state is shared: start every test dismissed
  return getShell();
}

const nodesOf = (shell) => shell.reloadEl.childNodes.slice();
const buttonOf = (shell) => shell.reloadEl.querySelectorAll('button')[0];

/* ================================================================= R7-UI-1 */

test('R7-UI-1 — re-offering the SAME message leaves the bar nodes (and the focus in them) alone', () => {
  const shell = freshShell();
  showReloadBar(MSG, () => {});
  assert.equal(shell.reloadEl.hasAttribute('hidden'), false, 'the bar is showing');
  const first = nodesOf(shell);
  assert.equal(first.length, 3, 'text + Reload + dismiss');

  // five poll ticks with the same message — exactly what a session being
  // recorded produces, and what remounted the subtree three times in 56s live
  for (let i = 0; i < 5; i += 1) showReloadBar(MSG, () => {});

  const after = nodesOf(shell);
  assert.equal(after.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(after[i], first[i], `node ${i} is the SAME object — replace() did not run`);
  }
  assert.equal(after[0].textContent, MSG, 'and it still says what it said');
});

test('R7-UI-1 — the handler is refreshed on every offer: Reload runs the NEWEST snapshot', () => {
  const shell = freshShell();
  const fired = [];
  showReloadBar(MSG, () => fired.push('first'));
  const btn = buttonOf(shell);
  showReloadBar(MSG, () => fired.push('second'));   // the no-op path — must still re-wire
  showReloadBar(MSG, () => fired.push('third'));
  assert.equal(buttonOf(shell), btn, 'precondition: the button was never rebuilt');

  btn.dispatch('click');
  assert.deepEqual(fired, ['third'],
    'the buttons read the stored offer, never a captured param — a stale `next` would be the COR-14 bug');
  assert.equal(shell.reloadEl.hasAttribute('hidden'), true, 'Reload hides the bar it acted on');
});

test('R7-UI-1 — a DIFFERENT message rebuilds, because the reader is being told something new', () => {
  const shell = freshShell();
  showReloadBar(MSG, () => {});
  const first = nodesOf(shell);
  showReloadBar('2 sessions changed on disk', () => {});
  const after = nodesOf(shell);
  assert.notEqual(after[0], first[0], 'new text means new nodes');
  assert.equal(after[0].textContent, '2 sessions changed on disk');
});

test('R7-UI-1 — a dismissed bar comes back on the next offer (DESIGN §7)', () => {
  const shell = freshShell();
  showReloadBar(MSG, () => {});
  const dismiss = shell.reloadEl.querySelectorAll('button')[1];
  dismiss.dispatch('click');
  assert.equal(shell.reloadEl.hasAttribute('hidden'), true, 'dismissed');

  showReloadBar(MSG, () => {});
  assert.equal(shell.reloadEl.hasAttribute('hidden'), false,
    'hideReloadBar must clear the remembered message, or the offer would never return');
  assert.equal(nodesOf(shell).length, 3);
});

/* ============================================ R7-HEAD-SURROGATE-TRUNCATION */

test('R7-HEAD-SURROGATE-TRUNCATION — truncate() never leaves a lone surrogate before the ellipsis', () => {
  const EMOJI = String.fromCodePoint(0x1f680);
  // the cut is at max-1 = 219, so units 218/219 hold the pair: it straddles.
  const straddle = 'Z'.repeat(218) + EMOJI + 'Q'.repeat(40);
  assert.ok(straddle.charCodeAt(218) >= 0xd800 && straddle.charCodeAt(218) <= 0xdbff,
    'precondition: unit 218 is a high surrogate');

  const out = truncate(straddle);
  assert.equal(out.isWellFormed(), true, 'no lone surrogate reaches textContent');
  assert.equal(out, 'Z'.repeat(218) + '…', 'the half-emoji is dropped, not half-kept');

  const plain = truncate('Y'.repeat(400));
  assert.equal(plain, 'Y'.repeat(219) + '…', 'a plain truncation is unchanged');
  assert.equal(truncate('short'), 'short', 'nothing under the cap is touched');
  assert.equal(truncate(null), '', 'non-strings still yield the empty string');

  const whole = 'W'.repeat(217) + EMOJI + 'Q'.repeat(40); // the pair fits inside the cut
  const wout = truncate(whole);
  assert.equal(wout.isWellFormed(), true);
  assert.equal(wout, 'W'.repeat(217) + EMOJI + '…', 'a pair that fits is kept whole');
});
