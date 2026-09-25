# playback-lens (Claude Code plugin)

Search and replay your own Claude Code history — every time you mentioned
something, every command a session ran, which session moved a file — and ask
what it cost, instead of grepping gigabytes of JSONL in `~/.claude/projects`.

The plugin bundles two things:

- **the `lens` MCP server** — `lens_search` (timeline search by event kind,
  tool and date), `lens_read` (open a hit), `lens_sessions`, `lens_session`,
  `lens_usage`, `lens_status`, and `lens_pricing` (see and repair the rate
  table for newly released models). Every figure is a recorded fact or
  arithmetic over recorded facts; an unknown value renders `—`, never `0`.
- **the `/playback-lens:usage` skill** — the search recipes ("every time I
  mentioned X", "which session moved this file"), the pricing-gap repair
  procedure, and how to read a result without inventing numbers.

## Install

```
/plugin marketplace add aaronorelup/claude-playback-lens
/plugin install playback-lens@claude-playback-lens
```

## Requirements

**Node >= 20.** The server is launched with `npx -y claude-playback-lens-mcp`,
which fetches the npm package on first run — plugin installs never run
`npm install`, so nothing is vendored here.

Nothing writes to your corpus, and nothing leaves your machine. The only file
the plugin writes is your own rate file, `~/.claude/playback-lens/pricing.json`.
One shared background process holds the index for all sessions and exits after
15 idle minutes.

## More

- Project overview and the viewer UI: [root README](https://github.com/aaronorelup/claude-playback-lens#readme)
- How the MCP server works, its output rules and token budgets:
  [`mcp/README.md`](https://github.com/aaronorelup/claude-playback-lens/blob/main/mcp/README.md)

MIT.
