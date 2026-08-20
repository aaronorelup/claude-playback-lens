// tests/web-fixes-round10.test.mjs — named regressions for the round-10 fix
// pass, BROWSER side. The server halves live in tests/fixes-round10.test.mjs.
//
//   R10-S1 (web/js/views/l2.mjs — sessionFacts)
//       The facts strip collapsed "the file records no such event" and "this
//       payload never mentioned it" into one branch (`d.prLinks || []`,
//       `d.mode || null`), so a payload that simply did not carry the field
//       printed the POSITIVE DENIAL "no pr-link event recorded". That is the
//       exact class the one design rule forbids: never claim a recorded fact
//       is absent. Three states now — value / recorded absence (a count of 0
//       or an empty list the server actually shipped) / payload silence.
//       Second half: the count chip reads the EVENT count before falling back
//       to the item count, because the parser dedupes items — 36 pr-link
//       events over one PR must not print "1 pr-link events".
//
//   R10-F2 (web/js/views/settings.mjs)
//       On every successful save the page said "the indexer is re-reading the
//       store." Nothing re-points a running indexer; POST /api/reindex does not
//       either. Only a restart does — and not even that when --projects or
//       CLAUDE_PROJECTS outranks config.json (SPEC §9). Two further dead
//       branches in the same section: the counts were read off `res` while the
//       endpoint nests them under `res.preview`, and provenance was read from
//       `cfg.source` while the endpoint sends `projectsDirSource`.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as L2 from '../web/js/views/l2.mjs';
import { saveMessage, sourceLabelOf, SOURCE_LABEL } from '../web/js/views/settings.mjs';

/* ==================================================================== R10-S1 */

const factOf = (detail, key) => L2.sessionFacts(detail).find((f) => f.key === key);

test('R10-S1: a payload that never mentions a metadata type denies nothing', () => {
  for (const [key, srcRe, reasonRe] of [
    ['mode', /^mode — not recorded in this payload$/, /this payload carries no mode fact/],
    ['pr', /^PR links — not recorded in this payload$/, /this payload carries no pr-link list/],
    ['frame', /^frame links — not recorded in this payload$/, /this payload carries no frame-link list/],
  ]) {
    const f = factOf({}, key);
    assert.match(f.source, srcRe, `${key} source`);
    assert.match(f.reason, reasonRe, `${key} reason`);
    assert.equal(f.counts[0].n, null, `${key} count is unknown, not 0`);
  }
});

test('R10-S1: a null field (fragment session) is payload silence, not a recorded zero', () => {
  // summarise() ships null for every metadata field when main === null.
  const frag = { state: 'fragment', mode: null, modeCount: null, prLinks: null, prLinkCount: null, frameLinks: null, frameLinkCount: null };
  for (const key of ['mode', 'pr', 'frame']) {
    assert.match(factOf(frag, key).source, /not recorded in this payload/, key);
  }
});

test('R10-S1: a recorded zero IS a licence to say "no … event recorded"', () => {
  const empty = { modeCount: 0, prLinks: [], prLinkCount: 0, frameLinks: [], frameLinkCount: 0 };
  assert.equal(factOf(empty, 'mode').source, 'no mode event recorded');
  assert.equal(factOf(empty, 'pr').source, 'no pr-link event recorded');
  assert.equal(factOf(empty, 'frame').source, 'no frame-link event recorded');
});

test('R10-S1: the count chip prints EVENTS, never the deduped item count', () => {
  // the reproducing session: 36 pr-link events, one unique PR
  const d = {
    prLinks: [{ prNumber: 1, prRepository: 'octocat/demo-repo', prUrl: 'https://github.com/octocat/demo-repo/pull/1' }],
    prLinkCount: 36,
    frameLinks: [{ frameUrl: 'https://x/y', title: 'a frame' }], frameLinkCount: 14,
    mode: 'normal', modeCount: 2,
  };
  assert.equal(factOf(d, 'pr').counts[0].n, 36);
  assert.equal(factOf(d, 'frame').counts[0].n, 14);
  assert.equal(factOf(d, 'mode').counts[0].n, 2);
  // a payload that ships the list ALONE still gets a count from the list
  assert.equal(factOf({ prLinks: d.prLinks }, 'pr').counts[0].n, 1);
});

test('R10-S1: a count with no list is disclosed as a count with no list', () => {
  // never "no pr-link event recorded" next to a chip reading "36 pr-link events"
  const f = factOf({ prLinks: [], prLinkCount: 36 }, 'pr');
  assert.equal(f.counts[0].n, 36);
  assert.match(f.source, /pr-link events recorded, no link list/);
  assert.doesNotMatch(f.source, /^no pr-link event recorded$/);
});

test('R10-S1: mode events with no recorded value are not reported as no events', () => {
  const f = factOf({ mode: null, modeCount: 2 }, 'mode');
  assert.match(f.source, /mode events recorded, none carrying a value/);
  assert.equal(f.counts[0].n, 2);
});

/* ==================================================================== R10-F2 */

test('R10-F2: the save message never claims the indexer is re-reading the store', () => {
  const msg = saveMessage({
    saved: true, applied: false,
    activeProjectsDir: 'C:\\old\\projects', savedProjectsDir: 'C:\\new\\projects',
    pendingRestart: true, savedOutrankedBy: null,
    preview: { ok: true, projects: 1, sessions: 1, bytes: 571 },
  });
  assert.doesNotMatch(msg, /re-reading the store/);
  assert.doesNotMatch(msg, /re-index/i);
  assert.match(msg, /restart the app/i, 'it names the one thing that does apply the save');
  assert.ok(msg.includes('C:\\old\\projects'), 'the ACTIVE dir is named');
  assert.ok(msg.includes('C:\\new\\projects'), 'the SAVED dir is named');
});

test('R10-F2: the preview counts are read from res.preview, not from res', () => {
  const msg = saveMessage({ saved: true, applied: false, activeProjectsDir: 'a', savedProjectsDir: 'b', pendingRestart: true, preview: { ok: true, projects: 3, sessions: 42, bytes: 1024 } });
  assert.match(msg, /3 projects · 42 sessions/, 'the nested path is the live one');
  // the old code read res.projects/res.sessions/res.bytes — dead every time
  const stale = saveMessage({ saved: true, applied: false, activeProjectsDir: 'a', savedProjectsDir: 'b', pendingRestart: true, projects: 9, sessions: 9, preview: { ok: true } });
  assert.doesNotMatch(stale, /9 projects/);
});

test('R10-F2: a saved value that a flag outranks does not get a restart promise', () => {
  for (const flag of ['--projects', 'CLAUDE_PROJECTS']) {
    const msg = saveMessage({ saved: true, applied: false, activeProjectsDir: 'a', savedProjectsDir: 'b', pendingRestart: true, savedOutrankedBy: flag, preview: { ok: true } });
    assert.ok(msg.includes(`${flag} outranks config.json`), flag);
    assert.match(msg, /even after a restart/);
  }
});

test('R10-F2: saving the directory already in use says nothing changes', () => {
  const msg = saveMessage({ saved: true, applied: false, activeProjectsDir: 'C:\\same', savedProjectsDir: 'C:\\same', pendingRestart: false, savedOutrankedBy: null, preview: { ok: true } });
  assert.match(msg, /nothing changes/);
  assert.doesNotMatch(msg, /re-reading the store/);
  assert.doesNotMatch(msg, /restart/i);
});

test('R10-F2: provenance is read from the field the endpoint actually sends', () => {
  // cfg.source was never sent, so the label always fell back to a literal
  assert.equal(sourceLabelOf({ activeSource: 'arg' }), SOURCE_LABEL.arg);
  assert.equal(sourceLabelOf({ projectsDirSource: 'env' }), SOURCE_LABEL.env);
  assert.equal(sourceLabelOf({ activeSource: 'config' }), 'config.json');
  assert.equal(sourceLabelOf({ activeSource: 'default' }), SOURCE_LABEL.default);
  assert.equal(sourceLabelOf({}), null, 'unknown provenance is null, never an invented label');
});
