# BUILD CONTRACTS — module seams for the parallel build

Binding on every implementer. SPEC.md defines WHAT (rules, shapes, API);
DESIGN.md defines the UI; this file defines the exact exports each module
provides so independently-built modules link on first integration. If a
signature here proves unworkable, implement the closest working form and
leave a `// CONTRACT-DEVIATION:` comment — the integrator reconciles.

General rules (all groups):
- Node ≥18 ESM, dependency-free (`node:` builtins only). Browser code is
  vanilla ESM, no build step.
- `shared/pricing.mjs` must run unmodified in BOTH Node and the browser:
  no `node:` imports, pure data + functions.
- Every path handed to `fs` is absolute; join with `node:path`. FileTable
  `rel` keys are POSIX-separated, session-relative (SPEC §9).
- NEVER write into the projects folder. Fixtures are copied OUT of it into
  `tests/fixtures/**` by `tests/extract-fixtures.mjs` (group A owns it).
- Tests: `node --test tests/` must pass. Each group writes
  `tests/<area>-*.test.mjs` for its own modules. Every R-rule (R1–R10, R-T)
  gets at least one test against a real-corpus-derived fixture.
- Money: integer tcu everywhere (SPEC §6). Never floats in accumulation.
- Line numbers: 1-based at every boundary; jsonl.mjs owns the conversion.

---

## shared/pricing.mjs  (group A)

```js
export const PRICING_VERSION      // '2026-08-17'
export const TCU_PER_USD          // 2e9
export const RATES                // { [key]: [ {from:null|'YYYY-MM-DD', to:null|'YYYY-MM-DD', inputU, outputU} ] }
                                  // key = modelKey, or `${modelKey}@fast` for R9 tier rows
export function modelKey(raw)     // SPEC §6 normalisation incl. 3.x reorder
export function resolveRate({ key, speed, serviceTier, atMs })
  // -> { inputU, outputU, w5mU, w1hU, readU, interval:{from,to}, tier:'standard'|'fast' } | null
  // speed/serviceTier are the RAW row values (null|string); resolution per R9.
  // null => no rate (caller routes to R7 unpriced / R9 tierAssumed per SPEC).
export function priceRow(row)     // billed row (SPEC §5 shape) ->
  // { usd:{input,output,cacheWrite,cacheRead,webSearch,total}   // integer tcu
  //   , unpriced:false } | { unpriced:true }
export function formatUsd(tcu)    // SPEC §6 display rule: '0' | '<$0.0001' | '$X.XXXX'
export function assertRateTable() // throws unless every effective rate integral; run at module load
```

## server/jsonl.mjs  (group B)

```js
export function stripHeavy(lineText)         // -> { text, blobs:[{kind:'base64'|'signature', length}] }
export async function* readLines(absPath)    // yields { text, line /*1-based*/, byteOffset, bytes }
                                             // \n-only; holds back unterminated tail; strips \r
export async function buildOffsetTable(absPath)  // -> { offsets:BigUint64Array|number[], total, bytes }
export async function readLineAt(absPath, line1) // -> raw line text (seek via table, build if absent)
export async function readLineAtWithBom(absPath, line1)
  // -> { text, bom } | null   (round 7) — same read as readLineAt plus the one
  //    fact the string return has to swallow: `bom` is true when line 1 carried
  //    a UTF-8 BOM that was stripped. Never true for line > 1 (a BOM there is
  //    corrupt data and is returned exactly as recorded).
export async function readLineRange(absPath, from1, count)
  // -> { from, count, total, lines:[raw], bom }   (round 8) — `bom` is the same
  //    disclosure, scoped to the WINDOW: true only when line 1 was actually
  //    returned by this call and its recorded bytes began with EF BB BF.
```

## server/scan.mjs  (group B)

```js
export async function scanStore(projectsDir)
  // -> FileTable: Map<relFromProjectsDir(POSIX), {size, mtimeMs}>  (+ .tookMs, .problems)
  // .problems: dir-unreadable | file-unreadable | unclassified-file (round 8:
  //   a symlink/junction Dirent is neither isDirectory() nor isFile(); it is
  //   disclosed and NOT followed).
export function groupSessions(fileTable)
  // -> { projects:[{slug, sessionIds, memoryFiles, bytes}],
  //      sessions:[{ id, slug /*owning project per SPEC §2*/, mainRel|null,
  //                  files:[rel], bytes, fragmentDirs:[{slug, rel}] }] }
  // Sessions keyed by sessionId alone; fragments union (SPEC §2).
export function fingerprint(sessionFiles /*[ {rel,size,mtimeMs} ] sorted*/) // -> sha1 hex
```

## server/parse.mjs  (group B)

```js
export async function parseSession(sessionEntry, { readLines, stripHeavy, onProgress })
  // -> SessionModel:
  // { id, slug, main: { rows:[Row], turns:[Turn], meta:{...} } | null,
  //   agents:[AgentModel], workflows:[WorkflowModel], journalOnly:[...],
  //   inventory:{ perType:{}, attachmentKinds:{}, images:[...], spills:[...],
  //               filesLedger:[...], sessionIdsSeen:[], problems:[Problem] },
  //   assistantLines:[ ... raw parsed assistant events with usage, for ledger ] }
  // Row = { line /*1-based*/, bi /*dotted string|null*/, kind /*SPEC §3 vocab*/,
  //         at:msEpoch|null, head:string /*≤220ch*/, extra:{...small recorded facts} }
  // Turn = { idx, preamble:bool, openerLine, at, endAt /*bounds ledger*/, rowRange:[a,b] }
  // AgentModel = { agentId, rel, meta:{...sidecar}, rows, firstAt, lastAt,
  //               lineage:{kind:'workflow'|'plain'|'child'|'orphan', runId?, toolUseId?,
  //                        parentAgentId?, spawnLine? /*in owning session main*/},
  //               turnIdx /*attribution per SPEC §7*/, label:{text, source} }
```

## server/ledger.mjs  (group A)

```js
export function buildSessionLedger(assistantLines /*from parse, one session incl. agent files*/)
  // -> rows: BilledRow[] per SPEC §5 (R1 keep-last, R3 split, R4 synthetic flag,
  //    R6 finalized flag, R9 raw speed/serviceTier). NO R2 here (index-level).
export function resolveCanonical(sessionsMsgIds /* Map<sessionId, Set|string[] mainMsgIds> plus
                                                   Map<sessionId, {firstTsMs, rel}> */)
  // -> Map<msgId, canonicalSessionId>  (R2 i/ii/iii; also returns { ambiguous: [] })
export function aggregate(rows, { canonicalOf, sessionId, priceRow })
  // -> CostAgg (SPEC §9 shape, integer tcu; inherited/unpriced/tierAssumed/
  //    premiumUnknown/neverFinalized/synthetic/ttlAssumed/embeddedSidechain/thinking)
export function addCostAgg(a, b)   // component-wise; parent = Σ children
```

## server/summary.mjs  (group B)

```js
export function summarise(sessionModel, ledgerRows, fingerprint)
  // -> { card: SessionCard /*SPEC §9, tokens only, incl. mainMsgIds*/,
  //      detail: SessionDetail }
```

## server/config.mjs · index-store.mjs · lru.mjs · indexer.worker.mjs  (group C)

```js
// config.mjs
export function resolveProjectsDir(argv, env, config?, appDir?)  // precedence per SPEC §9; -> {dir, raw, source, sourceLabel}
                                               //    a CONFIG-sourced relative path resolves against config.json's own
                                               //    directory (R13-D2), never the process cwd; arg/env keep cwd semantics
export function expandPath(p, base?)           // `base` anchors a relative input; absolute input is unaffected
export async function loadConfig() / saveConfig(obj)   // atomic write per SPEC §9; the ONLY writer of config.json
export async function validateDir(dir)  // -> {ok, dir, reason, message, projects, sessions, bytes, files, truncated,
                                        //     tookMs, problems[]} preview. `reason` is the machine key, `message`
                                        //     the prose for it (R13-F2) — one vocabulary, owned here
export const REASON_MESSAGE            // reason -> message; web/js/views/settings.mjs mirrors it as REASON_TEXT

// index-store.mjs
export async function loadIndex(cacheDir)      // -> {indexVersion, cards:Map} | null (corrupt => delete+null;
                                               //    CHANGED-under-the-read => KEEP + `cache-busy`, R9-F1)
export function createIndexWriter(cacheDir)    // .update(card) debounced ≥2s, atomic, retry/EPERM per SPEC §9
export async function sweepStaleTmpFiles(dir)  // R9-F1: drop `<name>.tmp-*` orphans >6h; the writer's owner
                                               //    calls it at boot (worker onStart / lens.mjs fallback)
export const INDEX_VERSION

// lru.mjs
export function createLru({ maxEntries=8, maxBytes=96e6, sizeOf })  // .get/.set/.delete; key `${slug}/${id}@${fp}`

// indexer.worker.mjs (worker thread; parent = api layer)
// parent -> worker: {type:'start', projectsDir, cacheDir} | {type:'rescan'} | {type:'reindex'}
// worker -> parent: {type:'card', card} | {type:'progress', done, of, bytesDone, bytesTotal}
//                  | {type:'stale', sessionIds} | {type:'problem', problem} | {type:'ready'}
//                  | {type:'session-problems', id, slug, problems}   (round 8)
// `problem` is the APPEND channel and carries store/worker-scope events only.
// `session-problems` is one batch per summarise attempt, posted UNCONDITIONALLY
// (including the empty case, and including a failure where no card follows) —
// the parent REPLACES that session's whole contribution with it, which is what
// makes a retraction possible. Without an empty batch there is no event to
// retract on. MRU-first ordering; a card is emitted only when fully summarised.
```

## server/http.mjs · api.mjs · static.mjs · errors.mjs · find.mjs · audit.mjs · lens.mjs  (group D)

- Routes, envelopes, status codes, SSE vocabulary, scope grammar: SPEC §9
  verbatim. `errors.mjs` exports `problem(code, …)` (Problem factory) and
  `httpError(status, code, message)`.
- **`server/api.mjs` is a pure façade** over `server/api/`: one module per
  concern (`scope`, `params`, `fileref`, `session-lookup`, `costs`, `bands`,
  `index-view`) plus one `routes-*.mjs` per resource group (store, project,
  session, workflow, content, find, audit, config), wired by
  `server/api/index.mjs` (`createApi`, cross-route memos, BOOT id). The
  façade's export list is the public seam and must not shrink: `createApi`,
  `catastrophicShape`, `parseScope`, `scopeString`, `resolveFileRef`,
  `localDateOf`, `dateOfDay`, `dayStartMsOf`, `finishBands`, `makeBands`.
  Route modules share one signature:
  `registerXRoutes({G,P,PUT}, ctx, {canonMemo, dupMemo, boot, buildIndexView, projectSlice})`.
- **`server/limits.mjs` owns every tunable knob** (ports, caps, debounces,
  LRU sizes, walk budgets), one named export each with a one-line comment.
  Modules that historically exported a knob (`find.mjs` `REGEX_LINE_CAP`,
  `index-store.mjs` `TMP_SWEEP_MAX_AGE_MS`) re-export the limits value —
  add new knobs to limits.mjs, not as scattered literals.
- api.mjs computes CostAggs at read time via group A's
  `aggregate`/`addCostAgg`/`priceRow` over cached tokens + LRU'd sessions;
  serves `shared/pricing.mjs` to the browser at `/shared/pricing.mjs`.
- **audit.mjs is Path B and must NOT import jsonl.mjs, parse.mjs, or
  ledger.mjs** — it contains its own \n-splitter, its own R1–R4+R7
  implementation and its own directory walk (SPEC §10 independence);
  it MAY import shared/pricing.mjs (the one shared piece, disclosed).
- find.mjs streams over stripHeavy'd lines; resolves bi via a minimal
  block-offset pass (may import jsonl.mjs + parse block-mapper).
- lens.mjs: args → config → port probe (`/api/hello`) → worker → open
  browser. start.bat / start.sh per SPEC §9 / DESIGN §8.
- lens.mjs `createIndexState({projectsDir, cacheDir, mods, restartDebounceMs,
  workerBackoffMs=[1000,2000,5000], crashWindowMs=60000, crashCap=5})` owns the
  indexer worker's whole lifecycle (round 8): ONE `spawnWorker()`, called from
  `start()` and from every `exit`/`error`; `alive` flips true only when the
  fresh worker first speaks; more than `crashCap` respawns inside
  `crashWindowMs` and it stays down, disclosed as a live `worker-exit` problem
  rather than an appended one. It additionally returns `close()` — orderly
  teardown (stop respawning, terminate the worker), because without it a
  terminate at shutdown is indistinguishable from a crash and is faithfully
  answered with a replacement.
- `createIndexState` de-duplicates in-flight parses per session id
  (`ensureParsed` / `ensureModel`), and that dedup is **staleness-aware**
  (R13-D1). The two events that declare a session's copy superseded — the
  worker's `{type:'stale'}` message and `reindex()` — EVICT the id from both
  in-flight maps, so a request arriving after them parses the current bytes
  instead of joining a parse of bytes already known stale. A parse whose
  per-id generation moved while it ran still WRITES (suppressing it would
  strand `need()` in a permanent `PendingError` for any session being appended
  to — the 409 loop COR-15 exists to prevent) but marks the id dirty, and the
  warm guard is `rowsStore.has(id) && !dirty.has(id)`, so the next request
  reparses. The map entries are deleted BY IDENTITY on settle — a bare
  `delete(id)` lets an older promise drop a newer entry and silently restores
  the dogpile.
- **The no-worker fallback rebuild is supersession-safe (R14-F2).** When
  `server/indexer.worker.mjs` is absent from the install, `createIndexState`
  indexes in-process via `indexAll({ force, clear })`. The card map is cleared
  INSIDE `indexAll`, after its `if (S.indexing)` guard and only when `clear` is
  asked for — never by the caller. Clearing from outside wiped cards a running
  loop had already written and would never revisit, while that same guard turned
  the second call into a silent no-op, so nothing rebuilt them: `status()` then
  reported `state:'ready'` with `sessionsDone < sessionsTotal`, and the stranded
  ids answered `409 not-indexed-yet` for the life of the process. The `clear`
  flag must stay opt-in — `start()` calls `indexAll()` right after seeding the
  map from the index.json cache, and an unconditional clear would silently turn
  every warm boot cold. A rebuild requested while one is running is QUEUED (not
  dropped — the one exposed recovery action must never be a silent no-op), and
  the running pass does NOT set `state:'ready'` when it already knows it has
  been superseded, the same honesty rule R13-D1 applied to `dirty`. The
  INVARIANT to test is not the race but its consequence: whenever
  `status().state === 'ready'`, `sessionsDone === sessionsTotal`. Worker mode
  gets this from the worker's own generation counter and is unaffected.
- **find.mjs normalizes to NFC at the call site, never inside the matcher**
  (R14-F1, SPEC §9). `runFind` normalizes each stripped line once (and each
  block once on the rescue pass) and uses THAT string for both matching and the
  `ctx` snippet, so `index`/`length` never address a string the caller does not
  hold; `JSON.parse` still runs on the raw line so the address and `at` come
  from the bytes on disk. `makeMatcher` normalizes the query for the SUBSTRING
  path only — a regex `q` is pattern syntax, not subject text.
- Bind 127.0.0.1; Host check; FileTable membership guard on file routes.

## web/  (groups E, F, G; group E owns the foundation + styles.css)

Files (disjoint ownership):
- E: `web/index.html`, `web/styles.css`, `web/js/router.mjs` (+
  `web/js/router/pattern.mjs`, the pure route-pattern grammar it re-exports),
  `web/js/api.mjs`, `web/js/format.mjs`, `web/js/components/{statbar,vtable,
  timeline,rows,jsonview,chips,costfigure,scope}.mjs`
- F: `web/js/views/{l0,l1,l2}.mjs`
- G: `web/js/views/{l3,l4,l5,inv,find,audit,settings,workflow,memory}.mjs` —
  `l3.mjs` and `l5.mjs` are pure façades over `views/l3/` and `views/l5/`;
  `l4.mjs` re-exports its pure analysis from `views/l4/analysis.mjs`.
- Shared drill-view kit: `web/js/lib/{net,dom,fmt,links,locator,blocks,
  chrome,text}.mjs` — the cross-view helpers (page chrome, locators, block
  enumeration, null-preserving formatting). Views import lib/ directly;
  never route shared helpers through another view's module.

Foundation contracts (group E implements exactly; F/G import):

```js
// router.mjs
export function defineRoute(pattern, render)
  // pattern like '/p/:slug/s/:sid/t/:idx'; 'x' and 'e' tails handled per DESIGN §0
  // render(ctx) where ctx = { params, query:URLSearchParams, el /*content root*/,
  //                           navigate(hash), setTitle(t), signal, stale,
  //                           crumbs(p), scopeSentence(p), statbar(p), banner(...), loading(p) }
  // STALE-RENDER RULE (R13-F1, widened R14-D1). `el` IS the shell's content node
  // and the three bands are the shell's own persistent nodes — nothing a render
  // paints is private to it. A view MUST therefore `if (ctx.stale) return;`
  // after EVERY await, as the FIRST statement of every catch (ahead of
  // handle404, which banners AND navigates), and before any pendingCard; and
  // MUST pass `{ signal: ctx.signal }` to every fetch so an abandoned request is
  // actually cancelled. The router additionally no-ops setTitle/crumbs/
  // scopeSentence/statbar/banner/loading once superseded — a backstop at the one
  // shared site, never a substitute for the guards (a stale view still burns CPU
  // and can still call navigate()).
  //
  // THE RULE IS UNCONDITIONAL — it binds all TWELVE views, not the ones that
  // happen to call handle404. R13-F1 fixed l3/l4/inv/workflow and left l5,
  // audit, find, memory and settings unguarded; R14-D1 was that omission coming
  // back as a reader yanked off the page they were reading. When adding a view,
  // the guards are part of writing it, not a later hardening pass.
  //   · l5's renderEvent additionally OWNS resolveAgentFile's fetch: the signal
  //     is threaded in, and `_relCache` stays a VALUE cache (`if (rel)
  //     _relCache.set(...)`) — memoising a promise, or memoising a failure,
  //     lets one aborted render poison every later one. memory.mjs's
  //     `_indexSessions` follows the same rule for the same reason.
  //   · audit.mjs and find.mjs register their `ctx.signal` abort listener (the
  //     SSE stream's lifecycle) at the END of the render, so their guard after
  //     `await kit()` is load-bearing: without it a superseded render opens a
  //     whole-corpus scan whose abort has already fired and which nothing is
  //     left to close.
  //   · WRITE CARVE-OUT (settings.mjs): a mutating PUT/POST fired from a live
  //     click handler — `/api/config`, `/api/reindex` — deliberately does NOT
  //     take ctx.signal. Aborting a mutation mid-flight leaves the app unable to
  //     say whether the server applied it, and this app never prints a state it
  //     does not know. Those call sites still guard on ctx.stale before
  //     painting either outcome. Every READ still takes the signal.
  // handle404(ctx, err, {slug, sid, thing}) -> boolean   (views/l5.mjs, shared)
  //   R14-D1 WIDENED ITS CONTRACT: it now short-circuits `true` for ANY stale
  //   ctx, whatever the status — it is no longer 404-only. `ctx.navigate` is the
  //   one chrome surface the router cannot no-op (find.mjs calls it from a live
  //   submit handler, so a blanket gate there would swallow real navigations),
  //   and every handle404 call site is `if (handle404(...)) return;` — so
  //   "handled" is the correct answer for a superseded render: the caller
  //   returns and paints nothing. This is a backstop at the one shared site, NOT
  //   a substitute for each view's own `if (ctx.stale) return;` ahead of it.
export function start()
export function href(...segments)        // encodes each segment
// api.mjs (client)
export async function api(path, params)  // JSON; throws {status, code, message}; 409 -> {pending:{...}}
export function sse(path, params, handlers /*{progress,match,skip,problem,invariant,done,error}*/)
export async function pricing()          // imports /shared/pricing.mjs once, caches
// components — each is  mount(el, props) -> { update(props), destroy() }
export function statbar(el, { cost, tokens, span, active, counts, chips, scopeSentence,
                              footnote, onDrill })         // DESIGN §1; every cell a button
export function vtable(el, { columns, rows, sort, group, page, footerSums, onNav })  // DESIGN §4
export function timeline(el, { lanes, marks, axis, gutter, binsCap:2500, onMark })   // DESIGN §2
export function rowsPane(el, { fetchPage, kinds, onExpand })  // 300-row paging timetable
export function jsonview(el, { value, highlightPath })
export function costfigure(el, { agg, scope })  // DESIGN §6 panel incl. /api/records paging
export function chipsRow(el, { agg })           // DESIGN §1 disclosure chips
```

- CSS: BEM-ish flat classes `lens-<component>[__part][--mod]`; CSS
  variables for the palette in `:root`; no inline styles except SVG geometry
  and computed/data-driven geometry or colour **whose value is the datum** —
  measured widths (contribution share bars, progress bars), `flex-grow` from a
  recorded count, contact-sheet tile sizes and grid columns, virtualisation
  offsets and spacer heights, tree indent depth, project swatch hues. A static
  class cannot carry a per-row measured value, and inventing one to hold it
  would mean authoring CSS for classes that have none. The permitted sites are
  enumerated in two places and nowhere else: the header of `web/styles.css`
  (the measured widths) and the `CONTRACT-DEVIATION` block at the head of
  `web/js/views/l0.mjs` (swatch hue, composition `flex-grow`, contact-sheet
  tiles) — plus the `CONTRACT-DEVIATION` notes in `web/js/views/l3.mjs` (tree
  indent) and `web/js/views/l4.mjs` (exactly two values in the `?v=raw`
  virtualisation: the spacer's total height and the visible window block's
  `top` offset), which are the same kind. The raw view's static geometry is
  NOT covered: its viewport box, its fixed row height and the spacer/block
  `position` properties are stylesheet rules (`.lens-raw--virt`,
  `.lens-raw__line--virt`, `.lens-raw__spacer`, `.lens-raw__block`), scoped so
  they never reach inv.mjs's non-virtualised listing, which shares the bare
  `.lens-raw` classes. Anything that is not a datum still belongs in the
  stylesheet.
- Views never fetch bytes they don't render (SPEC §9 payload discipline).
- Keyboard map (DESIGN §5) lives in router.mjs; views register `[`/`]`
  sibling handlers via ctx.

## tests/  layout

```
tests/extract-fixtures.mjs      (group A; reads a local corpus READ-ONLY, REDACTS
                                 mechanically, then writes tests/fixtures/**.
                                 Fixtures must never carry real corpus strings —
                                 paths, project names, session/agent/msg ids and
                                 prose are all mapped to synthetic equivalents.)
tests/fixtures/…                (redacted structural samples, committed)
tests/helpers/…                 (shared fake DOM, timing helpers)
tests/pricing-*.test.mjs        (A)  R5 R7 R8 R9 R10, modelKey incl. 3.x, integrality, formatUsd
tests/ledger-*.test.mjs         (A)  R1 R2(i,ii,iii,census) R3(split+provenance) R4 R6 aggregate/addCostAgg
tests/jsonl-*.test.mjs          (B)  \n-only, U+2028, tail holdback, offset tables, 1-based
tests/parse-*.test.mjs          (B)  R-T (373-turn check on fixture), kinds vocab, bounds ledger, attribution
tests/scan-*.test.mjs           (B)  grouping, fragments union, fingerprint
tests/store-*.test.mjs          (C)  atomic write + EPERM retry, LRU eviction, config precedence
tests/api-*.test.mjs            (D)  routes, scope grammar, error envelope, guards, SSE framing
tests/audit-*.test.mjs          (D)  Path B vs known fixture totals; independence (no forbidden imports)
```
