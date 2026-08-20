// server/api/routes-workflow.mjs — /api/workflow/:slug/:id/:runId. The rule
// this route serves under: never 404 an existing run dir. The run DIRECTORY
// LISTING is the enumeration source for the agents array on BOTH envelopes
// (SPEC §7); manifest, journal and script are enrichments that may be absent.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { httpError, problem } from '../errors.mjs';
import { sendJson } from '../http.mjs';
import { IS_WIN, assertCleanRel, tableLookup } from './fileref.mjs';
import { requireIndex, findSession } from './session-lookup.mjs';
import { getCanonical, rowsSumTcuOf, sumVerdict } from './costs.mjs';

const AGENT_REL_RE = /agent-(a[0-9a-f]{16})\.jsonl$/;

export function registerWorkflowRoutes({ G }, ctx, { canonMemo }) {
  // The run's own cost, on BOTH envelopes, under the key the client reads
  // (`cost`). The header folds PER-AGENT aggregates over the run's
  // transcripts (the same pattern as /api/session's agentsOut) while the row
  // sum comes from the independent rowsSumTcuOf/priceRowTcu path, so the ✓
  // stays a real cross-check rather than the same number compared to itself.
  // A run whose rows cannot be loaded ships null (unknown), never a 0.
  const runFileOf = (runId) => new RegExp(`(^|/)subagents/workflows/${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
  // the row's file spelling varies (store-relative vs session-relative); one
  // transcript = one agent, so key the partition by the agentId the filename
  // records — the same suffix join /api/session's agentsOut uses.
  const agentKeyOf = (file) => (AGENT_REL_RE.exec(String(file ?? '')) || [null, null])[1] ?? String(file ?? '');

  async function workflowCostOf(slug, id, runId) {
    // `byAgent`/`zero` are the per-transcript partition + the empty aggregate
    // the run rows below are folded from; both stay null when nothing loaded,
    // which is what makes a per-agent figure UNKNOWN rather than a zero.
    const out = { cost: null, rowsSumToHeader: null, byAgent: null, zero: null };
    if (!ctx.ledger || !ctx.pricing || typeof ctx.ledger.addCostAgg !== 'function') return out;
    try {
      const rows = await ctx.index.rows(slug, id);
      const re = runFileOf(runId);
      const runRows = (rows ?? []).filter((r) => re.test(String(r.file ?? '')));
      const canonicalOf = getCanonical(ctx, canonMemo);
      const opts = { canonicalOf, sessionId: id, priceRow: ctx.pricing.priceRow };
      const byAgent = new Map(); // one transcript = one agent (SPEC §7 enumeration source)
      for (const r of runRows) {
        const k = agentKeyOf(r.file);
        let list = byAgent.get(k);
        if (!list) byAgent.set(k, list = []);
        list.push(r);
      }
      // Σ over the run's agents — an empty run folds to a real, provable zero
      // (its transcripts hold no billed row), the same rule /api/turn applies.
      let cost = ctx.ledger.aggregate([], opts);
      const aggByAgent = new Map();
      for (const [k, list] of byAgent) {
        const one = ctx.ledger.aggregate(list, opts);
        aggByAgent.set(k, one);
        cost = ctx.ledger.addCostAgg(cost, one);
      }
      out.cost = cost;
      // The per-agent partition the header was folded from, so the run's
      // agent rows sum to its own headline BY CONSTRUCTION — never a second
      // pricing pass that could disagree with the first.
      out.byAgent = aggByAgent;
      out.zero = ctx.ledger.aggregate([], opts);
      out.rowsSumToHeader = sumVerdict(cost?.usd?.total ?? null, rowsSumTcuOf(ctx, runRows, id, canonicalOf));
    } catch { /* pending / group A absent — both stay null (unknown) */ }
    return out;
  }

  // ONE agents array for BOTH workflow envelopes.
  //
  // Every agent-a*.jsonl in `subagents/workflows/<runId>/` gets exactly one
  // row, whether or not anything else knows about it. Each row is then
  // ENRICHED from the session-level agent projection /api/session already
  // emits (matched on rel first, then on the agentId the filename records),
  // and carries its own slice of the very partition the run's cost header was
  // folded from. A transcript the projection does not know keeps the one fact
  // its filename proves — its agentId — and everything unrecorded stays null,
  // so the client's normalizeAgent renders '—' honestly instead of inventing.
  // Objects, never strings: normalizeAgent reads raw.agentId/raw.label.text/…,
  // all of which are undefined on a bare filename.
  function runAgentsOf(slug, id, runId, inDir, projection, byAgent, zeroAgg) {
    const dirPrefix = `${slug}/${id}/subagents/workflows/${runId}/`;
    const byRel = new Map();
    const byId = new Map();
    for (const a of projection ?? []) {
      if (!a) continue;
      if (a.rel) byRel.set(IS_WIN ? String(a.rel).toLowerCase() : String(a.rel), a);
      if (a.agentId) byId.set(a.agentId, a);
    }
    const out = [];
    for (const key of inDir) {
      const m = AGENT_REL_RE.exec(key);
      if (!m) continue;
      const agentId = m[1];
      const hit = byRel.get(IS_WIN ? key.toLowerCase() : key) ?? byId.get(agentId) ?? null;
      // Billing per transcript. A transcript the loaded ledger covers gets its
      // own slice; one the ledger covers but never billed folds to the real,
      // provable zero (same rule the run header applies to an empty run). A
      // transcript that appeared on disk since the last parse is covered by
      // NOTHING, and its billing is UNKNOWN — null, never a zero that would
      // read as "this agent cost nothing".
      const agg = byAgent
        ? (byAgent.get(agentId) ?? (hit ? (zeroAgg ?? null) : null))
        : null;
      // the listing's own locators win over the projection's copies: `rel` is
      // the store-relative key (the same spelling /api/session's agents carry),
      // `file` the transcript's name inside the run directory.
      const locators = { rel: key, file: key.slice(dirPrefix.length) };
      if (!hit) {
        // on disk, unknown to the projection — the filename is still evidence
        out.push({ agentId, ...locators, runId, model: null, agg });
        continue;
      }
      out.push({
        ...hit,
        agentId,
        ...locators,
        runId: hit.runId ?? runId,
        // The projection resolves the model from four recorded names, in the
        // order the ladder consults them. normalizeAgent (web/js/views/l3.mjs)
        // runs this SAME ladder itself, with `raw.model` as its top rung — so
        // this pre-resolved value still wins on the run-page envelope and the
        // run page, L3 and L4 cannot print different models for one agent.
        // Keep the two ladders in step.
        model: hit.resolvedModel ?? hit.progressModel ?? (Array.isArray(hit.models) ? hit.models[0] : null) ?? hit.metaModel ?? null,
        agg,
      });
    }
    return out;
  }

  // the session-level agent projection, or null when it is not loadable (the
  // run page must still serve: "never 404 an existing run dir").
  async function sessionAgentProjection(slug, id) {
    try {
      const detail = await ctx.index.detail(slug, id);
      return Array.isArray(detail?.agents) ? detail.agents : null;
    } catch { return null; }
  }

  G('/api/workflow/:slug/:id/:runId', async (_req, res, { params }) => {
    requireIndex(ctx);
    const { slug, id, runId } = params;
    assertCleanRel(slug); assertCleanRel(id); assertCleanRel(runId);
    findSession(ctx, slug, id);
    const fileTable = ctx.index.fileTable();
    // the run directory is read FIRST and read ONCE: it is the enumeration
    // source for the agents array on BOTH envelopes (SPEC §7).
    const dirPrefix = `${slug}/${id}/subagents/workflows/${runId}/`;
    const dirPrefixLc = dirPrefix.toLowerCase();
    const inDir = [...fileTable.keys()].filter((k) => (IS_WIN ? k.toLowerCase().startsWith(dirPrefixLc) : k.startsWith(dirPrefix)));
    // The journal is read ONCE, ABOVE the manifest branch split, and rides
    // BOTH envelopes — a completed run's page needs its journal exactly as
    // much as an in-flight one's.
    //
    // The value is DISCRIMINATED, because [] and "not disclosed" are different
    // facts: [] ONLY when the run directory provably lists no journal.jsonl,
    // and null when the file is there but its read failed or raced. A bare []
    // for the second case would let the client claim "no journal" about a
    // journal it was never shown.
    const journalProblems = [];
    const journalRel = inDir.find((k) => k.endsWith('/journal.jsonl'));
    let journal = [];
    if (journalRel) {
      try {
        const text = await fsp.readFile(path.resolve(ctx.projectsDir, ...journalRel.split('/')), 'utf8');
        journal = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { torn: true }; } });
      } catch (e) {
        journal = null;   // exists, not readable — UNKNOWN, never an empty list
        journalProblems.push(problem('file-unreadable', {
          severity: 'warning', scope: 'file', slug, id, runId, file: journalRel,
          message: `journal.jsonl for run ${runId} is unreadable (${e && e.code ? e.code : 'read error'}) — the journal facts on this page are undisclosed, not absent`,
          affects: 'display',
        }));
      }
    }
    const recordRel = tableLookup(fileTable, `${slug}/${id}/workflows/${runId}.json`);
    const manifestProblems = [];
    if (recordRel) {
      const abs = path.resolve(ctx.projectsDir, ...recordRel.split('/'));
      let record = null;
      let readable = true;
      try { record = JSON.parse(await fsp.readFile(abs, 'utf8')); }
      catch (e) {
        // "never 404 an existing run dir": a manifest mid-write/unparseable is
        // a Problem, and the partial envelope below still serves the run
        readable = false;
        manifestProblems.push(problem('file-unreadable', {
          severity: 'warning', scope: 'file', slug, id, runId, file: recordRel,
          message: `workflow record ${runId}.json is unreadable/unparseable (${e && e.code ? e.code : 'parse error'}) — serving the partial envelope`,
          affects: 'display',
        }));
      }
      if (readable) {
        // costed only once the run is known to exist — a 404 never forces a parse
        const { cost, rowsSumToHeader, byAgent, zero } = await workflowCostOf(slug, id, runId);
        // A completed run gets the SAME agents array the partial branch ships:
        // the run's time anchor (at/span) comes from the agents' own
        // firstAt/lastAt, and the client reconciles the manifest against this
        // list — an empty list there would read as "N manifest entries have no
        // transcript in this directory", an affirmative false claim.
        const agents = runAgentsOf(slug, id, runId, inDir,
          await sessionAgentProjection(slug, id), byAgent, zero);
        sendJson(res, 200, { slug, id, runId, complete: true, record, agents, journal, cost, rowsSumToHeader, problems: journalProblems });
        return;
      }
    }
    // 404 only when NOTHING of the run exists — an unreadable manifest with no
    // run dir still proves the run and serves an (empty) partial envelope
    if (inDir.length === 0 && manifestProblems.length === 0) {
      throw httpError(404, 'unknown-workflow', `no workflow run ${runId} in ${slug}/${id}`);
    }
    // partial envelope for an in-flight run: journal (read above) + script +
    // transcripts
    let script = null;
    const scriptRel = [...fileTable.keys()].find((k) =>
      k.startsWith(`${slug}/${id}/workflows/scripts/`) && k.endsWith(`-${runId}.js`));
    if (scriptRel) {
      try { script = await fsp.readFile(path.resolve(ctx.projectsDir, ...scriptRel.split('/')), 'utf8'); }
      catch { script = null; }
    }
    const { cost, rowsSumToHeader, byAgent, zero } = await workflowCostOf(slug, id, runId);
    // Objects, never bare filenames: a string row would make every column of
    // the in-flight run's agents table read as unknown, agentId included, and
    // the row's link resolve to a dead href.
    const agents = runAgentsOf(slug, id, runId, inDir,
      await sessionAgentProjection(slug, id), byAgent, zero);
    sendJson(res, 200, {
      slug, id, runId, complete: false,
      journal, script, agents, cost, rowsSumToHeader,
      note: manifestProblems.length
        ? 'workflow record unreadable (mid-write?); envelope from journal + script + transcripts'
        : 'in-flight run: no workflow record yet; envelope from journal + script + transcripts',
      problems: [...manifestProblems, ...journalProblems],
    });
  });
}
