/**
 * Workflow record (`…/s/<sid>/w/<runId>`).
 * DESIGN §3 (beside the spine), SPEC §7 (workflow lineage, five input shapes,
 * agent states), §9 (/api/workflow partial envelope).
 *
 * A run directory that exists ALWAYS renders. `wf_*.json` is written at
 * completion only, so an in-flight run has agents and a journal but no
 * manifest: that case renders a partial envelope labelled from the run dir
 * name, never a 404 and never an error page.
 */

import { kit } from '../lib/net.mjs';
import { h, a, unknown, section, factList } from '../lib/dom.mjs';
import { fmtInt, fmtDur, fmtLocalTime, toMs, shortId, truncate, spanProps } from '../lib/fmt.mjs';
import { routes } from '../lib/links.mjs';
import { page, errorCard, pendingCard, statHeader, mountCrumbs, handle404 } from '../lib/chrome.mjs';
import { safeStringify, textBody } from '../lib/text.mjs';
import {
  agentGlyph, agentTags, normalizeAgent, phaseLabelOf,
} from './l3.mjs';

/* ============================================================ pure ==== */

/**
 * The FIVE recorded shapes of `Workflow.input` (SPEC §7). Never assume
 * `script ?? scriptPath`: naming the shape is the whole point.
 */
export function describeWorkflowInput(input) {
  if (!input || typeof input !== 'object') {
    return { shape: 'not recorded', detail: null, reason: 'no Workflow tool_use input is recorded for this run' };
  }
  if (input.resumeFromRunId) {
    return {
      shape: 'resume', detail: input.resumeFromRunId, key: 'resumeFromRunId',
      note: 'a resume mutates the same run directory in place; the run stays attributed to the turn of its FIRST spawning call (SPEC §7)',
    };
  }
  if (typeof input.script === 'string') {
    return { shape: 'inline script', detail: input.script, key: 'script', note: `${fmtInt(input.script.length)} characters recorded inline` };
  }
  if (input.scriptPath) return { shape: 'scriptPath', detail: input.scriptPath, key: 'scriptPath' };
  if (input.name && input.args !== undefined) {
    return { shape: 'registered workflow with args', detail: input.name, key: 'name', args: input.args };
  }
  if (input.name) return { shape: 'registered workflow', detail: input.name, key: 'name' };
  return { shape: 'unrecognised shape', detail: safeStringify(input), reason: 'the recorded input matches none of the five observed shapes — shown raw rather than guessed at' };
}

/**
 * Journal census (SPEC §2: journal.jsonl holds only started/result, no
 * timestamps, no uuids; `key` is NOT unique — join on agentId only).
 */
export function journalCensus(journal = []) {
  const entries = Array.isArray(journal) ? journal : (journal?.entries ?? []);
  const started = new Set(), resulted = new Set();
  let startedEvents = 0, resultEvents = 0, noAgentId = 0;
  for (const e of entries) {
    const id = e?.agentId ?? null;
    if (!id) { noAgentId++; continue; }
    if (e.type === 'started') { started.add(id); startedEvents++; }
    else if (e.type === 'result') { resulted.add(id); resultEvents++; }
  }
  const running = [...started].filter((id) => !resulted.has(id));
  const resultOnly = [...resulted].filter((id) => !started.has(id));
  return {
    startedEvents, resultEvents, noAgentId,
    startedAgents: [...started], resultedAgents: [...resulted],
    running, resultOnly,
    retried: startedEvents > started.size,
  };
}

/** Manifest-vs-journal split (SPEC §7's three orphan signatures). */
export function reconcileAgents({ manifestIds = [], journal = [], transcriptIds = [] } = {}) {
  const jc = journalCensus(journal);
  const manifest = new Set(manifestIds.filter(Boolean));
  const transcripts = new Set(transcriptIds.filter(Boolean));
  const inManifestNotOnDisk = [...manifest].filter((id) => !transcripts.has(id));
  const onDiskNotInManifest = [...transcripts].filter((id) => !manifest.has(id));
  return {
    journal: jc,
    manifestCount: manifest.size,
    transcriptCount: transcripts.size,
    inManifestNotOnDisk,
    onDiskNotInManifest,
    running: onDiskNotInManifest.filter((id) => jc.running.includes(id)),
    superseded: onDiskNotInManifest.filter((id) => !jc.running.includes(id)),
  };
}

/* ============================================================ view ==== */

export async function renderWorkflow(ctx) {
  const { body } = page(ctx, 'lens-wf');
  const P = ctx.params ?? {};
  const slug = P.slug, sid = P.sid ?? P.id, runId = P.runId ?? P.run;
  const K = await kit();
  if (ctx.stale) return;

  mountCrumbs(ctx, [
    { label: 'store', href: routes.store() },
    { label: slug ?? 'project', href: routes.project(slug) },
    { label: `session ${shortId(sid)}`, sub: sid, href: routes.session(slug, sid) },
    { label: `workflow ${runId}` },
  ]);
  ctx.setTitle?.(`workflow ${runId} — Claude Playback Lens`);

  // DESIGN §7: chrome first.
  statHeader(ctx, { pending: true });

  let payload;
  try {
    payload = await K.api(`/api/workflow/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/${encodeURIComponent(runId)}`,
      null, { signal: ctx.signal });
  } catch (err) {
    // STALE-RENDER RULE: ahead of handle404, which banners AND navigates; and the place
    // the `signal` above lands its AbortError for a superseded render.
    if (ctx.stale) return;
    if (handle404(ctx, err, { slug, sid, thing: `workflow run ${runId}` })) return;
    body.appendChild(errorCard(err, { retry: () => renderWorkflow(ctx) }));
    return;
  }
  // This render's title was set PRE-await, so only its scope sentence
  // and stat band could go stale here — but pendingCard would still blank the
  // live page (ctx.el IS shell.contentEl), and statHeader below would repaint
  // the current page's bands with this run's figures.
  if (ctx.stale) return;
  if (payload?.pending) { pendingCard(ctx, payload.pending, () => renderWorkflow(ctx)); return; }

  // The envelope's discriminator is `complete` (SPEC §9), and this
  // is where the client branches on it. The server has never sent `partial`,
  // and never sent `manifest`/`wf` either — the manifest ships as `record` on
  // the complete branch. Reading keys the server does not send left `!manifest`
  // as the only live half of the test, so the page's whole partial/complete
  // decision rested on a fallback. `!manifest` stays AFTER the real test as a
  // cheap backstop for a malformed envelope (a body with neither key still
  // renders the honest in-flight page rather than an empty complete one).
  const manifest = payload.record ?? null;
  const partial = payload.complete === false || !manifest;
  const progress = payload.workflowProgress ?? manifest?.workflowProgress ?? [];
  const agentsRaw = payload.agents ?? [];
  const agents = agentsRaw.map(normalizeAgent);
  // Never `?? []` here — it would conflate three different facts: "this run
  // directory has no journal.jsonl", "the file is there and would not read",
  // and "this envelope never mentioned the journal at all". An undisclosed
  // journal is UNKNOWN (null); only a server that has looked at the directory
  // listing may say [].
  const journal = payload.journal === undefined ? null : payload.journal;
  const journalKnown = journal !== null;
  const recon = reconcileAgents({
    manifestIds: progress.map((p) => p.agentId).filter(Boolean),
    journal,
    transcriptIds: agents.map((x) => x.agentId).filter(Boolean),
  });

  const name = manifest?.workflowName ?? manifest?.name ?? null;
  const firstAt = agents.map((x) => x.firstAt).filter((t) => t !== null && t !== undefined);
  const lastAt = agents.map((x) => x.lastAt).filter((t) => t !== null && t !== undefined);

  statHeader(ctx, {
    agg: payload.cost ?? null,
    // The SPEC §9 scope grammar has NO workflow level — passing the
    // session scope here made the panel's "show the N requests" fetch the
    // whole session and reprice it against the run's own agg (a false ✗).
    // No scope → no records button; the reason prints on the panel's page.
    scope: null,
    subject: `workflow run ${runId} of session ${shortId(sid)}`,
    sentenceCounts: [{ n: agents.length, noun: 'agent' }],
    rule: partial
      ? 'IN FLIGHT: the orchestration record (wf_*.json) is written at completion only, so this page is assembled from what exists now — the journal, the script, and the agent transcripts in the run directory; the run is labelled from its directory name because workflowName is manifest-only (SPEC §7)'
      : 'its recorded orchestration record, with the journal and every agent transcript in the run directory',
    scopeSentence: 'The scope grammar has no workflow level, so this cost figure opens no per-request table — the per-request rows are on the session\'s cost panel.',
    // The run's earliest recorded agent timestamp anchors the
    // printed R10 interval.
    at: firstAt.length ? Math.min(...firstAt) : null,
    span: firstAt.length && lastAt.length
      ? spanProps(Math.min(...firstAt), Math.max(...lastAt), 'span')
      : { label: 'span', ms: null, reason: 'no agent transcript in this run records two timestamps' },
    counts: [
      { key: 'agents', label: 'agents', value: agents.length },
      { key: 'manifest', label: 'in manifest', value: progress.length ? progress.length : (partial ? null : 0), reason: 'no manifest exists yet — it is written at completion only' },
    ],
    footnote: { requests: payload.cost?.requests ?? null, rowsSumToHeader: payload.rowsSumToHeader },
  });
  // `/` still scans the owning session's bytes — the find scope is real even
  // though the records scope is not.
  ctx.registerScope?.(`session:${slug}/${sid}`);

  if (partial) {
    body.appendChild(h('p', {
      class: 'lens-banner lens-banner--partial',
      text: 'Partial envelope: this run directory exists on disk and has no wf_*.json yet. Everything below is recorded; nothing about the run\'s outcome is inferred from its absence.',
    }));
  }

  // ---- facts
  body.appendChild(section('run facts', factList([
    { label: 'runId', value: runId, source: 'the run directory name' },
    { label: 'workflowName', value: name, source: 'wf_*.json workflowName', reason: partial ? 'manifest-only, and no manifest exists yet — the run is labelled from its directory name' : 'not recorded in the manifest' },
    { label: 'state', value: manifest?.state ?? manifest?.status ?? null, source: 'wf_*.json', reason: partial ? 'the manifest that would record it is written at completion only' : 'not recorded' },
    { label: 'agents in run directory', value: fmtInt(agents.length), source: 'directory listing — the enumeration source (SPEC §7)' },
    { label: 'entries in workflowProgress', value: progress.length ? fmtInt(progress.length) : null, source: 'wf_*.json workflowProgress (display metadata, never the enumeration source)', reason: 'no manifest' },
    // Both of these are journal ARITHMETIC: with no journal disclosed there is
    // nothing to count, and '0 / 0' / 'no' would be claims, not facts.
    { label: 'journal started / result', value: journalKnown ? `${fmtInt(recon.journal.startedEvents)} / ${fmtInt(recon.journal.resultEvents)}` : null, source: 'journal.jsonl (no timestamps, no uuids; joined on agentId — `key` is not unique)', reason: 'this envelope does not disclose the journal' },
    { label: 'retried', value: !journalKnown ? null : (recon.journal.retried ? `yes — ${fmtInt(recon.journal.startedEvents)} started events for ${fmtInt(recon.journal.startedAgents.length)} distinct agents` : 'no'), source: 'journal arithmetic', reason: 'this envelope does not disclose the journal, so its started-event arithmetic is unavailable' },
  ])));

  // ---- the recorded Workflow.input shape
  const input = payload.input ?? manifest?.input ?? payload.toolUseInput ?? null;
  const shape = describeWorkflowInput(input);
  const inSec = section('how this run was called');
  inSec.appendChild(factList([
    { label: 'input shape', value: shape.shape, source: 'the Workflow tool_use input', reason: shape.reason, note: shape.note },
    { label: shape.key ?? 'detail', value: shape.key === 'script' ? null : shape.detail, source: shape.key ? `input.${shape.key}` : null, reason: shape.reason },
  ]));
  if (shape.args !== undefined) inSec.appendChild(h('pre', { class: 'lens-json', text: safeStringify(shape.args) }));
  if (shape.shape === 'resume' && shape.detail) {
    inSec.appendChild(a(routes.workflow(slug, sid, shape.detail), `open the resumed run ${shape.detail}`));
  }
  if (payload.spawnLine) {
    inSec.appendChild(a(routes.event(slug, sid, 'main', payload.spawnLine, null), `the spawning tool_use — main line ${fmtInt(payload.spawnLine)}`));
  }
  if (payload.turnIdx !== undefined && payload.turnIdx !== null) {
    inSec.appendChild(a(routes.turn(slug, sid, payload.turnIdx), `counted in turn ${payload.turnIdx}`));
  }
  body.appendChild(inSec);

  // ---- script
  const script = payload.script ?? null;
  const scriptSec = section('script');
  if (script) {
    const src = typeof script === 'string' ? script : script.source ?? script.text ?? null;
    if (script.rel || script.path) {
      scriptSec.appendChild(factList([{ label: 'path', value: script.rel ?? script.path, source: 'workflows/scripts/' }]));
      if (script.rel) scriptSec.appendChild(a(routes.sessionFile(slug, sid, script.rel), 'raw file'));
    }
    if (src) scriptSec.appendChild(h('pre', { class: 'lens-code', text: src }));
    else scriptSec.appendChild(unknown('the script file is recorded but its source is not on this payload — open the raw file'));
  } else if (shape.shape === 'inline script') {
    scriptSec.appendChild(h('pre', { class: 'lens-code', text: String(shape.detail) }));
  } else {
    scriptSec.appendChild(unknown('no script source is recorded for this run'));
  }
  body.appendChild(scriptSec);

  // ---- phases / workflowProgress
  body.appendChild(progressSection(progress, { slug, sid }));

  // ---- agents
  body.appendChild(agentsSection(agents, recon, { slug, sid, partial, journalKnown }));

  // ---- journal
  body.appendChild(journalSection(journal, recon, { slug, sid }));

  // ---- logs + result
  const logs = payload.logs ?? manifest?.logs ?? null;
  const logSec = section('logs');
  if (logs && (Array.isArray(logs) ? logs.length : true)) {
    if (Array.isArray(logs)) {
      const box = h('div', { class: 'lens-logs' });
      for (const l of logs) {
        const at = toMs(l?.at ?? l?.timestamp);
        box.appendChild(h('div', { class: 'lens-logs__line' },
          at === null ? h('span', { class: 'lens-logs__at', text: '' }) : h('span', { class: 'lens-logs__at', text: fmtLocalTime(at) }),
          h('code', { text: typeof l === 'string' ? l : (l.message ?? safeStringify(l)) })));
      }
      logSec.appendChild(box);
    } else logSec.appendChild(h('pre', { class: 'lens-code', text: typeof logs === 'string' ? logs : safeStringify(logs) }));
  } else logSec.appendChild(unknown(partial ? 'logs are recorded in the manifest, which is written at completion only' : 'no logs recorded in this run\'s record'));
  body.appendChild(logSec);

  const result = payload.result ?? manifest?.result ?? null;
  const resSec = section('result');
  if (result === null || result === undefined) {
    resSec.appendChild(unknown(partial ? 'no result recorded yet — the run has not written its manifest' : 'no result recorded in this run\'s record'));
  } else if (typeof result === 'string') {
    resSec.appendChild(result === '' ? h('p', { class: 'lens-note', text: 'a recorded result that is genuinely empty (∅) — recorded, and empty.' }) : textBody(result, { prefKey: 'markdown.wfresult' }));
  } else {
    resSec.appendChild(h('pre', { class: 'lens-json', text: safeStringify(result) }));
  }
  body.appendChild(resSec);
}

function progressSection(progress, { slug, sid }) {
  const sec = section(`workflowProgress — ${fmtInt(progress.length)} entr${progress.length === 1 ? 'y' : 'ies'}`);
  if (!progress.length) {
    sec.appendChild(unknown('no manifest entries — workflowProgress is display metadata and is missing entirely for in-flight runs and superseded retries (SPEC §7)'));
    return sec;
  }
  const t = h('table', { class: 'lens-table' },
    h('thead', {}, h('tr', {},
      h('th', { text: 'label' }), h('th', { text: 'phase' }), h('th', { text: 'state' }), h('th', { text: 'model' }),
      h('th', { class: 'lens-table__num', text: 'attempt' }), h('th', { text: 'queued' }), h('th', { text: 'started' }),
      h('th', { class: 'lens-table__num', text: 'durationMs' }), h('th', { text: 'flags' }), h('th', { text: '' }))));
  const tb = h('tbody');
  for (const p of progress) {
    const q = toMs(p.queuedAt), st = toMs(p.startedAt);
    // The manifest spells this phaseTitle/phaseIndex, never `phase` —
    // reading the key that does not exist printed "no phase recorded" on every
    // row of every run. phaseLabelOf is the one reader (l3.mjs).
    const phase = phaseLabelOf(p);
    tb.appendChild(h('tr', {},
      h('td', { text: p.label ?? '' }, p.label ? null : unknown('no label recorded')),
      h('td', { text: phase ?? '' }, phase ? null : unknown('no phase recorded')),
      h('td', { text: p.state ?? '' }, p.state ? null : unknown('no state recorded')),
      h('td', { text: p.model ?? '' }, p.model ? null : unknown('no model recorded')),
      h('td', { class: 'lens-table__num', text: p.attempt === undefined ? '' : String(p.attempt) }),
      h('td', {}, q === null ? unknown('queuedAt not recorded') : h('span', { text: fmtLocalTime(q) })),
      h('td', {}, st === null ? unknown('startedAt not recorded') : h('span', { text: fmtLocalTime(st) })),
      h('td', { class: 'lens-table__num' }, p.durationMs === undefined || p.durationMs === null
        ? unknown('not recorded (cached replays carry no counters)') : h('span', { text: fmtDur(p.durationMs) })),
      h('td', { text: [p.cached ? 'cached' : null, p.isolation ? `isolation ${p.isolation}` : null].filter(Boolean).join(' · ') }),
      h('td', {}, p.agentId ? a(routes.agent(slug, sid, p.agentId), 'agent') : unknown('no agentId on this entry'))));
  }
  t.appendChild(tb);
  sec.appendChild(t);
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: 'workflowProgress[].tokens is a context-size gauge, not usage (about 5.6× real output) and is only ever displayed labelled "final context size"; toolCalls counters are exact (SPEC §7). Billing comes from the transcripts.',
  }));
  return sec;
}

/**
 * What a transcript that the manifest does not
 * list actually says, phrased for the run's own state.
 *
 * SPEC §7 conditions the "running — journal records a start, no result yet"
 * wording on a run that is still in flight. Shipping the journal on the
 * complete envelope (which is the fix) makes recon.running non-empty on
 * FINISHED runs for the first time, and reusing the in-flight wording there
 * would trade one false claim for another: nothing is running on a run that
 * has written its manifest. So a complete run states the recorded signature
 * and stops, naming no state at all.
 */
function orphanNoteText(recon, { partial, journalKnown }) {
  const n = fmtInt(recon.onDiskNotInManifest.length);
  const tail = 'Enumeration is the directory listing, never the manifest (SPEC §7).';
  if (!journalKnown) {
    return `${n} transcript(s) in this directory are absent from the manifest: ${recon.onDiskNotInManifest.map((x) => shortId(x, 10)).join(', ')}. This envelope does not disclose the journal, so nothing here splits them further. ${tail}`;
  }
  if (partial) {
    return `${n} transcript(s) in this directory are absent from the manifest: ${fmtInt(recon.running.length)} with a journal start and no result ("running — journal records a start, no result yet") and ${fmtInt(recon.superseded.length)} with both ("superseded attempt"). ${tail}`;
  }
  return `${n} transcript(s) in this directory are absent from the manifest: for ${fmtInt(recon.running.length)} the journal records a start and no result, and for ${fmtInt(recon.superseded.length)} it records both. This run has written its manifest, so no in-flight state is named for either group — SPEC §7 conditions that wording on a run that has not finished. ${tail}`;
}

/**
 * The reconciliation notes render even when the run directory holds no agent
 * transcript at all: the empty case skips only the TABLE build, never the
 * notes — an inManifestNotOnDisk banner computed by reconcileAgents must
 * reach the page precisely when everything is missing.
 */
function agentsSection(agents, recon, { slug, sid, partial = true, journalKnown = true }) {
  const sec = section(`agents in this run — ${fmtInt(agents.length)}`);
  if (!agents.length) {
    sec.appendChild(unknown('no agent transcript in this run directory'));
  } else {
    const t = h('table', { class: 'lens-table' },
      h('thead', {}, h('tr', {},
        h('th', { text: '' }), h('th', { text: 'label' }), h('th', { text: 'agentId' }), h('th', { text: 'model' }),
        h('th', { text: 'phase' }), h('th', { class: 'lens-table__num', text: 'depth' }),
        h('th', { text: 'first' }), h('th', { text: 'wall' }), h('th', { text: 'tags' }))));
    const tb = h('tbody');
    for (const ag of agents) {
      const gl = agentGlyph(ag);
      tb.appendChild(h('tr', {},
        h('td', { class: `lens-lane__glyph--${gl.code}`, title: `${gl.label}${gl.source ? ` · source: ${gl.source}` : ''}`, text: gl.glyph }),
        h('td', {}, a(routes.agent(slug, sid, ag.agentId), ag.label ?? ag.agentType ?? ag.agentId)),
        h('td', {}, h('code', { text: truncate(ag.agentId ?? '', 20) })),
        h('td', { text: ag.model ?? '' }, ag.model ? null : unknown('no model recorded')),
        h('td', { text: ag.phase ?? '' }, ag.phase ? null : unknown('no phase recorded')),
        h('td', { class: 'lens-table__num', text: ag.spawnDepth === null ? '' : String(ag.spawnDepth) }),
        h('td', {}, ag.firstAt === null ? unknown('this transcript records no timestamp') : h('span', { text: fmtLocalTime(ag.firstAt) })),
        h('td', {}, (ag.firstAt !== null && ag.lastAt !== null) ? h('span', { text: fmtDur(ag.lastAt - ag.firstAt) }) : unknown('a wall figure needs two recorded timestamps')),
        h('td', { text: agentTags(ag).map((x) => x.text).join(' ') })));
    }
    t.appendChild(tb);
    sec.appendChild(t);
  }

  if (recon.onDiskNotInManifest.length) {
    sec.appendChild(h('p', { class: 'lens-note', text: orphanNoteText(recon, { partial, journalKnown }) }));
  }
  if (recon.inManifestNotOnDisk.length) {
    sec.appendChild(h('p', {
      class: 'lens-note lens-note--problem',
      text: `${fmtInt(recon.inManifestNotOnDisk.length)} manifest entr${recon.inManifestNotOnDisk.length === 1 ? 'y has' : 'ies have'} no transcript in this directory: ${recon.inManifestNotOnDisk.map((x) => shortId(x, 10)).join(', ')}.`,
    }));
  }
  return sec;
}

function journalSection(journal, recon, { slug, sid }) {
  // An UNDISCLOSED journal (null) and an ABSENT one ([]) are
  // different facts and get different sentences. The old code printed the
  // absence claim for both, which made it false on 52 of the corpus's 53 runs.
  if (journal === null) {
    const sec = section('journal');
    sec.appendChild(unknown('this envelope does not disclose the journal — whether journal.jsonl exists in this run directory is not stated here'));
    return sec;
  }
  const entries = Array.isArray(journal) ? journal : (journal?.entries ?? []);
  const sec = section(`journal — ${fmtInt(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'}`);
  if (!entries.length) {
    sec.appendChild(unknown('no journal.jsonl in this run directory'));
    return sec;
  }
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: 'journal.jsonl records only {type, key, agentId[, result]} — no timestamps and no uuids. `key` ("v2:<64hex>") is not unique, so entries join to agents on agentId alone (SPEC §2).',
  }));
  const t = h('table', { class: 'lens-table' },
    h('thead', {}, h('tr', {}, h('th', { class: 'lens-table__num', text: '#' }), h('th', { text: 'type' }), h('th', { text: 'agentId' }), h('th', { text: 'result' }))));
  const tb = h('tbody');
  entries.forEach((e, i) => {
    const res = e?.result;
    tb.appendChild(h('tr', {},
      h('td', { class: 'lens-table__num', text: String(i + 1) }),
      h('td', { text: e?.type ?? '' }),
      h('td', {}, e?.agentId ? a(routes.agent(slug, sid, e.agentId), shortId(e.agentId, 12)) : unknown('no agentId on this entry')),
      h('td', {}, res === undefined ? h('span', { text: '' })
        : res === null ? unknown('result key present and null')
          : typeof res === 'string'
            ? (res === '' ? h('span', { class: 'lens-note', text: '∅ recorded and genuinely empty' }) : h('code', { text: truncate(res, 160) }))
            : h('code', { text: truncate(safeStringify(res), 160) }))));
  });
  t.appendChild(tb);
  sec.appendChild(t);
  if (recon.journal.running.length) {
    sec.appendChild(h('p', { class: 'lens-note', text: `${fmtInt(recon.journal.running.length)} agent(s) have a start with no result recorded.` }));
  }
  if (recon.journal.noAgentId) {
    sec.appendChild(h('p', { class: 'lens-note lens-note--problem', text: `${fmtInt(recon.journal.noAgentId)} journal entr${recon.journal.noAgentId === 1 ? 'y carries' : 'ies carry'} no agentId and therefore join to nothing.` }));
  }
  return sec;
}

/* ---------------------------------------------------------------- routes */

export const routeList = [['/p/:slug/s/:sid/w/:runId', renderWorkflow]];
export function register(defineRoute) {
  for (const [p, r] of routeList) {
    try { defineRoute(p, r); } catch (err) { console.error('defineRoute failed', p, err); }
  }
}
