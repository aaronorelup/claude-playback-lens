// tests/views-overview-l1.test.mjs — group F, L1 (one project) pure logic.
// Loader rationale is documented in tests/views-overview-l0.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const VIEW_DIR = new URL('../web/js/views/', import.meta.url);
const JS_DIR = new URL('../web/js/', import.meta.url);
// router.mjs / api.mjs are the DOM-facing shell -- stripped as before. The
// LEAF modules (format.mjs, components/*.mjs) are node-loadable and are the
// helper-unification sources, so their imports become real file: URLs.
const STRIP_IMPORT = /^import\s+[^;]*?\s+from\s+'\.\.\/(?:router|api)\.mjs';[ \t]*$/gm;

async function strippedSource(name) {
  let src = await readFile(new URL(`${name}.mjs`, VIEW_DIR), 'utf8');
  src = src.replace(STRIP_IMPORT, '');
  src = src.replace(/from\s+'\.\.\/((?:format|components\/[^']+)\.mjs)'/g,
    (m, rel) => `from '${new URL(rel, JS_DIR).href}'`);
  // cross-view imports of node-loadable group-G modules resolve to the real files
  src = src.replace(/from\s+'\.\/(inv|l5)\.mjs'/g,
    (m, name2) => `from '${new URL(`views/${name2}.mjs`, JS_DIR).href}'`);
  return src;
}
const dataUrl = (code) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code).replace(/'/g, '%27');
async function loadView(name) {
  let code = await strippedSource(name);
  if (name !== 'l0') {
    const l0 = dataUrl(await strippedSource('l0'));
    code = code.replace(/from\s+'\.\/l0\.mjs'/g, `from '${l0}'`);
  }
  return import(dataUrl(code));
}

// The stripped foundation imports leave free identifiers behind. Provide the one
// the pure functions actually call (router.href), mirroring its documented
// behaviour, so link building stays exercised rather than stubbed away.
globalThis.href = (...parts) => {
  const segs = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === null || p === undefined || p === '') continue;
    if (i === parts.length - 1 && typeof p === 'object' && !Array.isArray(p)) continue;
    segs.push(encodeURIComponent(String(p)));
  }
  return '#/' + segs.join('/');
};

const L1 = await loadView('l1');
const T = (iso) => Date.parse(iso);

/* ----------------------------------------------------------- payload shape */

test('projectPayload normalises the recorded label and the three listings', () => {
  const p = L1.projectPayload({
    project: { label: 'C:\\Users\\a\\proj' },
    sessions: [{ id: 's1' }],
    memory: [{ name: 'a.md' }],
    fragments: [{ slug: 'other', rel: 'x' }],
  }, 'C--Users-a-proj');
  assert.equal(p.label, 'C:\\Users\\a\\proj');
  assert.equal(p.labelReason, null);
  assert.equal(p.sessions.length, 1);
  assert.equal(p.memory.length, 1);
  assert.equal(p.fragments.length, 1);
});

test('an unlabellable project dir keeps its raw slug and says why', () => {
  const p = L1.projectPayload({}, 'C--Users-a-memory-only');
  assert.equal(p.label, 'C--Users-a-memory-only');
  assert.match(p.labelReason, /re-encodes to the dir name/);
  assert.deepEqual([p.sessions, p.memory, p.fragments], [[], [], []]);
});

test('projectPayload tolerates the alternate key names for the same listings', () => {
  const p = L1.projectPayload({ cards: [{ id: 'x' }], memoryFiles: ['a.md'], fragmentDirs: [{}] }, 'slug');
  assert.equal(p.sessions.length, 1);
  assert.equal(p.memory.length, 1);
  assert.equal(p.fragments.length, 1);
});

/* --------------------------------------------------------------- memory */

const IDX = new Map([['aaaa1111', 'C--Users-a-proj'], ['bbbb2222', 'C--Users-a-other']]);

test('a resolving originSessionId becomes a real link', () => {
  const [r] = L1.memoryRows([{ name: 'note.md', bytes: 120, mtimeMs: T('2026-08-17T18:00:00Z'), originSessionId: 'aaaa1111' }], 'C--Users-a-proj', IDX);
  assert.equal(r.name, 'note.md');
  assert.equal(r.bytes, 120);
  assert.deepEqual(r.resolved, { slug: 'C--Users-a-proj', id: 'aaaa1111' });
  assert.equal(r.crossProject, false);
  assert.equal(r.note, null);
  assert.ok(r.originHref.includes('aaaa1111'));
});

test('a dangling originSessionId says "session not on disk" and links nowhere', () => {
  const [r] = L1.memoryRows([{ name: 'old.md', originSessionId: 'deadbeef' }], 'C--Users-a-proj', IDX);
  assert.equal(r.resolved, null);
  assert.equal(r.originHref, null);
  assert.equal(r.note, 'session not on disk');
});

test('a memory file with no recorded origin says so rather than showing a blank', () => {
  const [r] = L1.memoryRows([{ name: 'plain.md' }], 'C--Users-a-proj', IDX);
  assert.equal(r.originSessionId, null);
  assert.match(r.note, /no originSessionId is recorded/);
  assert.equal(r.bytes, null);
});

test('a memory listing that records `size` rather than `bytes` still shows its size', () => {
  // /api/project ships {name, rel, size, mtimeMs}
  const [r] = L1.memoryRows([{ name: 'a.md', rel: 'mem/a.md', size: 1105, mtimeMs: 1786511965624 }], 'slug', {});
  assert.equal(r.bytes, 1105);
  assert.equal(r.mtimeMs, 1786511965624);
});

test('an origin session in another project dir is flagged for cross-linking', () => {
  const [r] = L1.memoryRows([{ name: 'x.md', originSessionId: 'bbbb2222' }], 'C--Users-a-proj', IDX);
  assert.equal(r.crossProject, true);
  assert.equal(r.resolved.slug, 'C--Users-a-other');
});

test('a bare string memory entry and a mem/ prefix both resolve to the file name', () => {
  const rows = L1.memoryRows(['MEMORY.md', { name: 'mem/other.md' }], 'slug', {});
  assert.deepEqual(rows.map((r) => r.name), ['MEMORY.md', 'other.md']);
  assert.ok(rows[0].rawHref.includes('MEMORY.md'));
});

test('an explicit originSlug on the payload wins over the index lookup', () => {
  const [r] = L1.memoryRows([{ name: 'x.md', originSessionId: 'cccc3333', originSlug: 'C--elsewhere' }], 'C--Users-a-proj', IDX);
  assert.deepEqual(r.resolved, { slug: 'C--elsewhere', id: 'cccc3333' });
  assert.equal(r.crossProject, true);
});

/* -------------------------------------------------------- session underline */

test('session underlines span each session’s own bars within a day', () => {
  const band = {
    localDate: '2026-08-17',
    segments: [
      { startMs: 100, endMs: 200, bar: { slug: 'p', id: 's1', idx: 1 } },
      { startMs: 300, endMs: 400, bar: { slug: 'p', id: 's1', idx: 2 } },
      { startMs: 150, endMs: 160, bar: { slug: 'p', id: 's2', idx: 1 } },
    ],
  };
  const u = L1.sessionUnderlines(band);
  assert.equal(u.length, 2);
  assert.deepEqual(u[0], { slug: 'p', id: 's1', start: 100, end: 400, turns: 2 });
  assert.deepEqual(u[1], { slug: 'p', id: 's2', start: 150, end: 160, turns: 1 });
});

test('a tick segment underlines at its single recorded timestamp, with no width', () => {
  const u = L1.sessionUnderlines({ segments: [{ startMs: 500, endMs: null, bar: { slug: 'p', id: 's', idx: 1 } }] });
  assert.deepEqual(u, [{ slug: 'p', id: 's', start: 500, end: 500, turns: 1 }]);
});

test('an empty band underlines nothing', () => {
  assert.deepEqual(L1.sessionUnderlines({ segments: [] }), []);
  assert.deepEqual(L1.sessionUnderlines({}), []);
});

/* ------------------------------------------------------------- sentence */

test('the L1 scope props name the project, the rule, the fragments and the coverage', () => {
  const s = L1.scopeSentenceL1({
    view: 'sessions', label: 'C:\\Users\\a\\proj', labelReason: null,
    counts: { sessions: 12, turns: 40, agents: 7 }, range: { active: false },
    st: { done: 85, of: 85, building: false }, bandCount: 0, tzText: '(UTC−7)', fragments: 1,
  });
  assert.equal(s.subject, 'project C:\\Users\\a\\proj');
  assert.deepEqual(s.counts, [{ n: 12, noun: 'session' }, { n: 40, noun: 'turn' }, { n: 7, noun: 'agent' }]);
  assert.match(s.rule, /one row per session whose main transcript lives in this dir/);
  assert.ok(s.extra.some((e) => /1 fragment dir/.test(e)));
  assert.ok(s.extra.some((e) => /totals over 85 of 85 sessions/.test(e)));
  assert.deepEqual(s.filters, []);
});

test('the L1 props explain a raw-slug label and carry the date filter', () => {
  const s = L1.scopeSentenceL1({
    view: 'timeline', label: 'C--memory-only', labelReason: 'no transcript records a cwd that re-encodes',
    counts: { sessions: 0, shown: 0 },
    range: { active: true, from: '2026-07-01', to: null },
    st: {}, bandCount: 3, tzText: '(UTC−7)', fragments: 0, hasDayBands: false,
  });
  assert.ok(s.extra.some((e) => /raw slug/.test(e)));
  assert.match(s.rule, /3 local calendar days/);
  assert.match(s.rule, /underline marking each session/);
  assert.deepEqual(s.filters, [{ label: 'date', value: '2026-07-01 → (no end)' }]);
  assert.deepEqual(s.totals, { all: 0, filtered: 0 });
  // a project timeline says out loud that per-project day totals are not
  // recorded (UI-50: reworded so the clause parses as a sentence)
  assert.ok(s.extra.some((e) => /per-project day totals are not recorded/.test(e)));
  assert.ok(s.extra.some((e) => /token and cost columns read — with that reason/.test(e)));
});

test('an unrecorded session count is omitted rather than printed as zero', () => {
  const s = L1.scopeSentenceL1({ view: 'sessions', label: 'p', labelReason: null, counts: {}, range: { active: false }, st: {}, bandCount: 0, tzText: '', fragments: 0 });
  assert.deepEqual(s.counts, []);
  assert.equal(s.totals, undefined);
});
