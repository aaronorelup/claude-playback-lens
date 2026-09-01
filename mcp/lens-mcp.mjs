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

// ---------------------------------------------------------------- 4. the lens
//
// mcp/context.mjs statically imports the engine from ../lens.mjs and ../server,
// builds the same ctx the lens's own main() builds, and hands back the module
// bundle every tool reads. start() must complete before any tool is callable:
// every index-backed route reads ctx.index, and an unstarted index answers 409
// for everything.
const { createContext, TOOLS_VERSION, lens } = await import('./context.mjs');
const { createDispatcher } = await import('./dispatch.mjs');
const render = await import('./render.mjs');

log(`lens: ${REPO_ROOT} (in-package — engine and MCP server ship together)`);

const ctx = await createContext();
log(`corpus: ${ctx.projectsDir} (from ${ctx.projectsDirSource})`);
log(`cache: ${ctx.cacheDir}`);

log('starting index…');
await ctx.index.start();
const st = ctx.index.status();
log(`index ${st.state}: ${st.sessionsDone} of ${st.sessionsTotal} sessions, ${st.bytesIndexed} of ${st.bytesTotal} bytes`);

// ---------------------------------------------------------------- 5. serve
//
// One dispatcher, shared by every tool: it owns the router and the memos that
// carry R2 canonical resolution, so two tools called in one session see the
// same de-duplication state the UI would.
const call = createDispatcher(lens, ctx);

// Every tool module exports register(server, deps) and is otherwise
// self-contained, so one tool can be rewritten without touching another.
const deps = {
  ctx,     // the lens's ctx — what the API handlers read
  lens,    // the imported lens module bundle
  call,    // the dispatcher: call(method, pathname, query) -> { status, json }
  render,  // mcp/render.mjs, whole namespace
  // lensDir is the engine's own root, which in-package IS the repo root.
  meta: { TOOLS_VERSION, lensDir: REPO_ROOT, mcpDir: MCP_DIR },
};

const tools = await Promise.all([
  import('./tools/status.mjs'),
  import('./tools/sessions.mjs'),
  import('./tools/usage.mjs'),
  import('./tools/search.mjs'),
  import('./tools/session.mjs'),
]);

// serveStdio takes a FACTORY, not a server instance. It calls the factory to
// build the instance it pins to the connection, and it may build and discard
// one while probing which protocol era the client speaks. So the factory
// registers the tools fresh each time it runs. Registration is pure — the
// expensive state (the index, the dispatcher's memos) is built once above and
// captured by closure, so a second construction costs nothing.
function buildServer() {
  const server = new McpServer({
    name: 'claude-playback-lens',
    // The lens's own version. One version for the app; TOOLS_VERSION tracks
    // this tool surface separately and is reported by lens_status.
    version: lens.core.APP_VERSION,
  }, { capabilities: { tools: {} } });
  for (const tool of tools) tool.register(server, deps);
  return server;
}

log(`serving MCP over stdio — ${tools.length} tools (tools v${TOOLS_VERSION})`);
await serveStdio(buildServer, {
  // Transport-level failures are otherwise swallowed. They go to stderr like
  // everything else that is not JSON-RPC.
  onerror: (e) => log(`transport error: ${(e && e.stack) || e}`),
});
