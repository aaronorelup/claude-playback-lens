// mcp/engine.mjs — the ONE place the index lives, and the tool table over it.
//
// Two processes use this module:
//
//   * the shared daemon (mcp/daemon.mjs) — the normal case. Claude Code starts
//     one MCP server per session, and before this split every one of them
//     built and held its own copy of the whole index (~0.5 GB each; eighteen
//     open sessions measured 11 GB). Now every session's process is a thin
//     forwarder and exactly one daemon per corpus holds the index.
//   * the in-process fallback (LENS_MCP_INPROCESS=1, or a daemon that could
//     not be reached) — the pre-split shape, kept because availability beats
//     memory when the daemon cannot start.
//
// collectTools() also runs in the forwarder WITHOUT an engine: it needs the
// tool names, schemas and descriptions to answer tools/list, and nothing else.
// Registration is pure — every tool touches ctx/call only inside its handler.

import { createContext, TOOLS_VERSION, lens, REPO_ROOT, MCP_DIR } from './context.mjs';
import { createDispatcher } from './dispatch.mjs';
import * as render from './render.mjs';
import { createUserPricing } from '../server/user-pricing.mjs';

import * as statusTool from './tools/status.mjs';
import * as sessionsTool from './tools/sessions.mjs';
import * as usageTool from './tools/usage.mjs';
import * as searchTool from './tools/search.mjs';
import * as sessionTool from './tools/session.mjs';
import * as readTool from './tools/read.mjs';
import * as pricingTool from './tools/pricing.mjs';
import * as promptsTool from './tools/prompts.mjs';
import * as fileTool from './tools/file.mjs';

export const TOOL_MODULES = [statusTool, sessionsTool, usageTool, searchTool, sessionTool, readTool, promptsTool, fileTool, pricingTool];
export { TOOLS_VERSION, lens, REPO_ROOT, MCP_DIR, render };

/**
 * collectTools(deps) -> [{ name, def, handler }]
 *
 * Runs every tool module's register() against a capturing stand-in for
 * McpServer. The result can be registered on a real server (in-process),
 * exposed over the daemon's socket, or — with handlers discarded — used by the
 * forwarder to advertise the same surface.
 */
export function collectTools(deps) {
  const out = [];
  const capture = { registerTool: (name, def, handler) => out.push({ name, def, handler }) };
  for (const m of TOOL_MODULES) m.register(capture, deps);
  return out;
}

/** Deps for a process that only needs schemas (the forwarder). */
export function schemaDeps() {
  const unavailable = () => { throw new Error('this process forwards tool calls; it holds no index'); };
  return {
    ctx: null,
    lens,
    call: unavailable,
    render,
    userPricing: null,
    meta: { TOOLS_VERSION, lensDir: REPO_ROOT, mcpDir: MCP_DIR, mode: 'forwarder' },
  };
}

/**
 * createEngine({ log, mode }) -> { ctx, tools, invoke(name, args), close() }
 *
 * Builds the ctx, starts the index, loads the user's rate file and builds the
 * tool table. invoke() validates arguments with the tool's own schema (so
 * defaults apply exactly as the MCP SDK applies them), refreshes the user
 * rate file, and runs the handler.
 */
export async function createEngine({ log = () => {}, mode = 'daemon' } = {}) {
  const ctx = await createContext();
  log(`corpus: ${ctx.projectsDir} (from ${ctx.projectsDirSource})`);
  log(`cache: ${ctx.cacheDir}`);

  const userPricing = createUserPricing(lens.pricing);
  const up = userPricing.state();
  log(`user rates: ${up.models.length} model(s) from ${up.file}${up.problem ? ` — PROBLEM: ${up.problem}` : ''}`);

  log('starting index…');
  await ctx.index.start();
  const st = ctx.index.status();
  log(`index ${st.state}: ${st.sessionsDone} of ${st.sessionsTotal} sessions, ${st.bytesIndexed} of ${st.bytesTotal} bytes`);

  // The dispatcher owns memos that hold PRICED aggregates keyed on the index
  // version. A user-rate change does not bump that version, so the dispatcher
  // is rebuilt instead — a fresh createApi, fresh memos, repriced on demand.
  let dispatch = createDispatcher(lens, ctx);
  const call = (...a) => dispatch(...a);

  const deps = {
    ctx,
    lens,
    call,
    render,
    userPricing,
    meta: { TOOLS_VERSION, lensDir: REPO_ROOT, mcpDir: MCP_DIR, mode },
  };
  const tools = collectTools(deps);
  const byName = new Map(tools.map((t) => [t.name, t]));

  function refreshPricing() {
    if (userPricing.refresh()) {
      dispatch = createDispatcher(lens, ctx);
      const s = userPricing.state();
      log(`user rates reloaded: ${s.models.length} model(s)${s.problem ? ` — PROBLEM: ${s.problem}` : ''}`);
    }
  }
  deps.onPricingChanged = () => { dispatch = createDispatcher(lens, ctx); };

  // caller: { sessionId } of the Claude Code session that made the call —
  // lens_search uses it to leave that session out (it matches its own query).
  async function invoke(name, args, caller = null) {
    const t = byName.get(name);
    if (!t) return render.errorResult(`unknown tool ${name}`);
    refreshPricing();
    const parsed = t.def.inputSchema ? t.def.inputSchema.safeParse(args ?? {}) : { success: true, data: args ?? {} };
    if (!parsed.success) {
      return render.errorResult(`${name}: invalid arguments — ${parsed.error.message}`);
    }
    return t.handler(parsed.data, { caller: caller || {} });
  }

  return {
    ctx,
    tools,
    invoke,
    async close() { try { await ctx.index.close(); } catch { /* exiting anyway */ } },
  };
}
