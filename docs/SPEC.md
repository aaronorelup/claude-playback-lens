# Claude Playback Lens — SPEC (normative)

This document is the build contract: the on-disk format facts the app relies on,
the accounting rules (R-numbered, cited in UI disclosure text), and the API
contract. Every fact here was **measured on a real ~1 GB corpus** by the
research fleet. The distilled research digest quotes that private corpus, so
it is maintainer-local and not tracked (`docs/research/_digest.md`,
gitignored); citations like "gap-2 §6.2" or "timing-order §2" are provenance
labels naming its source reports. Re-derivation scripts live in
`docs/research/scripts/` and run against any local corpus (set
`LENS_CORPUS`). Where something is not measured it is marked
UNKNOWN and the code must degrade gracefully, never guess. This revision
incorporates the validated findings of the design critique fleet
(3 critics + 3 validators, 54 findings, 2026-08-17).

House rules, inherited from the owner and binding on every module:

1. **No inference.** The app shows recorded fields and arithmetic on them. The
   few unavoidable judgment calls are numbered rules (below) and each prints
   its rule at the point of use.
2. **Exactness.** Aggregates at every level sum consistently by construction,
   and the audit page proves it by recomputation.
3. **An unknown renders as `—` with a reason; a real zero renders as `0`.**
   Never the same glyph. A missing rate is never $0.

---

## 1. Reading files (the reader contract)

- **Split lines on `\n` only.** Never `node:readline` — it also splits on raw
  U+2028/U+2029, which are legal inside JSON strings and present in this corpus
  (12+ occurrences); readline manufactures parse failures in a corpus that has
  **zero** genuinely torn lines. Trailing `\r` is stripped if present (none
  observed). Reference implementation: `docs/research/scripts/lib-lines.mjs`.
- **Hold back the unterminated tail.** Bytes after the final `\n` are not
  parsed (live files are appended in whole lines; a prefix is a valid
  transcript).
- **Strip base64 before `JSON.parse`.** `"data":"<500+ b64 chars>"` and
  `"base64":"<...>"` payloads are replaced with `""`, lengths recorded per
  block. Images are 61.7% of corpus bytes; thinking `signature` values (another
  4.5%) are dropped from the parsed model (presence + length kept).
- **A line that fails `JSON.parse` is counted, located (file, line, byteOffset,
  bytes) and skipped** (a `torn-line` Problem, §9). It contributes zero
  everywhere and appears in the inventory. Expected count on this corpus: 0.
- Progress is measured in **bytes consumed**, not lines (line sizes vary 9x).
- Max observed line 1.37 MB; buffers must tolerate ~2 MB lines routinely.
- Files start with `{` (no BOM observed); tolerate and count a BOM if present.
- **Line numbers are 1-based everywhere they are shown, routed, or stored** —
  the ledger, `#/…/e/<line>`, `/api/line`, `/api/lines`, `/api/image`, raw-view
  highlights, copy-locator, and audit evidence links — "as an editor shows it".
  0-based indexing exists only as an internal array index inside
  `server/jsonl.mjs`, which performs the single conversion.

## 2. The store layout (all 10 patterns, verified exhaustive)

```
<projectsDir>/<project-slug>/
  <sessionId>.jsonl                                        main transcript
  <sessionId>/subagents/agent-<agentId>.jsonl              plain (Agent-tool) agent
  <sessionId>/subagents/agent-<agentId>.meta.json          its sidecar (100% coverage)
  <sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl      workflow agent
  <sessionId>/subagents/workflows/<runId>/agent-<agentId>.meta.json  its sidecar
  <sessionId>/subagents/workflows/<runId>/journal.jsonl    started/result events only
  <sessionId>/workflows/<runId>.json                       orchestration record (written at COMPLETION only)
  <sessionId>/workflows/scripts/<name>-<runId>.js          workflow script source
  <sessionId>/tool-results/<name>                          spilled results (6 naming families)
  memory/*.md                                              project memory (frontmatter may carry originSessionId)
```

- IDs: sessionId = lowercase UUIDv4; agentId = `a` + 16 lowercase hex,
  globally unique in this corpus (821/821); runId = `wf_<8hex>-<3hex>`.
- The main transcript may be a **minority of a session's bytes** (as low as
  1%); agent transcripts are ~50% of the corpus. Never treat the main file as
  "the session".
- **Fragment dirs** — a `<sessionId>/` dir with no sibling `.jsonl` (3 cases
  here, all containing only workflow scripts). Rules:
  (a) A session is keyed by sessionId alone; a fragment dir whose sessionId
  HAS a main `.jsonl` elsewhere in the store unions into that session — its
  files (including any `agent-*.jsonl`, which enumerate and bill normally
  under §7 and R1–R9) belong to that session, at that session's project.
  Billing fragments locally would split one session across two projects and
  break parent = Σ children at L1. (b) A truly orphaned fragment (no main
  `.jsonl` anywhere in the store) is assigned to the project dir that
  physically holds it, disclosed as "fragment, no main transcript", and
  counted in the inventory denominator. (c) "zero tokens" applies only when
  the fragment contains no usage-bearing transcripts; the badge states which
  case applies. Measured: all 3 fragments here are case (a) with zero
  transcripts; sessions demonstrably get deleted (18 of 71 memory
  originSessionIds dangle), so case (b) is a live possibility, never a crash.
- **Project identity**: the slug is a lossy encoding of `cwd`
  (`[\\/:. ]` → `-`; note SPACE is included). The display label is the recorded
  `cwd` value that re-encodes exactly to the dir name (verified 22/22 dirs,
  85/85 sessions). Projects with no transcripts keep the raw slug and say so
  (2 of 27 dirs are memory-only and unlabellable — show the raw slug + why).
  `cwd` is per-event and can vary within a session (up to 14 values) — the
  label rule uses the encoding match, not the modal value. Never derive a
  project from an *agent's* cwd (worktrees would invent phantom projects).
- Session → project = the dir holding the main `.jsonl` (85/85 unique), with
  fragment rule (b) above as the explicit fallback for orphans.
- `journal.jsonl` holds only `{type:'started'|'result', key, agentId[, result]}`,
  no timestamps, no uuids. `key` ("v2:<64hex>") is NOT unique — join on
  agentId only.
- meta.json keys: `agentType` (100%; values incl. capitalised `Plan`,
  `Explore` — do not case-normalise), `spawnDepth` (100%; observed 1,2),
  `model` (83%; bare aliases opus/sonnet/fable/haiku, never full IDs),
  `description` + `toolUseId` (plain agents only, 143/143), `parentAgentId`
  (exactly the spawnDepth-2 agents, 91/91), `worktreePath` +
  `spawnedWithWorktree` (9, workflow only; all 9 in one measured run;
  9/9 paths outside the store and now deleted — displayed at L4 with a
  "path not on disk" annotation, and as an L3 lane tag).

## 3. Event shapes (what the parser must handle)

- **Main files** carry 11 event types: `assistant`, `user`, `last-prompt`,
  `ai-title`, `attachment`, `custom-title`, `mode`, `queue-operation`,
  `system`, `pr-link`, `frame-link`. **Agent files carry exactly 3**:
  `assistant`, `user`, `attachment`. Journals carry `started`/`result`.
  Unknown future types must surface (inventory + raw view), never crash.
- 7 metadata types (`last-prompt`, `ai-title`, `custom-title`, `mode`,
  `queue-operation`, `pr-link`, `frame-link`) have **no uuid, no version**;
  4 of them also have **no timestamp** (`last-prompt`, `ai-title`,
  `custom-title`, `mode`) — placeable by file order only. They are *state
  snapshots*, massively duplicated (one file rewrites the same ai-title
  168×): display the latest value + a count, never a timeline row per
  occurrence (except queue-operation, which is a real timeline event).
  Measured volume: pr-link 239 events in 10 files ({prNumber, prRepository,
  prUrl}); frame-link 14 events in 2 files ({frameUrl, path, title});
  last-prompt 4,647 events in 85/85 files, `leafUuid` resolving 100%
  in-file. All seven render on the L2 session facts row (DESIGN §3).
- One assistant API response is written as **one content block per line**
  (66,137 of 66,162 lines carry exactly one block), all lines repeating
  `message.usage`. `message.id` groups them (up to 26 lines).
- `isSidechain` is `true` on 100% of agent-file events and on 0 main-file
  events in this corpus. Old-style embedded sidechains: ABSENT here, tolerate
  if seen — `isSidechain:true` runs in a main file are foreign rows,
  excluded from turn billing, surfaced in inventory, and their usage
  accumulates in the disclosed `embeddedSidechain` CostAgg channel (§9) so
  session = Σ turns + channels still holds exactly.
- `user` content is a string OR an array (blocks: `text`, `image`,
  `tool_result`). `tool_result.is_error` is TRI-STATE (absent 71% / false 25%
  / true 3.7%) — only `=== true` is an error. `toolUseResult` (the rich
  sidecar) is polymorphic: object / array / bare string (string form = always
  a failure text). It exists on ~100% of main-file tool results but only ~3%
  of agent-file ones — agent rendering must not depend on it.
- Compaction markers: ABSENT in this corpus (verified with positive
  controls). Parser tolerates unknown types/keys as a matter of course.
- `system` subtypes: `stop_hook_summary`, `api_error` (fractional
  `retryInMs`), `model_refusal_fallback` (carries `originalModel`,
  `fallbackModel`, `retractedMessageUuids` — which resolve to nothing in this
  corpus; display, don't act).
- `attachment.type`: 20 observed kinds; unknown kinds render as
  pretty-printed JSON, never dropped.
- Timestamps: 100% ISO-8601 `...sss Z` (ms precision). **File order is a
  topological order of the uuid DAG** (0 violations) but NOT timestamp order
  (2,779 inversions, two benign mechanisms). Row order = file order, always.
  Timestamps are UTC; the UI displays local time (host timezone).
- The uuid DAG per main file: exactly 1 root, 0 dangling parents, branches
  are parallel tool calls (max out-degree 2), no conversation forks.

### Row-kind vocabulary (closed; drives `?k`, composition bars, kind chips)

```
prompt, text, thinking, tool_use, tool_result, image, fallback,
attachment:<type>, system:<subtype>, queue-operation, unknown:<type>
```

Measured basis: 11 main-file event types, 4 assistant block types (text,
thinking, tool_use, fallback — `fallback` has 2 occurrences, tied to the
refusal-fallback messages), 20 attachment kinds, 3 system subtypes. `?k` is a
comma-separated subset matched on the prefix before `:` (so `k=attachment`
selects all attachment kinds, `k=system` all subtypes); unknown values in `k`
are preserved and ignored. The L2 composition bar and the L3 kind chips count
exactly these kinds and share one legend.

## 4. Turns (rule R-T, prints in UI)

> **R-T:** A turn opens at a `user` event where `origin.kind === 'human'`,
> OR where `origin` is absent and the content is a string starting with
> `<command-message>` (a slash-command invocation, which is a real prompt).
> Everything before the first opener is the preamble (turn 0). A turn runs to
> the next opener or end of file.

- Do NOT use `typeof content === 'string'` as the discriminator: 20 human
  turns have array content (pasted image + text).
- Do NOT count origin-less string user events as turns (all 73 are slash
  scaffolding: `<command-name>`, `<local-command-stdout>`,
  `<local-command-caveat>` etc.). The old "absent origin = turn" fallback
  adds phantom turns and is retired.
- `origin.kind === 'human'` includes scheduled-task (cron) sessions — a
  recorded fact; the turn card shows the `<scheduled-task>` opener as-is.
- Verified: this rule partitions 100.00% of main-file DAG nodes; 372 turns
  in this corpus (median 3, p90 9, max 24).
- `last-prompt` events are chain-tip checkpoints (~12.5 per turn), NOT
  turns; `leafUuid` always resolves within the file (53 forward-references —
  resolve after the full pass, not eagerly).

### Turn addressing

`turns[0]` is always the preamble (`preamble: true`); real turns occupy
`idx` 1..N. **`idx` is the sole addressable index** and is what both
`#/…/t/<idx>` and `/api/turn/:slug/:id/:idx` carry; `/api/turn` returns 404
for `idx > turns.length-1`. There is no separate `n` field — the display
label for a real turn IS its `idx`, and the preamble card is labelled
"preamble", not a number. (372 openers + a preamble in all 85 files = 457
array elements.)

### Turn time windows (total; used only for orphan-agent fallback, §7)

Turn N's time window is `[its opener's timestamp, the next opener's
timestamp)`; the last turn's window extends to +∞; anything before the first
opener belongs to turn 0 (the preamble). The fallback is therefore total.
Opener timestamps are verified non-decreasing in file order (372/372 openers
carry a timestamp, 0 inversions between consecutive openers), which makes
these intervals well-formed; if a future transcript has a non-monotonic
opener pair, clamp each window start to the running maximum of prior opener
timestamps and record it in the audit's ordering census. An orphan starting
before the first opener lands in the greyed turn-0 card (disclosed).

### Time-bounds ledger (normative; DESIGN §2's ⓘ popover renders this table)

| Bar kind | Starts at | Ends at |
|---|---|---|
| Turn bar (L0/L1/L2) | opener event's timestamp | max timestamp over the turn's **conversation rows only** — assistant and user rows, **excluding** queue-operation, system, attachment, and isMeta rows (timing-order §2: this collapses 972 backward steps corpus-wide to 12; naive last-event rules inherit skew up to ~10 h) |
| Turn hatched extension (agents overhang) | turn end | max over attributed agents' own transcript last timestamps (the §7 agent-span rule — `startedAt`/`endedAt` keys DO NOT EXIST on events; zero occurrences in 946 files) |
| Agent bar (L3/L4) | first timestamp of its own transcript | last timestamp of its own transcript |
| Agent queued segment | `workflowProgress[].queuedAt` | `workflowProgress[].startedAt` (drawn only when recorded — 648 entries) |
| Session bar | min over its turn/agent bar starts | max over its turn/agent bar ends |

Header **`span`** at session/project/store level = max(ts) − min(ts) over the
scope's bars; a second explicitly-labelled **`active`** figure = the length of
the union of the scope's turn and agent intervals (pure interval arithmetic
on recorded spans). The header cell at L3/L4 may read `wall` for a single
bar's extent; at L2 and above the cell is `span` with `active` beside it.
A bar with fewer than two recorded timestamps renders `—` with a reason.

## 5. The request ledger (the atom of cost)

One **billed row** per API response. Construction rules:

- **R1 — per-file dedupe.** Group assistant lines by `message.id` (fallback
  `uuid` — occurs only for `<synthetic>`); keep the **last line** in file
  order. Verified: last ≡ max-output on 30k/30k groups; all input-side
  counters (`input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `ephemeral_5m/1h`) and `model` are byte-identical
  across lines of a group — only `output_tokens`/`thinking_tokens`/`stop_reason`
  progress, and the last line holds the final values.
- **R2 — canonical copy across files.** Forks/resumes copy prefix events into
  the new file (7 pairs / 11 files here, of which pairs 5–7 form one 3-file
  chain; 6 of 7 REWRITE the copied events' `sessionId`, 1 keeps the
  original). A duplicated `message.id` is billed once, in its canonical file
  (only MAIN-file rows are contestable — the aggregator never routes a
  `subagents/` row to the inherited channel, so the full and lite paths
  coincide structurally, not just empirically):
  **(i)** the copy whose main filename equals the copy's own `sessionId` when
  only one does; else **(ii)** the copy in the file whose **FIRST RECORD IN
  FILE ORDER THAT CARRIES A `timestamp`** is earliest — the four
  untimestamped metadata types (last-prompt, ai-title, custom-title, mode)
  are skipped, never treated as 0 or NaN. This is deliberately NOT the
  minimum timestamp over the file: in a resumed file the minimum is an
  inherited timestamp and ties, destroying the discriminator (gap-2 §6.2;
  measured margins under this rule: 48s to 12h22m, all strictly positive; 5
  of 85 main files open with an untimestamped custom-title and would
  evaluate `undefined` under a naive first-record reading). **(iii)** On an
  exact tie, the lexicographically smallest relative file path (gap-2's own
  deterministic backstop; never reached here: 0/505). Verified: resolves
  1,841/1,841 uuids and 505/505 message.ids, 0 ambiguous; the tie case is
  counted in the audit's R2 ambiguity census (expected 0). Non-canonical
  copies still display (rows, text) but carry `billedElsewhere: {sessionId}`
  and contribute to a disclosed `inherited` channel, not to billed totals. A
  session whose file is 100% copies bills $0 and says why (real zero).
  Detection = cross-file duplicate `message.id` within the store index (the
  cached `mainMsgIds` sets, §9 — duplication exists ONLY between main files;
  0 among the 868 non-main files). **The R2 canonicality decision is never
  persisted**: `billedElsewhere`, the `inherited` channel and every billed
  CostAgg are derived in the aggregator over the whole loaded index at read
  time; a session's billed CostAgg is only defined against a complete index.
  While `status.state === 'building'`, R2 figures are provisional for EVERY
  session (`status.r2 = 'pending'`, and the `aggScope` denominator says how
  much of the store they cover); a session participating in an
  ALREADY-DETECTED duplicate group additionally flags
  `agg.inheritedPending: true`. A partnership with a session that has never
  been indexed is undecidable before that session is parsed — no code can
  flag it specifically; the denominator is that disclosure.
- **R3 — iterations override.** If `usage.iterations` is a **non-empty
  array**, the billed row(s) come from its elements — one row per element.
  Field provenance (measured: elements carry exactly input_tokens,
  output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  cache_creation{5m,1h}, type, plus model on 20 of 48k):
  **from the element** — input, output, cacheRead, cache5m, cache1h,
  cacheFlat, model (= `element.model ?? message.model`; fallback messages
  carry a refused first call on another model that exists nowhere else);
  **from the kept line (R1)** — msgId, at, file, line, iterIndex, stopReason,
  thinkingTokens, webSearch, webFetch, ttl, synthetic, billedElsewhere,
  speed, serviceTier. When `iterations.length > 1`, the line-level scalars
  (thinkingTokens, webSearch, webFetch) attach to the **final** element's row
  — the call whose numbers the recorded top-level usage reports (gap-3 §6;
  stated rule, since the top-level usage on a fallback message is a measured
  inconsistent merge) — with webSearch/webFetch **0** on the other rows (a
  real zero) and thinkingTokens **null** (not recorded per iteration);
  stopReason and ttl copy to every element (line properties). Measured
  exposure: 10 lines / 2 messages corpus-wide, none carrying thinking or
  server-tool counts — forward-compat, not a correction. This override
  repairs the `5m+1h === flat` identity corpus-wide (0 breaks after; 10
  lines / 2 messages before). If `iterations` is absent (streaming-only
  groups) or empty, bill from the top-level usage fields. Audit asserts
  Σ per-row webSearch (and webFetch) over a split group equals the group's
  top-level count.
- **R4 — `<synthetic>`.** `usage.iterations === null` is the exact
  discriminator (28/28; message.id is a UUID not `msg_*`). Synthetic events
  bill nothing (usage is all-zero), are excluded from per-model billing
  groups, do NOT count in `CostAgg.requests` (they appear only in the
  `synthetic: n` counter and as rendered events), and render as events (API
  errors, limit notices).
- **R5 — cache TTL.** Price `ephemeral_5m_input_tokens` at 1.25× input rate
  and `ephemeral_1h_input_tokens` at 2× input rate. The split is recorded on
  100% of lines in all 8 harness versions here. If a foreign transcript ever
  carries only the flat `cache_creation_input_tokens`, bill it at the
  5-minute rate, tag `ttl:'unrecorded'`, count it in `ttlAssumed`, and
  disclose the exact dollar delta if 1h had applied (chip + panel; expected
  0 on this corpus — its absence is not a bug). `ttlAssumed` counts every
  billed row with `cacheFlat > 0` REGARDLESS of the line-level ttl tag: an R3
  element without its own 5m/1h split falls back to its flat counter and is
  billed at the 5-minute assumption even when the line-level usage carried a
  split (hybrid rows) — the disclosure follows the billed mass, not the tag.
  (Measured tier pattern, display-worthy: main threads write 100% 1-hour
  cache; agent tiers 100% 5-minute.)
- **R6 — never-finalized responses.** Single predicate, used everywhere:
  `finalized ≙ Array.isArray(usage.iterations) && usage.iterations.length > 0`
  (gap-3: a non-null stop_reason is NOT sufficient — one measured 2.1.209
  message group carries stop_reason `end_turn` with an EMPTY iterations
  array and a stub output_tokens of 3 for 3,566 chars).
  `neverFinalized` ≙ billed rows with `!finalized && !synthetic` (the
  synthetic guard is required: `Array.isArray(null) === false`). Expected
  census here: **1,584 canonical rows** — 1,583 stop_reason-null agent-tier
  groups + that one main-tier empty-array group (its fork duplicate removed
  by R2). Their recorded `output_tokens` are stubs (median shortfall ~99.5%
  vs finalized siblings; recorded stub mass 11,747 output tokens). Bill the
  recorded numbers, count the rows in the `neverFinalized` disclosure at
  every level with the recorded mass labelled as recorded (never as the
  exposure), and never estimate the missing output.
- **R7 — unpriced models.** A model with no rate for the row's resolved
  (modelKey, speed, serviceTier, at) contributes its tokens to a parallel
  `unpriced` channel, never $0, never blended. The badge propagates to every
  ancestor aggregate. Legacy 3.x coverage is deliberately partial: rows
  exist for haiku-3-5 / haiku-3 / sonnet-3-7; `claude-3-opus-*` and
  `claude-3-5-sonnet-*` fall to this channel cleanly (unit-tested).
- **R8 — server tools.** `server_tool_use.web_search_requests` bills at
  $10/1,000 (= exactly 1 cent/request) when nonzero (0 in this corpus);
  `web_fetch_requests` is free. Both counts display when present.
- **R9 — speed / service tier.** `usage.speed` and `usage.service_tier` are
  recorded price discriminators (fast mode on opus-5/opus-4-8 is a published
  2× tier, $10/$50). Resolution: `speed` absent-as-key or null resolves to
  `'standard'` (measured: absent occurs on exactly the 1,593 never-finalized
  billed lines, where the key is a finalization marker, not a tier signal;
  null|null occurs on exactly the 28 synthetic rows R4 already excludes);
  `service_tier` null resolves to `'standard'`. The rate lookup is keyed on
  (modelKey, resolvedSpeed, resolvedServiceTier, at). Shipped tier rates:
  the documented pair only — opus-5 and opus-4-8 at speed `fast` → $10/$50.
  Do NOT pre-ship a batch rate (unobserved, unverifiable in transcripts).
  Any resolved pair not in the table routes to R7's unpriced channel with
  chip text naming the tier. Parse-time assertion: every resolved pair
  observed is either in the table or counted unpriced. The audit reports
  the (speed, service_tier) pair census with this corpus's expected values:
  `standard|standard` 28,998 · `null|null` 28 · `ABSENT|standard` 1,593.
  Rows priced at standard rates whose RAW tier strings were absent/null are
  NOT flagged; a row with a recognized non-standard pair (e.g. fast) prices
  at its tier rate; `tierAssumed` counts only rows where a non-standard,
  non-null raw value was priced at standard sticker rates as a fallback
  (expected 0 here) — mirrored by a chip and audit line.
- **R10 — rate intervals.** Every model's rate is a list of
  `{effectiveFrom, effectiveTo, input, output}` intervals; a billed row
  resolves its rate from its own recorded `at` (arithmetic on a recorded
  field; R3 split rows inherit the kept line's `at`). Interval dates are
  **UTC calendar days** of the row's recorded `at` (dayBands are host-local
  days — a row can sit in local band 08-31 yet price under the 09-01
  interval; both are exact on their own axis). A row with **no recorded
  `at`** resolves only against a model whose rate is a single all-time
  interval; otherwise it routes to R7. The earliest interval
  of every model is open-ended backwards (`effectiveFrom: null`) so history
  never falls into a hole; a row with no covering interval routes to R7.
  The cost panel prints the resolved interval (`tokens × rate (in effect
  2026-06-01..2026-08-31)`); Settings lists all intervals read-only. Audit
  asserts every billed row's `at` falls inside exactly one interval for its
  priced model.
- **Long context:** every model with any >200K-context request in this
  corpus (fable-5 6,865 / opus-5 4,846 / sonnet-5 547 / opus-4-8 60 msgs
  measured) has published pricing covering the full 1M window at standard
  rates, so no long-context premium applies to them. The one other model
  present, haiku-4-5 (claude-haiku-4-5-20251001, 87 lines / 31 messages),
  has a 200K context window and cannot exceed 200K at all (measured: 0 of
  31). Disclosure rule: a billed row on a model OUTSIDE that verified set
  whose measured input+cacheCreation+cacheRead > 200,000 is priced at
  standard rates and counted in a `premiumUnknown` census (audit's >200K
  report + chip) — distinct from R7: a rate exists and is applied, only the
  tier is unknown. The `[1m]` suffix appears only in
  `workflowProgress[].model` / `toolUseResult.resolvedModel` (216 recorded
  instances), never in `message.model`; displayed as a recorded fact,
  priced identically.
- `output_tokens_details.thinking_tokens` exists only on harness ≥2.1.229
  (7.6% of lines). Display it where recorded; render `—` (not 0) elsewhere,
  always as a covered fraction (`X thinking tokens recorded on A of B rows ·
  C rows do not record it (pre-2.1.229 harness, or a non-final row of an R3
  split — R3 sets thinkingTokens null on non-final elements by rule)`),
  never a bare scalar.

### Billed-row shape

```js
{ msgId, model,            // raw string as recorded
  input, output, cacheRead, cache5m, cache1h, cacheFlat,   // integers
  thinkingTokens: n|null,  // null = not recorded (pre-2.1.229 / non-final split row)
  webSearch: n, webFetch: n,
  speed: string|null,      // raw recorded value; null when absent (R9 resolves)
  serviceTier: string|null,
  speedAbsent: bool, serviceTierAbsent: bool, // recorded ABSENT-vs-null distinction
                           // (feeds §10's (speed, service_tier) pair census from Path A)
  stopReason, at,          // ts of the kept line (ms epoch)
  file, line,              // locator of the kept line (1-based line, as an editor shows it)
  ttl: 'recorded'|'unrecorded',
  finalized: bool,         // R6 predicate: iterations non-empty array
  synthetic: bool,
  billedElsewhere: null | { sessionId },   // R2 non-canonical copies
  iterIndex: n|null }      // R3: which iterations element, when split
```

The ledger stores **tokens only, never dollars** — cost is computed at read
time from the pricing module, so pricing edits never invalidate the cache.
`CostAgg.requests` counts billed rows with `synthetic === false`; Path A,
Path B, the audit's row-count reconciliation and the UI footnote all use this
definition (the §10 reference figure 29,741 is on this basis; the ~26
synthetic ledger rows are reported separately in the inventory).

## 6. Pricing (single source of truth: `shared/pricing.mjs`)

USD per 1,000,000 tokens, Anthropic first-party metered ("sticker") rates.
Sources: https://platform.claude.com/docs/en/about-claude/pricing (retrieved
2026-08-17) cross-checked against the Anthropic model reference (which states
sonnet-5's $2/$10 as an intro price through 2026-08-31, superseding this
spec's earlier "made permanent" note — the corpus, 2026-07-07..2026-08-17,
sits entirely inside the intro window, so present totals are identical under
both readings). `PRICING_VERSION = '2026-08-17'` renders in the footer and
every arithmetic panel. Not editable in the UI — editing is a code change.

Rates are interval lists (R10). Single-interval rows are written once:

| key (normalised) | input | output | notes |
|---|---|---|---|
| fable-5 / mythos-5 | 10 | 50 | |
| opus-5 / opus-4-8 / opus-4-7 / opus-4-6 / opus-4-5 | 5 | 25 | |
| opus-5 @ speed=fast / opus-4-8 @ speed=fast | 10 | 50 | R9; research-preview tier, documented |
| opus-4-1 / opus-4 | 15 | 75 | legacy |
| sonnet-5 (…→2026-08-31) | 2 | 10 | intro interval (open-ended backwards) |
| sonnet-5 (2026-09-01→…) | 3 | 15 | post-intro interval |
| sonnet-4-6 / sonnet-4-5 / sonnet-4 / sonnet-3-7 | 3 | 15 | |
| haiku-4-5 | 1 | 5 | |
| haiku-3-5 | 0.80 | 4 | legacy |
| haiku-3 | 0.25 | 1.25 | legacy |

Multipliers: cache write 5m = 1.25×input; 1h = 2×input; read = 0.1×input.
Web search $0.01/request exactly.

**modelKey(raw)** normalisation: strip `claude-` prefix, `[1m]` suffix,
`-YYYYMMDD` date suffix; then reorder genuine 3.x ids, which name version
before family — rewrite `/^3(-(\d))?-(haiku|sonnet|opus)$/` to
`<family>-3[-<sub>]` (3-5-haiku → haiku-3-5, 3-haiku → haiku-3,
3-7-sonnet → sonnet-3-7; anchored on leading `3`, cannot touch 4.x+ keys).
Module-load unit cases: `claude-3-5-haiku-20241022` → haiku-3-5,
`claude-3-haiku-20240307` → haiku-3, `claude-3-7-sonnet-20250219` →
sonnet-3-7, plus `claude-3-opus-20240229` → opus-3 and
`claude-3-5-sonnet-20241022` → sonnet-3-5, which have no rows and must fall
to R7 cleanly. Raw string preserved on every row and shown in breakdowns.

**Money is exact integer arithmetic.** Unit: **rate unit = 1/20 cent per
Mtok** (scale 20 = lcm of the ×0.1 and ×5/4 multipliers' denominators, so
every effective rate derived from any integer-cent — even half-cent — base
rate stays integral; haiku-3 = 500 units, read 50, 5m 625, 1h 1000). Cost
accumulates as integer `tcu = rateUnits × tokens`; **USD = tcu / 2e9**;
a web-search request adds exactly 2e7 tcu. Module-load assertion: every
effective rate (base ×1, ×1.25, ×2, ×0.1) across ALL intervals including
legacy rows is an integer in rate units — a future rate that breaks this
fails loudly at import, not silently at runtime. JS safe-integer range
covers 2^53/2e9 ≈ $4.5M, ~500× this corpus; the audit asserts non-overflow.
Rounding happens only at display.

**Display rule** (house rule 3 applied to money): exact zero renders `0`
(never `$0.0000`; reachable — session 4219546d is 100% inherited and bills a
real $0); any nonzero value below the display threshold renders `<$0.0001`
(measured unreachable on this corpus: 0 of 30,587 billed rows — robustness
only); `—` stays reserved for unknown; four decimals otherwise. Sum-check
footnotes compare exact integer tcu, never rendered strings, and are
labelled "totals are exact; rows shown rounded to 4 dp".

## 7. Agents: enumeration, lineage, attribution

- **Enumeration** = the directory listing: every `subagents/**/agent-*.jsonl`
  is an agent (821/821 here; the transcript's own `agentId` field always
  equals the filename stem, and its `sessionId` equals the session dir).
  `workflowProgress` is display metadata, NOT the enumeration source — it
  misses in-flight runs and superseded retries entirely, and lists
  `cached:true` agents WITHOUT tokens/toolCalls/durationMs (three different
  failure modes; 30 agents ≈ 11.4% of workflow-tier output would vanish).
- **Lineage (recorded, three edges):**
  1. workflow agents → their `<runId>` dir → the `Workflow` tool_use in the
     owning session's main transcript whose `toolUseResult.runId` (or
     tool_result text) names it. `Workflow.input` has FIVE shapes (inline
     script, scriptPath, registered `{name}`, `{args,name}`, resume) — never
     assume `script ?? scriptPath`. A running workflow has agents + journal
     but no `wf_*.json` yet (its `…/w/<runId>` page renders a partial
     envelope from journal + script + transcripts, labelled from the run dir
     name — `workflowName` is manifest-only). `resumeFromRunId`
     (input shape five) mutates the same run dir in place.
  2. plain agents → `meta.toolUseId` → the `Agent` tool_use with that id
     (143/143).
  3. depth-2 agents → `meta.parentAgentId` → parent agent in the same dir
     (91/91); depth = `meta.spawnDepth`, trusted (validated 821/821).
- **Attribution scoping (invariant):** an agent is attributed only within
  the session whose directory tree holds its transcript (the enumeration
  source; 0 non-main files carry a foreign sessionId). Its spawning
  tool_use / runId is looked up among THAT session's rows only. A
  fork-copied spawn line in another session is an R2 non-canonical copy and
  never claims agents (measured instance: runId wf_b15c6aed-d1e is named by
  tool_results in both 1596079c and 8d63f339 while its ~80 agents live only
  under 8d63f339). **Every agent belongs to exactly one turn of exactly one
  session**; the audit asserts Σ agents over all turns == the enumerated
  count (821 here).
- **Turn attribution:** an agent belongs to the turn containing its spawning
  tool_use line (transitively for depth ≥2). **A resumed workflow run
  belongs to the turn of its FIRST spawning call**, and every agent stays
  with the turn of the call that actually created its transcript — so
  `cached:true` replays remain in the original turn (measured on a real
  resume: the same workflow id is named from two different turns' lines,
  and gap-5's run arithmetic already resolved to the first call). The resuming turn renders the run as a link-only reference
  row with zero tokens, a `resumed here` fact and a `counted in turn N`
  chip, so its rows still sum to its header. For an agent with no recorded
  spawn edge (journal-only orphans), fall back to the turn whose time window
  (§4, total) contains the agent's first timestamp, and say so (rule
  prints). The fallback never fires on this corpus (821/821 via recorded
  edges).
- **Agent spans:** first/last timestamp of its own transcript. There are no
  recorded `startedAt/endedAt` fields on events; `workflowProgress` carries
  `queuedAt/startedAt/durationMs` for its 658 entries (display; hatched
  queued segment only when recorded). **Manifest timestamps are bare
  epoch-millisecond NUMBERS** (`"queuedAt": 1786090380798` — 686 of 696
  `workflow_agent` entries numeric, 0 string), unlike transcript event
  `timestamp`s, which are ISO-8601 strings corpus-wide. One reader per rule:
  the manifest reader accepts both shapes, the event reader stays strict, so
  a stray number can never become a §4 turn bound. Async agents outlive the parent's
  tool_result 100% of the time — never bound an agent bar by the parent.
- **Labels** (all recorded, show source): `workflowProgress.label` ▸
  `[AGENT: x]` prompt tag ▸ Agent `input.description` ▸
  `meta.description` ▸ `<agentType> <id>`. Label and tag legitimately differ
  (per-item vs per-role) — L4 header shows both when both exist.
- **Phases** are recorded as `workflowProgress[].phaseTitle` (+ `phaseIndex`),
  with matching `{type:'workflow_phase', index, title}` entries — never under
  a key called `phase` (696 of 696 `workflow_agent` entries carry phaseTitle,
  0 carry phase). One reader spells that alias for the whole app; a second
  spelling is how the run page's phase column, the session agents table and
  the named `?group=phase` grouping all went dark at once.
- Agent files: exactly one real (non-isMeta) prompt each; `origin.kind`
  `peer`/`coordinator` messages are continuations (SendMessage), and
  `origin.senderTaskId` names another agent (sibling edges — display as
  facts on the timetable, no graph inference).
- **Agent states for display** (recorded signatures, named by fact not
  diagnosis): manifest `workflowProgress[].state` gives `done` (650) /
  `error` (8); journal `started` with no `result` while the session is live
  = "running — journal records a start, no result yet" (distinct `⋯ running`
  glyph; when no manifest exists the glyph source is the journal, never
  workflowProgress); journal `started`+`result` but absent from the manifest
  = "superseded attempt". Both wordings are conditioned on a run still in
  flight: on a run that has written its `wf_*.json`, a transcript the manifest
  does not list states its recorded signature ("the journal records a start
  and no result", or "both") and names no state — nothing is running there.
  `cached:true` = listed in the manifest without
  counters, lane-tagged `— cached` ("replayed from an earlier attempt of
  this run"), billed from its transcript in its original turn. `∅ no-result`
  is reserved for a recorded result that is genuinely empty.
- `<usage>subagent_tokens: N</usage>` footers and `workflowProgress[].tokens`
  are **context-size gauges, not usage** (5.6× real output) — displayable
  only with the label "final context size". `toolCalls` counters are exact.
  `toolUseResult.totalTokens` (sync Agent calls) = final-turn in+cc+cr+out.

## 8. Spills, images, memory, file paths

- Spill references, five recorded forms (build sweep 2026-08-17 found two
  beyond the original research three): `<persisted-output>` banner inside
  tool_result text (59) — regex-extract the absolute path; structured
  `toolUseResult.persistedOutputPath` (6); `[Binary content (mime, size) also
  saved to <abspath>]` (16); `Output has been saved to <path>` (oversize MCP
  results) and `full HTML saved to <path>` (artifact fetches) — together the
  `saved-to` form (6 files would otherwise falsely list unreferenced). Link
  rule is exact-match only; an unreferenced spill file lists as "not
  referenced from any transcript" (0 here) and stays viewable. Sniff content type (10 of 55 `.txt` files contain JSON).
- Images: 4 JSON paths, 2 shapes. Counts by path: `message.content[i]` 36;
  `message.content[i].content[j]` (inside tool_result) 2,573;
  `toolUseResult[j]` 22; `toolUseResult.file.base64` 862 (NO media_type —
  sniff magic bytes). 859 lines carry the same image twice (tool_result
  block + sidecar, SHA-verified identical) — render once, note the twin.
  `/api/image` re-reads the line and decodes on demand.
- **Block locator `bi` is a dotted path string, not an integer** (a single
  integer addresses only 36 of 3,493 image blocks): `<i>` for
  `message.content[i]`; `<i>.<j>` for `message.content[i].content[j]`; `r`
  for the `toolUseResult` object form; `r.<j>` for `toolUseResult[j]`.
  Applied identically in the L5 route `e/<line>[.<bi>]` and
  `/api/image?…&block=<bi>` (`block` is a string). When twins exist,
  `e/<line>.<i>.<j>` addresses the tool_result-block copy and `e/<line>.r`
  the sidecar; L5 renders the block copy and prints the sidecar as a noted
  twin. The hash router splits `e/<line>` and the block path on the first
  `.` only after the line number.
- **Files-view sources (L2 `?v=files`)**: paths come from `tool_use.input`
  keyed BY TOOL NAME — Read/Write/Edit → `file_path` (8,238 main / 7,902
  agent occurrences), NotebookEdit → `notebook_path` (0 here; tolerate),
  Glob/Grep → `path` (437 main / 634 agent) — unioned with
  `toolUseResult.filePath` (main tier only, 5,634 records).
  Read/write/edit classification comes from the recorded tool `name`.
  Free-form path-shaped keys inside StructuredOutput/MCP tool inputs
  (files_written, report_path, brief_file, report_file, doc_path,
  fragmentPath, chartPath, postPath, retrospectivePath — 140 occurrences)
  are payload fields, NOT file operations — excluded. The view itself
  carries the denominator ("paths from N main-thread and M agent tool
  calls; K agent tool results carry no path sidecar").
- Memory files: parse YAML frontmatter for `metadata.originSessionId`
  (71/90); link when it resolves, say "session not on disk" when it dangles
  (18 dangle; 1 resolves into a different project dir — cross-link).

## 9. Server architecture

Dependency-free Node ≥18 ESM. Modules:

```
lens.mjs                     entry: args, config, port probe, worker, browser open
server/config.mjs            config load/save (atomic), dir validation
server/scan.mjs              fs walk → FileTable {rel,size,mtimeMs} + grouping (70ms)
server/jsonl.mjs             \n-only reader, offset tables, readLineAt, stripBase64 (owns the 0↔1-based line conversion)
server/parse.mjs             events → session model (rows keep head ≤220ch + locator, no long text)
server/ledger.mjs            assistant lines → billed rows (R1–R10)
shared/pricing.mjs           interval rate table + modelKey + tcu cost() (imported by server, served to client)
server/summary.mjs           parsed session → cached SessionCard/SessionDetail (tokens only)
server/index-store.mjs       index.json load/save (atomic, debounced), fingerprints
server/indexer.worker.mjs    worker thread: scan+parse+summarise, MRU-first
server/lru.mjs               parsed-session LRU
server/api.mjs               routes, envelopes, problems
server/audit.mjs             independent flat rescan (Path B) + invariants (SSE)
server/find.mjs              corpus substring/regex scan, SSE
server/static.mjs http.mjs errors.mjs
web/  (vanilla ESM SPA — see DESIGN.md)
start.bat  start.sh  README.md
```

### Cache & liveness

- Fingerprint = sha1 over the session's whole file tree `(rel, size,
  mtimeMs)`, sorted. Cache: `index.json` (~5.8 MB measured — ledgerLite
  dupRows ≈5.2 MB + `mainMsgIds` ≈0.47 MB + summaries; the earlier ~1.1 MB
  figure predates the exact-under-forks dupRows decision) in `<app>/.cache/`
  (fallback `%LOCALAPPDATA%`, override `LENS_CACHE_DIR`); tokens only;
  `indexVersion` bump invalidates all. Never write into the projects folder.
- **Atomic write** = write `<name>.tmp-<pid>-<rand>` in the same directory,
  fsync, then rename over the destination. On EPERM/EBUSY/EACCES (routine on
  win32 when a scanner or editor holds the destination) retry 3× with 50 ms
  backoff, then `unlink(dest)` + rename; on final failure emit a
  `cache-write-failed` Problem and keep serving from memory — a cache that
  cannot be written must never take down a server that is already correct. A
  corrupt/unparseable index.json on read is deleted and rebuilt.
- **The intermediate file is per-write, never a fixed `<name>.tmp`** (R9-F1).
  Two processes sharing one cache dir — the default for two instances of one
  install, since the already-running guard is keyed on port alone — otherwise
  open the same tmp path with `'w'` and interleave, and the winning rename
  publishes a spliced file: invalid JSON at rest in the destination, plus an
  ENOENT storm on the losing renames (ENOENT is not retryable, so the ladder
  never engages). The cost of unique names is litter — a crash between open and
  rename now leaves a distinct orphan instead of one reusable file — so the
  owner of the writer **sweeps `<name>.tmp-*` older than 6 h at boot**.
- **A cache dir belongs to one running instance.** Writes are collision-safe,
  but two instances still double the scan and overwrite each other's cache;
  point the second at its own `LENS_CACHE_DIR`. Deleting the cache file is
  gated on evidence: if `index.json` CHANGED between the read and the delete
  (stat before/after — size, mtime, inode), it is a torn snapshot of a file
  that may be healthy now, so it is **kept** and disclosed as `cache-busy`
  rather than deleted and misreported as `cache-corrupt`.
- Cold build ≈ 5s measured for 1.15GB; worker builds most-recently-modified
  first; **a session appears in the index only when fully summarised, and
  every aggregate ships its denominator** ("totals over 61 of 85 sessions").
- Liveness: re-scan (stat walk) every 5s while visible; on change mark
  sessions stale and show a Reload bar — never re-render under the reader.
- **LRU**: key = `` `${slug}/${id}@${fingerprint}` `` (a changed session
  misses naturally — no explicit invalidation). Size proxy (an estimate,
  not measured heap): `sizeBytes = Σ(row.head.length) × 2 + rows × 120 +
  offsetTableBytes` (offset tables are retained with the entry and counted).
  Budget: 8 entries / 96 MB — both can bind (§11 caps a parsed session at
  ~10 MB).
- jsonl.mjs line-offset tables (14 KB / 38 MB file, <1 ms seek-read) are
  retained alongside the LRU entry and are what `/api/line`, `/api/lines`
  and `/api/image` seek against — one `/api/line` call on a non-resident
  session builds one offset table, never rescans 38 MB.

### Security & config

- Bind 127.0.0.1 only + Host-header check, PLUS a cross-site request gate:
  a drive-by page on another origin reaches 127.0.0.1 with the browser
  setting `Host` itself, so requests whose `Sec-Fetch-Site` is neither
  `same-origin` nor `none`, or whose `Origin` is not a local address, are
  403 (`cross-site-forbidden`); non-browser clients carry neither header and
  stay allowed. Every response carries `X-Content-Type-Options: nosniff`.
  `/api/file`·`/api/image`·
  `/api/lines` paths must resolve inside projectsDir AND be present in the
  current FileTable (403 otherwise).
- **`rel` grammar**: POSIX-separated (`/`), relative to the SESSION
  directory. FileTable keys are normalised to POSIX separators at scan time
  and compared case-insensitively on win32. Cross-project fragment files use
  the explicit form `frag/<otherSlug>/<relpath>` (2 sessions span 2–3
  project dirs); project-level files (memory) use `mem/<name>` with `id`
  omitted — `..` is never accepted.
- Port probe `/api/hello` → focus existing instance on double-click-twice.
- The URL printed at startup (and handed to `--open`) is built from
  `server.address().port` **after** the bind, never from the requested port:
  `--port 0` / `PORT=0` asks the OS for an ephemeral port, and printing the
  requested `0` names an address nothing is listening on (R10-F1).
- Config resolution: `--projects` → `CLAUDE_PROJECTS` → config.json →
  `~/.claude/projects`; winner printed at startup and shown in the UI.
  **The winner is fixed for the life of the process.** Saving a new
  `projectsDir` through `PUT /api/config` rewrites config.json only; the
  running indexer, and the path-containment guards above, keep the directory
  the process started with until it is restarted — and a `--projects` /
  `CLAUDE_PROJECTS` in force outranks the saved value across a restart too. The
  API and the settings page state both facts rather than implying a live swap
  (R10-F2).
- `start.bat`: `cd /d "%~dp0"` (the `/d` matters — install paths can cross
  drives and contain spaces, e.g. `…\My Projects\Claude Playback Lens`),
  `where node` guard with plain-language message, every path passed to node
  quoted, window stays open, `if errorlevel 1 pause`.

### Payload shapes (normative)

`Tokens = { input, output, cache5m, cache1h, cacheFlat, cacheRead }` —
the one token object, used at every level. cacheFlat is 0 across all 8
harness versions here (foreign-transcript channel; R5).

```js
CostAgg = {
  requests,                     // billed rows with synthetic === false (R4)
  tokens: Tokens,
  usd: { input, output, cacheWrite, cacheRead, webSearch, total },  // integer tcu at source
  // usd.cacheWrite = 5m + 1h + cacheFlat-priced-at-5m-rate (R5)
  thinking: { tokens, recordedOn, notRecordedOn },  // covered fraction; never a bare scalar
  unpriced:  { [model]: { requests, tokens: Tokens } },        // R7
  inherited: { [sessionId]: { requests, tokens: Tokens } },    // R2 copies billed elsewhere
  embeddedSidechain: { requests, tokens: Tokens },             // §3 foreign rows (0 here)
  neverFinalized: n,  synthetic: n,  ttlAssumed: n,            // R6 / R4 / R5
  tierAssumed: n,  premiumUnknown: n,                          // R9 / long-context
  neverFinalizedOutput: n,   // recorded stub output-token mass on R6 rows (chip wording; recorded, not an estimate)
  ttlDeltaTcu: n,            // exact tcu delta if 1h had applied to ttlAssumed rows (R5's promised disclosure)
  webSearchRequests: n, webFetchRequests: n, // R8 METRICS (like `requests`, Σ over billed rows) —
                             // not disclosure counters, so the drift rule's chip+census requirement does not attach
  byModel: { [raw]: CostAggLite } }

CostAggLite = { requests, tokens: Tokens, usd: { total } }
```

Adds component-wise; parent = Σ children **by construction** (partition:
store → project → session → turn; agents whole within a turn; main-thread
rows by kept-line position; R2 canonical copies). Every disclosure counter
CostAgg carries has exactly one chip in DESIGN §1 and one audit census —
a new counter requires both (drift rule).

```js
SessionCard = {           // per-session element of /api/index
  v, slug, id, fingerprint, state,       // state: 'ok'|'live'|'fragment'|'pending'
  title, aiTitle, customTitle, cwd, version, entrypoint, branch,
  startedAt, endedAt, otherSessionIds,   // cross-project fragments
  mainRel,                               // projectsDir-relative path of the main transcript
                                         // (`<slug>/<id>.jsonl`), or null when the session is
                                         // fragment-only. R2 clause (iii) wants the RECORDED rel,
                                         // never a reconstruction. Survives cardOut → /api/index ships it
  bytes, files, lines,
  events, rows, toolCalls, images, thinkingChars, textChars,
  usageByModel,                          // tokens only
  mainMsgIds: [],                        // main-tier message.id list (R2 detection; gap-2 §5: main-only suffices)
  r2FirstTsMs,                           // ts of the FIRST file-ordered record carrying one (R2 clause ii evidence)
  foreignMsgIds: [],                     // msgIds whose recorded per-event sessionId ≠ filename id (R2 clause i evidence; 185 corpus-wide)
  ledgerLite,                            // see below — exact CostAgg at index level without reparse
  turnCount, agentCount, workflowCount, lastPromptCount, lostAgents /*census, expected 0*/,
  badges }                               // fragment/forked/no-reply/retried/running/cached/live

// LedgerLite: per-session billed-token tallies, pricing-independent, cached.
// dupRows: EVERY MAIN-TIER row kept individually ({msgId, model, at, line,
//   speed, serviceTier, speedAbsent, serviceTierAbsent, ttl, finalized,
//   synthetic, iterIndex, thinkingTokens, webSearch, webFetch, tokens…};
//   locator-less rows and §3 embedded-sidechain rows are also kept, flags
//   intact). Rationale: R2 duplication is a store-level fact and a FUTURE fork
//   can contest ANY cached main msgId without changing this session's
//   fingerprint — per-row retention of the main tier is the only rule that
//   stays exact under corpus growth (bucketing only currently-duplicated ids
//   is not incrementally correct).
// buckets: AGENT-TIER rows only (never contested — resolveCanonical sees
//   mainMsgIds alone), tallied by (rawModel, speedRaw, serviceTierRaw,
//   utcDate(at), localDate(at) /*host-local day for read-time dayBands*/,
//   finalized, synthetic, ttl); each bucket carries { requests, tokens: Tokens,
//   thinking:{tokens,recordedOn,notRecordedOn}, webSearch, webFetch,
//   neverFinalizedOutput /*recorded stub output mass*/,
//   ttlAssumed /*rows billed under the 5m assumption — cacheFlat>0*/,
//   over200k /*recorded input-side >200K row count, so premiumUnknown resolves
//   at read time against the CURRENT pricing set*/ }.
// Rates apply at read time per bucket date (intervals are date-granular, R10), so
// pricing edits never invalidate the cache. INDEX_VERSION bumps when this shape changes.
// Cache size: ~5.8 MB measured on this corpus (dominated by per-row main-tier
// retention, ~340 B/row; buckets compress the agent tier to 88 entries
// store-wide) — accepted for exactness; grows linearly with main-tier rows.

SessionDetail = SessionCard + {
  turns: [ { idx, preamble, at, endedAt, promptHead, usage /*Tokens*/,
             kinds /*row-kind counts for the composition bar*/,
             agentIds, workflowRunIds } ],
  agents: [ … incl. per-agent usage ], workflows: [ … ],
  markers: [ {at, kind, line} ],         // queue-ops, system events, denials, edited files (L2 marker lane)
  images: [ {file, line, bi, bytes, b64Chars, source, mediaType, twin} ], // locators only, never pixels
  //   bytes    = DECODED size of the payload the reader stripped (§1), null when
  //              no stripped span is attributable to that block address — never 0.
  //   b64Chars = the recorded base64 length itself. The two differ by ~33%
  //              (44,128 chars is a 33,095-byte JPEG), so `bytes` is what L2's
  //              contact sheet and the inventory render through fmtBytes and
  //              `b64Chars` is what L5 prints as the recorded length.
  filesLedger: [ {path, reads, writes, edits, tier} ], // recorded sources per §8
  turnBars: [ {idx, at, endedAt} ],      // this session's turn bounds (§4). DETAIL ONLY:
                                         // the cached card carries it, and cardOut strips it
                                         // for /api/index alongside ledgerLite/mainMsgIds/
                                         // foreignMsgIds. Distinct from the index-level
                                         // turnBars below, which additionally carry {slug, id}.
  journalOnly: [ {runId, agentId, startedCount, hasResult} ],
                                         // workflow-journal agents with no transcript in the
                                         // run directory — the evidence behind the lostAgents
                                         // census (§7); [] is a real, provable none

  // §3's seven metadata types, latest value + EVENT count. DETAIL ONLY — the
  // card is serialised into index.json and restored verbatim, so putting these
  // on it would need an INDEX_VERSION bump; the detail is rebuilt on every read.
  mode, modeCount,                       // latest recorded mode + how many mode events
  prLinks: [ {prNumber, prRepository, prUrl} ],   frameLinks: [ {frameUrl, path, title} ],
  prLinkCount, frameLinkCount,           // items are DEDUPED; the counts are every event
                                         // (one corpus session: 36 pr-link events, 1 PR)
  aiTitleCount, customTitleCount,        // the two title types' event counts
  //   All eight are null — unknown, never 0/[] — when the session has no main
  //   tier (state:'fragment'), because nothing was ever parsed for metadata.
  //   The client MUST distinguish null (this payload says nothing) from a
  //   recorded 0/[] (this file records no such event); only the latter licenses
  //   "no pr-link event recorded".

  inventory counts, problems: [Problem] }

Problem = {               // promoted from the (retired) arch brainstorm
  code,                   // closed enum below; unknown codes render as the raw string
  severity: 'error'|'warning'|'note',
  scope: 'store'|'project'|'session'|'file'|'line',
  slug?, id?, agentId?, runId?,
  file?, line?, byteOffset?, bytes?,
  message,
  affects: 'aggregates'|'display'|'nothing',   // the load-bearing field
  count }                 // identical code+scope records collapse to one row carrying count

Problem codes: dir-unreadable, file-unreadable, torn-line, unknown-event-type,
unclassified-file, session-fragment, session-duplicate-id, model-unpriced,
cache-ttl-unrecorded, tier-assumed, usage-reconcile, indexer-crashed,
cache-corrupt, cache-busy, cache-write-failed, worker-exit, prefix-only,
dangling-origin-session, unreferenced-spill, duplicate-message-id,
bom-stripped, day-span-capped.

Store-scope `problems[]` on `/api/index` is a **current-state census, not a
log**: every session's contribution is replaced wholesale on each (re)parse, so
a condition that stops holding drops out on the next parse, and re-parsing an
unchanged condition does not inflate `count`. `worker-exit` is likewise derived
from live worker state, never appended per crash. The 200-record cap is applied
after the fold, so no amount of re-parsing can evict a still-true record.
```

### API

All failures return `{ error: { code, message, detail? } }` as JSON; no 2xx
response ever carries an `error` key (advisories ride `problems[]`).
Status table: **400** malformed param / unparseable scope · **403** path
outside projectsDir or absent from the FileTable · **404** unknown
slug/session/agent/line/runId · **409** `not-indexed-yet` (carries
`retryAfterMs`, `bytesIndexed`, `bytesTotal` — same denominators as the R2
`pending` state) · **416** unsatisfiable Range/window · **503** indexer
worker down — **except `/api/index` and `POST /api/reindex`**, which answer
while the indexer is down (`status.state: 'failed'` plus a `worker-exit`
problem saying so): `problems[]` is only reachable through `/api/index`, so
503ing it would make a dead indexer undiagnosable, and `/api/reindex` is the
action that revives it. Router: 404 resolves to the nearest ancestor with a banner;
409 renders that route's determinate loading state and re-polls; 400/403
render an error card and never resolve upward.

**Scope grammar** (shared by /api/records, /api/audit, /api/find):
`scope=store` | `project:<slug>` | `session:<slug>/<id>` |
`turn:<slug>/<id>/<idx>` | `agent:<slug>/<id>/<agentId>`, components
percent-encoded; responses echo the parsed scope and a `total`.

**Top-level `r2`.** Five routes ship `r2: 'pending'|'resolved'` as a TOP-LEVEL
field beside their payload: `/api/project`, `/api/session`, `/api/turn`,
`/api/agent` and `/api/records`. It is the R2 resolution state the response was
computed under, and it is what a page with no index status to poll polls
instead (DESIGN §7) — L2 keys its quiet re-check on `detail.r2 === 'pending'`.
It is a DIFFERENT field from `/api/index`'s `status.r2` (§5, R2): that one
describes the store-wide build, this one rides every deeper payload.

| Route | Ships |
|---|---|
| `GET /api/hello` | `{app,version,pid}` |
| `GET /api/index?since=N&boot=B` | `{version, boot, status(+denominator), agg /*store CostAgg, FULL*/, rowsSumToHeader, lostAgents /*Σ card census — a provable 0, never `—`*/, projects[] (each with FULL agg + label per §2), sessions: [SessionCard + agg /*LITE: requests, tokens, usd.total, disclosure counters, inheritedRequests, unpricedRequests — the maps and component usd ship at deeper scopes*/], turnBars[], dayBands[], pending[], problems[]}` — aggs computed at read time from cached ledgerLite + R2 resolution over the loaded index. `version` is a monotonic integer bumped on any index mutation, not persisted; `boot` is a per-process id — **204 only when `since === version` AND `boot` matches**, else full payload (a cursor from a previous server life never gets a spurious 204). `status.state` may be `'failed'` (the build crashed; problems say why; r2 stays `pending`) |
| `GET /api/project/:slug` | its sessions (with LITE aggs), project agg (FULL), rowsSumToHeader, project-filtered dayBands + turnBars, memory listing, fragments |
| `GET /api/session/:slug/:id` | SessionDetail MINUS the cache-only bulk (ledgerLite, mainMsgIds, foreignMsgIds) and the two on-demand lists — `images[]`/`filesLedger[]` ship from the routes below; `imagesTotal`/`filesLedgerTotal` counts stay here — plus per-turn/per-agent aggs, `rowsSumToHeader`. agents[] carry the recorded spawn edge (`toolUseId`, `parentAgentId`, `kind`, `spawnLine`) and the lane-tag facts (`cached`, `worktreePath`, `spawnedWithWorktree`, `isolation`, `attempt`, phase). `forkPartners` maps each session sharing a duplicated msgId with this one to `{slug, sharedMsgIds, billedHere, billedThere, billedElsewhere}` — the R2 reverse map that gives the CANONICAL side its fork banner (`{}` = real none; `null` = not derivable yet: index still building, or this session's rows are not loaded). `sharedMsgIds` is the RAW superset (ids recorded in both files); the three `billed*` counts use the priceRowTcu sense of billed (non-synthetic, non-embedded-sidechain — the same exclusion `aggregate()` applies BEFORE the R2 gate), so `sharedMsgIds` is **not** their sum: the shortfall is exactly this file's $0 copies, and `billedThere` therefore equals the CostAgg's own `inherited[partner].requests`. `badges` carries the read-time `forked` OR-in `/api/index` applies (one helper, one contested-msgId source — L1 and L2 can never disagree), and while the index builds `agg.inheritedPending: true` marks a session already inside a detected duplicate group. Also here and NOT on the card: `turnBars` (this session's `{idx, at, endedAt}` — cardOut strips it for /api/index) and `journalOnly` (the lostAgents evidence) |
| `GET /api/session/:slug/:id/images` | `{images: [{file /*SESSION-RELATIVE rel — feeds /api/image directly*/, line, bi, bytes /*decoded*/, b64Chars /*recorded base64 length*/, source, mediaType, twin}], total}` |
| `GET /api/session/:slug/:id/files` | `{filesLedger: [...], total, denominators}` |
| `GET /api/turn/:slug/:id/:idx?from&count` | turn slice: `rows[]` (the turn's main-thread row index — heads ≤220 chars, no bodies; whole by default, `?from&count` page it) + `rowsTotal` + `turnCount`, agents (with edge + lane-tag facts), workflows (a run resumed here ships too, flagged with its OWNING `turnIdx` — the turn of its FIRST spawning call — plus `resumedInTurns`, so the resuming turn renders the link-only reference row per §7), agg, `rowsSumToHeader`; 404 past end |
| `GET /api/agent/:slug/:id/:agentId?from&count` | rows without long text + locators (`main` = main thread), agg, `rowsSumToHeader`, and the agent's recorded facts (timing: firstAt/lastAt/queuedAt/startedAtRecorded/durationMs; edge: toolUseId/parentAgentId/runId; state: stateFacts/cached/worktree facts) |
| `GET /api/line?slug&id&file&line` | one full raw event + rendered fields (line 1-based) |
| `GET /api/lines?slug&id&file&from&count` | `{from, count, total, lines:[raw], bom, problems[]}` from the offset table; max count 500; `total` re-stat'd per request (live files grow); 416 on unsatisfiable window. `bom` is emitted unconditionally and is a fact about the WINDOW: true only when line 1 was actually returned by this call and its recorded bytes began with a UTF-8 BOM that was stripped, which also emits one `bom-stripped` note — the same disclosure `/api/line` makes about the same bytes |
| `GET /api/image?slug&id&file&line&block` | decoded image (`block` = dotted bi string), immutable cache headers |
| `GET /api/file?slug&id?&rel` | raw file bytes, Range OK; `id` optional — absent resolves `rel` against the project dir (`mem/<name>`); both guards always apply |
| `GET /api/workflow/:slug/:id/:runId` | the wf record incl. script/logs/result; **partial envelope** (journal+script+transcripts, no manifest) for in-flight runs — never 404 for an existing run dir. **`complete: boolean` is the discriminator** and the field a client must branch on: `true` = the manifest was read, and `record` (the parsed `wf_*.json`) ships with it; `false` = no manifest yet, and `script`/`note` ship instead. There is no `partial` key — a client testing `payload.partial` is testing a field the server has never sent. BOTH envelopes carry `cost` (the run's CostAgg: Σ over the per-agent aggregates of the transcripts in the run dir; `null` = not computable) and `rowsSumToHeader`, whose row side comes from the independent priceRow path so the ✓ stays a cross-check. BOTH also carry `agents[]` — **objects, never filenames** — enumerated from the run DIRECTORY LISTING (§7), one row per `agent-a*.jsonl`, enriched from the session's own per-agent projection (matched on `rel`, then `agentId`) with a flat `model` (`resolvedModel ▸ progressModel ▸ models[0] ▸ metaModel`) and that agent's slice `agg` of the very partition `cost` was folded from, so the rows sum to the header by construction. A transcript the last parse never read carries its `agentId` and `null` everywhere else (`agg: null` = unknown, distinct from a transcript the ledger covers and that billed nothing). BOTH also carry `journal`, read ONCE from the run directory and **discriminated**: `[]` only when the directory listing proves there is no `journal.jsonl`, `null` when the file is listed but the read failed or raced (UNKNOWN — a `file-unreadable` Problem rides beside it). A bare `[]` for the second case, or an absent key for either, is what let the run page assert "no journal.jsonl in this run directory", "journal started / result 0 / 0" and "retried: no" over runs whose journal records real work |
| `GET /api/records?scope=…&from&count` | billed rows for the scope; default count 300, hard cap 5,000; response carries `total` and server-computed `rowsSumToHeader: true \| {delta}` — the header is aggregated PER SESSION with each row's own sessionId as canonical authority, then summed (a null authority over a mixed row set would misroute canonical fork copies); an unknown agentId in an `agent:` scope is a 404, never a 200 with total 0 |
| `GET /api/audit?scope=…` | SSE (vocabulary below): Path A vs Path B reconciliation + invariants, scoped |
| `GET /api/find?q=&re=&case=&after=&scope=` | SSE: streamed matches + progress + skip report |
| `GET /api/progress/:slug/:id` | SSE parse progress (bytes, agent i/N) |
| `GET/PUT /api/config` | ACTIVE and SAVED are two facts and are named as two fields — a save rewrites config.json but does NOT re-point the running indexer (`createIndexState` closes over `projectsDir`, and the `/api/file`, `/api/image`, `/api/lines` containment guards read `ctx.projectsDir`), and `POST /api/reindex` does not either: only a restart applies it. GET returns `{activeProjectsDir, activeSource, savedProjectsDirRaw, savedProjectsDir, pendingRestart, savedOutrankedBy, cacheDir, projectsDir /*legacy alias = active*/, projectsDirSource, config, pricingVersion}`; `pendingRestart` compares the two with the win32-aware path rule, never a raw string compare. **`savedProjectsDirRaw` is the string config.json LITERALLY holds; `savedProjectsDir` is what that string resolves to** — two facts, and the settings page prints the raw one on the row it labels "saved in config.json" and adds a "resolved to" row only when they differ. Collapsing them into one pre-resolved field made that row print a path config.json does not contain, and made `pendingRestart` a comparison of two identically-derived values (structurally false for every config-sourced win). A config-sourced RELATIVE entry resolves against **config.json's own directory**, never the process cwd — a string persisted in a file must not name a different corpus depending on how the app was launched; `--projects` and `CLAUDE_PROJECTS` are typed in a shell and keep resolving against the cwd. Nothing is ever re-written on load: migrating would cement whichever cwd one accidental launch happened to use. PUT validates, saves, and returns `{saved:true, applied:false, activeProjectsDir, savedProjectsDir, pendingRestart, savedOutrankedBy, preview}` — the counts preview is nested under `preview`. `savedOutrankedBy` is `--projects` / `CLAUDE_PROJECTS` when the precedence order above means the saved value will not be used even after a restart |
| `GET /api/pricing` | interval rate table + PRICING_VERSION (read-only) |
| `POST /api/reindex` | forced, ignores fingerprints. NOT gated on a live indexer: when the worker is down this is what respawns it (and resets its crash budget), so the one exposed recovery action can actually recover |
| `POST /api/validate-dir` | setup screen probe. Returns `{ok, dir /*the RESOLVED path — printed on BOTH branches*/, reason, message, projects, sessions, bytes, files, truncated, tookMs, problems[]}`. `reason` is the machine key (`empty` \| `missing` \| `unreadable` \| `not-a-directory`, `null` on success) and **`message` is the prose that goes with it**, so client and server share one vocabulary instead of the client collapsing four recorded reasons into one sentence. The `missing`/`unreadable` paths also attach the real OS error as a `dir-unreadable` Problem — an EPERM on a genuine directory is the case no generic sentence diagnoses |

**SSE vocabulary** (find, progress, audit): `event: progress`
`{sessionsDone, of, bytesDone, ofBytes, elapsedMs}` · `event: match`
`{slug, id, file, line, bi, at, ctx}` (find) · `event: skip`
`{file, reason, bytes}` · `event: problem` `{Problem}` · `event: invariant`
`{name, pass, expected, actual}` (audit; per-session A/B rows are invariant
events named `session:<slug>/<id>`, pass null when Path A had no figure) ·
`event: pending` `{retryAfterMs, bytesIndexed, bytesTotal}` (progress: a
not-yet-indexed session opens the stream and says so — never a 409 body the
EventSource reads as a transport error) · `event: done`
`{matches?, capped?, cap? /*the per-scan result cap — the N in "capped at N"*/, cursor?}` (audit's `done` additionally carries
`pathA`/`pathB` — both paths' file censuses, side by side) ·
`event: error` `{code, message}`.
Comment heartbeat every 15 s; server closes the stream after `done`.
Find scans sessions newest-first and emits file-ordered matches within a
session — DESIGN's "ordered by time newest-first" is satisfied by scan
order; the client never re-orders. `&case=1` = case-sensitive;
`&after=<cursor>` resumes past the 500-match cap. The cursor carries the
capped session's mtime snapshot: on resume, sessions that changed (or
appeared) after the capped scan are RE-scanned (repeats possible, gaps
never), and a cursor that no longer resolves ends in a
`find-cursor-stale` problem + error — never a clean `done {matches: 0}`
masquerading as a real zero. Regex queries are pre-checked: an
exponential-backtracking shape (unbounded quantifier over a group containing
one) is a `400 bad-regex` — a sync regex cannot be aborted and must not hang
the server; oversized lines are regex-matched on a bounded prefix, counted
in the skip report.

**Find's corpus** is each line AFTER the same `stripBase64` the reader uses
(base64 + thinking `signature` spans replaced); the skip report states "N
image payloads and M signatures skipped". Matches resolve through parsed
block offsets to a real `e/<line>.<bi>` address; a match outside any block
(top-level metadata keys) links to `e/<line>` with no block index — never a
fabricated one.

**Unicode normalization (R14-F1).** The searched text is normalized to NFC
once per line (and once per block on the rescue pass), and a SUBSTRING query
is normalized to NFC too — so `café` typed as `caf`+U+00E9 finds the same
word stored decomposed as `caf`+`e`+U+0301, which the old literal comparison
reported as a clean `done {matches: 0}`. Two limits are deliberate and stated
here rather than inferred: a REGEX query is left exactly as typed (it is
pattern syntax, not subject text — only its subject is normalized), and
normalization is canonical (NFC) only, never compatibility (NFKC), so `ﬁ`
does not match `fi`. The `ctx` snippet is cut from the same normalized string
the match was found in, so its offsets can never cross forms; the address
(`file`, `line`, `bi`) and `at` are still derived from the raw bytes on disk.

**Day bands** (L0's gutter source): server-computed
`dayBands: [{localDate, startMs, turnCount, tokens: Tokens, usd, sessionsTouched}]`
over billed rows bucketed by the **server host's local calendar day** of
each row's `at` (consistent with DESIGN §2 "local time always"); a turn
crossing local midnight therefore splits between bands by its rows'
recorded timestamps — the split rule is disclosed in the band gutter ⓘ.
`turnCount` counts a turn ONCE per distinct local calendar day its bar
touches (calendar-day iteration, noon-anchored day stepping — DST-safe in
both directions), so Σ over bands ≥ distinct turns and the surplus is
exactly the midnight crossings (re-measured on the 2026-08-17 frozen
snapshot after the day-iteration fix: **387 vs 376** — 376 distinct turn
bars + 11 midnight-crossing days; the earlier "752 vs 376" was 2×376, an
artifact of the old 24 h-step loop double-counting every same-day bar's
final day, and is retired): the L0 header counts distinct turn bars and the
scope sentence states both figures and why they differ.
`turnBars: [{slug, id, idx, at, endedAt}]` (idx per §4; bounds per §4's
ledger) remain identity-only.

Payload discipline: **a level ships identities, timings, counts and token
totals; prose, diffs and pixels are fetched per line.** Every response
carries `problems[]` and (for aggregates) `scope{sessions,of,bytes,ofBytes}`.
`usd` figures and full CostAggs are computed per response from
`shared/pricing.mjs` — the cache stores tokens only, which is what makes
"pricing edits never invalidate the cache" true.

## 10. The audit (`#/audit`, `GET /api/audit` — SSE)

- **Path A** = the hierarchy the app displays (cache-backed).
- **Path B** = an independent flat rescan with separately-written code:
  its own recursive directory walk (no FileTable reuse; both paths' file
  censuses — count + bytes — reported side by side), its own \n-only
  line reader (no LRU, no cached summaries, no shared offset tables —
  independence is the point), applying R1–R4 plus R7's unpriced partition,
  pricing through the shared rate table, summing per file → session → total.
  Path B narrows to the requested scope (store = all files; session = that
  session's tree).
- **What A === B proves** (printed on the page next to the ✓): the ledger
  arithmetic, the R1–R4 application, R7 routing, every level of aggregation,
  and the cache — GIVEN the rate table. It cannot validate the rates or
  modelKey normalisation: both paths (and the client-side panel reprice)
  import the same `shared/pricing.mjs`. The rate table is covered instead by
  PRICING_VERSION, the printed source + retrieval date, and the module-load
  integrality assertions.
- Invariants reported every run, with EXPECTATIONS computed live by Path A
  from its own aggregates (never the snapshot numbers below hardcoded):
  session = Σ turns + disclosed channels (`session-sum-channels` — the
  unattributed-leak detector); Σ agents over all turns == enumerated agents
  (`agents-attribution`); (speed, service_tier) pair census — Path A derives
  it from the billed rows' recorded `speedAbsent`/`serviceTierAbsent` flags,
  one census entry per R1-kept line; never-finalized census; synthetic
  census (counted PER COPY PER FILE — fork duplicates included: 28 lines →
  28 row-copies on this corpus, 2 of them fork duplicates; both paths agree
  on this basis and routing synthetic copies through R2 would muddy the
  inherited channel's requests semantics); 5m+1h == flat after R3 (0
  exceptions); cross-file duplicate census + R2 resolution (`r2-census`
  FAILS on `tieBreaks != 0` — the tie case IS the ambiguity census);
  usage-integers census (0 — a present non-integer token counter bills 0
  and is counted, never silently coerced); >200K-context census +
  premiumUnknown (0; the verified set comes from
  `pricing.LONG_CONTEXT_COVERED`, the audit's one disclosed shared import);
  unpriced census (keyed by RAW model string, `(unrecorded)` sentinel — the
  same key rule as the ledger); ttlAssumed (0); rate-interval coverage
  (every priced row's `at` in exactly one interval); R3 split-group
  webSearch/webFetch sums; torn-line census (0); lost-agents census (0 —
  enumeration closed; census stays, the L1 badge does not exist); fork-pair
  listing; resumed-run census; per-session A/B diff table (all zeros; also
  emitted as one `session:<key>` invariant row per session so the audit
  page's per-session table populates); both paths' file censuses (on the
  `done` event, side by side); tcu non-overflow; a sampled evidence row's
  file:line re-read to the same message.id (catches off-by-one at run time).
- Reference BASELINE (2026-08-17 frozen snapshot; the corpus is LIVE and
  these are for reference, never pass/fail expectations — the invariants
  compare live A-vs-B figures): 30,886 billed requests /
  15,752,688,106,400 tcu; pair census `standard|standard` 29,771 /
  `null|null` 28 / `ABSENT|standard` 1,617; never-finalized 1,618;
  synthetic 28; agents 837; duplicate groups 505 / tieBreaks 0 /
  ambiguous 0. To re-derive, use `docs/research/scripts/gap6-*.mjs` — with
  one caveat: the COMMITTED `gap6-03-ledger.mjs` still carries a pre-gap-2
  PLACEHOLDER canonical rule ("earliest row timestamp, tie-break lex path"
  — its own header says so), which picks a different canonical copy in 459
  of 503 duplicate groups. Its store TOTALS are attribution-independent and
  correct; its PER-SESSION splits are not authoritative — re-derive splits
  against the normative R2 clauses (i)/(ii)/(iii).

## 11. Performance budgets (measured; re-measured 2026-08-17 on the frozen
snapshot — 85 sessions / 2,067 files / 1.18 GB — after the round-1 fix pass)

- Cold full index ≤ ~8s (measured 5.2–6.8s). **Warm boot: first HTTP answer
  ≤ ~150 ms (measured 106–114 ms); visible `building` window ≤ ~600 ms
  (measured 321–331 ms on one machine, 503–549 ms on another)** — the cost
  is the stat walk (~70 ms) + the ~5.8 MB cached card set reloading and
  re-crossing the worker boundary, an honest consequence of the
  exact-under-forks dupRows retention (the earlier 200 ms budget predates
  ledgerLite). Median session parse 34ms; worst single file ~38MB <1s.
- Full-store audit ≤ ~8s (measured 4.1–4.3s single-threaded, now with
  periodic event-loop yields so heartbeats flow); session-scope audit
  ≤ 200ms.
- `/api/index` ≤ ~250KB (measured 238KB: sessions incl. LITE per-card aggs
  ≈125KB + turnBars ≈64KB + projects with full aggs ≈40KB); session summary
  ≤ ~200KB for an 80-agent monster (measured 199KB — images[]/filesLedger[]
  now ship on demand from their own endpoints, which took the monster from
  862KB to 199KB; the remaining mass is 80 agents × ~2KB of mandated
  recorded facts + per-agent aggs); agent rows ≤ ~300KB;
  `/api/records` ≤ ~3.5MB at the 5,000-row cap (measured 3.51MB: 5,000
  rows × ~700 B of full billed-row JSON — the earlier ~1MB figure predates
  the row shape); one `/api/lines` window is byte-capped at 16 MiB
  (returns fewer lines rather than one giant allocation);
  parsed-session retained heap ≤ ~10MB (rows keep `head` ≤220 chars +
  locators + counts, never bodies).
- UI renders ≤ ~2,500 SVG marks per view (bin above that, exact counts).
