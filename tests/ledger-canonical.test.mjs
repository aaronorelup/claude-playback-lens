// tests/ledger-canonical.test.mjs — R2: resolveCanonical clauses (i)/(ii)/(iii),
// the ambiguity census, and the inherited-channel routing in aggregate(),
// against the two real fork pairs the corpus provides:
//   proj-a …0001/…0002 — copies KEEP the original sessionId and the
//     first-timestamped-record timestamps TIE -> clause (i) is load-bearing;
//   proj-b …0003/…0004 — copies REWRITE sessionId, the
//     resumed file opens with an untimestamped custom-title -> clause (ii) with
//     the skip-untimestamped rule is load-bearing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionLedger, resolveCanonical, aggregate, addCostAgg } from '../server/ledger.mjs';
import { priceRow } from '../shared/pricing.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const manifest = JSON.parse(readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));

function loadCase(name) {
  const c = manifest.cases[name];
  assert.ok(c, `fixture case ${name} missing — run: node tests/extract-fixtures.mjs`);
  const parts = readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8').split('\n');
  const texts = parts.slice(0, -1);
  return {
    notes: c.notes,
    sourceRel: c.sourceRel,
    lines: texts.map((t, i) => ({ file: c.sourceRel, line: c.lines[i], event: JSON.parse(t) })),
  };
}

const A1BE = '0000000a-0000-4000-8000-000000000001';
const C3D0 = '0000000a-0000-4000-8000-000000000002';
const ORIG = '0000000a-0000-4000-8000-000000000003';
const RESU = '0000000a-0000-4000-8000-000000000004';

test('R2 clause (i) — proj-a: copies keep the original sessionId; (ii) would tie', () => {
  const a = loadCase('r2a-proja-00000001');
  const c = loadCase('r2a-proja-00000002');
  const dupId = a.notes.dupMsgId;

  // recorded evidence, verified from the fixture events themselves
  for (const l of a.lines) assert.equal(l.event.sessionId, A1BE, 'original file: copy sessionId == filename');
  for (const l of c.lines) assert.equal(l.event.sessionId, A1BE, 'resumed file: copy KEEPS the original sessionId');
  assert.equal(a.notes.firstTimestamped.ms, c.notes.firstTimestamped.ms, 'the copied prefix includes the first timestamped record — clause (ii) TIES');

  const canonical = resolveCanonical(
    new Map([
      [A1BE, new Set([dupId])],
      [C3D0, new Set([dupId])],
    ]),
    new Map([
      [A1BE, { firstTsMs: a.notes.firstTimestamped.ms, rel: a.sourceRel }],
      [C3D0, { firstTsMs: c.notes.firstTimestamped.ms, rel: c.sourceRel, foreignMsgIds: new Set([dupId]) }],
    ]),
  );
  assert.equal(canonical.get(dupId), A1BE);
  assert.equal(canonical.stats.byClause.i, 1, 'resolved by clause (i)');
  assert.equal(canonical.stats.byClause.ii, 0);
  assert.equal(canonical.stats.byClause.iii, 0);
  assert.deepEqual(canonical.ambiguous, [], 'the ambiguity census is empty');
});

test('R2 clause (ii) — proj-b: both copies rewrite sessionId; earliest FIRST-TIMESTAMPED record wins', () => {
  const o = loadCase('r2b-projb-original');
  const r = loadCase('r2b-projb-resumed');
  const dupId = o.notes.dupMsgId;

  // recorded evidence: the rewrite (clause (i) matches BOTH copies -> non-discriminating)
  for (const l of o.lines) assert.equal(l.event.sessionId, ORIG);
  for (const l of r.lines.filter((x) => x.event.type === 'assistant')) assert.equal(l.event.sessionId, RESU, 'copies are REWRITTEN to the resuming session');

  // the skip-untimestamped rule is load-bearing: the resumed file opens with
  // 4 untimestamped metadata records (custom-title first); its first
  // TIMESTAMPED record is at line 5. A naive first-record reading evaluates
  // undefined; the file-minimum reading would tie on inherited timestamps.
  const opening = r.lines.filter((l) => r.notes.openingUntimestampedLines.includes(l.line));
  assert.equal(opening.length, 4);
  assert.equal(opening[0].event.type, 'custom-title');
  for (const l of opening) assert.ok(!('timestamp' in l.event), `line ${l.line} carries no timestamp`);
  assert.equal(r.notes.firstTimestamped.line, 5);
  assert.ok(o.notes.firstTimestamped.ms < r.notes.firstTimestamped.ms, 'strictly positive margin (measured: 12h22m)');

  const canonical = resolveCanonical(
    new Map([
      [ORIG, [dupId]],
      [RESU, [dupId]],
    ]),
    new Map([
      [ORIG, { firstTsMs: o.notes.firstTimestamped.ms, rel: o.sourceRel }],
      [RESU, { firstTsMs: r.notes.firstTimestamped.ms, rel: r.sourceRel }],
    ]),
  );
  assert.equal(canonical.get(dupId), ORIG);
  assert.equal(canonical.stats.byClause.ii, 1, 'resolved by clause (ii)');
  assert.deepEqual(canonical.ambiguous, []);
});

test('R2 clause (iii) — exact tie falls to the lexicographically smallest rel path and is censused', () => {
  const canonical = resolveCanonical(
    new Map([
      ['s-bbb', ['msg_tie']],
      ['s-aaa', ['msg_tie']],
    ]),
    new Map([
      ['s-bbb', { firstTsMs: 1000, rel: 'proj/bbb.jsonl' }],
      ['s-aaa', { firstTsMs: 1000, rel: 'proj/aaa.jsonl' }],
    ]),
  );
  assert.equal(canonical.get('msg_tie'), 's-aaa');
  assert.equal(canonical.stats.byClause.iii, 1);
  assert.equal(canonical.ambiguous.length, 1, 'clause-(iii) resolutions ARE the R2 ambiguity census (expected 0 on this corpus)');
  assert.deepEqual(canonical.ambiguous[0].candidates.sort(), ['s-aaa', 's-bbb']);
  assert.equal(canonical.ambiguous[0].chose, 's-aaa');
});

test('R2 — an id in exactly one session gets no entry (canonical where it lives)', () => {
  const canonical = resolveCanonical(
    new Map([
      ['s1', ['msg_only']],
      ['s2', []],
    ]),
    new Map([
      ['s1', { firstTsMs: 1, rel: 'a' }],
      ['s2', { firstTsMs: 2, rel: 'b' }],
    ]),
  );
  assert.equal(canonical.size, 0);
  assert.equal(canonical.stats.duplicated, 0);
});

test('R2 — aggregate routes non-canonical copies to the inherited channel, derived at read time', () => {
  const a = loadCase('r2a-proja-00000001');
  const c = loadCase('r2a-proja-00000002');
  const dupId = a.notes.dupMsgId;
  const canonicalOf = resolveCanonical(
    new Map([
      [A1BE, [dupId]],
      [C3D0, [dupId]],
    ]),
    new Map([
      [A1BE, { firstTsMs: a.notes.firstTimestamped.ms, rel: a.sourceRel }],
      [C3D0, { firstTsMs: c.notes.firstTimestamped.ms, rel: c.sourceRel, foreignMsgIds: new Set([dupId]) }],
    ]),
  );

  const rowsA = buildSessionLedger(a.lines);
  const rowsC = buildSessionLedger(c.lines);
  assert.equal(rowsA.length, 1);
  assert.equal(rowsC.length, 1);

  // ACC-23: aggregate() is PURE — it never mutates the rows it reads (they
  // may be shared cached arrays). Frozen rows must aggregate without a throw,
  // and billedElsewhere stays exactly as built (null) on BOTH sides — the API
  // layer derives display annotations from canonicalOf itself.
  const frozenA = rowsA.map((r) => Object.freeze({ ...r }));
  const frozenC = rowsC.map((r) => Object.freeze({ ...r }));
  const aggA = aggregate(frozenA, { canonicalOf, sessionId: A1BE, priceRow });
  const aggC = aggregate(frozenC, { canonicalOf, sessionId: C3D0, priceRow });

  // canonical session bills normally
  assert.equal(aggA.requests, 1);
  assert.equal(rowsA[0].billedElsewhere, null);
  assert.ok(aggA.usd.total > 0);
  assert.deepEqual(aggA.inherited, {});

  // non-canonical copy: inherited channel, not billed totals — the row still displays
  assert.equal(aggC.requests, 0);
  assert.equal(aggC.usd.total, 0, 'a session whose rows are 100% copies bills a REAL $0');
  assert.equal(rowsC[0].billedElsewhere, null, 'purity: the routing decision is never written back onto the row');
  assert.ok(aggC.inherited[A1BE], 'inherited keyed by the canonical sessionId');
  assert.equal(aggC.inherited[A1BE].requests, 1);
  assert.equal(aggC.inherited[A1BE].tokens.output, rowsC[0].output);
  assert.deepEqual(aggC.byModel, {}, 'inherited copies do not enter byModel');

  // the copies are byte-identical on usage — token identity across the pair
  assert.deepEqual(aggC.inherited[A1BE].tokens, {
    input: rowsA[0].input,
    output: rowsA[0].output,
    cache5m: rowsA[0].cache5m,
    cache1h: rowsA[0].cache1h,
    cacheFlat: rowsA[0].cacheFlat,
    cacheRead: rowsA[0].cacheRead,
  });

  // parent = Σ children: the pair sums to exactly one billed request
  const sum = addCostAgg(aggA, aggC);
  assert.equal(sum.requests, 1);
  assert.equal(sum.usd.total, aggA.usd.total);
  assert.equal(sum.inherited[A1BE].requests, 1);
});

test('R2 — without foreignMsgIds evidence the proj-a tie degrades to the deterministic clause-(iii) backstop', () => {
  // graceful degradation only: clause (i) needs the recorded-sessionId evidence;
  // absent that, the tie is resolved deterministically and COUNTED as ambiguous.
  const a = loadCase('r2a-proja-00000001');
  const c = loadCase('r2a-proja-00000002');
  const dupId = a.notes.dupMsgId;
  const canonical = resolveCanonical(
    new Map([
      [A1BE, [dupId]],
      [C3D0, [dupId]],
    ]),
    new Map([
      [A1BE, { firstTsMs: a.notes.firstTimestamped.ms, rel: a.sourceRel }],
      [C3D0, { firstTsMs: c.notes.firstTimestamped.ms, rel: c.sourceRel }],
    ]),
  );
  assert.equal(canonical.get(dupId), A1BE, '…0001 happens to sort first');
  assert.equal(canonical.stats.byClause.iii, 1);
  assert.equal(canonical.ambiguous.length, 1, 'the degradation is DISCLOSED, never silent');
});

test('R2 — a session with no timestamped record loses clause (ii) to one that has one', () => {
  const canonical = resolveCanonical(
    new Map([
      ['s-none', ['msg_x']],
      ['s-ts', ['msg_x']],
    ]),
    new Map([
      ['s-none', { firstTsMs: null, rel: 'z.jsonl' }],
      ['s-ts', { firstTsMs: 5000, rel: 'a.jsonl' }],
    ]),
  );
  assert.equal(canonical.get('msg_x'), 's-ts');
  assert.equal(canonical.stats.byClause.ii, 1);
});
