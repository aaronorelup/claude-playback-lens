# Changelog

## 0.4.0 — one shared service instead of one server per session

**Why.** Claude Code starts one stdio MCP server per session. 0.3.0 already made those
servers thin forwarders to one shared index, but the processes themselves remained. With
about 30 sessions open, one Windows machine carried 15 `npx -y claude-playback-lens-mcp`
chains, each `cmd → npx → cmd → node` plus a console host, over 60 processes in all. None
were orphans; every parent was a live session.

**Added**
- `--http`: the shared daemon, long-lived, also serves MCP over Streamable HTTP at
  `http://127.0.0.1:8792/mcp` (`LENS_MCP_PORT` to change it). Sessions connect with
  `"type": "http"`, so an open session costs no process. It listens before the index is
  built (tool lists answer at once; calls wait for the index). It takes over the daemon lock
  from an idle-mode daemon, so stdio forwarders share its index too. Loopback only, with the
  SDK's Host/Origin checks. `GET /health` names the service, its pid and version.
- `--http --detach`: start the service in the background unless something already answers
  the port.
- `--install-service` / `--uninstall-service`: start it now and at every logon. On Windows
  this is a hidden launcher in the Startup folder (no admin rights, no console window).
  Installed through npx, the launcher fetches `@latest` once per logon.
- Plugin SessionStart hook (`plugin/hooks/ensure-service.mjs`, ~300 ms of `node`): starts
  the service if it is down, and replaces it if it is older than the plugin. It prints
  nothing and never blocks the session.
- `tests/mcp/http.test.mjs`: two sessions served by one process, cross-origin refusal,
  stdio forwarders routing to the service, the duplicate-start exit, and stdio exit on
  stdin close.

**Changed**
- The plugin's MCP server is now `"type": "http"` → `http://127.0.0.1:${LENS_MCP_PORT:-8792}/mcp`
  (was `npx -y claude-playback-lens-mcp` over stdio).
- A stdio server now exits when its session closes stdin or its parent process dies. The
  in-process fallback previously held an indexer worker and could outlive its session.
- Search tools (`lens_search`, `lens_file`, `lens_prompts`) say `calling session unknown`
  when they cannot identify the calling session, instead of silently including it. Over
  HTTP that is always the case: Claude Code does not pass the session id to HTTP servers,
  and a `${CLAUDE_CODE_SESSION_ID}` header would carry the parent session's id in a nested
  `claude`, which would skip the wrong session.
- Docs: stdio registrations should use `node <path>/mcp/lens-mcp.mjs` from a global
  install, not `npx -y`, which on Windows adds three processes and a registry check per
  session.

**Upgrading.** After the plugin updates, run `npx -y claude-playback-lens-mcp --install-service`
once, then restart the Claude Code sessions (or the desktop app) so the old stdio servers go
away.
