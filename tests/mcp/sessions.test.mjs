// tests/mcp/sessions.test.mjs — lens_sessions (mcp/tools/sessions.mjs).
//
// The tool is the addressing layer: everything else on this server needs the
// `slug` + `id` it prints. So what is proved here is less "the code runs" than
// "the rendering is honest":
//
//  * every aggregate line carries its denominator,
//  * a filter that matches nothing renders a real answer, not an error,
//  * a session whose cost is not computable renders `—`, sorts last, and is
//    excluded from min_usd with the exclusion DISCLOSED — never silently
//    treated as $0,
//  * paging arithmetic is stated and the pages partition the matched list,
//  * a pending index is a state, not an isError.
//
// The tool is exercised through a fake MCP server that keeps the registered
// zod schema and parses arguments through it before calling the handler —
// which is what the real SDK does, so the schema's DEFAULTS are under test too
// rather than being re-specified here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as render from '../../mcp/render.mjs';
import { createDispatcher } from '../../mcp/dispatch.mjs';
import { register } from '../../mcp/tools/sessions.mjs';
import { TOOLS_VERSION } from '../../mcp/context.mjs';
import { fixtureContext, REPO_ROOT, MCP_DIR } from './helpers.mjs';

let H;      // { ctx, lens, fixtures, close }
let call;   // the real dispatcher

before(async () => {
  H = await fixtureContext();
  call = createDispatcher(H.lens, H.ctx);
});

after(async () => { if (H) await H.close(); });

// ------------------------------------------------------------------ harness

/**
 * A stand-in for McpServer that records the one registerTool call and exposes
 * the handler behind an `invoke(args)` that parses through the declared schema.
 * Parsing here is the point: the defaults in the schema (sort=recent, limit=20,
 * offset=0, structured=false) are the tool's contract, and a test that passed
 * them explicitly would not be testing them.
 */
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    get(name) {
      const t = tools.get(name);
      assert.ok(t, `tool ${name} was not registered`);
      return {
        config: t.config,
        invoke: (args = {}) => t.handler(t.config.inputSchema.parse(args)),
      };
    },
  };
}

// deps as lens-mcp.mjs builds them. `callOverride` lets a test substitute a
// response at the dispatcher seam — the only way to exercise a 409 or a
// null-agg card against a fixture store that has neither.
function tool(callOverride = null) {
  const server = fakeServer();
  register(server, {
    ctx: H.ctx,
    lens: H.lens,
    call: callOverride || call,
    render,
    meta: { TOOLS_VERSION, lensDir: REPO_ROOT, mcpDir: MCP_DIR },
  });
  return server.get('lens_sessions');
}

const textOf = (r) => {
  assert.ok(Array.isArray(r.content) && r.content[0] && r.content[0].type === 'text',
    'result carries one text content block');
  return r.content[0].text;
};

// ------------------------------------------------------------------ surface

test('registers with read-only annotations and NO outputSchema', async () => {
  const t = tool();
  assert.equal(t.config.title, 'Find sessions');
  assert.deepEqual(t.config.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  // Declaring an outputSchema would oblige the server to emit conforming
  // structuredContent on EVERY call — the token doubling this whole server
  // exists to prevent (KAN-106 §7.2).
  assert.equal(t.config.outputSchema, undefined);
  // The description has to tell an agent when NOT to reach for this tool.
  assert.match(t.config.description, /does NOT search transcript text/i);
});

test('register() is repeatable — the stdio transport builds a throwaway server', async () => {
  // serveStdio takes a FACTORY and may build and discard an instance while
  // probing. Registration must therefore be side-effect-free apart from the
  // registerTool call on the server it was handed.
  const a = tool();
  const b = tool();
  const ta = textOf(await a.invoke({}));
  const tb = textOf(await b.invoke({}));
  assert.equal(ta, tb, 'a second registration renders identically');
});

// ------------------------------------------------------------------ default

test('default listing: header, one line per session, totals with denominators, next: hints', async () => {
  const { SLUG, S1, S2, EXPECT } = H.fixtures;
  const text = textOf(await tool().invoke({}));

  // Header: scope, paging arithmetic, sort. Both fixture sessions are in scope
  // and none is filtered out, so the header states the simple denominator.
  assert.match(text, /^SESSIONS — store · showing 1–2 of 2 · sort=recent$/m);

  // Basis: the denominator under every figure below it.
  assert.match(text, /^basis: 2 of 2 sessions indexed · index ready · pricing v/m);

  // Recorded titles are corpus-authored text and the block is fenced.
  assert.ok(text.includes(render.FENCE), 'the table carrying recorded titles is fenced');

  // Column header, then one line per session, each carrying its full locator.
  assert.match(text, /^id\s+started\s+ended\s+turns\s+agents\s+\$\s+title \(recorded\)$/m);
  assert.ok(text.includes(S1), 'session 1 id is printed in full — it is the locator');
  assert.ok(text.includes(S2), 'session 2 id is printed in full');
  assert.equal(text.split('\n').filter((l) => l.startsWith(S1) || l.startsWith(S2)).length, 2);

  // Recorded facts from the cards, not recomputed here.
  assert.match(text, /"Fixture one"/, 'the recorded title is printed, labelled recorded');
  assert.match(text, /\[running forked\]/, 'the recorded badges ride the title cell');

  // Totals over the shown rows AND the scope total, each with a denominator.
  assert.match(text, /^totals over the 2 shown: 3 turns · 9 requests · \$/m);
  assert.match(text, /\(store total: 2 of 2 sessions · 9 requests · \$/);

  // The store total is the ledger's own figure, byte-identical to /api/index.
  const usd = H.ctx.pricing.formatUsd(EXPECT.totalTcu);
  assert.ok(text.includes(usd), `the scope total renders ${usd}`);
  // …and the shown total equals it here, because all 2 of 2 sessions are shown.
  assert.equal(text.match(new RegExp(usd.replace(/[$.]/g, '\\$&'), 'g')).length, 2);

  // The independent cross-check, named with the scope it was computed over.
  assert.match(text, /^rows sum to header \(store\): ✓$/m);

  // The drill-down, named literally, with a real locator in it.
  assert.match(text, new RegExp(`^next: lens_session slug="${SLUG}" id="[0-9a-f-]{36}"$`, 'm'));
  assert.match(text, new RegExp(`^\\s+lens_usage scope="session:${SLUG}/[0-9a-f-]{36}" group_by="model"$`, 'm'));
  assert.match(text, new RegExp(`^\\s+lens_sessions project="${SLUG}"`, 'm'));

  // Budget: KAN-106 §7.1 puts lens_sessions at ~600 tokens by default.
  assert.ok(text.length < 2400, `default render is ${text.length} chars — over the ~600-token budget`);
});

test('every disclosure counter recorded on the LITE aggs reaches the output', async () => {
  // The fixture records, across its two sessions: neverFinalized 1, synthetic 1,
  // ttlAssumed 1, inheritedRequests 1 (R2 — a copy billed in the other
  // session), unpricedRequests 1 (R7 — a model with no rate). None may be
  // silently dropped, and `unpriced` in particular must never render as $0.
  const text = textOf(await tool().invoke({}));
  const line = text.split('\n').find((l) => l.startsWith('disclosures over the 2 shown:'));
  assert.ok(line, 'a disclosures line is printed when any counter is nonzero');
  assert.match(line, /inherited 1 req \(billed in another session\)/);
  assert.match(line, /unpriced 1 req \(no rate recorded — never counted as \$0\)/);
  assert.match(line, /neverFinalized 1/);
  assert.match(line, /synthetic 1/);
  assert.match(line, /ttlAssumed 1/);
  // R8 metrics are not disclosures and must not clutter the line, even though
  // the fixture records webSearchRequests 4.
  assert.ok(!line.includes('webSearchRequests'), 'R8 metrics are not disclosure counters');
});

test('a session with no recorded title renders — , never a fabricated one', async () => {
  const { S2 } = H.fixtures;
  // Fixture session 2 records title/aiTitle/customTitle all null.
  const text = textOf(await tool().invoke({}));
  const row = text.split('\n').find((l) => l.startsWith(S2));
  assert.ok(row, 'session 2 is listed');
  assert.ok(row.includes('—'), 'the missing title renders the unknown glyph');
  assert.ok(!row.includes('""'), 'an absent title is not rendered as an empty string');
});

// ------------------------------------------------------------------ project

test('project filter reads /api/project/:slug and labels the scope', async () => {
  const { SLUG, EXPECT } = H.fixtures;
  const text = textOf(await tool().invoke({ project: SLUG }));
  assert.match(text, new RegExp(`^SESSIONS — project:${SLUG} · showing 1–2 of 2 · sort=recent$`, 'm'));
  assert.match(text, new RegExp(`\\(project ${SLUG} total: 2 of 2 sessions · 9 requests · \\$`));
  assert.ok(text.includes(H.ctx.pricing.formatUsd(EXPECT.totalTcu)));
  assert.match(text, new RegExp(`^rows sum to header \\(project:${SLUG}\\): ✓$`, 'm'));
  // The all-projects hint is pointless once a project is named.
  assert.ok(!text.includes('(narrow to one project)'));
});

test('an unknown project slug is a tool error naming the code and the way out', async () => {
  const r = await tool().invoke({ project: 'no-such-project-slug' });
  assert.equal(r.isError, true, 'a slug that does not exist is a model-correctable error');
  const text = textOf(r);
  assert.match(text, /404 unknown-project/);
  assert.match(text, /no project no-such-project-slug/);
  assert.match(text, /without `project`/, 'the error names the way to list the real slugs');
});

// ------------------------------------------------------------------ filters

test('a filter that matches nothing renders an honest empty result, not an error', async () => {
  const r = await tool().invoke({ title_contains: 'zzz-no-session-has-this-string' });
  assert.notEqual(r.isError, true, 'an empty match set is an answer, not an error');
  const text = textOf(r);

  // The paging line still carries BOTH denominators: nothing matched, out of
  // how many were tested.
  assert.match(text, /^SESSIONS — store · title~"zzz-no-session-has-this-string" · showing 0–0 of 0 matched \(of 2 in scope\) · sort=recent$/m);
  assert.match(text, /^basis: 2 of 2 sessions indexed/m);
  assert.match(text, /all 2 sessions in store were tested and none passed every filter\./);
  // The scope total and the cross-check are facts about the scope and survive
  // an empty match set.
  assert.match(text, /store total: 2 of 2 sessions · 9 requests · \$/);
  assert.match(text, /^rows sum to header \(store\): ✓$/m);
  assert.match(text, /^next: lens_sessions   \(drop a filter, or widen since\/until\)$/m);
});

test('title_contains matches the recorded title, case-insensitively', async () => {
  const { S1, S2 } = H.fixtures;
  const text = textOf(await tool().invoke({ title_contains: 'FIXTURE' }));
  assert.match(text, /showing 1–1 of 1 matched \(of 2 in scope\)/);
  assert.ok(text.includes(S1));
  assert.ok(!text.split('\n').some((l) => l.startsWith(S2)));
});

test('cwd_contains matches the recorded cwd; a session with no recorded cwd never matches', async () => {
  const { S1, S2 } = H.fixtures;
  const text = textOf(await tool().invoke({ cwd_contains: 'proj-a' }));
  assert.match(text, /showing 1–1 of 1 matched \(of 2 in scope\)/);
  assert.ok(text.includes(S1), 'the session recording cwd C:\\test\\proj-a matches');
  assert.ok(!text.split('\n').some((l) => l.startsWith(S2)), 'the session recording no cwd does not');
});

test('branch matches exactly; both fixture sessions record no branch, so none match', async () => {
  const text = textOf(await tool().invoke({ branch: 'main' }));
  assert.match(text, /showing 0–0 of 0 matched \(of 2 in scope\)/);
  assert.match(text, /none passed every filter/);
});

test('has= reads the recorded card counters and ANDs them', async () => {
  const { S1, S2 } = H.fixtures;
  // Fixture: S1 records agentCount 2 and workflowCount 1; S2 records 0 and 0.
  const agents = textOf(await tool().invoke({ has: ['agents'] }));
  assert.match(agents, /has=agents/);
  assert.match(agents, /showing 1–1 of 1 matched \(of 2 in scope\)/);
  assert.ok(agents.includes(S1));

  const both = textOf(await tool().invoke({ has: ['agents', 'workflows'] }));
  assert.match(both, /showing 1–1 of 1 matched/, 'AND semantics: S1 records both');

  // images is a recorded card counter and both sessions record 0.
  const images = textOf(await tool().invoke({ has: ['images'] }));
  assert.match(images, /showing 0–0 of 0 matched \(of 2 in scope\)/);
  assert.ok(!images.split('\n').some((l) => l.startsWith(S2)));
});

test('"problems" is not offered as a has= value — there is no recorded card field for it', async () => {
  // KAN-106 §6.3 sketches has:["…","problems"], but cardOut() strips `problems`
  // from every card before it ships and SPEC §9's SessionCard does not carry
  // it. Rather than reconstruct session identity from a problem's file path
  // (and silently miss every problem recorded against an agent transcript),
  // the value is absent from the enum and the schema rejects it.
  assert.throws(() => tool().config.inputSchema.parse({ has: ['problems'] }));
});

test('badges= filters on the recorded badges and ANDs them', async () => {
  const { S1, S2 } = H.fixtures;
  // Fixture: S1 badges [running, forked]; S2 badges [forked].
  const forked = textOf(await tool().invoke({ badges: ['forked'] }));
  assert.match(forked, /showing 1–2 of 2 · sort=recent/, 'both sessions record `forked`');

  const running = textOf(await tool().invoke({ badges: ['forked', 'running'] }));
  assert.match(running, /badges=forked\+running/);
  assert.match(running, /showing 1–1 of 1 matched \(of 2 in scope\)/);
  assert.ok(running.includes(S1));
  assert.ok(!running.split('\n').some((l) => l.startsWith(S2)));
});

test('since/until compare local calendar days against the recorded span', async () => {
  const { S1 } = H.fixtures;
  const idx = await call('GET', '/api/index');
  const card = idx.json.sessions.find((s) => s.id === S1);
  const d = new Date(card.startedAt);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const before = new Date(card.startedAt - 86400000);
  const dayBefore = `${before.getFullYear()}-${String(before.getMonth() + 1).padStart(2, '0')}-${String(before.getDate()).padStart(2, '0')}`;

  // The session's own recorded day is inclusive at both ends.
  const on = textOf(await tool().invoke({ since: day, until: day }));
  assert.match(on, new RegExp(`${dayBefore.slice(0, 0)}${day}\\.\\.${day}`));
  assert.match(on, /showing 1–2 of 2 · sort=recent/, 'both fixture sessions start on that day');

  // A window that closes before the session opened excludes it.
  const past = textOf(await tool().invoke({ until: dayBefore }));
  assert.match(past, /showing 0–0 of 0 matched \(of 2 in scope\)/);

  // A window that opens after the session ended excludes it too.
  const future = textOf(await tool().invoke({ since: '2099-01-01' }));
  assert.match(future, /showing 0–0 of 0 matched \(of 2 in scope\)/);
});

// ------------------------------------------------------------------ paging

test('limit/offset paging arithmetic is stated and the pages partition the matched list', async () => {
  const { S1, S2 } = H.fixtures;
  // `limit` narrows the PAGE, never the match set: the denominator stays 2.
  const p1 = textOf(await tool().invoke({ limit: 1 }));
  assert.match(p1, /^SESSIONS — store · showing 1–1 of 2 · sort=recent$/m);
  assert.match(p1, /^totals over the 1 shown: /m);
  // The continuation is named with the exact next offset and how many remain.
  assert.match(p1, /^\s+lens_sessions offset=1   \(1 more matched\)$/m);

  const p2 = textOf(await tool().invoke({ limit: 1, offset: 1 }));
  assert.match(p2, /^SESSIONS — store · showing 2–2 of 2 · sort=recent$/m);
  // No further page, so no continuation hint.
  assert.ok(!p2.includes('more matched'));

  // Together the two pages cover both sessions exactly once.
  const shown = [p1, p2].map((t) => t.split('\n').find((l) => l.startsWith(S1) || l.startsWith(S2)));
  assert.equal(new Set(shown.map((l) => l.slice(0, 36))).size, 2, 'the pages partition the list');
});

test('offset past the end shows an empty page without claiming nothing matched', async () => {
  const r = await tool().invoke({ offset: 99 });
  assert.notEqual(r.isError, true, 'an empty page is an answer, not an error');
  const text = textOf(r);
  // 2 sessions still matched; this page is simply past them, and the two facts
  // are never conflated — an agent's next move differs completely.
  assert.match(text, /^SESSIONS — store · showing 0–0 of 2 · sort=recent$/m);
  assert.match(text, /^this page is empty — offset 99 is past the end of the 2 matched sessions\. The matches are still there; ask for offset < 2\.$/m);
  assert.ok(!text.includes('none passed every filter'), 'past-the-end is not "nothing matched"');
  assert.match(text, /^next: lens_sessions offset=0$/m);
});

// ------------------------------------------------------------------ sorting

test('sort=recent (the default) is recorded startedAt, newest first', async () => {
  const idx = await call('GET', '/api/index');
  const expected = [...idx.json.sessions]
    .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
    .map((s) => s.id);
  const text = textOf(await tool().invoke({}));
  const got = text.split('\n').filter((l) => /^[0-9a-f]{8}-/.test(l)).map((l) => l.slice(0, 36));
  assert.deepEqual(got, expected);
});

test('sort=cost is recorded cost, largest first', async () => {
  const { S1, S2, EXPECT } = H.fixtures;
  assert.ok(EXPECT.s2Tcu > EXPECT.s1Tcu, 'fixture precondition: session 2 costs more');
  const text = textOf(await tool().invoke({ sort: 'cost' }));
  assert.match(text, /sort=cost$/m);
  const got = text.split('\n').filter((l) => /^[0-9a-f]{8}-/.test(l)).map((l) => l.slice(0, 36));
  assert.deepEqual(got, [S2, S1]);
});

test('sort=turns and sort=bytes read their recorded card counters', async () => {
  const { S1, S2 } = H.fixtures;
  // Fixture: S2 records turnCount 2, S1 records 1; S1 records more bytes.
  const turns = textOf(await tool().invoke({ sort: 'turns' }));
  assert.deepEqual(
    turns.split('\n').filter((l) => /^[0-9a-f]{8}-/.test(l)).map((l) => l.slice(0, 36)),
    [S2, S1],
  );
  const bytes = textOf(await tool().invoke({ sort: 'bytes' }));
  assert.deepEqual(
    bytes.split('\n').filter((l) => /^[0-9a-f]{8}-/.test(l)).map((l) => l.slice(0, 36)),
    [S1, S2],
  );
});

// ------------------------------------- a session whose cost is not computable
//
// The fixture store indexes cleanly, so both its sessions carry an agg. The
// case that matters most for the no-inference rule — `agg: null`, meaning the
// cost is UNKNOWN rather than zero — is therefore injected at the dispatcher
// seam. SPEC §9 says cardAggLite returns null for a card with no computable
// aggregate, so this is a shape the route really does emit.

/**
 * A tool whose /api/index payload has been rewritten on the way through.
 *
 * `mutate(view, template)` is handed the parsed 200 body and the first real
 * card, and may push cards, change `status`, whatever the case under test
 * needs. This is the dispatcher seam the file already uses for the null-agg
 * card, generalised: the fixture store is deliberately clean, so every shape
 * that only occurs on a messier corpus has to arrive here.
 */
function withIndexView(mutate) {
  const inject = async (method, path, query) => {
    const r = await call(method, path, query);
    if (path === '/api/index' && r.status === 200 && r.json && Array.isArray(r.json.sessions)) {
      mutate(r.json, r.json.sessions[0]);
    }
    return r;
  };
  return tool(inject);
}

function withNullAggCard() {
  const NULL_ID = '99999999-9999-4999-8999-999999999999';
  const inject = async (method, path, query) => {
    const r = await call(method, path, query);
    if (path === '/api/index' && r.status === 200 && Array.isArray(r.json.sessions)) {
      const template = r.json.sessions[0];
      r.json.sessions = [...r.json.sessions, {
        ...template,
        id: NULL_ID,
        title: 'no agg recorded',
        aiTitle: null,
        customTitle: null,
        startedAt: template.startedAt - 3600000,
        endedAt: template.startedAt - 3500000,
        turnCount: 0,
        agentCount: 0,
        agg: null, // unknown — NOT zero
      }];
    }
    return r;
  };
  return { NULL_ID, t: tool(inject) };
}

test('a session with agg:null renders — for cost, never $0.0000', async () => {
  const { NULL_ID, t } = withNullAggCard();
  const text = textOf(await t.invoke({}));
  const row = text.split('\n').find((l) => l.startsWith(NULL_ID));
  assert.ok(row, 'the null-agg session is listed');
  assert.ok(row.includes(render.UNKNOWN), 'its cost cell is the unknown glyph');
  assert.ok(!/\$0\.0000/.test(row), 'unknown is never rendered as a zero dollar figure');
  assert.ok(!/\s0\s/.test(row.replace(NULL_ID, '')) || row.includes(render.UNKNOWN),
    'a recorded 0 and an unknown are different facts');
});

test('a totals line over a mixed set states how many of the shown rows had a cost', async () => {
  const { t } = withNullAggCard();
  const text = textOf(await t.invoke({}));
  assert.match(text, /^totals over the 3 shown: .* over 2 of 3 with a recorded cost/m,
    'the money total names the rows it actually covers');
});

test('sort=cost puts an unknown cost LAST, not at the bottom of the money order', async () => {
  const { NULL_ID, t } = withNullAggCard();
  const text = textOf(await t.invoke({ sort: 'cost' }));
  const got = text.split('\n').filter((l) => /^[0-9a-f]{8}-/.test(l)).map((l) => l.slice(0, 36));
  assert.equal(got.length, 3);
  assert.equal(got[2], NULL_ID, 'unknown sorts last — it is not $0');
});

test('min_usd excludes an uncomputable cost and DISCLOSES the exclusion', async () => {
  const { NULL_ID, t } = withNullAggCard();
  const text = textOf(await t.invoke({ min_usd: 0 }));
  assert.ok(!text.split('\n').some((l) => l.startsWith(NULL_ID)),
    'min_usd:0 must not admit a session whose cost is unknown');
  assert.match(text, /^not testable against min_usd: 1 session have no computable cost \(excluded — unknown is never treated as \$0\)\.$/m);
  // …and the excluded row is not counted as a non-match either: 2 matched of 3.
  assert.match(text, /showing 1–2 of 2 matched \(of 3 in scope\)/);
});

test('min_usd INCLUDES a session costing exactly the threshold', async () => {
  // The float round-trip: `61 / TCU_PER_USD * TCU_PER_USD === 61.00000000000001`,
  // which is strictly greater than 61. Without snapping the product back to the
  // integer it overshot, a session costing exactly `min_usd` fails `tcu >=
  // minTcu` and vanishes — from a filter whose own schema says "at least this
  // many US dollars".
  const P = H.ctx.pricing;
  const EXACT_ID = '61616161-6161-4161-8161-616161616161';
  const TCU = 61;
  assert.ok((TCU / P.TCU_PER_USD) * P.TCU_PER_USD > TCU,
    'the repro is real on this platform: the round-trip overshoots the integer');

  const t = withIndexView((view, template) => {
    view.sessions = [...view.sessions, {
      ...template,
      id: EXACT_ID,
      title: 'exactly at the threshold',
      aiTitle: null,
      customTitle: null,
      agg: { ...template.agg, usd: { ...template.agg.usd, total: TCU } },
    }];
  });

  const text = textOf(await t.invoke({ min_usd: TCU / P.TCU_PER_USD, sort: 'cost' }));
  assert.ok(text.split('\n').some((l) => l.startsWith(EXACT_ID)),
    'a session costing exactly min_usd is at least min_usd');
  // The two fixture sessions cost far more, so all three match and the header
  // takes its simple form.
  assert.match(text, /showing 1–3 of 3 · sort=cost/);

  // One tcu above the threshold still excludes it — the snap is narrow, not a
  // blanket loosening of the comparison.
  const above = textOf(await t.invoke({ min_usd: (TCU + 1) / P.TCU_PER_USD, sort: 'cost' }));
  assert.ok(!above.split('\n').some((l) => l.startsWith(EXACT_ID)),
    'the snap does not admit a session that is genuinely below the threshold');
});

test('min_usd compares in integer tcu, not rounded dollars', async () => {
  const { EXPECT, S2 } = H.fixtures;
  const P = H.ctx.pricing;
  const s2Usd = EXPECT.s2Tcu / P.TCU_PER_USD;
  // Exactly at the threshold: inclusive.
  const at = textOf(await tool().invoke({ min_usd: s2Usd }));
  assert.match(at, /showing 1–1 of 1 matched \(of 2 in scope\)/);
  assert.ok(at.includes(S2));
  // A hair above: excluded.
  const above = textOf(await tool().invoke({ min_usd: s2Usd + 1e-9 }));
  assert.match(above, /showing 0–0 of 0 matched \(of 2 in scope\)/);
});

// ------------------------------------------------------------------ structured

test('structured:true attaches structuredContent; the default does not', async () => {
  const { SLUG, S1 } = H.fixtures;
  const plain = await tool().invoke({});
  assert.equal(plain.structuredContent, undefined,
    'text-only by default — attaching the JSON unasked is the token doubling this server prevents');

  const r = await tool().invoke({ structured: true, project: SLUG, limit: 1 });
  const sc = r.structuredContent;
  assert.ok(sc, 'structuredContent is attached when asked for');
  assert.equal(sc.scope, `project:${SLUG}`);
  assert.deepEqual(sc.filters, { project: SLUG });
  assert.equal(sc.sort, 'recent');
  assert.equal(sc.limit, 1);
  assert.equal(sc.offset, 0);
  assert.equal(sc.matched, 2);
  assert.equal(sc.inScope, 2);
  assert.equal(sc.sessions.length, 1, 'the sessions array is the PAGE, matching what was rendered');
  assert.equal(sc.rowsSumToHeader, true);
  assert.equal(sc.r2, 'resolved');
  // The scope agg is the route's own, in exact integer tcu.
  assert.equal(sc.scopeAgg.usd.total, H.fixtures.EXPECT.totalTcu);
  assert.deepEqual(sc.excluded, { noStartDate: 0, noCost: 0 });
  assert.ok([S1, sc.sessions[0].id].includes(sc.sessions[0].id));
  // The text block is still the complete, self-sufficient answer.
  assert.match(textOf(r), /^SESSIONS — project:/m);
});

// ------------------------------------------------------------------ R2
//
// R2 is the cross-session de-duplication of one message.id across forks and
// resumes. Its state lives on the FETCHED VIEW at both scopes: `/api/project`
// carries it at the top level, `/api/index` carries it on `status` (the lens's
// index-view.mjs writes `status: { ...status, r2: r2State(ctx) }`). The RAW
// index status — ctx.index.status() — has no r2 field at all, so reading that
// at store scope reported null forever and made the footer unreachable.

test('store scope reports the R2 state the route shipped, not null', async () => {
  const r = await tool().invoke({ structured: true });
  assert.equal(r.structuredContent.scope, 'store');
  assert.equal(r.structuredContent.r2, 'resolved',
    'the fixture index has resolved R2 — "resolved" and "not reported" are different facts');
});

test('a pending R2 prints the footer at STORE scope, not only per project', async () => {
  const t = withIndexView((view) => { view.status = { ...view.status, r2: 'pending' }; });
  const r = await t.invoke({ structured: true });
  const text = textOf(r);
  assert.match(text, /^R2 fork resolution: pending — inherited\/forked figures may still change; re-run when lens_status reports the index ready\.$/m,
    'the disclosure a store-scope reader needs actually prints');
  assert.equal(r.structuredContent.r2, 'pending');

  // …and the resolved case still prints nothing: a footer on every result is a
  // footer nobody reads.
  assert.ok(!textOf(await tool().invoke({})).includes('R2 fork resolution'));
});

// ------------------------------------------------------- token denominator
//
// Tokens are recorded whether or not a rate exists for the model that burned
// them (R7). So the token sum's denominator is "shown rows that have an agg",
// which is NOT the money line's "shown rows with a computable dollar total".
// Reusing the money set silently dropped every all-unpriced session from the
// token mass while labelling the result "over the N with an agg".

function withUnpricedCard() {
  const UNPRICED_ID = '77777777-7777-4777-8777-777777777777';
  const EXTRA = { input: 7, output: 11, cache5m: 0, cache1h: 0, cacheFlat: 0, cacheRead: 0 };
  const t = withIndexView((view, template) => {
    view.sessions = [...view.sessions, {
      ...template,
      id: UNPRICED_ID,
      title: 'all rows unpriced',
      aiTitle: null,
      customTitle: null,
      // A real agg with real recorded tokens, and NO computable dollar total:
      // every row ran on a model with no rate. usd.total is unknown, not zero.
      agg: { ...template.agg, usd: { ...template.agg.usd, total: null }, tokens: { ...EXTRA } },
    }];
  });
  return { UNPRICED_ID, EXTRA, t };
}

// The `in N · out N` figures off a tokens line. fmtTokens prints counts under
// 10,000 exactly, and every figure here is small, so these are exact integers.
function tokensOf(text) {
  const line = text.split('\n').find((l) => l.trimStart().startsWith('tokens over the '));
  assert.ok(line, 'a tokens line ships');
  const den = /tokens over the (\d+) with an agg/.exec(line);
  const io = /in ([\d,]+) · out ([\d,]+)/.exec(line);
  assert.ok(den && io, `tokens line is parseable: ${line}`);
  const n = (s) => Number(s.replace(/,/g, ''));
  return { den: Number(den[1]), input: n(io[1]), output: n(io[2]) };
}

test('the token line sums every shown row with an agg, priced or not', async () => {
  const base = tokensOf(textOf(await tool().invoke({})));
  assert.equal(base.den, 2, 'both fixture sessions have an agg');

  const { EXTRA, t } = withUnpricedCard();
  const got = tokensOf(textOf(await t.invoke({})));

  assert.equal(got.den, 3,
    'the denominator counts rows with an AGG — an unpriced session has one');
  assert.equal(got.input, base.input + EXTRA.input,
    'the unpriced session\'s recorded input tokens are in the sum');
  assert.equal(got.output, base.output + EXTRA.output,
    'the unpriced session\'s recorded output tokens are in the sum');
});

test('the money line keeps its OWN denominator when the two sets differ', async () => {
  const { t } = withUnpricedCard();
  const text = textOf(await t.invoke({}));
  // Three shown; two have a dollar total; three have an agg. Both lines state
  // their own set, and neither borrows the other's.
  assert.match(text, /^totals over the 3 shown: .* over 2 of 3 with a recorded cost/m);
  assert.match(text, /^ {2}tokens over the 3 with an agg: /m);
});

// ------------------------------------------------------------------ pending

test('a 409 renders as a STATE, not an isError', async () => {
  // KAN-106 §4.3: a pending index is never an error to the model. An agent can
  // act on "re-run this in 2s"; it cannot act on an exception.
  const pending = async () => ({
    status: 409,
    headers: {},
    json: {
      error: {
        code: 'not-indexed-yet',
        message: 'index is still building',
        detail: { retryAfterMs: 2000, bytesIndexed: 412 * 1024 * 1024, bytesTotal: 1.18 * 1024 * 1024 * 1024 },
      },
    },
  });
  const r = await tool(pending).invoke({});
  assert.notEqual(r.isError, true, 'pending is a state, not an error');
  const text = textOf(r);
  assert.match(text, /Index is still building — 412 MB of 1\.2 GB done\./);
  assert.match(text, /Re-run this call in ~2s\./);
  assert.match(text, /lens_status/);
});

test('a non-409, non-404 failure is a tool error naming the route and status', async () => {
  const boom = async () => ({
    status: 503, headers: {},
    json: { error: { code: 'indexer-down', message: 'worker exited' } },
  });
  const r = await tool(boom).invoke({});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /could not read \/api\/index: 503 indexer-down — worker exited/);
});
