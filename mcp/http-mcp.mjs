// mcp/http-mcp.mjs — the daemon's Streamable HTTP MCP endpoint (POST /mcp).
//
// Why it exists: the stdio shape costs one server process per Claude Code
// session. On Windows, `npx -y claude-playback-lens-mcp` makes that FOUR
// processes plus a conhost per session (cmd → npx → cmd → node); thirty open
// sessions measured fifteen of those chains. With this endpoint the shared
// daemon IS the MCP server: Claude Code connects to http://127.0.0.1:<port>/mcp
// ("type": "http"), and an open session costs a socket, not a process tree.
//
// The SDK's createMcpHandler speaks web-standard Request/Response; the daemon
// is plain node:http. The adapter below is the whole bridge — no framework.
//
// Security: loopback only, and the SDK's own Host and Origin checks refuse a
// browser page (DNS rebinding, cross-site POSTs). There is no token: any local
// process could already read ~/.claude/projects directly, which is all this
// endpoint serves, read-only.

import { Readable } from 'node:stream';
import {
  McpServer,
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
} from '@modelcontextprotocol/server';
import { serverInstructions } from './instructions.mjs';

const MAX_BODY = 1 << 20;

/**
 * createHttpMcp({ tools, invoke, version, log }) -> { handle(req, res), close() }
 *
 * tools: [{ name, def }] — schemas to advertise (engine.collectTools output).
 * invoke(name, args, caller): runs one call; the daemon's engine.invoke.
 */
export function createHttpMcp({ tools, invoke, version, log = () => {} }) {
  const instructions = serverInstructions();
  // One factory for every request (stateless serving): registration is pure.
  //
  // WHO IS CALLING: unknown, on purpose. The stdio forwarder knows its session
  // (Claude Code puts CLAUDE_CODE_SESSION_ID in the environment of processes
  // it starts) and the search tools skip that session's own events. Over HTTP
  // nothing carries it: Claude Code expands ${VAR} in .mcp.json headers from
  // its OWN environment, which does not hold the id — except in a claude
  // started from another session's shell, where it holds the PARENT's id and
  // would make the tools skip the wrong session. So no header is read, and
  // the tools say "calling session unknown" instead of guessing.
  const factory = () => {
    const server = new McpServer(
      { name: 'claude-playback-lens', version },
      { capabilities: { tools: {} }, instructions },
    );
    for (const t of tools) server.registerTool(t.name, t.def, (args) => invoke(t.name, args, { sessionId: null }));
    return server;
  };
  const handler = createMcpHandler(factory, {
    legacy: 'stateless',
    onerror: (e) => log(`mcp http: ${(e && e.message) || e}`),
  });

  async function handle(req, res) {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413).end(); return; }
        chunks.push(c);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const url = `http://${req.headers.host || '127.0.0.1'}${req.url}`;
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        signal: ac.signal,
      });
      const response = hostHeaderValidationResponse(request, localhostAllowedHostnames())
        ?? originValidationResponse(request, localhostAllowedOrigins())
        ?? await handler.fetch(request);
      const outHeaders = {};
      response.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(response.status, outHeaders);
      if (!response.body) { res.end(); return; }
      Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      log(`mcp http request failed: ${(e && e.stack) || e}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
    }
  }

  return { handle, close: () => handler.close?.() };
}
