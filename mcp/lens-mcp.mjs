#!/usr/bin/env node
// lens-mcp.mjs — entry point for the Claude Playback Lens MCP server.
//
// Speaks MCP over stdio. Every step below is ordered deliberately and the
// order is load-bearing; the comments say why rather than what.
//
// ONE STRUCTURAL NOTE UP FRONT, because it explains the shape of this file:
// ESM `import` declarations are hoisted. Every static import in a module runs
// to completion BEFORE the module's first statement executes. So the two
// guards below — the --help handler and the stdout redirect — could not
// actually come first if the things they guard were imported statically. They
// are therefore dynamic `await import(...)` calls further down. Only node's
// own side-effect-free builtins are imported statically here.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
// The engine ships in this same package, one directory up. There is no search,
// no probe and no override: the MCP server and the engine it adapts are one
// unit, versioned together, and pointing this process at a foreign engine
// checkout is precisely the version-drift failure the KAN-126 merge removed.
const REPO_ROOT = path.resolve(MCP_DIR, '..');
const ARGV = process.argv.slice(2);

// ---------------------------------------------------------------- 1. --help
//
// FIRST, before anything imports the lens. lens.mjs has a module-level --help
// handler of its own: it reads process.argv and calls process.exit(0) at
// import time. If this process were invoked with --help and imported the lens
// before handling it, the LENS's help text would print and the process would
// exit from inside an import, which is a confusing thing to debug.
if (ARGV.includes('--help') || ARGV.includes('-h')) {
  process.stdout.write(`claude-playback-lens-mcp — MCP server over Claude Code's transcript store

  node mcp/lens-mcp.mjs

Speaks MCP over stdio; it is started by an MCP client, not by hand. Running it
in a terminal is useful only to check that it boots — it will then sit waiting
for JSON-RPC on stdin.

The lens engine ships in this same package (../lens.mjs, ../server, ../shared)
and is imported directly. There is nothing to point at and nothing to find.

Environment:
  CLAUDE_PROJECTS       corpus root. The lens's own ladder applies:
                        --projects > CLAUDE_PROJECTS > config.json > ~/.claude/projects
  LENS_CACHE_DIR        index cache location. Defaults to <repo root>/.cache/mcp —
                        a writer directory of its own, so this process never
                        contends with the lens UI's cache writer at <repo root>/.cache.
  LENS_MCP_MAX_CHARS    hard cap on one tool result's rendered text (default 20000)
  LENS_MCP_INPROCESS=1  hold the index in this process instead of the shared daemon
  LENS_DAEMON_IDLE_MS   shared daemon exits after this long with no calls (default 900000)
  LENS_STATE_DIR        daemon lock/info/log files (default ~/.claude/playback-lens/run)
  LENS_PRICING_FILE     user rate file (default ~/.claude/playback-lens/pricing.json)

Every Claude Code session starts its own copy of this server. Those copies are
thin forwarders: ONE shared daemon per corpus holds the index and exits when
idle, so N open sessions cost one index, not N.

Registering it with Claude Code:
  claude mcp add --scope user lens -- node "<repo root>/mcp/lens-mcp.mjs"
`);
  process.exit(0);
}

// ---------------------------------------------------------------- 2. stdout guard
//
// On the stdio transport, stdout IS the JSON-RPC channel. A single stray
// console.log anywhere in this process — ours, the lens's, or a dependency's —
// injects non-JSON bytes into the stream, and the failure mode is silent and
// baffling: the client reports that the server did not start, with no
// indication why. So console.log/info/warn are redirected to stderr before
// anything else can run module-level code. lens.mjs's main() and
// resolveProjects() both use console.log.
//
// The SDK writes to stdout through the transport's own handle, not through
// console, so this redirect cannot break the protocol.
console.log = (...a) => console.error(...a);
console.info = (...a) => console.error(...a);
console.warn = (...a) => console.error(...a);

// WHAT THIS GUARD COVERS, EXACTLY. It rebinds console on THIS process, so it
// catches anything that reaches stdout through console from this thread — ours,
// the lens's, or a dependency's. It does NOT cover the indexer WORKER THREAD:
// node auto-pipes a Worker's stdout into the parent's real stdout unless the
// worker is constructed with `stdout: true`, and the lens constructs it without
// that option, so a console.log on the worker side would bypass this rebinding
// entirely and land on the wire. Nothing in the lens's worker-side code writes
// to stdout today — that is a property of the lens, not something this file can
// enforce — and tests/stdio.test.mjs is what enforces it: it drives the real
// process with the real worker running and asserts every byte on the pipe is a
// JSON-RPC message, so a future lens regression fails the suite here.
//
// So: every byte THIS thread writes that is not JSON-RPC goes to stderr, and
// the worker's stdout is outside the guard and covered by the purity test.
const log = (msg) => process.stderr.write(`[lens-mcp] ${msg}\n`);

// ---------------------------------------------------------------- 3. SDK import
//
// The lens engine is dependency-free; this server is not. If node_modules is
// missing, say so in plain language on stderr — an MCP client shows the user
// stderr when a server fails to start, and that message is the only diagnostic
// they will see.
let McpServer;
let serveStdio;
try {
  ({ McpServer } = await import('@modelcontextprotocol/server'));
  ({ serveStdio } = await import('@modelcontextprotocol/server/stdio'));
} catch (e) {
  process.stderr.write(
    `Claude Playback Lens MCP needs its dependencies. Run: npm install in ${REPO_ROOT}\n`
    + `  (${(e && e.message) || e})\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------- 4. mode
//
// THREE shapes, one entry point:
//
//   --daemon              the shared process that holds the index
//                         (mcp/daemon.mjs). Spawned by forwarders, never by
//                         an MCP client.
//   default (forwarder)   what every Claude Code session runs. Answers
//                         tools/list from the schemas and forwards each call
//                         to the daemon, spawning it when needed. One index
//                         for all sessions instead of one per session.
//   LENS_MCP_INPROCESS=1  the pre-daemon shape: this process builds and holds
//                         its own index. Also the automatic fallback when the
//                         daemon cannot be reached — availability beats memory.
if (ARGV.includes('--daemon')) {
  const { runDaemon } = await import('./daemon.mjs');
  await runDaemon();
} else {
  const engineMod = await import('./engine.mjs');
  const { TOOLS_VERSION, lens } = engineMod;
  log(`lens: ${REPO_ROOT} (in-package — engine and MCP server ship together)`);

  const inProcess = process.env.LENS_MCP_INPROCESS === '1';
  let engine = null;
  let enginePromise = null;
  const localEngine = () => {
    if (!enginePromise) enginePromise = engineMod.createEngine({ log, mode: 'in-process' }).then((e) => (engine = e));
    return enginePromise;
  };

  let forwarder = null;
  if (inProcess) {
    await localEngine();
  } else {
    const { createForwarder } = await import('./forwarder.mjs');
    forwarder = createForwarder({ log });
    log(`forwarding tool calls to the shared lens daemon (state: ${forwarder.paths.dir})`);
  }

  async function invoke(name, args) {
    if (forwarder) {
      try {
        return await forwarder.invoke(name, args);
      } catch (e) {
        log(`daemon unreachable (${(e && e.message) || e}) — falling back to an in-process index for this session`);
        forwarder = null;
      }
    }
    await localEngine();
    return engine.invoke(name, args, { sessionId: process.env.CLAUDE_CODE_SESSION_ID || null });
  }

  // Schemas only: the handlers captured here are never called in forwarder
  // mode; every call goes through invoke() above.
  const tools = engineMod.collectTools(engineMod.schemaDeps());
  // The usage guide rides the MCP handshake, so it is always as current as
  // this code — see mcp/instructions.mjs.
  const { serverInstructions } = await import('./instructions.mjs');
  const instructions = serverInstructions();

  // serveStdio takes a FACTORY, not a server instance. It calls the factory to
  // build the instance it pins to the connection, and it may build and discard
  // one while probing which protocol era the client speaks. So the factory
  // registers the tools fresh each time it runs. Registration is pure.
  function buildServer() {
    const server = new McpServer({
      name: 'claude-playback-lens',
      // The lens's own version. One version for the app; TOOLS_VERSION tracks
      // this tool surface separately and is reported by lens_status.
      version: lens.core.APP_VERSION,
    }, { capabilities: { tools: {} }, instructions });
    for (const t of tools) server.registerTool(t.name, t.def, (args) => invoke(t.name, args));
    return server;
  }

  log(`serving MCP over stdio — ${tools.length} tools (tools v${TOOLS_VERSION})`);
  await serveStdio(buildServer, {
    // Transport-level failures are otherwise swallowed. They go to stderr like
    // everything else that is not JSON-RPC.
    onerror: (e) => log(`transport error: ${(e && e.stack) || e}`),
  });
}
