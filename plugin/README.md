# playback-lens (Claude Code plugin)

Ask Claude about your own Claude Code usage — what a project cost this week,
which model you are spending on, which session did that thing, what a past
session actually did — instead of writing a throwaway parse script over a
gigabyte of JSONL in `~/.claude/projects`.

The plugin bundles two things:

- **the `lens` MCP server** — five read-only tools (`lens_status`,
  `lens_sessions`, `lens_usage`, `lens_search`, `lens_session`) over your local
  transcript store. Every figure is a recorded fact or arithmetic over recorded
  facts; an unknown value renders `—`, never `0`.
- **the `/playback-lens:usage` skill** — the knowledge the tool descriptions
  cannot carry: when to reach for the tools, how to read a result without
  inventing numbers, and the gotchas (scope grammar, date-band refusals).

## Install

```
/plugin marketplace add aaronorelup/claude-playback-lens
/plugin install playback-lens@claude-playback-lens
```

## Requirements

**Node >= 20.** The server is launched with `npx -y claude-playback-lens-mcp`,
which fetches the npm package on first run — plugin installs never run
`npm install`, so nothing is vendored here.

Nothing writes to your corpus, and nothing leaves your machine.

## More

- Project overview and the viewer UI: [root README](https://github.com/aaronorelup/claude-playback-lens#readme)
- How the MCP server works, its output rules and token budgets:
  [`mcp/README.md`](https://github.com/aaronorelup/claude-playback-lens/blob/main/mcp/README.md)

MIT.
