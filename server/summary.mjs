// server/summary.mjs — parsed session -> cached SessionCard / SessionDetail
// (SPEC §9 payload shapes). TOKENS ONLY — never dollars: cost is computed at
// read time from shared/pricing.mjs, which is what makes "pricing edits never
// invalidate the cache" true.
//
// Badges are the RECORDED conditions of DESIGN §3 L1:
//   fragment  — SPEC §2 (no main transcript, or fragment dirs exist)
//   forked    — R2 group member. At summary time only the locally recorded
//               evidence is visible (foreign sessionId values inside the main
//               file — the keep-original fork). Rewrite-style fork membership
//               is an INDEX-level fact (duplicate mainMsgIds across cards);
//               the API layer must OR that in when aggregating. (integrator note)
//   no-reply  — the final turn's slice contains zero assistant message.id
//               groups (synthetic rows excluded per R4: an API error is an
//               event, not a reply)
//   retried   — a run with more journal `started` entries than manifest agents
//   running   — journal `started` without `result`
//   cached    — workflowProgress cached:true
//   live      — file growing (recorded evidence at parse time: an unterminated
//               tail; the indexer may additionally set it from observed growth)

const CARD_V = 4; // v4 (R8-PROB-1, INDEX_VERSION 5): the card carries the
// session's own `problems` list, so the store-level census survives a warm boot.
// v3 (round-1 fixes, one INDEX_VERSION bump): bucket ttlAssumed
// counts rows with cacheFlat > 0 regardless of the ttl tag (R5 disclosure follows
// the billed mass); turn/agent usage excludes synthetic rows; dupRows carry
// speedAbsent/serviceTierAbsent (pair-census fidelity). v2 added mainRel,
// r2FirstTsMs, foreignMsgIds, ledgerLite, turnBars, lastPromptCount, lostAgents.

function emptyTokens() {
  return { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };
}

function addRowTokens(t, r) {
  t.input += r.input || 0;
  t.output += r.output || 0;
  t.cache5m += r.cache5m || 0;
  t.cache1h += r.cache1h || 0;
  t.cacheFlat += r.cacheFlat || 0;
  t.cacheRead += r.cacheRead || 0;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Host-local calendar day of a ms epoch (SPEC §9 dayBands rule). Computed at
 *  index time with the host's full tz rules (DST-correct per timestamp); a
 *  system timezone CHANGE between index and read leaves cached localDates on
 *  the old zone until a reindex — disclosed here, not silently patched. */
function localDateOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function utcDateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// buildLedgerLite — SPEC §9 SessionCard.ledgerLite: exact per-session billed-
// token tallies, pricing-independent, cacheable. server/ledger.mjs
// aggregateLite() consumes it at read time; tests/index-lite.test.mjs pins
// aggregateLite(buildLedgerLite(rows)) === aggregate(rows) exactly.
//
// INTEGRATION-NOTE (dupRows rule): dupRows keeps
// EVERY main-tier row individually and buckets only agent-tier rows. R2
// duplication is only knowable at index level, and a future fork can contest
// any main msgId of an already-cached session — a bucketed main row could then
// never be re-partitioned without a re-summarise, so per-row retention of the
// main tier is the only rule that stays exact under corpus growth. Agent-tier
// rows are never contested (0 cross-file duplicates among 868 non-main files;
// resolveCanonical only ever sees mainMsgIds). Main-tier rows are ~49% of this
// corpus's ledger rows (15,298 of ~30.8k); the cache grows accordingly
// (measured at integration: index.json 0.56 MB -> 5.8 MB, buckets compress the
// agent tier to 88 entries store-wide) — accepted for exactness.
//
// Bucket key adds TWO components beyond SPEC §9's inline list (documented
// deviation): localDate (host-local day, for read-time dayBands without
// reparse) and nothing else; per-bucket values add ttlAssumed (rows actually
// billed under the 5m assumption — the ttl key alone cannot separate
// cacheFlat==0 rows) and over200k (recorded input-side >200K row count, so
// premiumUnknown resolves at read time against the CURRENT pricing set).
// ---------------------------------------------------------------------------
export function buildLedgerLite(rows, mainRel) {
  const buckets = new Map();
  const dupRows = [];
  for (const r of rows ?? []) {
    const isMain = mainRel != null && r.file === mainRel;
    if (isMain || r.file == null || r.embeddedSidechain === true) {
      // kept individually: main tier (R2-contestable), locator-less rows
      // (over-approximation, safe), and §3 embedded-sidechain rows (flag must survive)
      const slim = {
        msgId: r.msgId, model: r.model ?? null, at: r.at ?? null, line: r.line ?? null,
        speed: r.speed ?? null, serviceTier: r.serviceTier ?? null,
        speedAbsent: r.speedAbsent === true, serviceTierAbsent: r.serviceTierAbsent === true,
        ttl: r.ttl, finalized: r.finalized === true, synthetic: r.synthetic === true,
        iterIndex: r.iterIndex ?? null,
        thinkingTokens: r.thinkingTokens ?? null,
        webSearch: r.webSearch || 0, webFetch: r.webFetch || 0,
        input: r.input || 0, output: r.output || 0, cacheRead: r.cacheRead || 0,
        cache5m: r.cache5m || 0, cache1h: r.cache1h || 0, cacheFlat: r.cacheFlat || 0,
      };
      if (r.embeddedSidechain === true) slim.embeddedSidechain = true;
      dupRows.push(slim);
      continue;
    }
    const utcDate = r.at != null ? utcDateOf(r.at) : null;
    const localDate = r.at != null ? localDateOf(r.at) : null;
    const finalized = r.finalized === true;
    const synthetic = r.synthetic === true;
    const key = JSON.stringify([r.model ?? null, r.speed ?? null, r.serviceTier ?? null, utcDate, localDate, finalized, synthetic, r.ttl ?? null]);
    let b = buckets.get(key);
    if (!b) {
      buckets.set(key, b = {
        model: r.model ?? null, speed: r.speed ?? null, serviceTier: r.serviceTier ?? null,
        utcDate, localDate, finalized, synthetic, ttl: r.ttl ?? null,
        requests: 0, tokens: emptyTokens(),
        thinking: { tokens: 0, recordedOn: 0, notRecordedOn: 0 },
        webSearch: 0, webFetch: 0,
        neverFinalizedOutput: 0, ttlAssumed: 0, over200k: 0,
      });
    }
    b.requests += 1; // row count; synthetic buckets map to the synthetic counter at read time
    addRowTokens(b.tokens, r);
    if (r.thinkingTokens == null) b.thinking.notRecordedOn += 1;
    else { b.thinking.tokens += r.thinkingTokens; b.thinking.recordedOn += 1; }
    b.webSearch += r.webSearch || 0;
    b.webFetch += r.webFetch || 0;
    if (!finalized && !synthetic) b.neverFinalizedOutput += r.output || 0;
    // R5 — same predicate as aggregate(): every row with cacheFlat > 0 is
    // billed under the 5-minute assumption, whatever the line-level ttl tag
    // says (hybrid R3 rows: split at top level, flat-only element).
    if ((r.cacheFlat || 0) > 0) b.ttlAssumed += 1;
    if (((r.input || 0) + (r.cache5m || 0) + (r.cache1h || 0) + (r.cacheFlat || 0) + (r.cacheRead || 0)) > 200000) b.over200k += 1;
  }
  return { v: 1, buckets: [...buckets.values()], dupRows };
}

export function summarise(sessionModel, ledgerRows, fingerprint) {
  const m = sessionModel;
  const main = m.main;
  const turns = main?.turns ?? [];
  const realTurnCount = Math.max(0, turns.length - 1);
  const openerLines = turns.filter((t) => !t.preamble).map((t) => t.openerLine);
  const haveLedger = Array.isArray(ledgerRows);
  const rows = haveLedger ? ledgerRows : [];

  const turnOfLine = (line) => {
    let idx = 0;
    for (let i = 0; i < openerLines.length; i++) {
      if (openerLines[i] <= line) idx = i + 1; else break;
    }
    return idx;
  };
  const agentTurnByRel = new Map();
  for (const a of m.agents) agentTurnByRel.set(a.rel, a.turnIdx);

  // ---- token sums (as-recorded; R2 canonicality is NEVER persisted — the
  //      aggregator derives billed/inherited over the whole index at read time)
  const usageByModel = haveLedger ? {} : null;
  const turnUsage = haveLedger ? turns.map(() => emptyTokens()) : null;
  const agentUsage = haveLedger ? new Map() : null; // rel -> Tokens
  let unattributedUsage = null;
  const lastOpenerLine = openerLines.length ? openerLines[openerLines.length - 1] : null;
  const lastTurnMsgIds = new Set();

  if (haveLedger) {
    for (const r of rows) {
      if (!r.synthetic) {
        // model key: '(unrecorded)' sentinel for a model-less row — never the
        // JS-artifact string "undefined" (same sentinel as aggregate()).
        const mk = typeof r.model === 'string' ? r.model : '(unrecorded)';
        let u = usageByModel[mk];
        if (!u) { u = emptyTokens(); usageByModel[mk] = u; }
        addRowTokens(u, r);
      }
      if (main && r.file === main.rel) {
        // synthetic rows bill nothing anywhere (R4) — cached turn usage must
        // agree with the read-time turn aggs, which exclude them.
        if (!r.synthetic) addRowTokens(turnUsage[turnOfLine(r.line)], r);
        if (lastOpenerLine != null && r.line >= lastOpenerLine && !r.synthetic && r.msgId) {
          lastTurnMsgIds.add(r.msgId);
        }
      } else if (agentTurnByRel.has(r.file)) {
        if (!r.synthetic) {
          let u = agentUsage.get(r.file);
          if (!u) { u = emptyTokens(); agentUsage.set(r.file, u); }
          addRowTokens(u, r);
          const ti = agentTurnByRel.get(r.file);
          if (ti != null && ti < turnUsage.length) addRowTokens(turnUsage[ti], r);
          else {
            if (!unattributedUsage) unattributedUsage = emptyTokens();
            addRowTokens(unattributedUsage, r);
          }
        }
      } else if (!r.synthetic) {
        if (!unattributedUsage) unattributedUsage = emptyTokens();
        addRowTokens(unattributedUsage, r);
      }
    }
  }

  // ---- session bar (SPEC §4 bounds ledger): min over turn/agent bar starts,
  //      max over turn/agent bar ends (agents overhang turns 100% of the time
  //      for async spawns — never bound an agent bar by the parent)
  let startedAt = null;
  let endedAt = null;
  const consider = (ts, isStart) => {
    if (ts == null) return;
    if (isStart) { if (startedAt === null || ts < startedAt) startedAt = ts; }
    else if (endedAt === null || ts > endedAt) endedAt = ts;
  };
  for (const t of turns) {
    if (!t.preamble) { consider(t.at, true); consider(t.endAt ?? t.at, false); }
  }
  for (const a of m.agents) { consider(a.firstAt, true); consider(a.lastAt, false); }

  // ---- badges ------------------------------------------------------------
  const badges = [];
  if (main === null || (m.fragmentDirs?.length ?? 0) > 0) badges.push('fragment');
  const otherSessionIds = (m.inventory.sessionIdsSeen ?? []).filter((sid) => sid !== m.id);
  if (otherSessionIds.length > 0) badges.push('forked');
  // Documented risk (accepted): when haveLedger is false the no-reply badge is
  // UNKNOWABLE, not absent — production always supplies the ledger, so the
  // exposure is stub/test paths only; a ledger-less production path would need
  // a badgesUnknown disclosure here before shipping.
  if (haveLedger && realTurnCount > 0 && lastTurnMsgIds.size === 0) badges.push('no-reply');
  if (m.workflows.some((w) => w.record && w.journal
    && w.record.progressAgentCount != null && w.journal.startedCount > w.record.progressAgentCount)) {
    badges.push('retried');
  }
  if (m.workflows.some((w) => w.running) || m.agents.some((a) => a.state === 'running')) badges.push('running');
  if (m.agents.some((a) => a.stateFacts?.cached)) badges.push('cached');
  if (m.live) badges.push('live');

  const inv = m.inventory;
  const meta = main?.meta ?? null;
  const totalRows = (main?.rows.length ?? 0) + m.agents.reduce((n, a) => n + (a.counts?.rows ?? 0), 0);

  // ONE session problem list, built once and shared by the card and the
  // detail. The card must carry it (or a warm boot, where cards are restored
  // from cache and nothing is reparsed, has no census at all), and
  // usage-reconcile must be raised HERE, not by each indexer separately — the
  // store census and the session's own payload have to be the same array or
  // they are two computations free to disagree.
  const sessionProblems = [...(inv.problems ?? [])];
  if (haveLedger && (ledgerRows.usageIntViolations ?? 0) > 0) {
    sessionProblems.push({
      code: 'usage-reconcile', severity: 'warning', scope: 'session',
      slug: m.slug, id: m.id,
      message: `${ledgerRows.usageIntViolations} usage counter(s) were present but not integers — billed 0 for those counters (never silently coerced).`,
      affects: 'aggregates', count: ledgerRows.usageIntViolations,
    });
  }

  const card = {
    v: CARD_V,
    slug: m.slug,
    id: m.id,
    fingerprint,
    state: main === null ? 'fragment' : (badges.includes('live') ? 'live' : 'ok'),
    title: meta?.customTitle?.value ?? meta?.aiTitle?.value ?? null,
    aiTitle: meta?.aiTitle?.value ?? null,
    customTitle: meta?.customTitle?.value ?? null,
    cwd: meta?.cwd ?? null,
    version: meta?.version ?? null,
    entrypoint: meta?.entrypoint ?? null,
    branch: meta?.gitBranch ?? null,
    startedAt,
    endedAt,
    otherSessionIds,
    bytes: m.bytes ?? null,
    files: m.files ?? null,
    lines: m.lines ?? 0,
    events: inv.counts.events,
    rows: totalRows,
    toolCalls: inv.counts.toolCalls,
    images: inv.counts.images,
    thinkingChars: inv.counts.thinkingChars,
    textChars: inv.counts.textChars,
    usageByModel, // tokens only; null = ledger not supplied (unknown, never 0)
    mainMsgIds: meta?.msgIds ?? [],
    mainRel: main?.rel ?? null, // R2 clause (iii) backstop wants the real rel, not a reconstruction
    r2FirstTsMs: meta?.r2FirstTsMs ?? null, // R2(ii): first FILE-ORDERED record carrying a ts (SPEC §9)
    foreignMsgIds: meta?.foreignMsgIds ?? [], // R2(i) evidence (SPEC §9; 185 corpus-wide)
    ledgerLite: haveLedger ? buildLedgerLite(rows, main?.rel ?? null) : null, // null = unknown, never an empty tally
    turnBars: turns.filter((t) => !t.preamble).map((t) => ({ idx: t.idx, at: t.at ?? null, endedAt: t.endAt ?? null })),
    // INTEGRATION-NOTE: turnBars on the card is additive to SPEC §9's SessionCard
    // list — /api/index promises turnBars[] at index level, and with read-time
    // aggs coming from ledgerLite nothing else forces a session parse, so the
    // bars must ride the cached card or L0 would be dark until a drill.
    lastPromptCount: meta ? (meta.lastPrompt?.count ?? 0) : null, // real 0 when a main exists; null when it does not
    lostAgents: m.journalOnly.length, // census, expected 0 (journal starts with no transcript on disk)
    turnCount: realTurnCount,
    agentCount: m.agents.length,
    workflowCount: m.workflows.length,
    badges,
    // Additive to SPEC §9's SessionCard list, and CACHE-ONLY — the API's
    // cardOut (server/api/index-view.mjs) strips it from /api/index's
    // sessions[] the same way it strips ledgerLite and the msgId sets. It is
    // here so the store-level problems census survives a warm boot instead of
    // silently reading zero.
    problems: sessionProblems,
  };

  // ---- detail ------------------------------------------------------------
  const agentsByTurn = new Map();
  const workflowsByTurn = new Map();
  for (const a of m.agents) {
    const k = a.turnIdx;
    let list = agentsByTurn.get(k);
    if (!list) { list = []; agentsByTurn.set(k, list); }
    list.push(a.agentId);
  }
  for (const w of m.workflows) {
    // The run rides its OWNING turn (turn of the FIRST spawning call) AND
    // every turn that resumes it — the resuming turn needs the run in its
    // workflowRunIds to render the link-only reference row; the workflow
    // object's own turnIdx says which turn counts it (SPEC §7).
    const turnsFor = new Set([w.turnIdx, ...(w.resumedInTurns ?? [])]);
    for (const k of turnsFor) {
      let list = workflowsByTurn.get(k);
      if (!list) { list = []; workflowsByTurn.set(k, list); }
      list.push(w.runId);
    }
  }

  const detailTurns = turns.map((t) => {
    let promptHead = null;
    const kinds = {}; // row-kind counts over the turn's MAIN-THREAD rows (composition bar, SPEC §3 vocabulary)
    if (t.rowRange && main) {
      for (let i = t.rowRange[0]; i <= t.rowRange[1]; i++) {
        const r = main.rows[i];
        if (!r) continue;
        kinds[r.kind] = (kinds[r.kind] || 0) + 1;
        if (!t.preamble && promptHead === null && r.line === t.openerLine && r.kind === 'prompt') promptHead = r.head;
      }
    }
    return {
      idx: t.idx,
      preamble: t.preamble,
      at: t.at,
      endedAt: t.endAt,
      openerLine: t.openerLine ?? null, // 1-based; the API partitions main-thread billed rows on opener boundaries
      promptHead,
      kinds,
      usage: turnUsage ? turnUsage[t.idx] : null,
      agentIds: agentsByTurn.get(t.idx) ?? [],
      workflowRunIds: workflowsByTurn.get(t.idx) ?? [],
    };
  });

  // L2 marker lane (DESIGN §3): queue-ops, system events, denials, edited
  // files — all from recorded main-thread rows, {at, kind, line} per SPEC §9.
  const markers = [];
  if (main) {
    for (const r of main.rows) {
      if (r.kind === 'queue-operation' || r.kind.startsWith('system:')) {
        markers.push({ at: r.at, kind: r.kind, line: r.line });
      } else if (r.kind === 'tool_result' && r.extra && r.extra.denial) {
        markers.push({ at: r.at, kind: 'denial', line: r.line });
      } else if (r.kind === 'tool_use' && r.extra
        && (r.extra.tool === 'Edit' || r.extra.tool === 'Write' || r.extra.tool === 'NotebookEdit')) {
        markers.push({ at: r.at, kind: 'edit', line: r.line });
      }
    }
  }

  // images: locator list, never pixels (SPEC §9 SessionDetail).
  const detailImages = inv.images.map((im) => ({
    file: im.file,
    line: im.line,
    bi: im.bi,
    // DECODED bytes, not base64 chars: 44,128 chars is a 33,095-byte JPEG, so
    // shipping the char count under a field named `bytes` (and rendered
    // through fmtBytes at L2/inventory) would overstate every image by ~33%.
    // null = the reader could not attribute a stripped span to this block,
    // never 0.
    bytes: im.bytes ?? null,
    b64Chars: im.b64Length ?? null, // the recorded base64 length itself
    source: im.bi === 'r' || im.bi.startsWith('r.') ? 'toolUseResult' : (im.bi.includes('.') ? 'tool_result' : 'content'),
    mediaType: im.mediaType ?? null,
    twin: im.twin === true,
  }));

  // filesLedger: recorded sources per SPEC §8, grouped by (path, tier) with
  // per-op counts from the recorded tool names.
  const filesByKey = new Map();
  for (const f of inv.filesLedger) {
    const key = `${f.tier}\u0000${f.path}`;
    let e = filesByKey.get(key);
    if (!e) filesByKey.set(key, e = { path: f.path, tier: f.tier, reads: 0, writes: 0, edits: 0, searches: 0, sidecar: 0 });
    if (f.op === 'read') e.reads += 1;
    else if (f.op === 'write') e.writes += 1;
    else if (f.op === 'edit') e.edits += 1;
    else if (f.op === 'search') e.searches += 1;
    else if (f.op === 'sidecar') e.sidecar += 1;
  }

  const detailAgents = m.agents.map((a) => ({
    agentId: a.agentId,
    rel: a.rel,
    runId: a.runId,
    kind: a.lineage?.kind ?? null,
    // The RECORDED spawn edge, flattened to the field names the drill views
    // read. Omitting these breaks the recorded-edges guarantee AT THE PAYLOAD
    // LAYER: the client would classify a fully-resolved plain/child agent as
    // "no recorded spawn edge" (walkthrough 2026-08-17, session c4412635 —
    // the parse-level resolver was correct all along).
    toolUseId: a.lineage?.toolUseId ?? a.meta?.toolUseId ?? null,
    parentAgentId: a.lineage?.parentAgentId ?? a.meta?.parentAgentId ?? null,
    depth: a.meta?.spawnDepth ?? null,
    spawnDepth: a.meta?.spawnDepth ?? null,
    agentType: a.meta?.agentType ?? null,
    metaModel: a.meta?.model ?? null, // bare alias (opus/sonnet/fable/haiku), never a full id
    models: a.models, // recorded message.model values from its own transcript
    resolvedModel: a.resolvedModel,
    progressModel: a.progress?.model ?? null, // may carry the [1m] suffix — recorded fact
    label: a.label,
    tag: a.tag,
    state: a.state, // incl. 'superseded' (recorded signature, SPEC §7)
    stateFacts: a.stateFacts,
    // L3 lane-tag facts, flattened (— cached / ⌂ worktree):
    cached: a.stateFacts?.cached === true,
    worktreePath: a.meta?.worktreePath ?? null,
    spawnedWithWorktree: a.meta?.spawnedWithWorktree === true ? true : (a.meta?.spawnedWithWorktree ?? null),
    isolation: a.progress?.isolation ?? null,
    attempt: a.progress?.attempt ?? null,
    phaseIndex: a.progress?.phaseIndex ?? null,
    phaseTitle: a.progress?.phaseTitle ?? null,
    turnIdx: a.turnIdx,
    attributedBy: a.attributedBy,
    spawnLine: a.lineage?.spawnLine ?? null,
    firstAt: a.firstAt,
    lastAt: a.lastAt,
    queuedAt: a.progress?.queuedAt ?? null,
    startedAtRecorded: a.progress?.startedAt ?? null,
    durationMs: a.progress?.durationMs ?? null,
    counts: a.counts,
    usage: agentUsage ? (agentUsage.get(a.rel) ?? emptyTokens()) : null,
  }));

  const detail = {
    ...card,
    // SPEC §3's seven metadata types are all parsed (parse.mjs), and the
    // mode / pr-link / frame-link facts must reach a payload — otherwise the
    // client's facts strip prints "no mode event recorded" on sessions that DO
    // record one while the inventory census on the same page counts it: a
    // positive false denial of a recorded fact.
    //
    // They ride the DETAIL, never the card: cards are serialised into
    // index.json and restored verbatim, so a card field would be present on
    // freshly-parsed sessions and absent on cache-restored ones inside one
    // /api/index response unless INDEX_VERSION is bumped. detail is rebuilt on
    // every read, which is the same discipline
    // ledgerLite/problems/images/filesLedger already use.
    //
    // COUNTS ARE MANDATORY, not decoration: prLinks/frameLinks DEDUPE their
    // items but COUNT every event (parse.mjs) — one live session is 36
    // pr-link events over 1 unique PR — so shipping items alone would swap the
    // false denial for a 36→1 understatement.
    //
    // `meta ? … : null` throughout, matching lastPromptCount one field up: a
    // real 0 when a main tier exists, null (unknown) when it does not. A
    // fragment session (main === null) has never been parsed for metadata, and
    // `?? 0` / `?? []` there would assert a recorded zero that nothing recorded.
    mode: meta ? (meta.mode?.value ?? null) : null,
    modeCount: meta ? (meta.mode?.count ?? 0) : null,
    prLinks: meta ? (meta.prLinks?.items ?? []) : null,
    prLinkCount: meta ? (meta.prLinks?.count ?? 0) : null,
    frameLinks: meta ? (meta.frameLinks?.items ?? []) : null,
    frameLinkCount: meta ? (meta.frameLinks?.count ?? 0) : null,
    // Collateral in the same seam: sessionFacts() asks for these two by name
    // and neither was shipped, so both title count chips were silently dropped
    // (silence about a recorded fact — the lesser sibling of the above).
    aiTitleCount: meta ? (meta.aiTitle?.count ?? 0) : null,
    customTitleCount: meta ? (meta.customTitle?.count ?? 0) : null,
    turns: detailTurns,
    agents: detailAgents,
    workflows: m.workflows.map((w) => ({ ...w })),
    journalOnly: m.journalOnly,
    markers,
    images: detailImages,
    filesLedger: [...filesByKey.values()],
    inventory: {
      perType: inv.perType,
      attachmentKinds: inv.attachmentKinds,
      counts: inv.counts,
      filesLedgerDenominators: inv.filesLedgerDenominators,
      spillCounts: {
        refs: inv.spills.length,
        files: inv.spillFiles.length,
        unreferenced: inv.spillFiles.filter((s) => !s.referenced).length,
      },
      unattributedUsage, // null when none (real zero renders 0 only when recorded)
    },
    problems: sessionProblems, // the SAME array the card carries — one census, two payloads
  };

  return { card, detail };
}
