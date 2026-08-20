// gap6-05-xcheck.mjs — MEASURE 5: recomputed ledger vs every RECORDED aggregate.
//
// Recorded aggregates checked:
//   (A) toolUseResult.totalTokens on synchronous Agent tool calls
//   (B) <usage>subagent_tokens: N \n tool_uses: N \n duration_ms: N</usage> free-text
//       footers on nested spawn results (a text block inside the parent's tool_result)
//   (C) workflowProgress[].tokens + totalTokens in <session>/workflows/wf_*.json
//   (D) <usage><subagent_tokens>N</subagent_tokens>…</usage> XML footers on the
//       Workflow tool's task-notification (a workflow-level aggregate)
//
// Every comparison is against figures recomputed from the child transcript at the
// pinned snapshot, deduped by message.id keep-LAST.
import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, lfLinesCapped, parseLine, usageRow, zeroAcc, foldRow, OUT, ROOT } from './gap6-lib.mjs';

const man = loadManifest();

// ---------- per-agent recomputation ----------
const agents = new Map();   // agentId -> stats
for (const f of man.files) {
  if (f.tier !== 'plain-agent' && f.tier !== 'workflow-agent') continue;
  const keep = new Map();       // id -> {row, toolUses, order}
  let order = 0, toolUseBlocks = 0;   // content blocks are ONE PER LINE — count across ALL lines
  for await (const [n, line, isTail] of lfLinesCapped(f.file, f.bytes)) {
    if (isTail) continue;
    const ev = parseLine(line);
    if (!ev || ev.type !== 'assistant' || !ev.message || !ev.message.id || !ev.message.usage) continue;
    const c = ev.message.content;
    const toolUses = Array.isArray(c) ? c.filter(b => b && b.type === 'tool_use').length : 0;
    if (ev.message.model !== '<synthetic>') toolUseBlocks += toolUses;
    const row = usageRow(ev.message.usage);
    const prev = keep.get(ev.message.id);
    keep.set(ev.message.id, { row, model: ev.message.model, order: prev ? prev.order : order++, line: n, synthetic: ev.message.model === '<synthetic>' });
  }
  const list = [...keep.values()].sort((a, b) => a.order - b.order);
  const acc = zeroAcc();
  const ctxSeries = [];
  let last = null;
  for (const e of list) {
    if (e.synthetic) continue;
    foldRow(acc, e.row); last = e;
    ctxSeries.push(e.row.input_tokens + e.row.cache_creation_input_tokens + e.row.cache_read_input_tokens + e.row.output_tokens);
  }
  const toolUses = toolUseBlocks;
  const fin = last ? last.row : null;
  agents.set(f.agentId, {
    agentId: f.agentId, tier: f.tier, fileRel: f.rel, project: f.project, session: f.session, workflow: f.workflow,
    messages: acc.messages, sums: acc, toolUses, ctxSeries,
    finalTurn: fin && {
      input_tokens: fin.input_tokens, cache_creation_input_tokens: fin.cache_creation_input_tokens,
      cache_read_input_tokens: fin.cache_read_input_tokens, output_tokens: fin.output_tokens,
      ctx_no_output: fin.input_tokens + fin.cache_creation_input_tokens + fin.cache_read_input_tokens,
      ctx_with_output: fin.input_tokens + fin.cache_creation_input_tokens + fin.cache_read_input_tokens + fin.output_tokens,
    },
    maxCtx: list.reduce((m, e) => Math.max(m, e.row.input_tokens + e.row.cache_creation_input_tokens + e.row.cache_read_input_tokens), 0),
  });
}

// ---------- scan every transcript for recorded aggregates ----------
const A = [], B = [], D = [];
const AGENTID_RE = /agentId:\s*([0-9a-f]{17})\b/;
const COLON_RE = /<usage>\s*subagent_tokens:\s*(\d+)\s*\n\s*tool_uses:\s*(\d+)\s*\n\s*duration_ms:\s*(\d+)\s*<\/usage>/;
const XML_RE = /<usage>([\s\S]{0,400}?)<\/usage>/g;
function xmlNum(body, tag) { const m = new RegExp('<' + tag + '>(\\d+)</' + tag + '>').exec(body); return m ? +m[1] : null; }

for (const f of man.files) {
  for await (const [n, line, isTail] of lfLinesCapped(f.file, f.bytes)) {
    if (isTail) continue;
    const needsScan = line.includes('totalTokens') || line.includes('subagent_tokens');
    if (!needsScan) continue;
    const ev = parseLine(line);
    if (!ev) continue;

    // (A) toolUseResult.totalTokens
    const tur = ev.toolUseResult;
    if (tur && typeof tur.totalTokens === 'number') {
      let tuid = null;
      const c = ev.message && ev.message.content;
      if (Array.isArray(c)) for (const b of c) if (b && b.tool_use_id) tuid = b.tool_use_id;
      A.push({
        file: f.rel, tier: f.tier, line: n, tool_use_id: tuid,
        agentId: tur.agentId ?? null, description: tur.description ?? null,
        totalTokens: tur.totalTokens, totalToolUseCount: tur.totalToolUseCount ?? null,
        totalDurationMs: tur.totalDurationMs ?? null,
        usage: tur.usage ? usageRow(tur.usage) : null,
        usageIterLen: tur.usage && Array.isArray(tur.usage.iterations) ? tur.usage.iterations.length : null,
        toolStats: tur.toolStats ?? null,
      });
    }

    // gather every text carrier on this event
    const texts = [];
    const c = ev.message && ev.message.content;
    if (typeof c === 'string') texts.push({ bt: 'string', tuid: null, tx: c });
    else if (Array.isArray(c)) for (const b of c) {
      if (typeof b.text === 'string') texts.push({ bt: b.type, tuid: b.tool_use_id || null, tx: b.text });
      const bc = b.content;
      if (typeof bc === 'string') texts.push({ bt: b.type, tuid: b.tool_use_id || null, tx: bc });
      else if (Array.isArray(bc)) for (const bb of bc) if (typeof bb.text === 'string') texts.push({ bt: b.type, tuid: b.tool_use_id || null, tx: bb.text });
    }
    if (ev.attachment) texts.push({ bt: 'attachment', tuid: null, tx: JSON.stringify(ev.attachment) });

    for (const { bt, tuid, tx } of texts) {
      if (!tx || !tx.includes('subagent_tokens')) continue;
      // (B) colon footer
      const cm = COLON_RE.exec(tx);
      if (cm) {
        const am = AGENTID_RE.exec(tx);
        B.push({ file: f.rel, tier: f.tier, line: n, blockType: bt, tool_use_id: tuid,
          childAgentId: am ? am[1] : null,
          subagent_tokens: +cm[1], tool_uses: +cm[2], duration_ms: +cm[3] });
      }
      // (D) XML workflow footer
      XML_RE.lastIndex = 0; let m;
      while ((m = XML_RE.exec(tx))) {
        const body = m[1];
        if (!body.includes('<subagent_tokens>')) continue;
        const wf = /resumeFromRunId:\s*'(wf_[0-9a-f]{8}-[0-9a-f]{3})'/.exec(tx) || /(wf_[0-9a-f]{8}-[0-9a-f]{3})/.exec(tx);
        const tid = /<task-id>([0-9a-f]{17})<\/task-id>/.exec(tx);
        D.push({ file: f.rel, tier: f.tier, line: n, blockType: bt, evType: ev.type,
          workflow: wf ? wf[1] : null, taskId: tid ? tid[1] : null,
          agent_count: xmlNum(body, 'agent_count'), agents_done: xmlNum(body, 'agents_done'),
          agents_error: xmlNum(body, 'agents_error'), agents_skipped: xmlNum(body, 'agents_skipped'),
          subagent_tokens: xmlNum(body, 'subagent_tokens'), tool_uses: xmlNum(body, 'tool_uses'),
          duration_ms: xmlNum(body, 'duration_ms') });
      }
    }
  }
}

// ---------- (C) workflowProgress[].tokens ----------
const wfRecords = [];
for (const proj of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!proj.isDirectory()) continue;
  const pdir = path.join(ROOT, proj.name);
  for (const sess of fs.readdirSync(pdir, { withFileTypes: true })) {
    if (!sess.isDirectory()) continue;
    const wdir = path.join(pdir, sess.name, 'workflows');
    if (!fs.existsSync(wdir)) continue;
    for (const wf of fs.readdirSync(wdir, { withFileTypes: true })) {
      if (!wf.isFile() || !wf.name.endsWith('.json')) continue;
      let j; try { j = JSON.parse(fs.readFileSync(path.join(wdir, wf.name), 'utf8')); } catch { continue; }
      wfRecords.push({ project: proj.name, session: sess.name, file: wf.name, id: j.id ?? wf.name.replace(/\.json$/, ''), json: j });
    }
  }
}

const wfRows = [];
for (const w of wfRecords) {
  const prog = Array.isArray(w.json.workflowProgress) ? w.json.workflowProgress : [];
  const entries = [];
  for (const p of prog) {
    if (typeof p.tokens !== 'number') continue;
    const a = agents.get(p.agentId);
    entries.push({
      workflow: w.id, session: w.session, agentId: p.agentId, cached: !!p.cached,
      recordedTokens: p.tokens, recordedToolCalls: p.toolCalls ?? null,
      hasTranscript: !!a,
      finalCtxNoOutput: a && a.finalTurn ? a.finalTurn.ctx_no_output : null,
      finalCtxWithOutput: a && a.finalTurn ? a.finalTurn.ctx_with_output : null,
      maxCtx: a ? a.maxCtx : null,
      sumOutput: a ? a.sums.output_tokens : null,
      sumAllFour: a ? a.sums.input_tokens + a.sums.cache_creation_input_tokens + a.sums.cache_read_input_tokens + a.sums.output_tokens : null,
      measuredToolUses: a ? a.toolUses : null,
    });
  }
  wfRows.push({ workflow: w.id, session: w.session, project: w.project,
    totalTokens: w.json.totalTokens ?? null, totalToolCalls: w.json.totalToolCalls ?? null,
    sumProgressTokens: entries.reduce((s, e) => s + e.recordedTokens, 0), entries });
}

// ---------- comparisons ----------
function stat(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const q = p => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  return { n: a.length, min: a[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: a[a.length - 1], zeros: a.filter(v => v === 0).length, negatives: a.filter(v => v < 0).length };
}

// A: totalTokens vs final-turn ctx_with_output, and vs sums
const aCmp = A.map(r => {
  const a = r.agentId ? agents.get(r.agentId) : null;
  return { ...r, matchedAgent: !!a, fileRelChild: a ? a.fileRel : null,
    finalCtxWithOutput: a && a.finalTurn ? a.finalTurn.ctx_with_output : null,
    finalCtxNoOutput: a && a.finalTurn ? a.finalTurn.ctx_no_output : null,
    sumOutput: a ? a.sums.output_tokens : null,
    sumAllFour: a ? a.sums.input_tokens + a.sums.cache_creation_input_tokens + a.sums.cache_read_input_tokens + a.sums.output_tokens : null,
    measuredToolUses: a ? a.toolUses : null,
    deltaVsFinalWithOutput: a && a.finalTurn ? r.totalTokens - a.finalTurn.ctx_with_output : null,
    deltaVsFinalNoOutput: a && a.finalTurn ? r.totalTokens - a.finalTurn.ctx_no_output : null,
    prefixMatchIndex: a ? a.ctxSeries.lastIndexOf(r.totalTokens) : -1,
    childMessages: a ? a.messages : null,
    toolUseAgree: a ? r.totalToolUseCount === a.toolUses : null };
});

// B: subagent_tokens vs child figures
const bCmp = B.map(r => {
  const a = r.childAgentId ? agents.get(r.childAgentId) : null;
  const f = a && a.finalTurn;
  return { ...r, matchedAgent: !!a, fileRelChild: a ? a.fileRel : null,
    finalCtxWithOutput: f ? f.ctx_with_output : null, finalCtxNoOutput: f ? f.ctx_no_output : null,
    sumOutput: a ? a.sums.output_tokens : null,
    sumAllFour: a ? a.sums.input_tokens + a.sums.cache_creation_input_tokens + a.sums.cache_read_input_tokens + a.sums.output_tokens : null,
    measuredToolUses: a ? a.toolUses : null,
    deltaVsFinalWithOutput: f ? r.subagent_tokens - f.ctx_with_output : null,
    deltaVsFinalNoOutput: f ? r.subagent_tokens - f.ctx_no_output : null,
    prefixMatchIndex: a ? a.ctxSeries.lastIndexOf(r.subagent_tokens) : -1,
    messagesAfterPrefixMatch: a && a.ctxSeries.lastIndexOf(r.subagent_tokens) >= 0 ? a.ctxSeries.length - 1 - a.ctxSeries.lastIndexOf(r.subagent_tokens) : null,
    childMessages: a ? a.messages : null,
    toolUseAgree: a ? r.tool_uses === a.toolUses : null };
});

// D: workflow XML footer vs Σ recorded workflowProgress tokens and vs recomputed
const wfById = new Map(wfRows.map(w => [w.workflow, w]));
const agentsByWf = new Map();
for (const a of agents.values()) if (a.workflow) { let l = agentsByWf.get(a.workflow); if (!l) { l = []; agentsByWf.set(a.workflow, l); } l.push(a); }
const dCmp = D.map(r => {
  const ta = r.taskId ? agents.get(r.taskId) : null;
  const w = r.workflow ? wfById.get(r.workflow) : null;
  const list = r.workflow ? (agentsByWf.get(r.workflow) || []) : [];
  const sumFinalCtx = list.reduce((s, a) => s + (a.finalTurn ? a.finalTurn.ctx_no_output : 0), 0);
  const sumAllFour = list.reduce((s, a) => s + a.sums.input_tokens + a.sums.cache_creation_input_tokens + a.sums.cache_read_input_tokens + a.sums.output_tokens, 0);
  const sumTools = list.reduce((s, a) => s + a.toolUses, 0);
  return { ...r, wfRecordTotalTokens: w ? w.totalTokens : null, wfSumProgressTokens: w ? w.sumProgressTokens : null,
    transcriptsFound: list.length, sumFinalCtxNoOutput: sumFinalCtx, sumAllFour, sumToolUses: sumTools,
    deltaVsWfRecord: w && w.totalTokens != null ? r.subagent_tokens - w.totalTokens : null,
    deltaVsSumFinalCtx: r.subagent_tokens - sumFinalCtx,
    kind: r.agent_count != null ? 'workflow-aggregate' : (r.taskId ? 'per-agent-task-notification' : 'unknown'),
    taskAgentFound: !!ta,
    taskFinalCtxWithOutput: ta && ta.finalTurn ? ta.finalTurn.ctx_with_output : null,
    taskDeltaVsFinalWithOutput: ta && ta.finalTurn ? r.subagent_tokens - ta.finalTurn.ctx_with_output : null,
    taskPrefixMatchIndex: ta ? ta.ctxSeries.lastIndexOf(r.subagent_tokens) : -1,
    taskMeasuredToolUses: ta ? ta.toolUses : null,
    taskToolAgree: ta ? r.tool_uses === ta.toolUses : null };
});

const summary = {
  snapshotUtc: man.snapshotUtc,
  agentTranscripts: agents.size,
  A_totalTokens: {
    occurrences: A.length, matchedAgent: aCmp.filter(r => r.matchedAgent).length,
    exact_vs_finalTurn_in_cc_cr_out: aCmp.filter(r => r.deltaVsFinalWithOutput === 0).length,
    exact_vs_finalTurn_no_output: aCmp.filter(r => r.deltaVsFinalNoOutput === 0).length,
    exact_vs_sumOutput: aCmp.filter(r => r.totalTokens === r.sumOutput).length,
    exact_vs_sumAllFour: aCmp.filter(r => r.totalTokens === r.sumAllFour).length,
    toolUseCountAgree: aCmp.filter(r => r.toolUseAgree === true).length,
    residualVsFinalWithOutput: stat(aCmp.filter(r => r.deltaVsFinalWithOutput !== null).map(r => r.deltaVsFinalWithOutput)),
  },
  B_subagent_tokens: {
    occurrences: B.length, matchedAgent: bCmp.filter(r => r.matchedAgent).length,
    exact_vs_finalTurn_in_cc_cr_out: bCmp.filter(r => r.deltaVsFinalWithOutput === 0).length,
    exact_vs_finalTurn_no_output: bCmp.filter(r => r.deltaVsFinalNoOutput === 0).length,
    exact_vs_sumOutput: bCmp.filter(r => r.subagent_tokens === r.sumOutput).length,
    exact_vs_sumAllFour: bCmp.filter(r => r.subagent_tokens === r.sumAllFour).length,
    toolUseCountAgree: bCmp.filter(r => r.toolUseAgree === true).length,
    toolUseCountDisagree: bCmp.filter(r => r.toolUseAgree === false).length,
    residualVsFinalWithOutput: stat(bCmp.filter(r => r.deltaVsFinalWithOutput !== null).map(r => r.deltaVsFinalWithOutput)),
    residualVsFinalNoOutput: stat(bCmp.filter(r => r.deltaVsFinalNoOutput !== null).map(r => r.deltaVsFinalNoOutput)),
    matchesSomeMessageCtxWithOutput: bCmp.filter(r => r.prefixMatchIndex >= 0).length,
    matchesNoMessageAtAll: bCmp.filter(r => r.prefixMatchIndex < 0).length,
    ofTheNonFinalMatches_messagesAfter: stat(bCmp.filter(r => r.prefixMatchIndex >= 0 && r.deltaVsFinalWithOutput !== 0).map(r => r.messagesAfterPrefixMatch)),
    byTier: bCmp.reduce((m, r) => { m[r.tier] = (m[r.tier] || 0) + 1; return m; }, {}),
  },
  C_workflowProgress: (() => {
    const all = wfRows.flatMap(w => w.entries);
    const withT = all.filter(e => e.hasTranscript);
    return {
      workflows: wfRows.length, progressEntriesWithTokens: all.length, withTranscript: withT.length,
      totalTokensEqualsSumProgress: wfRows.filter(w => w.totalTokens === w.sumProgressTokens).length,
      exact_vs_finalCtxNoOutput: withT.filter(e => e.recordedTokens === e.finalCtxNoOutput).length,
      exact_vs_finalCtxWithOutput: withT.filter(e => e.recordedTokens === e.finalCtxWithOutput).length,
      exact_vs_sumOutput: withT.filter(e => e.recordedTokens === e.sumOutput).length,
      exact_vs_sumAllFour: withT.filter(e => e.recordedTokens === e.sumAllFour).length,
      residual_recorded_minus_finalCtxNoOutput: stat(withT.map(e => e.recordedTokens - e.finalCtxNoOutput)),
      residual_recorded_minus_maxCtx: stat(withT.map(e => e.recordedTokens - e.maxCtx)),
      toolCallsAgree: withT.filter(e => e.recordedToolCalls === e.measuredToolUses).length,
      sumRecordedTokens: all.reduce((s, e) => s + e.recordedTokens, 0),
      sumRecomputedAllFour: withT.reduce((s, e) => s + e.sumAllFour, 0),
      sumRecomputedOutput: withT.reduce((s, e) => s + e.sumOutput, 0),
    };
  })(),
  D_workflowXmlFooter: {
    occurrences: D.length,
    kinds: dCmp.reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {}),
    perAgentNotifications: {
      n: dCmp.filter(r => r.kind === 'per-agent-task-notification').length,
      agentFound: dCmp.filter(r => r.kind === 'per-agent-task-notification' && r.taskAgentFound).length,
      exact_vs_finalCtxWithOutput: dCmp.filter(r => r.kind === 'per-agent-task-notification' && r.taskDeltaVsFinalWithOutput === 0).length,
      matchesSomeMessageCtx: dCmp.filter(r => r.kind === 'per-agent-task-notification' && r.taskPrefixMatchIndex >= 0).length,
      toolAgree: dCmp.filter(r => r.kind === 'per-agent-task-notification' && r.taskToolAgree === true).length,
      residual: stat(dCmp.filter(r => r.kind === 'per-agent-task-notification' && r.taskDeltaVsFinalWithOutput !== null).map(r => r.taskDeltaVsFinalWithOutput)),
      toolsRecordedLEmeasured: dCmp.filter(r => r.kind === 'per-agent-task-notification' && r.taskMeasuredToolUses !== null && r.tool_uses <= r.taskMeasuredToolUses).length,
    },
    withWorkflowId: dCmp.filter(r => r.workflow).length,
    exact_vs_wfRecordTotalTokens: dCmp.filter(r => r.deltaVsWfRecord === 0).length,
    residualVsWfRecord: stat(dCmp.filter(r => r.deltaVsWfRecord !== null).map(r => r.deltaVsWfRecord)),
    toolUsesEqualWfTotalToolCalls: dCmp.filter(r => r.wfRecordTotalTokens !== null && r.tool_uses === (wfById.get(r.workflow) || {}).totalToolCalls).length,
    distinctWorkflows: new Set(dCmp.map(r => r.workflow)).size,
  },
};

fs.writeFileSync(path.join(OUT, 'gap6-xcheck.json'), JSON.stringify({ summary, A: aCmp, B: bCmp, C: wfRows, D: dCmp, agents: [...agents.values()].map(a => ({ ...a, ctxSeries: undefined })) }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log('\n--- A rows ---');
for (const r of aCmp) console.log(r.description, '| recorded', r.totalTokens, '| finalCtx+out', r.finalCtxWithOutput, '| Δ', r.deltaVsFinalWithOutput, '| tools', r.totalToolUseCount, 'vs', r.measuredToolUses);
console.log('\n--- B mismatches (first 15) ---');
for (const r of bCmp.filter(r => r.deltaVsFinalWithOutput !== 0).slice(0, 15)) console.log(r.file, 'L' + r.line, r.childAgentId, 'rec', r.subagent_tokens, 'finalCtx+out', r.finalCtxWithOutput, 'Δ', r.deltaVsFinalWithOutput, 'ΔnoOut', r.deltaVsFinalNoOutput, 'tools', r.tool_uses, 'vs', r.measuredToolUses);
console.log('wrote gap6-xcheck.json');
