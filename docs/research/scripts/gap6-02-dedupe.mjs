// gap6-02-dedupe.mjs — MEASURE 1: per-field, per-tier verification of the dedupe rule.
//
// Groups assistant events by message.id WITHIN each file, and for every field of
// interest counts the groups where the value differs across lines. Then compares
// three candidate policies: keep-LAST, keep-MAX-per-field, keep-the-line-with-
// non-null-stop_reason. Splits main / plain-agent / workflow-agent.
//
// Purpose: settle whether agent-tier usage is repeated-identical or cumulative
// (models-usage.md §3 vs event-census-agents.md §7 disagree).
import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, lfLinesCapped, parseLine, usageRow, OUT } from './gap6-lib.mjs';

const man = loadManifest();
const TIERS = ['main', 'plain-agent', 'workflow-agent'];

const NUMF = ['input_tokens', 'cache_creation_input_tokens', 'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'thinking_tokens'];
const ALLF = [...NUMF, 'model', 'stop_reason'];

function blankTier() {
  const t = {
    files: 0, assistantLines: 0, groups: 0, multiGroups: 0,
    lineHist: {},
    differs: Object.fromEntries(ALLF.map(f => [f, 0])),          // groups where value differs across lines
    nonMonotonic: Object.fromEntries(NUMF.map(f => [f, 0])),     // groups where value ever DECREASES in file order
    lastIsMax: Object.fromEntries(NUMF.map(f => [f, 0])),        // groups (multi) where last line holds the max
    allIdentical: 0, anyNumericDiffers: 0,
    sums: { last: zero(), max: zero(), sr: zero() },
    srGroupsZero: 0, srGroupsMulti: 0, srGroupsMultiDisagree: 0,
    lastVsMaxDisagreeGroups: 0, lastVsSrDisagreeGroups: 0,
    exceptions: [],
    thinkingAbsentLines: 0,
    modelDiffExamples: [], stopDiffOnly: 0,
  };
  return t;
}
function zero() { return Object.fromEntries(NUMF.map(f => [f, 0])); }

const tiers = Object.fromEntries(TIERS.map(t => [t, blankTier()]));
const samples = {};       // tier -> verbatim multi-line group
let parseFail = 0, tailLines = 0;

function rowOf(ev) {
  const m = ev.message || {};
  const r = usageRow(m.usage);
  r.model = m.model ?? null;
  r.stop_reason = m.stop_reason ?? null;
  return r;
}

for (const f of man.files) {
  if (!TIERS.includes(f.tier)) continue;
  const T = tiers[f.tier]; T.files++;
  /** @type {Map<string,{rows:any[],raws:string[],lines:number[]}>} */
  const groups = new Map();
  for await (const [n, line, isTail] of lfLinesCapped(f.file, f.bytes)) {
    if (isTail) { tailLines++; continue; }         // torn final line at the pin — never parsed
    const ev = parseLine(line);
    if (ev === undefined) { parseFail++; continue; }
    if (!ev || ev.type !== 'assistant' || !ev.message || !ev.message.id) continue;
    T.assistantLines++;
    const id = ev.message.id;
    let g = groups.get(id);
    if (!g) { g = { rows: [], raws: [], lines: [] }; groups.set(id, g); }
    g.rows.push(rowOf(ev));
    g.lines.push(n);
    if (g.raws.length < 40) g.raws.push(line.length > 4000 ? line.slice(0, 4000) + '…[truncated]' : line);
  }

  for (const [id, g] of groups) {
    T.groups++;
    const rows = g.rows;
    T.lineHist[rows.length] = (T.lineHist[rows.length] || 0) + 1;
    for (const r of rows) if (r.thinking_tokens === null) T.thinkingAbsentLines++;

    const last = rows[rows.length - 1];
    // per-field max (nulls treated as "absent"; max over the non-null values, null if all null)
    const mx = {};
    for (const f2 of NUMF) {
      let v = null;
      for (const r of rows) { const x = r[f2]; if (x === null) continue; v = v === null ? x : Math.max(v, x); }
      mx[f2] = v;
    }
    // non-null stop_reason lines
    const srIdx = rows.map((r, i) => (r.stop_reason !== null ? i : -1)).filter(i => i >= 0);
    if (srIdx.length === 0) T.srGroupsZero++;
    if (srIdx.length > 1) {
      T.srGroupsMulti++;
      const a = rows[srIdx[0]], b = rows[srIdx[srIdx.length - 1]];
      if (NUMF.some(f2 => a[f2] !== b[f2])) T.srGroupsMultiDisagree++;
    }
    const srPick = srIdx.length ? rows[srIdx[srIdx.length - 1]] : last;

    for (const f2 of NUMF) {
      T.sums.last[f2] += last[f2] ?? 0;
      T.sums.max[f2] += mx[f2] ?? 0;
      T.sums.sr[f2] += srPick[f2] ?? 0;
    }

    if (rows.length > 1) {
      T.multiGroups++;
      let anyNum = false;
      for (const f2 of ALLF) {
        const first = rows[0][f2];
        if (rows.some(r => r[f2] !== first)) {
          T.differs[f2]++;
          if (NUMF.includes(f2)) anyNum = true;
          if (f2 === 'model' && T.modelDiffExamples.length < 5)
            T.modelDiffExamples.push({ file: f.rel, id, values: rows.map(r => r.model) });
        }
      }
      if (!anyNum && rows.every(r => r.model === rows[0].model)) T.allIdentical++;
      if (anyNum) T.anyNumericDiffers++;
      if (!anyNum) T.stopDiffOnly++;
      for (const f2 of NUMF) {
        let dec = false;
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1][f2], b = rows[i][f2];
          if (a === null || b === null) continue;
          if (b < a) dec = true;
        }
        if (dec) T.nonMonotonic[f2]++;
        if ((last[f2] ?? null) === mx[f2]) T.lastIsMax[f2]++;
      }
      // policy disagreement at the group level
      const dLM = NUMF.filter(f2 => (last[f2] ?? null) !== mx[f2]);
      const dLS = NUMF.filter(f2 => (last[f2] ?? null) !== (srPick[f2] ?? null));
      if (dLM.length) {
        T.lastVsMaxDisagreeGroups++;
        if (T.exceptions.length < 40) T.exceptions.push({ kind: 'last!=max', file: f.rel, id, fields: dLM, rows });
      }
      if (dLS.length) {
        T.lastVsSrDisagreeGroups++;
        if (T.exceptions.length < 40) T.exceptions.push({ kind: 'last!=stopReason', file: f.rel, id, fields: dLS, nSr: srIdx.length, rows });
      }
      // verbatim sample: prefer a group whose numeric usage differs across lines
      if (!samples[f.tier] || (samples[f.tier].kind === 'identical' && anyNum)) {
        samples[f.tier] = { kind: anyNum ? 'differs' : 'identical', file: f.rel, id, lines: g.lines, raws: g.raws, rows };
      }
    }
  }
}

const outObj = { snapshotUtc: man.snapshotUtc, parseFail, tailLines, tiers, samples };
fs.writeFileSync(path.join(OUT, 'gap6-dedupe.json'), JSON.stringify(outObj, null, 1));

for (const t of TIERS) {
  const T = tiers[t];
  console.log('\n===== ' + t + ' =====');
  console.log('files', T.files, 'assistantLines', T.assistantLines, 'groups', T.groups, 'multiGroups', T.multiGroups);
  console.log('differs-across-lines:', JSON.stringify(T.differs));
  console.log('nonMonotonic:', JSON.stringify(T.nonMonotonic));
  console.log('lastIsMax (of multi):', JSON.stringify(T.lastIsMax));
  console.log('allIdentical(multi)', T.allIdentical, 'anyNumericDiffers', T.anyNumericDiffers, 'stopOrModelDiffOnly', T.stopDiffOnly);
  console.log('srGroupsZero', T.srGroupsZero, 'srGroupsMulti', T.srGroupsMulti, 'srGroupsMultiDisagree', T.srGroupsMultiDisagree);
  console.log('policy disagree groups: last!=max', T.lastVsMaxDisagreeGroups, 'last!=stopReasonPick', T.lastVsSrDisagreeGroups);
  console.log('SUM keep-last:', JSON.stringify(T.sums.last));
  console.log('SUM keep-max :', JSON.stringify(T.sums.max));
  console.log('SUM keep-sr  :', JSON.stringify(T.sums.sr));
  console.log('lineHist:', JSON.stringify(T.lineHist));
  console.log('thinkingAbsentLines', T.thinkingAbsentLines);
  if (T.modelDiffExamples.length) console.log('model diff examples:', JSON.stringify(T.modelDiffExamples));
  if (T.exceptions.length) console.log('exceptions (first 3):', JSON.stringify(T.exceptions.slice(0, 3), null, 1));
}
console.log('\nparseFail', parseFail, 'tailLines(unterminated at pin)', tailLines);
console.log('wrote gap6-dedupe.json');
