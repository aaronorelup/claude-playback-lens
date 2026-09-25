// tests/mcp/helpers.mjs — shared test setup for the MCP server's suite.
//
// The tests run against the engine's own test fixture store, not against the
// developer's real ~/.claude/projects: the fixture has hand-computed expected
// totals (tests/fixtures/api/make-store.mjs EXPECT) that a real corpus cannot
// provide, and it is small enough to index in milliseconds.
//
// The fixture store is generated rather than committed (it is listed in
// .gitignore) and the lens's own tests call makeStore() in a `before` hook on
// every run, so calling it here writes nothing the suite does not already
// write; makeStore is idempotent and leaves unchanged files untouched.
//
// Since the KAN-126 merge the engine is in this same repo, so the fixture is a
// plain relative import away — no lens directory to locate, and nothing to set
// in the environment before running the suite.
//
// LENS_CACHE_DIR is pointed at a scratch directory per run for the same reason
// createContext isolates it in normal operation: an index cache belongs to one
// process.

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createContext, lens } from '../../mcp/context.mjs';
import * as fixtures from '../fixtures/api/make-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repo root — engine, MCP server and this suite all live under it. */
export const REPO_ROOT = path.resolve(HERE, '../..');
/** The MCP server's own directory. */
export const MCP_DIR = path.join(REPO_ROOT, 'mcp');

export { lens };

/** Build the engine's fixture store. Returns the module namespace so a test
 *  can read STORE / EXPECT / SLUG / S1 / S2. */
export async function lensFixtures() {
  await fixtures.makeStore();
  return fixtures;
}

/**
 * Build a started ctx over the fixture store, plus the lens bundle.
 * The caller must `await ctx.index.close()` when done — the indexer runs on a
 * worker thread and would otherwise keep the test process alive.
 */
export async function fixtureContext() {
  const store = await lensFixtures();

  // The corpus root and the cache dir are both process-global inputs to the
  // lens's own resolution ladders, so they are set here rather than passed.
  process.env.CLAUDE_PROJECTS = store.STORE;
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lens-mcp-test-'));
  process.env.LENS_CACHE_DIR = cacheDir;

  const ctx = await createContext();
  // start() spawns the indexer and returns; it does not wait for the build.
  // The fixture store is two sessions, so waiting for 'ready' is fast and
  // makes the assertions below deterministic.
  await ctx.index.start();
  await waitReady(ctx);

  return {
    ctx,
    lens,
    fixtures: store,
    async close() {
      await ctx.index.close();
      await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Poll until the index reports 'ready' with every session summarised, or the
 *  deadline passes. A timeout here is a real failure, not a flake to retry:
 *  the fixture store is two small sessions. */
export async function waitReady(ctx, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = ctx.index.status();
    if (st.state === 'ready' && st.sessionsDone === st.sessionsTotal && st.sessionsTotal > 0) return st;
    if (st.state === 'failed') throw new Error('index failed while waiting for ready');
    if (Date.now() > deadline) {
      throw new Error(`index not ready after ${timeoutMs}ms: ${JSON.stringify(st)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// --------------------------------------------------------- honest hints
//
// The rule lens_search's renderer established and every other renderer now
// follows. This server registers FIVE tools. lens_read, lens_rows and
// lens_workflow are phase 2 and deliberately unbuilt, so a rendered line that
// spells one of them out as a literal call — `lens_rows scope="turn:…"` —
// reads as callable, fails at the tool boundary, and sends the reader into the
// raw .jsonl by hand, which is the work these tools exist to remove.
//
// So: a `next:` hint may only offer a tool that exists; an unbuilt tool may be
// NAMED only alongside an explicit statement that it is unavailable; and the
// locator that made the dead hint worth printing must survive as data.

export const PHASE1_TOOLS = ['lens_status', 'lens_sessions', 'lens_usage', 'lens_search', 'lens_session', 'lens_read', 'lens_pricing'];
export const UNBUILT_TOOLS = ['lens_rows', 'lens_workflow'];

/** Every `name arg=` shape in the text — i.e. everything rendered as a call. */
export const literalCalls = (text) => [...new Set(text.match(/\blens_[a-z_]+(?=\s+[a-z_]+=)/g) || [])];

/**
 * assertHonestHints(assert, text, label)
 *
 * Applied to one rendered result. Throws on the three ways a hint block lies.
 */
export function assertHonestHints(assert, text, label = 'result') {
  for (const name of UNBUILT_TOOLS) {
    assert.ok(!new RegExp(`\b${name}\s+[a-z_]+=`).test(text),
      `${label}: ${name} is unbuilt; rendering it with arguments makes it look callable:\n${text}`);
    assert.ok(!new RegExp(`^\s*${name}\b`, 'm').test(text),
      `${label}: ${name} must never OPEN a line — that position is where the callable tools go:\n${text}`);
    // Named at all? Then the same line has to say it cannot be called.
    for (const line of text.split('\n')) {
      if (!line.includes(name)) continue;
      assert.match(line, /phase 2/,
        `${label}: ${name} is named without saying it is phase 2:\n${line}`);
      assert.match(line, /not (callable|implemented) yet/,
        `${label}: ${name} is named without saying it is unavailable:\n${line}`);
    }
  }
  for (const c of literalCalls(text)) {
    assert.ok(PHASE1_TOOLS.includes(c), `${label}: hint names ${c}, which this server does not register`);
  }
}
