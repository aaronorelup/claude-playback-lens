# Claude Playback Lens

Play back what your Claude Code sessions actually did — every turn you sent, the
tool calls it made, the screenshots it looked at, the diffs it wrote, and what it
cost.

It is a small local Node server plus a plain-ESM browser client. You run it on
your own machine, it reads `~/.claude/projects` straight off disk, and the page
talks to it over `http://127.0.0.1`. There are no dependencies, no build step,
no account, and nothing is uploaded anywhere.

## The one design rule

> "I don't want you to do any clever tricks to try to infer things and extract
> information. I just want you to make the information that's already there
> easily viewable. It should be a glorified JSON reader."

Everything here serves that. It shows what the transcript records, in the order
it records it, and lets adjacency do the explaining. Where a number is derived —
cost, latency, a turn boundary — it is arithmetic on recorded fields, and the
rule is written next to it in the UI. Nothing is clustered, scored or guessed at.

The rule has a sharp edge that is worth stating outright: **the app may never
claim a recorded fact is absent.** An unknown renders as `—` plus the reason it
is unknown; a real zero renders as `0`. They are never the same glyph.

## Status

This is **v3**, a ground-up rebuild. The previous generation was a different
architecture entirely; none of it survives, and neither does anything that was
written about it. The tree today is `server/` (15 modules) + `web/js/` (an ESM
client that talks to a JSON API).

The build is complete and running. It went through 18 adversarial review
rounds — an independent reader hunts for places the UI asserts something the
transcript does not record, a validator re-derives each finding against the live
server, and the survivors get fixed with a named regression test. 89 validated
defects were fixed that way. The suite is 961 tests, all green.

## Quickstart

```bash
node lens.mjs --serve
```

Then open <http://localhost:8791>. On Windows you can double-click
**`start.bat`** instead (`start.sh` on macOS/Linux) — it checks for Node, tells
you where to get it if it is missing, and starts the server with `--open`.

Starting a second time does not start a second server: the launcher probes
`/api/hello` first, and if something answers it reports that instance's pid and
exits — with `--open` (which is what `start.bat` uses) it points your browser at
the one already running.

## CLI

```
node lens.mjs --serve [--open] [--port N] [--projects DIR]
```

| Flag | What it does |
|---|---|
| `--serve` | start the server (default port 8791) |
| `--open` | open your browser at it once it is listening |
| `--port N` | listen on N instead of 8791 |
| `--projects DIR` | read transcripts from DIR instead of `~/.claude/projects` |
| `--help`, `-h` | print the usage line and the precedence rule below |

Environment:

| Variable | What it does |
|---|---|
| `CLAUDE_PROJECTS` | transcripts directory |
| `PORT` | port, when `--port` is not given |
| `LENS_CACHE_DIR` | where the index cache is written |

The CLI prints its own precedence rule, and it is the authority:

```
Config precedence: --projects > CLAUDE_PROJECTS > config.json > ~/.claude/projects
```

The cache directory falls back the same way: `LENS_CACHE_DIR`, then
`<app>/.cache`, then your per-user cache dir, then tmp — the first one that is
actually writable. The projects directory can also be set from the app's own
settings page, which is what writes `config.json`.

## What it reads

```
<projectsDir>/<project-slug>/
  <sessionId>.jsonl                                             main transcript
  <sessionId>/subagents/agent-<agentId>.jsonl                   Agent-tool subagent
  <sessionId>/subagents/agent-<agentId>.meta.json               its sidecar (model, spawn depth)
  <sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl workflow subagent
  <sessionId>/subagents/workflows/<runId>/journal.jsonl         started/result events
  <sessionId>/workflows/<runId>.json                            the orchestration record
  <sessionId>/workflows/scripts/<name>-<runId>.js               the workflow script source
  <sessionId>/tool-results/<name>                               spilled large results
  memory/*.md                                                   project memory
```

The workflow record's `workflowProgress` array is the only place an agent's
**label, phase, state and attempt count** survive. The agent's own JSONL is the
only place its **tool sequence, screenshots, diffs and reasoning** survive.
Joining the two is the whole job, and it is what generic transcript viewers miss
— they show a flat list of anonymous sidechains and lose the orchestration.

The main transcript is often a *minority* of a session's bytes — as low as 1%.
Agent transcripts are about half the corpus. Nothing here treats the main file
as "the session".

## The model

```
project → session → turn → (agents and workflows spawned during that turn)
```

A **session is a conversation, not one prompt** — most sessions here hold
several turns, and a turn starts at a message you sent and runs until the next
one.

"You sent it" is read off the event's recorded `origin.kind` rather than guessed
from the text. A turn opens at a `user` event with `origin.kind === 'human'`, or
at an origin-less string event beginning `<command-message>` (a slash command,
which is a real prompt). A task notification or hook injection the runtime
pushed in does *not* open a turn — it shows as a row inside the turn it landed
in. Everything before your first message is the **preamble**, numbered 0 and
shown greyed. The rule is printed in the UI beside the turns it produced.

Agents are attributed to the turn containing their spawning `tool_use` line.
Where no spawn edge is recorded, the fallback is the turn whose time window
contains the agent's first timestamp — and the UI says which rule it used.

## The views

The app is a six-level spine. Every level has the same three bands — crumb rail,
a generated sentence saying exactly what the numbers below cover, and one stat
header — so a number never changes meaning as you drill.

| | Route | What it is |
|---|---|---|
| **L0** | `#/` | **the store.** Every project. Day bands newest-first, one bar per turn, coloured by project, split at local midnight. Also `?v=table`, `?v=sessions`, `?v=inventory`. |
| **L1** | `#/p/<slug>` | **one project.** Its sessions, its totals, its memory files. |
| **L2** | `#/p/<slug>/s/<sid>` | **one session.** Its turns; plus `?v=agents`, `?v=timeline`, `?v=workflows`, `?v=files`, `?v=images` (a contact sheet with tiles sized by recorded byte count). |
| **L3** | `#/p/<slug>/s/<sid>/t/<idx>` | **one turn.** What you asked for, and the orchestration it caused. |
| **L4** | `#/p/<slug>/s/<sid>/a/<agentId>` | **one agent** (`main` = the main thread). The recorded header facts, then that agent's timetable: one row per content block, in file order — prompt, reasoning, each tool call, each result, each screenshot, each attachment and hook message. |
| **L5** | `#/…/a/<agentId>/e/<line>[.<bi>]` | **one event, or one block of it.** Rendered at the top, the whole raw JSON line below with the addressed block highlighted. Addressed by 1-based line number and a dotted block path, so you can check it against the file in any editor. |

Because L4 is in file order and nothing is grouped, a screenshot sits under the
tool call that took it, and the reasoning under that is the reasoning about the
image — the adjacency does the explaining. It also means, with no special-casing,
that the first row is the prompt and the last row is what it returned.

Beside the spine:

- `#/p/<slug>/s/<sid>/w/<runId>` — **a workflow run.** Its manifest, its agents,
  its journal. An in-flight run renders a partial envelope that says what is
  known and does not pretend the missing manifest means anything.
- `#/p/<slug>/s/<sid>/inv` — **session inventory.** Every census: events by
  type, attachment kinds, images, files ledger, spill files, sessionIds seen,
  and the expected-zero counts, with problems carrying an "impacts totals?"
  column.
- `#/p/<slug>/s/<sid>/x/<relpath>` — **any raw file** in the session tree, and
  `#/p/<slug>/mem/<name>` for project memory. Nothing in the app lacks a raw view.
- `#/find` — substring or regex search across the store, streamed.
- `#/audit` — the reconciliation: an independently-written second pass over the
  same files, compared against the first, with the invariants listed pass/fail.
- `#/settings` — the projects directory, cache state, and the rate table.

**Pricing is read-only by design.** The rates live in `shared/pricing.mjs` and
changing one is a code change, not a preference (SPEC §6). The settings page
shows the table, its `PRICING_VERSION`, its retrieval date and its source URL,
so the estimate is auditable rather than adjustable behind your back.

## Numbers worth not misreading

- **Cost is an estimate, not a bill.** It multiplies the token counts in your
  transcripts by list rates. It cannot see negotiated discounts, batch pricing,
  or a subscription plan. Cache writes are billed at 1.25× input and cache reads
  at 0.1×.
- **Summed agent wall-clock exceeds real elapsed time.** Agents run concurrently.
  Both are shown; the sum is not a duration.
- **Output tokens dedupe by `message.id`.** One API message is written across
  several lines, each repeating that message's totals — summing the lines
  over-counts badly.
- **A turn's duration covers its agents**, so it can outlast the main thread's
  last line.
- **Cache reads dwarf output**, often 100×+, and bill at a fraction of it.
- **An agent that errored still billed** for everything it produced first.
- **Times are local**, everywhere. A UTC axis reads as a several-hour lie about
  when you were at the machine.

## How it stays fast on a gigabyte of transcripts

Three things do it, and none of them involve holding your corpus in memory.

**Base64 is stripped before `JSON.parse`.** Image payloads are ~62% of the
corpus by bytes. The reader replaces each one with `""` on the way past and
records what it removed — which key held it, how long it was, its decoded size,
and the first 24 characters, enough to sniff the media type. So the parse is
cheap *and* nothing is lost: the size you see on a screenshot is the size the
reader measured, not a guess.

**Indexing happens once, in a worker thread, and is cached on disk.** The
server spawns `server/indexer.worker.mjs`, which walks the store and writes one
`index.json` ledger holding per-session token tallies. Pages are served from
that. Rates are applied at read time, so editing the price table never
invalidates the cache; the ledger stores tokens only. Measured on the reference
corpus (85 sessions, 2,067 files, 1.18 GB): cold full index 5.2–6.8s, warm boot
first answer ~110 ms, median session parse 34 ms.

**Rows carry locators, not bodies.** Every row keeps its `{line, block}` address
and at most a 220-character head. Open a row and the server re-reads the one
line it lives on and returns the full text — or decodes the actual pixels
through `/api/image`. A parsed session's retained heap stays under ~10 MB.

## Repo layout

| Path | What it is |
|---|---|
| `lens.mjs` | the entrypoint: args → config → port probe → server → indexer worker |
| `server/` | the HTTP server, the JSONL reader, the parser, the cost ledger, the index cache, find, audit |
| `web/js/` | the client — `api.mjs` (the one door to the server), `router.mjs`, `components/`, `views/` |
| `web/index.html`, `web/styles.css` | the page |
| `shared/pricing.mjs` | the rate table, used by both sides |
| `tests/` | the suite (no dependencies — `node:test` only) |
| `docs/SPEC.md` | normative: file formats, the accounting rules (R1–R10), the API |
| `docs/DESIGN.md` | normative: the product surface, level by level |
| `docs/BUILD-CONTRACTS.md` | the module seams |

## Tests

```bash
node --test "tests/*.test.mjs"
```

961 tests, no dependencies, no server required — the browser-side tests install
a small fake `document` (`tests/helpers/fake-dom.mjs`) before importing the
view modules.

## Contributing notes

Read `docs/BUILD-CONTRACTS.md` before adding a function; the module seams are
deliberate and the tests pin them. Keep the suite green.

`INDEX_VERSION` (`server/index-store.mjs`) invalidates every cached SessionCard
on disk. Bump it when you change what the *persisted* card holds — not for a
change that is recomputed on every read. The constant carries a one-line reason
per bump; add yours.

Running a second instance with `--port N` works, but both instances then share
`<app>/.cache` — two full scans overwriting each other's index. Give the second
instance its own `LENS_CACHE_DIR`.

## Relation to `agent-metrics`

The `agent-metrics` skill answers *what did it cost*, as a table, for a
presentation appendix. This answers *what actually happened*. Same files, same
numbers.
