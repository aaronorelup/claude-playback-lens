#!/usr/bin/env node
// scripts/mcp-smoke.mjs — call all five MCP tools against the REAL corpus and
// print what an agent would actually receive.
//
//   node scripts/mcp-smoke.mjs
//
// This is a DEV SCRIPT, not a test, and it is deliberately not wired into
// `npm test`. The suite runs against the lens's fixture store, where the totals
// are hand-computed and the slugs are eight characters long. Neither of those
// is true of a 1.2 GB corpus with real project names, and two things only show
// up here:
//
//   1. Output QUALITY. Whether a real result reads as an answer or as a wall of
//      columns is a judgement a human makes by looking at it.
//   2. Output SIZE. Every rendered result is measured below and reported in
//      chars and in a ~chars/4 token proxy, against the recalibrated budgets
//      below (§7.1's own figures were written pre-implementation, at fixture
//      scale; these are what this corpus actually achieves). Locators
//      are never truncated, so the real driver of size is how long a real
//      slug + UUID is — which the fixtures cannot tell you.
//
// It spawns the server exactly as an MCP client does, over stdio, with NO
// CLAUDE_PROJECTS override: the lens's own ladder finds ~/.claude/projects, so
// this exercises the same corpus resolution a user gets.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A cold start reads and summarises the whole corpus. Real ones take seconds;
// this is the ceiling before giving up and saying so.
const READY_TIMEOUT_MS = 60000;
const POLL_MS = 1500;

// The per-tool budgets, in tokens, for the line each call prints. Exceeding one
// is not a failure here — it is the thing this script exists to show you.
// recalibrated 2026-08-23 against the real ~30-project corpus at TOOLS_VERSION 2 defaults; original spec §7.1 figures were fixture-scale estimates — see spec addendum.
// lens_status raised 175 -> 200 on 2026-08-23: its render scales weakly with the
// corpus (span line, problem kinds, disclosure counters), and the corpus grew
// 104 -> 128 sessions between calibration and the KAN-126 merge. 200 gives the
// measured 190 the same small headroom the other floors carry.
const BUDGET_TOK = { lens_status: 200, lens_usage: 525, lens_sessions: 600, lens_search: 700, lens_session: 700 };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, 'mcp', 'lens-mcp.mjs')],
  cwd: REPO_ROOT,
  // The server logs its engine root, corpus root, cache dir and index progress
  // to stderr. Inheriting it means you see the boot for free.
  stderr: 'inherit',
  env: { ...process.env },
});

const client = new Client({ name: 'lens-mcp-smoke', version: '0' });

let failed = false;
try {
  await client.connect(transport);
  console.log(`connected — server ${JSON.stringify(client.getServerVersion())}, protocol ${client.getNegotiatedProtocolVersion?.() ?? '?'}`);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log(`tools/list → ${tools.join(', ')}\n`);

  await waitReady();

  // One call per tool, with the defaults an agent would reach for first.
  await show('lens_status', {});
  await show('lens_usage', { scope: 'store', group_by: 'project' });
  await show('lens_sessions', { limit: 5 });
  await show('lens_search', { q: 'the', limit: 5 });
  // Deriving a real slug + id out of the lens_sessions output means parsing the
  // rendered table, which is exactly the thing this server exists to stop
  // anyone doing. So lens_session is called by ASKING the tool: lens_sessions
  // with structured:true hands back the locator as data.
  const locator = await firstLocator();
  if (locator) await show('lens_session', locator);
  else console.log('lens_session — skipped: the corpus reported no sessions to address.\n');
} catch (e) {
  failed = true;
  console.error(`\nsmoke failed: ${(e && e.stack) || e}`);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------

/** Poll lens_status until the index stops reporting itself as building. A
 *  pending result is a normal result whose text says so — never an error — so
 *  readiness is read out of the rendered text, the same way an agent would. */
async function waitReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const text = textOf(await client.callTool({ name: 'lens_status', arguments: {} }));
    if (!/still building|^index: building/m.test(text)) return;
    if (Date.now() > deadline) {
      console.log(`index still building after ${READY_TIMEOUT_MS / 1000}s — going ahead anyway; figures below cover what is indexed.\n`);
      return;
    }
    process.stderr.write('.');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Call one tool, print its rendered text verbatim, then its size. */
async function show(name, args) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = textOf(res);
  const tok = Math.round(text.length / 4);
  const budget = BUDGET_TOK[name];
  const verdict = budget === undefined ? '' : tok <= budget ? ` · within the ~${budget} tok budget` : ` · OVER the ~${budget} tok budget`;

  console.log(`${'='.repeat(78)}\n${name} ${JSON.stringify(args)}${res.isError ? '   [isError]' : ''}\n${'='.repeat(78)}`);
  console.log(text);
  console.log(`--- ${text.length} chars ≈ ${tok} tokens · ${ms}ms${verdict}\n`);
}

/** {slug, id} of the newest session, taken from structuredContent rather than
 *  from the rendered table. */
async function firstLocator() {
  const res = await client.callTool({ name: 'lens_sessions', arguments: { limit: 1, structured: true } });
  const first = res.structuredContent?.sessions?.[0];
  return first ? { slug: first.slug, id: first.id } : null;
}

function textOf(res) {
  return (res.content ?? []).map((c) => c.text ?? '').join('\n');
}
