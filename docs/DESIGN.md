# Claude Playback Lens — DESIGN (normative)

The product surface. This file is the rationale of record — the brainstorm
briefs it absorbed were retired 2026-08-19 (where they disagreed with this
file, this file already won). Format facts and
accounting rules live in `docs/SPEC.md` (R-rules are cited by number here).
This revision incorporates the validated critique findings (2026-08-17).

The product in one sentence: **open the whole store, see when/what/how much at
every altitude, and mine any number down to the bytes that produced it —
with nothing inferred, nothing hidden, and every aggregate provably the sum
of its children.**

## 0. The spine

```
L0  #/                                   the store   (all projects)
L1  #/p/<slug>                           one project  (its sessions)
L2  #/p/<slug>/s/<sid>                   one session  (its turns)
L3  #/p/<slug>/s/<sid>/t/<idx>           one turn     (its orchestration; idx per SPEC §4, preamble = 0)
L4  #/p/<slug>/s/<sid>/a/<agentId>       one agent    ("main" = main thread)
L5  #/p/<slug>/s/<sid>/a/<agentId>/e/<line>[.<bi>]   one event/block (line 1-based; bi = dotted path, SPEC §8)
```

Beside the spine: `…/s/<sid>/w/<runId>` (workflow record; renders a partial
envelope for in-flight runs), `…/s/<sid>/inv` (session inventory),
`…/s/<sid>/x/<relpath>` (any raw file in the session tree), and
`#/p/<slug>/x/<relpath>` + `#/p/<slug>/mem/<name>` (project-level raw
files/memory — included in the inventory's files ledger), `#/find`,
`#/audit`, `#/settings`. Query params: `v` (view), `q` (substring filter),
`k` (row kinds — the closed vocabulary in SPEC §3), `sort`/`dir`, `sel`
(L3 tree selection), `re` (regex flag), **`from`/`to`** (date range,
honoured at L0/L1 — filters billed rows by their recorded `at`, so a turn
spanning the boundary splits rather than double-counting; consistent with
midnight-splitting), `day` (L0 expanded day band), `sum` (`Σ all` vs
`Σ filtered` header toggle, DESIGN §4), `p` (table page), `group` (table
group-by column). Unknown params preserved and ignored.

Routing rules: hash-only, hand-rolled; every internal link is a real
`<a href>`; `hashchange` is the sole render entry; unknown routes resolve to
the nearest ancestor with a banner (404 from the API); a 409
`not-indexed-yet` renders that route's determinate loading state and
re-polls; refresh mid-parse re-attaches. **`x` consumes the remainder of
the hash** (relpaths contain up to 4 `/`-separated segments); every segment
is encodeURIComponent'd on write and decoded on read. Agents are addressed
by bare `agentId` (globally unique; ancestry is display, from recorded
fields, with a literal "parent not recorded" node where absent). Events are
addressed by 1-based file line number + dotted block index — user-verifiable
against the file in any editor.

## 1. The three fixed bands (every level)

1. **Crumb rail** — full chain to root; names + dim ids; last segment not a
   link; `↑` labelled with its destination.
   When a **named view** is active (`?v=`), it is appended as the final,
   non-link segment — "session 676bf186 / images" — so the header says which
   of a level's views you are standing in without reading the tab strip. The
   default view of every level carries no `?v` and therefore adds no segment.
   Beside the rail the shell holds the document's one `<h1>`, written from the
   crumb chain and visually hidden: the rail is the visible title, and a `nav`
   cannot carry the heading.
   When the page was drilled into from a list-like view, the rail also leads
   with a **back control** — `← back to <where>`, e.g. "back to find results",
   "back to session images". It is built from the `returnTo` query param the
   drill link carried (an encoded hash, at most one level deep — building a
   new one strips any already there, so a hash stays bounded), and the label
   is read from that hash's ROUTE SHAPE alone, never from its content. The
   control belongs to the shell, so every route has it identically; a crumb
   whose destination *is* the remembered page carries the remembered query
   instead of the stateless default.
   The rail row also carries the **appearance control** — light / dark /
   system, three states always visible, `aria-checked` on the chosen one. It
   belongs to the shell, not to a render, so it survives every navigation. The
   choice persists under `lens.theme` and is applied by a five-line `<head>`
   bootstrap before the stylesheet, so a reload never flashes the other mode.
   Absent choice = follow `prefers-color-scheme`. Both palettes are the same
   design in two modes, never an inversion, and every text role clears 4.5:1
   in both.
2. **Scope sentence** — one generated sentence stating what the numbers
   below cover and by what rule the set was formed (templates per level;
   gains a clause when a filter — including `from`/`to` — is active). This
   is the contract between the header and the rows.
3. **Stat header** — one component, identical at all levels:
   `$cost | in · out · cache-w · cache-r | span | counts` (counts vary by
   level, slot doesn't). Cost display per SPEC §6: 4 decimals, exact zero =
   `0`, sub-threshold = `<$0.0001`, unknown = `—` + reason. Tokens never
   collapse to one figure. The time cell shows `span` (max−min over the
   scope, SPEC §4 bounds ledger) with the separately-labelled `active`
   figure (union of intervals) in its panel; at L3/L4 the cell may read
   `wall` for a single bar. Every cell is a button → **contribution panel**:
   immediate children ranked by contribution to that number (a sort, not a
   score), with share bars and drill links; token cells toggle group-by
   child/model; the cost cell shows the four-component split + per-model
   rates + the R10 interval in effect; the span cell shows span vs Σ
   children (parallelism) labelled separately.
   Footnote: `N billed requests · deduped by message.id (R1) · rows sum to
   header ✓` — computed **server-side in exact integer tcu**
   (`rowsSumToHeader` on /api/records; never rendered strings); on mismatch
   it enumerates the delta. Labelled "totals are exact; rows shown rounded
   to 4 dp".
   **Disclosure chips** — every CostAgg disclosure counter has exactly one
   chip; every chip cites its R-number and carries the affected token mass
   in the owner's words (masses labelled as RECORDED values, never
   estimates). Render only when nonzero:
   - `↷ N events inherited from <sid> — billed there; X tokens excluded here · R2`
   - `synthetic N — API-error events, zero usage, excluded from billing · R4`
   - `ttl assumed on N rows (±$X if 1h) · R5`
   - `≈ N of M responses stopped mid-stream — output recorded on them is a
     stub, not a final count (X output tokens recorded; the shortfall is not
     measurable and never estimated) · R6`
   - `+⚠ N requests on a model with no rate — X tokens not priced · R7`
   - `tier assumed on N rows · R9`
   - `>200K on an unverified-tier model: N rows · SPEC §5 premiumUnknown`
   - `embedded sidechain: N foreign rows · SPEC §3`
   Unknown = `—` + reason; zero = `0`; never the same glyph.

Below the content, the shell also carries a **footer**, on every page:
global nav (store · find · audit · settings, the current one marked with
`aria-current`) and the two facts that qualify every number above it —
`PRICING_VERSION` and the index state (`index N of M sessions`, plus
`— indexing…` while it builds). The footer never fetches: it prints the
rate-table version already loaded at boot and whatever index state the last
view to read `/api/index` recorded. Either fact unread renders `—` with its
reason, never a zero.

## 2. Timelines — one grammar

Four primitives only: **span** (two recorded timestamps), **tick** (one; no
invented width), **lane**, **bin** (outlined block labelled with an exact
count). SVG everywhere; ≤2,500 marks/view enforced by pixel-column binning.
Local time always, axis labelled `(UTC−7)` once. Linear axis, no gap
compression; in-view empty stretches ≥20% of width get `no events for 2h 14m`.
Magnitude is never encoded in geometry — it lives in a right **stat gutter**
per lane/band (fixed scale, max printed). Zoom: none at L0/L1 (click a date
= single-day band); brush-to-zoom + shift-pan at L2–L4, ephemeral (never in
URL). Marks with end<start render as ⚠ tick showing both timestamps. Every
mark links to its drill route. **The bounds ledger is SPEC §4's time-bounds
table** (normative) and ships in the ⓘ popover per view,
including the day-band midnight-split rule.

Color semantics, one per level: L0 project identity (top-12 stable palette +
grey overflow, legend = filter chips); L1/L2 none; L3 model identity;
L4 event kind.

## 3. Level by level

### L0 — store. Default **timeline**; `?v=table`, `?v=sessions`, `?v=inventory`.
Day bands, newest first, one bar per **turn** (SPEC R-T), colored by project,
midnight-splitting; separator rows `— 12 days —` between gaps and **month
separator rows carrying month subtotals** (tokens 4-way, cost, turns). Band
gutter: day totals from the server-computed `dayBands` (SPEC §9 — the
gutter's sole data source; local calendar day, split disclosed in ⓘ). Click
bar → L3; click date → that day expanded. `from`/`to` filter the whole view
and the header. `?v=table`: projects table (slug label per SPEC §2 cwd rule,
sessions, turns, agents, first/last activity, bytes, 4-way tokens, cost,
badges), incl. transcript-less projects (memory-only) with `—` stats and
raw-slug labels where unlabellable. Footer = column sums. **`?v=sessions`**:
one row per session across the whole store (started, project, title, turns,
agents, 4-way tokens, cost, bytes, badges) with standard sort + column-sum
footer — ranking the store by cost is one click, and the contribution
panel's store→project→session path is no longer the only route.
`?v=inventory`: corpus ledger — files found/classified/unclassified
(project-level files included), bytes accounted, cache state (entries, age,
`re-index`), fragments, duplicate-id sessions, expected-zero censuses (lost
agents 0 · torn lines 0), problems drawer. While the index builds: every
aggregate carries its denominator ("totals over 61 of 85 sessions —
indexing…"), pending list is explicitly numberless, R2-pending sessions say
so (SPEC R2); poll 1s.

### L1 — project. Default **sessions table**; `?v=timeline`, `?v=memory`.
Columns: started, title (custom ▸ ai ▸ id), turns, agents, workflows, span,
4-way tokens, cost, bytes, badges. **Badges** (each a recorded condition):
`fragment` (SPEC §2), `forked` (R2 group member), `no reply` (the final
turn's slice contains zero assistant message.id groups), `retried` (a run
with more journal `started` entries than manifest agents), `running`
(journal `started` without `result`), `cached` (workflowProgress
cached:true), `live` (file growing). There is NO `lost agents` badge —
enumeration is closed (821/821); the provable zero lives in the inventory
census instead. Timeline = L0 grammar filtered to the project, with a thin
session underline beneath its turns; honours `from`/`to`. Memory view lists
`memory/*.md` with frontmatter `originSessionId` links (dangling → "session
not on disk") and raw views via `#/p/<slug>/mem/<name>`.

### L2 — session. Default **turn list**; `?v=agents`, `?v=timeline`,
`?v=workflows`, `?v=files`, `?v=images`; `/inv` beside.
Top strip (always): the three-row session strip — turns lane (solid main
span + hatched agent-overhang per SPEC §4 bounds), agent-concurrency
occupancy strip (exact ±1 arithmetic; **omitted entirely when the recorded
agent count is 0** — the majority case, 68 of 85 sessions — consistent with
L3's collapse), marker lane (queue-ops, system events, denials, edited
files). **Session facts row** (beneath the strip): each metadata snapshot
type as latest value + count with its source named — title (custom ▸ ai,
with the ai-title rewrite count), mode, PR links as clickable `prUrl`
labelled `prRepository#prNumber`, frame links as title + url, `last-prompt:
N checkpoints` reachable from the row each targets. The four untimestamped
types claim no time (file order only, SPEC §3). Each cell has **three**
states, never two: a recorded value; a recorded absence (the payload shipped
a count of 0 / an empty list — the only thing that licenses "no pr-link event
recorded"); and payload silence (the field is absent or null), which says so
and blames the payload, not the file. The count chip prints the EVENT count
the payload carries, not the length of the deduped list beside it — one corpus
session records 36 pr-link events naming a single PR (R10-S1).
Below: turn cards — idx, local time, wall, cost, agents; first ~3 lines of
the prompt verbatim; a composition bar of recorded block-kind counts (SPEC
§3 vocabulary); workflow chips. Preamble (turn 0) greyed with its census.
**Degenerate flip:** ≤1 non-preamble turn AND agents > 0 → default becomes
`?v=agents`; ≤1 turn and 0 agents → stay on the turn list, scope sentence
says "1 turn, 0 agents — showing the turn" (measured: 21 one-turn sessions,
19 of them agentless — the flip must not land them on an empty table).
Fork banner when the file carries foreign/duplicated events: "250 of 260
events are inherited from session 0000000a (fork); billed there (R2)" +
link. The CANONICAL side of the same pair gets its own banner from
`/api/session`'s `forkPartners` (its CostAgg has no `inherited` channel to
read): "43 of 44 msgIds in this file also appear in 0000000b (fork); those 43
are billed here, not there · R2" + link. Both can render at once (a 3-way
group inherits some ids and is canonical for others); `forkPartners: null`
is UNKNOWN (index still building) and banners nothing.
Live badge + `indexed through N of M bytes (93.6%)` when mid-write.
`?v=agents`: the full agents table (label+tag, model(raw), state, phase,
attempt, depth, spawn source, started, wall, 4-way tokens, cost, →)
sortable/groupable by workflow/phase/model/turn/depth. `?v=files`: paths
from the recorded sources in SPEC §8 (tool-name-keyed inputs ∪ main-tier
sidecar), read/write/edit counts from tool names, **with the coverage
denominator printed on the view** ("paths from 18,268 main-thread and
21,445 agent tool calls; 20,292 agent tool results carry no path sidecar").
`?v=images`: contact sheet (virtualized; tiles from byte counts, pixels on
scroll; captions time · source · bytes). Twins are folded — one tile per
distinct image, the coverage sentence stating both figures ("54 distinct
images; 106 recorded appearances") — and a tile **opens a lightbox in place
rather than navigating**: `role=dialog`, `[data-lens-layer]` so Escape closes
it through the router's layer system, ←/→ over gallery order, the recorded
facts + locator + the twin as a fact, and one `withReturn` link out to the raw
event. **L4 `?v=images` mounts the same component over the same list.**

### L3 — turn. Default **orchestration**; `[`/`]` = prev/next turn.
Layout: prompt card (expandable, verbatim) → lane Gantt → tree + timetable.
- **Lanes:** main thread as a mini-L4 strip; one collapsible group per
  workflow run (collapsed = occupancy strip; auto-collapsed when agents >
  24); agent lanes indented by recorded spawnDepth, hatched queued segment
  only when `queuedAt` recorded, end-glyph from recorded state — ✓ done ·
  ✗ error · **⋯ running** (journal `started` without `result`; glyph source
  is the journal when no manifest exists) · ∅ no-result (a recorded result
  that is genuinely empty). `— cached` tag for replayed agents (tooltip:
  "replayed from an earlier attempt of this run"; counted in the run's
  FIRST turn per SPEC §7); `⌂ worktree` tag for the 9 worktree agents.
  Split orphan groups named by fact, not diagnosis: "running — journal
  records a start, no result yet" and "superseded attempt" (SPEC §7). A
  run resumed in this turn renders as a link-only reference row: zero
  tokens, `resumed here`, `counted in turn N` chip.
- **Tree (left):** main → workflows (by run dir) → phases (workflowProgress)
  → agents → children (parentAgentId). Nodes carry mini cost/wall. Selection
  sets `?sel` and drives the right pane. The `?sel` grammar is `main` ·
  `w:<runId>` · `w:<runId>|ph:<phase>` · `a:<agentId>` · `g:<groupKey>` (the
  two non-run groups). **Every key the tree emits must parse to one of those
  forms** — a row whose key does not is a link that selects nothing while the
  row paints itself selected, which is the same lie as a blank preview. An
  unrecognised `?sel` (a stale bookmark, a hand-edited URL) falls back to the
  main thread and *says so*; it is never silently treated as "no selection".
  An agent whose recorded `parentAgentId` chain returns to itself has no
  lineage root, so it is drawn unnested with that fact stated on the row —
  never dropped, and never silently re-parented. The cycle walk is **turn
  scope** (R12-D1): it runs once over every agent in the turn and is shared by
  every lane group and phase, so a cycle split across two groups or two phases
  of one run is still marked. A cycle whose members land in *different turns*
  is beyond what this page holds; the server's session-wide walk names it as an
  `agent-lineage-cycle` Problem, and that Problem — not the row note — is the
  disclosure for that shape.
- **Timetable (right):** the selected node's rows (default: main-thread
  slice of this turn), one row per block, file order, kind chips (SPEC §3),
  300-row paging, expand-in-place (lazy `/api/line`), `{}` → L5.
- 0-agent turns collapse lanes+tree entirely; the timetable takes full width
  with an explicit `0 agents` in the header.
- The scope sentence states the attribution rule used (spawn-call turn in
  the owning session; time-window fallback only for orphans — SPEC §7).

### L4 — agent. Default **timetable** + header facts; `?v=images`,
`?v=files`, `?v=raw`.
Header definition list (all recorded, each with its source named): label (and
which source produced it), [AGENT] tag if different, agentType, model (raw;
resolvedModel/`[1m]` if recorded), effort census, state, phase, attempt,
spawnDepth, parent (link or "not recorded"), spawn tool_use (link), queued/
started/ended/wall, stop_reasons, tool histogram, MCP/skills attributions,
structured output, journal result, sibling `peer` messages, and —
when recorded — `isolation: worktree` + `worktreePath` (cross-referenced to
workflowProgress `isolation`; annotated "path not on disk" when it no longer
resolves, 9/9 here). Those facts are **grouped** into five native disclosures
— identity / lifecycle / model & effort / tools & output / provenance — open
by default for the first three and collapsed for the last two, with one
expand-all / collapse-all control above them. Grouping only: every fact is
still the same recorded value with the same named source and the same unknown
reason, and a fact the grouping does not name lands in `provenance` rather
than off the page. An agent's `cwd` is deliberately not shown as a header
fact (never a project signal — SPEC §2's phantom-project rule); it remains
visible in `?v=raw` and L5. Strip above the timetable: tool spans
(tool_use→tool_result by id; unmatched = tick+∅ with `toolDenialKind` when
present), thinking/text ticks (zero width), image ▣ markers. `?v=raw`:
virtualized raw-JSONL of the whole file, served by `/api/lines` windows
(500-line pages; a 33 MB transcript never ships whole).

### L5 — event. Rendered block on top (kind-specific: text, thinking
(+withheld note when text empty but signature present), tool input, result +
`structuredPatch` hunks + `userModified` badge, image, attachment by kind,
system by subtype, queue-op); full raw event JSON below with the addressed
block highlighted (dotted `bi` grammar per SPEC §8; twins: `<i>.<j>` = block
copy, `r` = sidecar, rendered once with the twin noted). The raw JSON sits
behind a native disclosure, **collapsed by default** — the rendered block is
what the reader addressed — and the choice persists under `lens.l5.raw.open`.
A `tool_use` input past 30 recorded lines folds the same way, its summary
stating the exact line count. tool_use ↔ result
cross-links; `<persisted-output>` spill links (SPEC §8); `[`/`]` sibling
blocks; copy-locator (1-based `file:line[.bi]`). Raw text is the default
everywhere; "render markdown" is a per-row toggle that persists.

### Inventory (`/inv`) — the completeness proof.
Files ledger (every path incl. project-level memory files, bytes, lines,
class, "surfaced as" link, raw link; ends `197 files · 197 classified · 0
unclassified`). Events ledger (parsed → rendered → not-rendered, each
not-rendered bucket enumerated and clickable). Each files-ledger row carries
an "in this app" cell: a recorded path INSIDE the session directory links to
the surface that shows it (`…/x/<rel>`, or its agent / workflow / memory
page); a recorded absolute working-tree path reads `—` with the reason, since
deriving a session-relative path from it would need a store root no payload
records. The ledger closes with how many of its recorded paths are
addressable here. Censuses: per-type events, attachment kinds, sessionIds in
file and models — each a native disclosure stating its distinct-value count,
under one expand-all / collapse-all control — then images
(count/bytes/source), spill files with their reference forms, expected-zero
censuses (lost agents
0 · torn lines 0), problems (Problem shape, SPEC §9 — `affects` drives an
"impacts totals?" column, and a `where` column that links to the named
session **only when the collapsed row has exactly one source** — this census
collapses by code+scope across sessions, so a row with several contributors
reads "N sessions" as plain text with the ids in its title, never a link to
whichever one happened to be first). Nothing in the app lacks a raw view.

### Search (`#/find`) — server SSE scan, substring or regex, case toggle
(`&case=1`). Scans the base64/signature-stripped corpus (SPEC §9);
results grouped by session, **ordered by scan order** (sessions
newest-first, file order within — no ranking, no client re-sort), 80-char
context, links to real `e/<line>[.<bi>]` addresses (no block → no index);
live progress (sessions/bytes/elapsed) + skip report ("N image payloads and
M signatures skipped"); 500-result cap with "keep scanning" (`&after=`
cursor). In-scope find (`/`) filters loaded rows only, its label states the
220-char head limit, and its primary action offers "search all bytes in
this scope" → `#/find?scope=…`.

### Audit (`#/audit[/…scope]`) — SPEC §10 rendered over the audit SSE
stream (determinate progress — bytes/sessions, never a spinner): Path A vs
Path B with ✓/✗ per session, both paths' file censuses side by side, the
invariant table (`invariant` events), disclosure censuses, expandable
evidence rows (billed rows with 1-based file:line links), and the printed
scope of what A === B does and does not prove (the rate table is covered by
PRICING_VERSION + source, not by the equality). The "prove it" page.

### Settings — projects dir (validate + counts preview), pricing table
(read-only: interval lists, PRICING_VERSION + both sources + retrieval
date), cache info, **appearance**, keyboard sheet.

The appearance block mirrors the header's control and states two facts: the
recorded choice (`localStorage` `lens.theme`, this browser only) and the mode
actually on screen with where it came from. When the choice is `system` and
the browser reports no preference, the mode on screen is `—` with its reason —
it is never inferred to be light.

The projects-dir block prints **active** (what this instance is serving, with
its provenance) and **saved in config.json** as two separate rows, plus a
`pending` row when they differ. Saving says what actually happened — the write
landed, this instance is still reading the old directory, restart to apply —
and, when `--projects`/`CLAUDE_PROJECTS` outranks config.json, says that a
restart will not help either. It never claims the indexer re-read the store.

## 4. Tables, one behaviour
Click-sort / shift-click secondary; substring filter on text columns only;
optional group-by on recorded fields with sticky subtotal subheaders (same
cell order as the stat header); numeric columns right-aligned monospace with
column-sum footers; `→` last column; 300-row paging with `showing N of M`;
no infinite scroll. Filtered state (incl. `from`/`to`): header stays Σ all
by default with an explicit `Σ filtered` toggle; the scope sentence names
both counts.

## 5. Keyboard
`j/k` rows · `Enter` drill · `u` up (labelled) · `[`/`]` prev/next sibling
(turn@L3, agent@L4, block@L5) · `/` find in scope · `\` raw JSON · `g0–g5`
jump to level · `t` cycle views · `?` sheet · `Esc` close · `←`/`→` prev/next
image **while the image lightbox is open** (scoped to that layer; it shadows
nothing on the page).

`u` takes the §1 back control when the page carries one — the recorded way
back beats the tree parent — and is the labelled `↑` otherwise. `Esc` closes
the top open layer (sheet, popover, panel) first, then any escape the view
registered, and only with nothing left to close does it follow the back
control. Neither key ever navigates when there is nothing to navigate to.

## 6. Cost transparency
Every dollar figure is one component (`CostFigure`) and is a button →
breakdown panel: per-raw-model groups with `tokens × rate` lines,
multipliers inline (`(2 × $5.00/M)`), and the R10 interval in effect; the
disclosure lines that apply (R2/R4/R5/R6/R7/R9 cited by number); then "show
the N requests" expanding to a per-row table with 1-based file:line links to
L5, fetched via `/api/records` pages (default 300, cap 5,000). The server's
CostAgg is the headline and its `rowsSumToHeader` check is shown; the panel
additionally reprices only the rows actually fetched for the open panel
client-side with the same shared module and asserts equality on that page —
at store scope it shows the server's check plus the first page rather than
shipping 29,741 rows. `PRICING_VERSION` shown.

## 7. Loading & liveness
Chrome first (crumbs/scope/header frame from the index, `—` pips at final
widths); determinate progress only (real bytes/agent counts over SSE), no
indeterminate spinners; <150ms shows nothing. Cache state visible at L0.
Changes on disk → non-modal "N sessions changed — Reload" bar (no re-render
under the reader); live sessions badged with byte-progress. Poll
`/api/index?since=<version>` (SPEC §9): 1s while building, 5s liveness.
A session page has no index status to poll — it polls its OWN `r2` field
instead. That field is not exclusive to one route: `/api/project`,
`/api/session`, `/api/turn`, `/api/agent` and `/api/records` all ship a
top-level `r2: 'pending'|'resolved'` (SPEC §9), never the index's
status/pending shape. The session page reads `/api/session`'s copy:
while `r2 === 'pending'` it rechecks quietly at 1s and, the moment R2
resolves, repaints the disclosure BAND only (the R2-pending chip's claim has
expired) and offers "R2 resolved — fork attribution is now exact" on the
reload bar for the fork banners in the page. Never a full re-render.
The two watchers are symmetric, because only one poll is ever outstanding:
each tick of the quiet R2 watcher compares the payload's `bytes`/`events`
against the previous one and offers "this session grew on disk" the same way
the live watcher does, and the moment the session is live it hands the poll
slot to the 5s live watcher (which hands it back when growth stops before R2
resolves). Growth is reported once and then handed off — never re-checked at
1s, which would re-show a dismissed reload bar five times as often. A session
that resolves R2 while still live keeps the 5s watcher; one that is not live
stops polling, because nothing is left to watch.

## 8. First run / distribution
`start.bat` per SPEC §9 (`cd /d "%~dp0"`, `where node` guard with
plain-language message, quoted paths, window stays open, `if errorlevel 1
pause`) → `node lens.mjs --serve --open`. Port probe focuses an existing
instance. No config → probe `~/.claude/projects`; found → index
immediately; not found → setup screen with dir field + validation preview
(never an empty dashboard). Zip = the folder, no deps, no build. The app
never writes into the store.

**Typefaces ship with the folder or not at all.** The UI is a three-face
system — a display face for headings, a chrome face for everything scanned, and
Georgia for the one thing that is read (rendered markdown) — over the system
mono that carries every figure, id, date and locator. Nothing is fetched from a
font host: each face is declared `local()` first, then a `woff2` served by this
server out of `web/fonts/`, which **ships empty by design** (its README names
the four expected files). With that directory empty the `url()`s 404 and each
family falls through to the system stack the app used before, at `font-display:
swap` — so first paint never waits, no measure, `ch` width or size in the sheet
depends on a downloaded face, and "zip the folder and it runs" still holds with
or without the fonts in it.

**Focus, motion, and what never moves.** Focus-visible is a 3px ring in the
heading gold at a 3px offset, taking the shape of whatever it surrounds; it
clears 4.5:1 against every ground in both modes. Motion is three durations and
one curve: 180ms on control hovers, 380ms `cubic-bezier(.4,0,.2,1)` on the two
overlays and the disclosure marker, 300ms on the appearance cross-fade (the
ground fades, the inks snap — transitioning inherited text colour would repaint
every node on a 2,000-node page). Nothing animates at rest: there is no
keyframe animation in the app and every transition is entered from a pointer, a
key or a click. `prefers-reduced-motion: reduce` removes all of it.

## 9. Deliberately excluded
All scoring/clustering/classification/summarisation; relevance ranking;
merging forked sessions (cross-link + R2 billing instead); annotations;
infinite scroll; markdown-by-default; trendlines; playback scrubber;
gap-compressed axes; magnitude-as-geometry; canvas; UI-editable rates;
cache-savings counterfactuals; estimates for missing data (incl. the
never-finalized shortfall and batch-tier rates for unobserved tiers); a
curated home.

## 10. Edge cases with designed screens
**0-agent sessions are the majority case (68 of 85), not an edge case** —
the default L2 layout is designed for them (no concurrency strip, turn-list
default). Remaining edge cases: 1-giant-turn agentic sessions (flip to
agents only when agents exist + queue-op band); fragment session dirs
(badge, per-SPEC §2 case labels, cross-project links, billed transcripts
when present); forked sessions (banner, R2 disclosures, both-files links);
running/superseded agents (split groups, ⋯ glyph); in-flight workflow runs
(partial `…/w/<runId>` envelope); never-finalized responses (≈ chip with
recorded-stub wording); unpriced models (—† + banner); unknown-tier rows
(R9 chip); `<synthetic>` API-error events (rendered as events, excluded
from billing with note); scheduled-task sessions (origin shown);
out-of-order timestamps (file order + blank deltas + note); live/growing
files (prefix totals + byte progress); torn lines (inventory + raw bytes);
worktree agents (L3 tag + L4 facts, "path not on disk").
