// gap6-03-ledger.mjs — MEASURE 2, 3, 4, 6. Builds the reference token ledger.
//
// Corrections applied in the mandated order, each measured separately:
//   (a) LF-only reading                     -> see gap6-04-readline.mjs for the delta
//   (b) exclude <synthetic> events
//   (c) per-file dedupe by message.id, keep-LAST
//   (d) global cross-file dedupe of duplicated message.ids  (BOTH variants emitted:
//       docs/research/gap-2.md does not exist at snapshot time, so no canonical-copy
//       rule is cited; the ledger reports with- and without-dedupe figures)
//   (e) usage.iterations[] attribution: bill each element to element.model ?? message.model
//
// Emits gap6-ledger.json.
import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, lfLinesCapped, parseLine, usageRow, zeroAcc, foldRow, OUT, num } from './gap6-lib.mjs';

const man = loadManifest();
const TIERS = ['main', 'plain-agent', 'workflow-agent'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- stage accumulators ----------
const S = {
  s0_naive_all_lines: zeroAcc(),
  s1_minus_synthetic_lines: zeroAcc(),
  s2_perfile_dedupe: zeroAcc(),
  s3_crossfile_dedupe: zeroAcc(),
  s4_iterations: zeroAcc(),
  s4_iterations_noCrossFileDedupe: zeroAcc(),
};
const counts = {
  filesScanned: 0, linesRead: 0, parseFail: 0, tailUnterminated: 0,
  assistantLines: 0, syntheticLines: 0, syntheticNonUuidId: 0, syntheticIds: new Set(),
  dedupedMessages: 0, dedupedSyntheticMessages: 0,
  iterBranch: { nonEmptyArray: 0, emptyArray: 0, nullValue: 0, absent: 0, notArray: 0 },
  iterElements: 0, iterElemWithOwnModel: 0, iterMismatchTopLevel: 0,
  ccIdentityBreaks: [], journalAssistantEvents: 0,
};

/** deduped message rows, keyed globally: id -> [rows...] (one per file it appears in) */
const byId = new Map();
/** per-main-file turn info */
const turnsBySession = new Map();

function ev2row(ev, f, lineNo) {
  const m = ev.message;
  const u = m.usage;
  const r = usageRow(u);
  return {
    id: m.id, model: m.model ?? null, version: ev.version ?? null,
    tier: f.tier, project: f.project, session: f.session, agentId: f.agentId ?? ev.agentId ?? null,
    workflow: f.workflow, fileRel: f.rel, line: lineNo, uuid: ev.uuid ?? null,
    ts: ev.timestamp ?? null, stop_reason: m.stop_reason ?? null,
    synthetic: m.model === '<synthetic>',
    idIsUuid: UUID_RE.test(m.id || ''),
    iterations: (u && 'iterations' in u) ? u.iterations : undefined,
    ...r,
  };
}

const t0 = Date.now();
for (const f of man.files) {
  if (f.tier === 'journal') {
    // journals carry no assistant events; verified below
    for await (const [n, line, isTail] of lfLinesCapped(f.file, f.bytes)) {
      if (isTail) { counts.tailUnterminated++; continue; }
      counts.linesRead++;
      const ev = parseLine(line);
      if (ev === undefined) { counts.parseFail++; continue; }
      if (ev && ev.type === 'assistant' && ev.message && ev.message.usage) counts.journalAssistantEvents++;
    }
    counts.filesScanned++;
    continue;
  }
  if (!TIERS.includes(f.tier)) continue;
  counts.filesScanned++;

  const perFile = new Map();          // message.id -> row (keep-last)
  const nodes = f.tier === 'main' ? new Map() : null;   // uuid -> parentUuid
  const openers = f.tier === 'main' ? [] : null;        // {uuid, line, ts, preview}

  for await (const [n, line, isTail] of lfLinesCapped(f.file, f.bytes)) {
    if (isTail) { counts.tailUnterminated++; continue; }
    counts.linesRead++;
    const ev = parseLine(line);
    if (ev === undefined) { counts.parseFail++; continue; }
    if (!ev) continue;

    if (nodes && ev.uuid) {
      nodes.set(ev.uuid, ev.parentUuid ?? null);
      if (ev.type === 'user') {
        const c = ev.message && ev.message.content;
        const isOpener = (ev.origin && ev.origin.kind === 'human') ||
          (ev.origin === undefined && typeof c === 'string' && c.startsWith('<command-message>'));
        if (isOpener) {
          openers.push({
            uuid: ev.uuid, line: n, ts: ev.timestamp ?? null,
            originKind: ev.origin ? ev.origin.kind : null,
            preview: (typeof c === 'string' ? c : JSON.stringify(c) || '').slice(0, 120).replace(/\s+/g, ' '),
          });
        }
      }
    }

    if (ev.type !== 'assistant' || !ev.message || !ev.message.id || !ev.message.usage) continue;
    counts.assistantLines++;
    const row = ev2row(ev, f, n);

    // stage 0: naive, every line, flat fields
    foldRow(S.s0_naive_all_lines, row);
    if (row.synthetic) {
      counts.syntheticLines++;
      counts.syntheticIds.add(row.id);
      if (!row.idIsUuid) counts.syntheticNonUuidId++;
    } else {
      foldRow(S.s1_minus_synthetic_lines, row);
    }

    // cache_creation identity check, per LINE
    if (row.cache_creation_input_tokens !== row.ephemeral_5m_input_tokens + row.ephemeral_1h_input_tokens) {
      if (counts.ccIdentityBreaks.length < 60) counts.ccIdentityBreaks.push({
        file: f.rel, line: n, id: row.id, model: row.model,
        flat: row.cache_creation_input_tokens, m5: row.ephemeral_5m_input_tokens, h1: row.ephemeral_1h_input_tokens,
      });
    }
    perFile.set(row.id, row);   // keep-LAST
  }

  // turn attribution for main files
  if (nodes) {
    const openerSet = new Set(openers.map(o => o.uuid));
    const memo = new Map();
    const findTurn = (uuid) => {
      const chain = [];
      let cur = uuid, guard = 0;
      while (cur && guard++ < 1e6) {
        if (memo.has(cur)) { const r = memo.get(cur); for (const c of chain) memo.set(c, r); return r; }
        if (openerSet.has(cur)) { for (const c of chain) memo.set(c, cur); memo.set(cur, cur); return cur; }
        chain.push(cur);
        if (!nodes.has(cur)) break;
        cur = nodes.get(cur);
      }
      for (const c of chain) memo.set(c, null);
      return null;
    };
    for (const row of perFile.values()) row.turnUuid = row.uuid ? findTurn(row.uuid) : null;
    turnsBySession.set(f.session, { fileRel: f.rel, project: f.project, bytes: f.bytes, openers });
  }

  for (const row of perFile.values()) {
    counts.dedupedMessages++;
    if (row.synthetic) counts.dedupedSyntheticMessages++;
    let arr = byId.get(row.id);
    if (!arr) { arr = []; byId.set(row.id, arr); }
    arr.push(row);
  }
}
console.error('scan done in', ((Date.now() - t0) / 1000).toFixed(1), 's');

// ---------- stage 2: per-file deduped, non-synthetic ----------
const allRows = [];
for (const arr of byId.values()) for (const r of arr) { if (!r.synthetic) { foldRow(S.s2_perfile_dedupe, r); allRows.push(r); } }

// ---------- stage 3: global cross-file dedupe ----------
// Canonical-copy rule: gap-2.md does NOT exist at snapshot time, so no established rule is
// cited. This script picks the EARLIEST-timestamp copy (tie-break: lexicographic file path)
// as canonical purely so the deduped ledger has a definite attribution, and reports the full
// list of affected ids so the choice can be re-decided.
const dupIds = [];
const canonical = new Set();
for (const [id, arr] of byId) {
  const live = arr.filter(r => !r.synthetic);
  if (!live.length) continue;
  if (live.length > 1) {
    const sorted = [...live].sort((a, b) => (a.ts || '').localeCompare(b.ts || '') || a.fileRel.localeCompare(b.fileRel));
    canonical.add(sorted[0]);
    dupIds.push({
      id, copies: live.length, model: live[0].model,
      files: live.map(r => ({ fileRel: r.fileRel, tier: r.tier, project: r.project, session: r.session, line: r.line, ts: r.ts })),
      tokens: { input: live[0].input_tokens, cache_creation: live[0].cache_creation_input_tokens, cache_read: live[0].cache_read_input_tokens, output: live[0].output_tokens },
      sameSession: new Set(live.map(r => r.session)).size === 1,
      sameProject: new Set(live.map(r => r.project)).size === 1,
    });
  } else canonical.add(live[0]);
}
for (const r of canonical) foldRow(S.s3_crossfile_dedupe, r);

// ---------- stage 4: iterations[] attribution ----------
/** expand one deduped message into 1..n billed rows */
function billedRows(r) {
  const it = r.iterations;
  if (Array.isArray(it) && it.length > 0) {
    counts.iterBranch.nonEmptyArray++;
    const out = [];
    let sum = { i: 0, cc: 0, cr: 0, o: 0 };
    for (const el of it) {
      counts.iterElements++;
      if (el && typeof el.model === 'string') counts.iterElemWithOwnModel++;
      const cc = el && el.cache_creation;
      const rowOut = {
        ...r, model: (el && el.model) ?? r.model, billedFrom: 'iteration', iterType: el && el.type,
        input_tokens: num(el && el.input_tokens),
        cache_creation_input_tokens: num(el && el.cache_creation_input_tokens),
        ephemeral_5m_input_tokens: num(cc && cc.ephemeral_5m_input_tokens),
        ephemeral_1h_input_tokens: num(cc && cc.ephemeral_1h_input_tokens),
        cache_read_input_tokens: num(el && el.cache_read_input_tokens),
        output_tokens: num(el && el.output_tokens),
        thinking_tokens: r.thinking_tokens,       // only recorded at message level
      };
      // thinking is a message-level field; attribute it to the FIRST element only
      if (out.length > 0) rowOut.thinking_tokens = null;
      sum.i += rowOut.input_tokens; sum.cc += rowOut.cache_creation_input_tokens;
      sum.cr += rowOut.cache_read_input_tokens; sum.o += rowOut.output_tokens;
      out.push(rowOut);
    }
    if (sum.i !== r.input_tokens || sum.cc !== r.cache_creation_input_tokens ||
        sum.cr !== r.cache_read_input_tokens || sum.o !== r.output_tokens) counts.iterMismatchTopLevel++;
    return out;
  }
  if (Array.isArray(it)) counts.iterBranch.emptyArray++;
  else if (it === null) counts.iterBranch.nullValue++;
  else if (it === undefined) counts.iterBranch.absent++;
  else counts.iterBranch.notArray++;
  return [{ ...r, billedFrom: 'flat' }];
}

const billed = [];               // canonical (cross-file deduped) + iterations applied
for (const r of canonical) for (const b of billedRows(r)) { billed.push(b); foldRow(S.s4_iterations, b); }
// variant without cross-file dedupe (iterations still applied) — branch counters are NOT re-counted
const savedBranch = JSON.parse(JSON.stringify(counts.iterBranch));
const savedElems = counts.iterElements, savedOwn = counts.iterElemWithOwnModel, savedMis = counts.iterMismatchTopLevel;
const billedNoX = [];
for (const r of allRows) for (const b of billedRows(r)) { billedNoX.push(b); foldRow(S.s4_iterations_noCrossFileDedupe, b); }
counts.iterBranch = savedBranch; counts.iterElements = savedElems;
counts.iterElemWithOwnModel = savedOwn; counts.iterMismatchTopLevel = savedMis;

// ---------- ledger roll-ups (from `billed` = final, cross-file deduped) ----------
function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    let a = m.get(k);
    if (!a) { a = zeroAcc(); m.set(k, a); }
    foldRow(a, r);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => (b[1].cache_read_input_tokens + b[1].output_tokens) - (a[1].cache_read_input_tokens + a[1].output_tokens)));
}

function buildLedger(rows) {
  return {
    corpus: (() => { const a = zeroAcc(); for (const r of rows) foldRow(a, r); return a; })(),
    byProject: group(rows, r => r.project),
    bySession: group(rows, r => r.session),
    byTier: group(rows, r => r.tier),
    byModel: group(rows, r => r.model),
    byVersion: group(rows, r => String(r.version)),
    byAgentId: group(rows.filter(r => r.tier !== 'main'), r => r.agentId),
    byWorkflow: group(rows.filter(r => r.tier === 'workflow-agent'), r => r.workflow),
    byTierModel: group(rows, r => r.tier + '|' + r.model),
    byProjectTier: group(rows, r => r.project + '|' + r.tier),
    bySessionTier: group(rows, r => r.session + '|' + r.tier),
  };
}
function buildTurnLedger(rows) {
  const tl = {};
  for (const [session, info] of turnsBySession) {
    const srows = rows.filter(r => r.tier === 'main' && r.session === session);
    const byTurn = new Map();
    const unattributed = zeroAcc();
    for (const r of srows) {
      const k = r.turnUuid;
      if (!k) { foldRow(unattributed, r); continue; }
      let a = byTurn.get(k); if (!a) { a = zeroAcc(); byTurn.set(k, a); }
      foldRow(a, r);
    }
    tl[session] = {
      fileRel: info.fileRel, project: info.project, bytes: info.bytes,
      turnCount: info.openers.length,
      turns: info.openers.map((o, i) => ({
        index: i + 1, turnUuid: o.uuid, line: o.line, ts: o.ts, originKind: o.originKind, preview: o.preview,
        ...(byTurn.get(o.uuid) || zeroAcc()),
      })),
      unattributedMainMessages: unattributed,
    };
  }
  return tl;
}
const ledger = buildLedger(billed);
const ledgerAsRecorded = buildLedger(billedNoX);
const turnLedger = buildTurnLedger(billed);
const turnLedgerAsRecorded = buildTurnLedger(billedNoX);

// ---------- MEASURE 4: consistency checks ----------
function sumAcc(objs) { const a = zeroAcc(); for (const o of objs) { a.messages += o.messages; for (const k of ['input_tokens','cache_creation_input_tokens','ephemeral_5m_input_tokens','ephemeral_1h_input_tokens','cache_read_input_tokens','output_tokens','thinking_tokens']) a[k] += o[k]; a.thinking_absent += o.thinking_absent; } return a; }
function diff(a, b) { const d = {}; for (const k of Object.keys(a)) if (a[k] !== b[k]) d[k] = a[k] - b[k]; return d; }

const checks = {
  sessionsSumToCorpus: diff(sumAcc(Object.values(ledger.bySession)), ledger.corpus),
  projectsSumToCorpus: diff(sumAcc(Object.values(ledger.byProject)), ledger.corpus),
  tiersSumToCorpus: diff(sumAcc(Object.values(ledger.byTier)), ledger.corpus),
  modelsSumToCorpus: diff(sumAcc(Object.values(ledger.byModel)), ledger.corpus),
  versionsSumToCorpus: diff(sumAcc(Object.values(ledger.byVersion)), ledger.corpus),
  sessionsSumToProjects: {},
  turnsSumToSessionMain: {},
  cacheCreationIdentity: { breakLines: counts.ccIdentityBreaks.length, samples: counts.ccIdentityBreaks },
};
{
  const perProj = new Map();
  for (const r of billed) { let a = perProj.get(r.project); if (!a) { a = new Map(); perProj.set(r.project, a); } let b = a.get(r.session); if (!b) { b = zeroAcc(); a.set(r.session, b); } foldRow(b, r); }
  for (const [proj, sessMap] of perProj) {
    const d = diff(sumAcc([...sessMap.values()]), ledger.byProject[proj]);
    if (Object.keys(d).length) checks.sessionsSumToProjects[proj] = d;
  }
}
for (const [session, t] of Object.entries(turnLedger)) {
  const mainTotal = ledger.bySessionTier[session + '|main'] || zeroAcc();
  const d = diff(sumAcc([...t.turns, t.unattributedMainMessages]), mainTotal);
  if (Object.keys(d).length) checks.turnsSumToSessionMain[session] = d;
  const dNoUnattr = diff(sumAcc(t.turns), mainTotal);
  if (Object.keys(dNoUnattr).length) (checks.turnsSumToSessionMain_excludingUnattributed ||= {})[session] = dNoUnattr;
}

// does correction (e) repair the cache_creation identity?
checks.cacheCreationIdentityAfterIterations = {
  billedRowsBreakingIdentity: billed.filter(r => r.cache_creation_input_tokens !== r.ephemeral_5m_input_tokens + r.ephemeral_1h_input_tokens).length,
  messagesBreakingIdentityBeforeIterations: [...canonical].filter(r => r.cache_creation_input_tokens !== r.ephemeral_5m_input_tokens + r.ephemeral_1h_input_tokens).length,
  positiveControl_linesBreakingIdentity: counts.ccIdentityBreaks.length,
};
checks.asRecorded_turnsSumToSessionMain = {};
for (const [session, t] of Object.entries(turnLedgerAsRecorded)) {
  const mainTotal = ledgerAsRecorded.bySessionTier[session + '|main'] || zeroAcc();
  const d = diff(sumAcc([...t.turns, t.unattributedMainMessages]), mainTotal);
  if (Object.keys(d).length) checks.asRecorded_turnsSumToSessionMain[session] = d;
}
checks.sessionsEmptiedByCrossFileDedupe = Object.keys(ledgerAsRecorded.bySession).filter(s2 => !(s2 in ledger.bySession));
checks.turnsEmptiedByCrossFileDedupe = [];
for (const [session, t] of Object.entries(turnLedgerAsRecorded)) {
  const cur = turnLedger[session];
  for (const [i, tr] of t.turns.entries()) {
    const c = cur.turns[i];
    if (tr.messages > 0 && c.messages === 0) checks.turnsEmptiedByCrossFileDedupe.push({ session, index: tr.index, line: tr.line, messages: tr.messages, cache_read: tr.cache_read_input_tokens, output: tr.output_tokens });
  }
}

// ---------- MEASURE 6: token-mass shares ----------
function shares(a) {
  const total = a.input_tokens + a.cache_creation_input_tokens + a.cache_read_input_tokens + a.output_tokens;
  const inputSide = a.input_tokens + a.cache_creation_input_tokens + a.cache_read_input_tokens;
  const pct = (x, d) => d ? +(100 * x / d).toFixed(4) : null;
  return {
    totalBilledTokens: total,
    inputSideTokens: inputSide,
    pctOfTotal: {
      cache_read: pct(a.cache_read_input_tokens, total),
      cache_write_5m: pct(a.ephemeral_5m_input_tokens, total),
      cache_write_1h: pct(a.ephemeral_1h_input_tokens, total),
      fresh_input: pct(a.input_tokens, total),
      output: pct(a.output_tokens, total),
    },
    pctOfInputSide: { cache_read: pct(a.cache_read_input_tokens, inputSide) },
    thinking_tokens: a.thinking_tokens,
    thinking_pctOfOutput: pct(a.thinking_tokens, a.output_tokens),
    thinking_notRecordedMessages: a.thinking_absent,
    thinking_recordedMessages: a.messages - a.thinking_absent,
  };
}
const massShares = { corpus: shares(ledger.corpus), byModel: {}, byTier: {} };
for (const [k, v] of Object.entries(ledger.byModel)) massShares.byModel[k] = shares(v);
for (const [k, v] of Object.entries(ledger.byTier)) massShares.byTier[k] = shares(v);

// ---------- per-correction impact ----------
const stageDeltas = {
  'b_exclude_synthetic': { messagesTouched: counts.syntheticLines, delta: diff(S.s1_minus_synthetic_lines, S.s0_naive_all_lines) },
  'c_perfile_dedupe_keep_last': { messagesTouched: counts.assistantLines - counts.syntheticLines - (counts.dedupedMessages - counts.dedupedSyntheticMessages), delta: diff(S.s2_perfile_dedupe, S.s1_minus_synthetic_lines) },
  'd_crossfile_dedupe': { messagesTouched: dupIds.reduce((s, d) => s + d.copies - 1, 0), delta: diff(S.s3_crossfile_dedupe, S.s2_perfile_dedupe) },
  'e_iterations_attribution': { messagesTouched: counts.iterMismatchTopLevel, delta: diff(S.s4_iterations, S.s3_crossfile_dedupe) },
};

const out = {
  meta: {
    snapshotUtc: man.snapshotUtc,
    generatedUtc: new Date().toISOString(),
    root: man.root,
    files: man.totals,
    script: 'docs/research/scripts/gap6-03-ledger.mjs',
    gap2Exists: fs.existsSync(path.join(OUT, '..', 'gap-2.md')),
    crossFileCanonicalRule: 'earliest timestamp, tie-break lexicographic file path (chosen HERE; gap-2.md absent)',
    note: 'TOKEN COUNTS ONLY. No dollar figures. thinking_absent = messages where output_tokens_details.thinking_tokens is NOT RECORDED (must never render as 0).',
  },
  counts: { ...counts, syntheticIds: [...counts.syntheticIds], ccIdentityBreaks: undefined },
  stages: S,
  stageDeltas,
  crossFileDuplicates: { idCount: dupIds.length, extraCopies: dupIds.reduce((s, d) => s + d.copies - 1, 0), ids: dupIds },
  ledger,
  ledgerAsRecorded_noCrossFileDedupe: ledgerAsRecorded,
  turnLedger,
  turnLedgerAsRecorded_noCrossFileDedupe: turnLedgerAsRecorded,
  checks,
  massShares,
};
fs.writeFileSync(path.join(OUT, 'gap6-ledger.json'), JSON.stringify(out, null, 1));

// ---------- console summary ----------
const p = (o) => JSON.stringify(o);
console.log('snapshot', man.snapshotUtc);
console.log('files', counts.filesScanned, 'lines', counts.linesRead, 'parseFail', counts.parseFail, 'tail', counts.tailUnterminated);
console.log('assistantLines', counts.assistantLines, 'syntheticLines', counts.syntheticLines, 'dedupedMessages', counts.dedupedMessages);
console.log('journalAssistantEvents', counts.journalAssistantEvents);
for (const [k, v] of Object.entries(S)) console.log('STAGE', k, p(v));
for (const [k, v] of Object.entries(stageDeltas)) console.log('DELTA', k, v.messagesTouched, p(v.delta));
console.log('iterBranch', p(counts.iterBranch), 'elements', counts.iterElements, 'withOwnModel', counts.iterElemWithOwnModel, 'mismatchTopLevel', counts.iterMismatchTopLevel);
console.log('crossFileDupIds', dupIds.length, 'extraCopies', dupIds.reduce((s, d) => s + d.copies - 1, 0));
console.log('ccIdentityBreakLines', counts.ccIdentityBreaks.length);
console.log('CHECKS', p({ ...checks, cacheCreationIdentity: { breakLines: counts.ccIdentityBreaks.length } }));
console.log('byTier', p(ledger.byTier));
console.log('byModel', p(ledger.byModel));
console.log('massShares.corpus', p(massShares.corpus));
console.log('wrote gap6-ledger.json');
