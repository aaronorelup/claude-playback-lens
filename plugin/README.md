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

The plugin connects to **one shared local service** (`http://127.0.0.1:8792/mcp`) instead of
starting a server process per session. Start the service now and at every logon (once per
machine; on Windows a hidden Startup-folder launcher, no admin):

```
npx -y claude-playback-lens-mcp --install-service
```

Then:

```
/plugin marketplace add aaronorelup/claude-playback-lens
/plugin install playback-lens@claude-playback-lens
```

The plugin's SessionStart hook restarts the service if it is not running. Claude Code
connects to MCP servers while that hook runs, so a session that found the service down starts
without the lens tools. The next session has them, or run `/mcp` → lens → Reconnect.

## Keep it current

The logon launcher runs the newest npm release, and the plugin's hook replaces a running
service that is older than the plugin. The **plugin** (and the skill inside it) updates only
when Claude Code refreshes this marketplace, which it does automatically **only if you turn
auto-update on**, because Claude Code leaves it off for third-party marketplaces:

`/plugin` → **Marketplaces** → `claude-playback-lens` → **Enable auto-update**

To update right now instead, in a terminal:

```
claude plugin marketplace update claude-playback-lens
claude plugin update playback-lens@claude-playback-lens
```

then restart Claude. Until you do, nothing breaks: the server ships its own usage
instructions (always as current as the code), `lens_status` names the package, engine and
plugin versions, and flags a skill that is older than the server.

## Requirements

**Node >= 20** on PATH (the hook and the service are both `node`).

Nothing writes to your corpus, and nothing leaves your machine. The service listens on
127.0.0.1 only and refuses browser pages. Files it writes: your rate file
`~/.claude/playback-lens/pricing.json`, and its state and log under
`~/.claude/playback-lens/run/`. To remove it: `npx -y claude-playback-lens-mcp --uninstall-service`.

## More

- Project overview and the viewer UI: [root README](https://github.com/aaronorelup/claude-playback-lens#readme)
- How the MCP server works, its output rules and token budgets:
  [`mcp/README.md`](https://github.com/aaronorelup/claude-playback-lens/blob/main/mcp/README.md)

MIT.
