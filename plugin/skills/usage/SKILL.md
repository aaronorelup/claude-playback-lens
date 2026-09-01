---
name: usage
description: Answer questions about the user's own Claude Code usage, cost, sessions, and transcript history using the lens MCP tools instead of parsing ~/.claude/projects JSONL by hand. Use when the user asks what did X cost, how many tokens did that use, which model am I spending the most on, what's my Claude spend this week/month, find that session where I did X, what did that session actually do, or search my transcripts for some text.
---

# Playback Lens: reading your own Claude Code usage

Reach for these tools for **any** question about the user's own Claude Code
history — cost, tokens, sessions, projects, models, or transcript text. Never
hand-roll a parse of `~/.claude/projects/**/*.jsonl` for this. Two errors bite
every hand-rolled script, and the lens has already fixed both:

- **Double-billing.** Forked and resumed sessions repeat the same `message.id`
  across files. Summing rows counts that spend twice. The lens de-duplicates.
- **Blending unpriced rows into $0.** Rows with no rate are *unknown*, not free.
  The lens keeps them separate and tells you how many there were.

## The five tools

- `lens_status` — what the corpus holds and whether the index is ready. First
  call when you are unsure of scale, or when another tool says "still building".
- `lens_sessions` — turns "that session last Tuesday about the parser" into the
  `slug` + `id` every other tool needs. Filters on project/date/cwd/branch/title/cost.
- `lens_usage` — tokens and dollars, grouped by project, session, model, day, or agent.
- `lens_search` — find text across every transcript; returns match locators, not files.
- `lens_session` — the structure of one session: turns, subagents, cost, problems.

## Reading results

The lens never infers. Read its output the same way.

- **`—` means unrecorded, not zero.** Never relay it as `0`, "none", or "free".
  Say it was not recorded.
- **Every aggregate carries its denominator** ("over 41 of 60 sessions",
  "showing 1–10 of 27"). Repeat the denominator whenever you repeat the number.
- **Disclosure lines are part of the answer** (`inherited`, `unpriced`,
  `synthetic`, `neverFinalized`, `ttlAssumed`…). They say what could not be
  priced exactly. Do not drop them as noise.
- **`rowsSumToHeader`** is the independent cross-check that the rows shown sum
  to the header shown. If it fails, say so.

## Gotchas

- **`scope` is ONE string**, not fields: `store`, `project:<slug>`, or
  `session:<slug>/<id>`. Get slug and id from `lens_sessions` first — do not guess.
- **Dates and splits don't mix.** `since`/`until` are answered from day bands,
  which carry only tokens and dollars. A per-model (or per-session) split over a
  date range is **refused**, not approximated. Drop the dates to get the split,
  or keep the dates with `group_by:"day"`.
- **`group_by:"agent"` requires a session scope.**
- **The per-component USD split** (input/output/cacheWrite/cacheRead/webSearch)
  lives at `group_by:"none"` with `detail:true`.
- **A capped search prints a `cursor`.** Pass it back verbatim with the same
  `q`/`scope` to resume.
- **`structured:true`** adds machine-readable JSON with exact integer tcu
  (USD = tcu / 2e9) — use it when you need to compute, not just report.

## Examples

- *"What did I spend on Claude Code last month, by project?"* →
  `lens_usage {scope:"store", group_by:"project", since:"2026-04-01", until:"2026-04-30"}`
- *"Which model am I burning the most tokens on?"* →
  `lens_usage {scope:"store", group_by:"model"}` — no dates, or the split is refused.
- *"Find the session last week where I rewrote the CSV importer."* →
  `lens_sessions {title_contains:"importer", since:"2026-05-04"}` (recorded titles
  only — use `lens_search` to match transcript text), then
  `lens_session {slug:"widget-shop", id:"11111111-2222-3333-4444-555555555555"}`.
- *"Where did I ever mention `retry_backoff`?"* →
  `lens_search {q:"retry_backoff", scope:"store"}`, then open a hit with `lens_session`.

## Not built yet

`lens_rows`, `lens_workflow`, and `lens_read` are phase 2 and **do not exist**.
The tools say so themselves. Do not call them and do not promise them.
