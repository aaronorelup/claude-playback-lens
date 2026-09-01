// tests/mcp/usage.test.mjs — lens_usage.
//
// The tool's whole claim is that its numbers ARE the lens's numbers, so the
// assertions here are number-for-number against the fixture store's
// hand-computed totals (make-store.mjs EXPECT) and against the dispatcher's
// raw payloads — always on exact integer tcu, never on a rounded dollar
// string. A test that compared "$0.0776" to "$0.0776" would pass while the
// ledger drifted by 99,999 tcu.
//
// The second thing under test is the renderer's honesty: a date-filtered
// result MUST print the day-band limitation, an unpriced model MUST render `—`
// rather than `$0.0000`, and a grouping that cannot be derived from a recorded
// payload MUST refuse with a sentence naming what to do instead.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDispatcher } from '../../mcp/dispatch.mjs';
import * as render from '../../mcp/render.mjs';
import { register } from '../../mcp/tools/usage.mjs';
import {
  fixtureContext, assertHonestHints, literalCalls, PHASE1_TOOLS, UNBUILT_TOOLS,
} from './helpers.mjs';
import { TOOLS_VERSION } from '../../mcp/context.mjs';

let H;      // { ctx, lens, fixtures, close }
let call;   // the in-process dispatcher
let tool;   // { config, handler } for lens_usage

// A stand-in for McpServer that captures the registration. It also PARSES the
// arguments through the tool's own zod schema before handing them over, which
// is what the SDK does — so `limit`, `sort` and the booleans get their declared
// defaults here exactly as they would in a real call, and a schema that stopped
// declaring a default would fail these tests rather than silently shifting the
// output.
function fakeServer() {
  const tools = new Map();
  return {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    tools,
  };
}

async function run(args = {}) {
  const parsed = tool.config.inputSchema.parse(args);
  return tool.handler(parsed);
}

const textOf = (r) => r.content.map((c) => c.text).join('\n');

before(async () => {
  H = await fixtureContext();
  call = createDispatcher(H.lens, H.ctx);
  const server = fakeServer();
  register(server, {
    ctx: H.ctx,
    lens: H.lens,
    call,
    render,
    meta: { TOOLS_VERSION, lensDir: null, mcpDir: null },
  });
  tool = server.tools.get('lens_usage');
});

after(async () => { if (H) await H.close(); });

// ---------------------------------------------------------------- surface

test('registers lens_usage read-only, with no outputSchema', () => {
  assert.ok(tool, 'lens_usage is registered');
  assert.equal(tool.config.title, 'Token and cost usage');
  assert.deepEqual(tool.config.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  // SPEC §7.2: declaring an outputSchema would force structuredContent on
  // every call and double the tokens this server exists to save.
  assert.equal(tool.config.outputSchema, undefined);
  const shape = tool.config.inputSchema.shape;
  assert.deepEqual(
    Object.keys(shape).sort(),
    ['detail', 'group_by', 'limit', 'scope', 'since', 'sort', 'structured', 'until'],
  );
});

test('register() is safe to run twice (the SDK builds a throwaway probe server)', () => {
  const a = fakeServer();
  const b = fakeServer();
  const deps = { ctx: H.ctx, lens: H.lens, call, render, meta: { TOOLS_VERSION } };
  register(a, deps);
  register(b, deps);
  assert.ok(a.tools.get('lens_usage') && b.tools.get('lens_usage'));
});

// ---------------------------------------------------------------- store scope

test('store scope defaults to group_by=project and totals the fixture exactly', async () => {
  const { EXPECT, SLUG } = H.fixtures;
  const r = await run({ structured: true });
  assert.ok(!r.isError, textOf(r));
  const t = textOf(r);

  assert.match(t, /^USAGE — store · group_by=project · sort=usd$/m);
  assert.match(t, /^basis: 2 of 2 sessions indexed · .* · pricing v2026-08-17 · index v5$/m);
  // The one project, its share, and the TOTAL row.
  assert.match(t, new RegExp(`^${SLUG}\\s+9\\s+\\S+\\s+\\$0\\.0776\\s+100\\.0%$`, 'm'));
  assert.match(t, /^TOTAL\s+9\s+\S+\s+\$0\.0776\s+100\.0%$/m);
  assert.match(t, /^rows sum to header: ✓$/m);
  assert.match(t, /^groups sum to TOTAL: ✓/m);

  // Money, on exact integer tcu.
  assert.equal(r.structuredContent.total.usdTcu, EXPECT.totalTcu);
  assert.equal(r.structuredContent.total.requests, EXPECT.totalRequests);
  assert.equal(r.structuredContent.groups.length, 1);
  assert.equal(r.structuredContent.groups[0].usdTcu, EXPECT.totalTcu);
});

test('acceptance criterion 3 — the tool\'s store total IS /api/index\'s agg, in integer tcu', async () => {
  const raw = await call('GET', '/api/index');
  const r = await run({ structured: true });
  // Not "computed the same way" — the same number out of the same handler.
  assert.equal(r.structuredContent.total.usdTcu, raw.json.agg.usd.total);
  assert.equal(r.structuredContent.total.requests, raw.json.agg.requests);
  assert.deepEqual(r.structuredContent.total.tokens, raw.json.agg.tokens);
  // And the rendered dollars are the lens's own formatter over that integer.
  assert.match(textOf(r), new RegExp(`TOTAL.*\\${H.ctx.pricing.formatUsd(raw.json.agg.usd.total)}`));
});

test('the declared default limit is 10, and the structured payload echoes it', async () => {
  // A DECLARED default is part of the surface an agent reads, so it is pinned
  // here rather than left to the schema. It fell 20 → 10 at TOOLS_VERSION 2:
  // §7.1's ~300-token budget was written against a three-row output sketch, and
  // on the real ~30-project corpus the top 10 projects carry ~93% of the spend,
  // so rows 11-20 were the long tail the TOTAL row already accounts for.
  // `limit` up to 100 is still there for a caller who wants that tail.
  assert.equal(tool.config.inputSchema.parse({}).limit, 10);
  const r = await run({ structured: true });
  assert.equal(r.structuredContent.limit, 10, 'the echoed limit is the one that was applied');
});

test('default output stays inside its ~525-token budget', async () => {
  const r = await run({});
  // ~4 chars/token: a default store call must not creep toward the 20000-char
  // global cap. 525 tokens is the RECALIBRATED per-tool budget (2026-08-23,
  // the measured floor on the real corpus at TOOLS_VERSION 2 defaults); §7.1's
  // ~300 was a pre-implementation estimate at fixture scale. Asserted, not hoped for.
  assert.ok(textOf(r).length < 1800, `default render is ${textOf(r).length} chars`);
});

// ---------------------------------------------------------- long-slug budget
//
// THE DEFECT THIS GUARDS. A project slug is a sanitised ABSOLUTE PATH. The
// fixture store's slug is eight characters; the real corpus's longest is 125,
// and render.table() used to pad every cell in a column to its widest cell with
// no ceiling. One outlier therefore padded all 22 lines of a store-scope table
// to ~163 characters and the table became 82% of a 1098-token result — against
// a ~300-token budget. The fixture cannot show this (one short-slugged
// project), so the payload is synthesised HERE, from the real one: same shapes,
// same ledger numbers, only the slug string is swapped.
//
// The rule the test encodes: clipping is DISPLAY ONLY. A clipped cell always
// carries `…` so it can never be mistaken for a real slug, and the full name
// must still be addressable from the same result.

// Verbatim off the real corpus — a git-worktree project root.
const LONG_SLUG = 'C--Users-userx-Organized-Personal-My-Projects-LLM-Monster-Hunter-2-LlmMonsterHunter--claude-worktrees-zealous-goldberg-628237';

/** lens_usage registered over a /api/index whose one project wears LONG_SLUG.
 *  Everything else is the real dispatcher's real payload. */
async function longSlugTool() {
  const real = await call('GET', '/api/index');
  const server = fakeServer();
  register(server, {
    ctx: H.ctx,
    lens: H.lens,
    render,
    meta: { TOOLS_VERSION, lensDir: null, mcpDir: null },
    async call(method, pathname, query) {
      if (method === 'GET' && pathname === '/api/index') {
        const json = JSON.parse(JSON.stringify(real.json));
        for (const p of json.projects ?? []) p.slug = LONG_SLUG;
        for (const s of json.sessions ?? []) s.slug = LONG_SLUG;
        return { status: real.status, json };
      }
      return call(method, pathname, query);
    },
  });
  return server.tools.get('lens_usage');
}

test('a 125-char project slug does not blow the budget, and stays addressable', async () => {
  assert.ok(LONG_SLUG.length >= 120, 'the fixture slug must be realistically long');
  const t2 = await longSlugTool();
  const r = await t2.handler(t2.config.inputSchema.parse({ structured: true }));
  assert.ok(!r.isError, textOf(r));
  const t = textOf(r);

  // 1. The budget. ~4 chars/token against the recalibrated ~525-token ceiling.
  //    MEASURED, not aspirational: this render is 1067 chars (~267 tok) today,
  //    and 1100 is the bound that catches the padding defect coming back.
  //    Note what `limit` does and does not do here: the synthesised payload
  //    wears ONE project, so limit=10 vs the old 20 changes nothing at fixture
  //    scale. The default's fall to 10 buys its tokens on a real ~30-project
  //    corpus — scripts/smoke.mjs is where that is measured.
  assert.ok(t.length < 1100, `long-slug store render is ${t.length} chars (~${Math.round(t.length / 4)} tok)`);

  // 2. The table row is clipped, keeps the DISTINGUISHING tail, and is marked.
  const row = t.split('\n').find((l) => l.startsWith('…'));
  assert.ok(row, `no clipped project row in:\n${t}`);
  assert.match(row, /^…r--claude-worktrees-zealous-goldberg-628237\s/);
  assert.equal(row.split(/\s{2,}/)[0].length, 44, 'clipped to exactly the ceiling');
  assert.ok(LONG_SLUG.endsWith(row.split(/\s{2,}/)[0].slice(1)), 'the clipped cell is a verbatim suffix');
  // No table line carries the full slug — that is the padding defect returning.
  for (const l of t.split('\n')) {
    if (l.startsWith('next:') || l.trimStart().startsWith('lens_')) continue;
    assert.ok(!l.includes(LONG_SLUG), `an unclipped slug is still padding a table line: ${l}`);
  }

  // 3. The clip is announced, so `…` is never read as part of a name.
  assert.match(t, /1 of 1 project name clipped for DISPLAY at 44 chars \(tail kept, marked …\)/);

  // 4. …and the FULL name is still in the result, twice over: as the literal
  //    next call, and as data.
  assert.match(t, new RegExp(`^next: lens_usage scope="project:${LONG_SLUG}" group_by="session"$`, 'm'));
  assert.equal(r.structuredContent.groups[0].name, LONG_SLUG);

  // 5. detail:true is the third door to the unclipped name.
  const d = await t2.handler(t2.config.inputSchema.parse({ detail: true }));
  assert.match(textOf(d), new RegExp(`^ {2}${LONG_SLUG}$`, 'm'));
});

// ---------------------------------------------------------------- session scope

test('session scope defaults to group_by=model and matches that session\'s own agg', async () => {
  const { SLUG, S1, EXPECT } = H.fixtures;
  const raw = await call('GET', `/api/session/${SLUG}/${S1}`);
  const r = await run({ scope: `session:${SLUG}/${S1}`, structured: true });
  assert.ok(!r.isError, textOf(r));

  assert.equal(r.structuredContent.groupBy, 'model');
  assert.equal(r.structuredContent.total.usdTcu, raw.json.agg.usd.total);
  assert.equal(r.structuredContent.total.usdTcu, EXPECT.s1Tcu);

  // Σ of the per-model rows is the session total, exactly.
  const sum = r.structuredContent.groups.reduce((n, g) => n + (g.usdTcu ?? 0), 0);
  assert.equal(sum, EXPECT.s1Tcu);

  const t = textOf(r);
  assert.match(t, /^USAGE — session:.* · group_by=model · sort=usd$/m);
  assert.match(t, /^groups sum to TOTAL: ✓/m);
  assert.match(t, /claude-fable-5/);
});

test('an unpriced model renders — and an unknown share, never $0.0000', async () => {
  const { SLUG, S1, EXPECT } = H.fixtures;
  const r = await run({ scope: `session:${SLUG}/${S1}`, group_by: 'model', structured: true });
  const row = r.structuredContent.groups.find((g) => g.name === EXPECT.unpricedModel);
  assert.ok(row, 'the rate-less model is a group of its own (R7)');
  assert.equal(row.usdTcu, null, 'a missing rate is null, never 0');
  assert.equal(row.requests, 1);

  const line = textOf(r).split('\n').find((l) => l.startsWith(EXPECT.unpricedModel));
  assert.ok(line, 'the unpriced model has a rendered row');
  assert.match(line, /—\s+—$/, 'unknown dollars and an unknown share both render —');
  assert.doesNotMatch(line, /\$0\.0000/);
  // …and the Σ check says so out loud rather than silently under-summing.
  assert.match(textOf(r), /1 group carries no dollar figure \(rendered —: .*\) and adds nothing to the Σ/);
});

// ---------------------------------------------------------------- disclosures

test('every nonzero disclosure counter the fixture carries is printed', async () => {
  const raw = await call('GET', '/api/index');
  const agg = raw.json.agg;
  // Assert against what the ledger actually reports, so this test tracks the
  // fixture rather than a memory of it.
  assert.ok(agg.synthetic > 0 && agg.neverFinalized > 0 && agg.ttlAssumed > 0);
  assert.ok(Object.keys(agg.unpriced).length > 0 && Object.keys(agg.inherited).length > 0);

  const t = textOf(await run({}));
  const line = t.split('\n').find((l) => l.startsWith('disclosures:'));
  assert.ok(line, 'a disclosures line is present');
  assert.match(line, /inherited 1 req \(billed in another session\)/); // R2 made visible
  assert.match(line, /neverFinalized 1/);
  assert.match(line, /synthetic 1/);
  assert.match(line, /ttlAssumed 1/);
  assert.match(line, /unpriced 1 req over 1 model/);
});

// ---------------------------------------------------------------- agents

test('group_by=agent on a store scope refuses and names the session requirement', async () => {
  const r = await run({ scope: 'store', group_by: 'agent' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /requires a session scope/);
  assert.match(textOf(r), /scope="session:<slug>\/<id>"/);
});

test('group_by=agent on a session scope lists the agents and states its coverage', async () => {
  const { SLUG, S1, A1, A2 } = H.fixtures;
  const r = await run({ scope: `session:${SLUG}/${S1}`, group_by: 'agent', structured: true });
  assert.ok(!r.isError, textOf(r));
  const names = r.structuredContent.groups.map((g) => g.name).sort();
  assert.deepEqual(names, [A1, A2].sort());
  // Agents are not a partition of a session — the main thread belongs to none
  // of them — so there is no share column and the shortfall is stated.
  assert.equal(r.structuredContent.covers, false);
  const header = textOf(r).split('\n').find((l) => l.startsWith('agentId'));
  assert.doesNotMatch(header, /share/, 'no share column when the groups are not a partition');
  assert.match(textOf(r), /^coverage: these 2 agent groups cover 2 of 5 billed requests and \$\S+ of \$\S+ in this scope/m);
  // …and no misleading "delta" line, because these groups were never meant to
  // sum to the scope.
  assert.doesNotMatch(textOf(r), /groups sum to TOTAL/);
});

test('with every agent aggregated, the coverage line claims no unknowns', async () => {
  // The negative half of the pair below: the disclosure clause must not appear
  // when there is nothing to disclose, or it would be noise on every call.
  const { SLUG, S1 } = H.fixtures;
  const r = await run({ scope: `session:${SLUG}/${S1}`, group_by: 'agent', structured: true });
  assert.equal(r.structuredContent.unknownGroupCount, 0);
  const line = textOf(r).split('\n').find((l) => l.startsWith('coverage: '));
  assert.ok(line, 'the coverage line ships');
  assert.doesNotMatch(line, /no computable figures/);
  assert.ok(line.endsWith('(no percentage column for that reason).'), `unexpected tail: ${line}`);
});

// ------------------------------------------------ an agent with no aggregate
//
// THE DEFECT THIS GUARDS. An agent whose transcript was never parsed carries
// `agg: null` — UNKNOWN, and a different fact from an agent the ledger covers
// that billed nothing. The per-row rendering has always got this right (`—`),
// but the COVERAGE line's arithmetic folds every such row in at 0 (`?? 0` on
// both the request count and the dollar sum) and then printed the result as
// "these N groups cover X of Y requests and $A of $B" — an at-least presented
// as an exact, with no disclosure. §0 rule 1 / §7.3.2: unknown is never 0.
//
// The fixture store's two agents both aggregate, so the shape is injected at
// the dispatcher seam — the same seam the long-slug and long-path tests use.

/** lens_usage over a /api/session whose FIRST agent lost its aggregate.
 *  Everything else is the real dispatcher's real payload. */
async function nulledAgentTool(slug, id) {
  const real = await call('GET', `/api/session/${slug}/${id}`);
  const server = fakeServer();
  register(server, {
    ctx: H.ctx,
    lens: H.lens,
    render,
    meta: { TOOLS_VERSION, lensDir: null, mcpDir: null },
    async call(method, pathname, query) {
      if (method === 'GET' && pathname === `/api/session/${slug}/${id}`) {
        const json = JSON.parse(JSON.stringify(real.json));
        if (json.agents && json.agents.length) json.agents[0].agg = null;
        return { status: real.status, json };
      }
      return call(method, pathname, query);
    },
  });
  return { tool: server.tools.get('lens_usage'), real };
}

test('an agent with no aggregate makes the coverage figures floors, and says so', async () => {
  const { SLUG, S1 } = H.fixtures;
  const { tool: t2, real } = await nulledAgentTool(SLUG, S1);
  const nulled = real.json.agents[0];
  const kept = real.json.agents[1];
  assert.ok(nulled.agg && kept.agg, 'the unmodified fixture aggregates both agents');

  const r = await t2.handler(t2.config.inputSchema.parse({
    scope: `session:${SLUG}/${S1}`, group_by: 'agent', structured: true,
  }));
  assert.ok(!r.isError, textOf(r));

  // 1. The unaggregated agent keeps its own row — it is an unknown, not an
  //    empty group, and must never be collapsed into the "recorded nothing"
  //    count that a provable zero earns.
  assert.equal(r.structuredContent.groupCount, 2);
  assert.equal(r.structuredContent.emptyGroupCount, 0);
  const row = r.structuredContent.groups.find((g) => g.name === nulled.agentId);
  assert.ok(row, 'the unaggregated agent is still listed');
  assert.equal(row.usdTcu, null);
  assert.equal(row.requests, null);
  assert.equal(row.tokens, null);

  // 2. The covered figures sum over the KNOWN agg only — the unknown adds
  //    nothing rather than being invented.
  const t = textOf(r);
  const line = t.split('\n').find((l) => l.startsWith('coverage: '));
  assert.ok(line, `no coverage line in:\n${t}`);
  assert.match(line, new RegExp(`^coverage: these 2 agent groups cover ${kept.agg.requests} of 5 billed requests`));
  assert.ok(
    line.includes(`and ${H.ctx.pricing.formatUsd(kept.agg.usd.total)} of `),
    `covered $ is not the surviving agent's own: ${line}`,
  );

  // 3. …and the sentence DISCLOSES that, rather than presenting an at-least as
  //    an exact. This is the whole defect.
  assert.match(line, /1 of these 2 agent groups has no computable figures/);
  assert.match(line, /its contribution is unknown, not zero, and is NOT included in the covered figures above, which are therefore floors rather than exact\./);

  // 4. The structured caller — who never sees the prose — learns it too.
  assert.equal(r.structuredContent.unknownGroupCount, 1);

  // 5. And the row itself still renders `—`, never $0.0000.
  const rendered = t.split('\n').find((l) => l.startsWith(nulled.agentId));
  assert.ok(rendered, 'the unaggregated agent has a rendered row');
  assert.doesNotMatch(rendered, /\$0\.0000/);
  assert.doesNotMatch(rendered, /\s0\s/);
});

// ---------------------------------------------------------------- dates

test('a date-filtered call sums the right bands and prints the limitation note', async () => {
  const raw = await call('GET', '/api/index');
  const bands = raw.json.dayBands;
  assert.ok(bands.length > 0, 'the fixture records at least one day band');
  const day = bands[0].localDate;

  const r = await run({ since: day, until: day, group_by: 'day', structured: true });
  assert.ok(!r.isError, textOf(r));
  assert.equal(r.structuredContent.groups.length, 1);
  assert.equal(r.structuredContent.groups[0].name, day);
  // The summed band, in exact tcu.
  assert.equal(r.structuredContent.total.usdTcu, bands[0].usd);
  assert.deepEqual(r.structuredContent.groups[0].tokens, bands[0].tokens);

  const t = textOf(r);
  assert.match(t, /^USAGE — store · \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2} \(1 recorded local day in range\) · group_by=day/m);
  assert.match(t, /note: date-filtered totals come from day bands, which carry tokens and \$ only\./);
  assert.match(t, /per-model split and the disclosure counters are not/);
  assert.match(t, /crossing\n\s+local midnight splits across days/);
  // Day bands carry no request count: `—`, not 0.
  assert.equal(r.structuredContent.groups[0].requests, null);
});

test('an undated day grouping prints Σ bands AND the ledger aggregate, and compares them', async () => {
  const raw = await call('GET', '/api/index');
  const r = await run({ group_by: 'day', structured: true });
  assert.ok(!r.isError, textOf(r));
  // The TOTAL row is Σ day bands; the scope aggregate is the ledger's own.
  const bandSum = raw.json.dayBands.reduce((n, b) => n + b.usd, 0);
  assert.equal(r.structuredContent.total.usdTcu, bandSum);
  assert.equal(r.structuredContent.scopeTotal.usdTcu, raw.json.agg.usd.total);
  assert.match(textOf(r), /^scope aggregate \(full ledger, every day\): 9 requests · \$0\.0776 · Σ day bands agree exactly$/m);
  // Day bands carry no request count, so a day row shows `—`, never 0.
  assert.equal(r.structuredContent.groups[0].requests, null);
});

test('a range that excludes every band totals $0 with the days it looked at stated', async () => {
  const r = await run({ since: '1999-01-01', until: '1999-01-02', group_by: 'day', structured: true });
  assert.ok(!r.isError, textOf(r));
  assert.equal(r.structuredContent.groups.length, 0);
  assert.equal(r.structuredContent.total.usdTcu, 0); // a real, provable zero over an empty range
  assert.match(textOf(r), /\(0 recorded local days in range\)/);
});

test('group_by=project over a date range sums each project\'s own bands to the store range', async () => {
  const raw = await call('GET', '/api/index');
  const day = raw.json.dayBands[0].localDate;
  const r = await run({ since: day, until: day, group_by: 'project', structured: true });
  assert.ok(!r.isError, textOf(r));
  // Per-project bands and the store's bands are the same walk, so this is an
  // equality, not an approximation.
  assert.match(textOf(r), /^groups sum to TOTAL: ✓/m);
  assert.equal(r.structuredContent.total.usdTcu, raw.json.dayBands[0].usd);
  assert.match(textOf(r), /^TOTAL\s+.*100\.0%$/m);
  assert.match(textOf(r), /note: date-filtered totals come from day bands/);
});

test('a group that recorded nothing is counted as a provable zero, not given a row', async () => {
  // No project has day bands in 1999, so every project group is an empty one.
  const r = await run({ since: '1999-01-01', until: '1999-01-02', group_by: 'project', structured: true });
  assert.ok(!r.isError, textOf(r));
  assert.equal(r.structuredContent.groups.length, 0);
  assert.equal(r.structuredContent.emptyGroupCount, 1);
  assert.match(textOf(r), /^all 1 project recorded nothing in this date range — a provable zero from the same source, not an unknown\.$/m);
});

test('a dated result labels the disclosure counters as the whole scope\'s', async () => {
  const raw = await call('GET', '/api/index');
  const day = raw.json.dayBands[0].localDate;
  const t = textOf(await run({ since: day, until: day, group_by: 'day' }));
  // The counters do not ride day bands and must not be read as the range's.
  assert.match(t, /^disclosures \(whole scope, not the date range\): /m);
});

test('a per-model split over a date range is refused, not approximated', async () => {
  const r = await run({ since: '2026-08-01', group_by: 'model' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not partitioned by model/);
  assert.match(textOf(r), /group_by="day"/);
});

test('dates outside store/project scope are refused with the reason', async () => {
  const { SLUG, S1 } = H.fixtures;
  const r = await run({ scope: `session:${SLUG}/${S1}`, since: '2026-08-01' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /day bands exist at store and project scope only/);
});

test('since after until is refused rather than silently returning nothing', async () => {
  const r = await run({ since: '2026-08-09', until: '2026-08-01' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /both bounds are inclusive/);
});

// ---------------------------------------------------------------- refusals

test('an unparseable scope is a tool error carrying the grammar', async () => {
  const r = await run({ scope: 'sessions/whatever' });
  assert.equal(r.isError, true);
  const t = textOf(r);
  assert.match(t, /unparseable scope/);
  assert.match(t, /scope grammar: store \| project:<slug> \| session:<slug>\/<id>/);
});

test('an unknown scope kind is refused by the lens\'s own parser', async () => {
  const r = await run({ scope: 'workflow:abc' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /unknown scope kind: workflow/);
});

test('a nonexistent project is a readable error naming the tool that lists them', async () => {
  const r = await run({ scope: 'project:no-such-project' });
  assert.equal(r.isError, true);
  // render.httpMessage relays the lens's own CODE and MESSAGE rather than
  // paraphrasing them (an agent can match `unknown-project` against the lens's
  // docs; a paraphrase it cannot), then names the way out.
  assert.match(textOf(r), /404 unknown-project — no project no-such-project/);
  assert.match(textOf(r), /lens_sessions/);
});

test('group_by=workflow says where it lands and what to use meanwhile', async () => {
  const r = await run({ group_by: 'workflow' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not implemented yet/);
  assert.match(textOf(r), /phase 2 with lens_workflow/);
  assert.match(textOf(r), /group_by="agent"/);
});

test('group_by=project inside a project scope is refused with the alternative', async () => {
  const { SLUG } = H.fixtures;
  const r = await run({ scope: `project:${SLUG}`, group_by: 'project' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /needs the store scope/);
  assert.match(textOf(r), /group_by="session"/);
});

// ---------------------------------------------------------------- projects, sessions, limits

test('a project scope defaults to group_by=session and matches the project agg', async () => {
  const { SLUG, EXPECT, S1, S2 } = H.fixtures;
  const raw = await call('GET', `/api/project/${SLUG}`);
  const r = await run({ scope: `project:${SLUG}`, structured: true });
  assert.ok(!r.isError, textOf(r));
  assert.equal(r.structuredContent.groupBy, 'session');
  assert.equal(r.structuredContent.total.usdTcu, raw.json.agg.usd.total);
  assert.equal(r.structuredContent.total.usdTcu, EXPECT.totalTcu);

  const byName = new Map(r.structuredContent.groups.map((g) => [g.name, g]));
  assert.equal(byName.get(`${SLUG}/${S1}`).usdTcu, EXPECT.s1Tcu);
  assert.equal(byName.get(`${SLUG}/${S2}`).usdTcu, EXPECT.s2Tcu);

  const t = textOf(r);
  assert.match(t, /^basis: 2 of 2 sessions in this project aggregated/m);
  assert.match(t, /^groups sum to TOTAL: ✓/m);
  // The LITE source is stated, with the call that gets the full split.
  assert.match(t, /LITE session aggregate/);
});

test('limit truncates and says how many groups it did not show', async () => {
  const { SLUG } = H.fixtures;
  const r = await run({ scope: `project:${SLUG}`, group_by: 'session', limit: 1, structured: true });
  const t = textOf(r);
  assert.match(t, /^… 1 more session \(2 total; raise limit to see all\)$/m);
  // The TOTAL row still covers both sessions — that is why it reads 100.0%.
  assert.equal(r.structuredContent.total.usdTcu, H.fixtures.EXPECT.totalTcu);
  assert.match(t, /^TOTAL\s+9\s+\S+\s+\$0\.0776\s+100\.0%$/m);
  assert.equal(r.structuredContent.shownCount, 1);
  assert.equal(r.structuredContent.groupCount, 2);
});

test('sort=name orders by the group name, ascending', async () => {
  const { SLUG, S1, S2 } = H.fixtures;
  const r = await run({ scope: `project:${SLUG}`, group_by: 'session', sort: 'name', structured: true });
  const names = r.structuredContent.groups.map((g) => g.name);
  assert.deepEqual(names, [`${SLUG}/${S1}`, `${SLUG}/${S2}`].sort());
});

test('group_by=none reports the scope total and nothing else', async () => {
  const { EXPECT } = H.fixtures;
  const r = await run({ group_by: 'none', structured: true });
  const t = textOf(r);
  assert.match(t, /^total: 9 requests · \$0\.0776 · tokens \S+$/m);
  assert.equal(r.structuredContent.groups.length, 0);
  assert.equal(r.structuredContent.total.usdTcu, EXPECT.totalTcu);
});

// ------------------------------------- the component split and its true scope
//
// THE DEFECT THESE GUARD. `group_by=none` printed its `usd:` component line
// from the SCOPE AGGREGATE while its header total came from the day bands the
// date range selected. On the real corpus that put (figures synthetic here,
// same shape as the real repro)
//
//   total: — requests · $111.1111 · tokens 42M
//     usd: … · total $999.9999
//
// in adjacent lines: a range subtotal with the whole store's split under it,
// unlabelled, while the `tokens:` line on the same call was correctly filtered.
// Day bands carry ONE dollar number per day (the lens's server/api/bands.mjs:
// `b.usd += priceRowTcu(...)`), so no split of a date range exists anywhere in
// the recorded data — which makes printing one an invention, not a rounding.

/** lens_usage over a /api/index carrying a SECOND day band, so a one-day range
 *  is a strict, nonzero subset of the scope and the two figures must differ. */
const DAY_A = '2026-08-01';
const DAY_B = '2026-08-02';
async function twoBandTool() {
  const real = await call('GET', '/api/index');
  const server = fakeServer();
  register(server, {
    ctx: H.ctx,
    lens: H.lens,
    render,
    meta: { TOOLS_VERSION, lensDir: null, mcpDir: null },
    async call(method, pathname, query) {
      if (method === 'GET' && pathname === '/api/index') {
        const json = JSON.parse(JSON.stringify(real.json));
        const first = json.dayBands[0];
        json.dayBands = [
          { ...first, localDate: DAY_B, startMs: H.lens.api.dayStartMsOf(DAY_B), usd: 50000000 },
          first,
        ];
        return { status: real.status, json };
      }
      return call(method, pathname, query);
    },
  });
  return { tool: server.tools.get('lens_usage'), agg: real.json.agg };
}

test('a date-filtered group_by=none never prints the whole scope\'s component split', async () => {
  const { tool: t2, agg } = await twoBandTool();
  const r = await t2.handler(t2.config.inputSchema.parse({
    group_by: 'none', since: DAY_B, until: DAY_B, detail: true, structured: true,
  }));
  assert.ok(!r.isError, textOf(r));
  const j = r.structuredContent;
  const t = textOf(r);

  // The header is the RANGE's, and it is not the whole scope's — which is the
  // precondition that makes an unlabelled split beneath it a false statement.
  assert.equal(j.total.usdTcu, 50000000);
  assert.notEqual(j.total.usdTcu, agg.usd.total);

  // 1. THE REGRESSION. If a component split is printed as this total's, its
  //    components must sum to no more than the total they claim to split.
  //    (Here it is not printed at all — day bands carry none.)
  if (j.total.usd) {
    const sum = ['input', 'output', 'cacheWrite', 'cacheRead', 'webSearch']
      .reduce((n, k) => n + (j.total.usd[k] ?? 0), 0);
    assert.ok(sum <= j.total.usdTcu, `printed components (${sum}) exceed their own header (${j.total.usdTcu})`);
    assert.ok(j.total.usd.total <= j.total.usdTcu);
  }

  // 2. No unlabelled component line may appear on a dated call whose header is
  //    not the whole-scope total. `usd: in $…` is that line's exact shape.
  assert.doesNotMatch(t, /^\s*usd: in \$/m, `an unscoped component split is still printed:\n${t}`);
  // …and the whole scope's total does not appear anywhere as a bare split.
  assert.ok(!t.includes(`total ${H.ctx.pricing.formatUsd(agg.usd.total)}`), `the whole-scope split leaked into a dated render:\n${t}`);

  // 3. The absence is STATED, with the reason and the call that answers it.
  assert.match(t, /^\s*usd: total \$\S+ · component split not available for this total —/m);
  assert.match(t, /day bands carry one dollar TOTAL per local day and no component object/);
  assert.match(t, /re-run without since\/until \(lens_usage scope="store" group_by="none" detail=true\)/);

  // 4. …and the structured caller, who never sees the prose, learns it too.
  assert.equal(j.total.usd, null);
  assert.match(j.total.usdSplitUnavailable, /not day-partitioned|no component object/);
  assert.equal(j.aggCoversDateRange, false, '`agg` is the whole scope even on a dated call');
  assert.equal(j.agg.usd.total, agg.usd.total);
});

test('an undated group_by=none does print the split, and it is a split of its OWN header', async () => {
  // The other half of the pair: suppressing the line everywhere would "fix" the
  // bug by deleting the feature.
  const r = await run({ group_by: 'none', detail: true, structured: true });
  const j = r.structuredContent;
  const t = textOf(r);
  assert.match(t, /^\s*usd: in \$.* · total \$/m);
  assert.ok(j.total.usd, 'the undated total carries its own component split');
  assert.equal(j.total.usd.total, j.total.usdTcu, 'the split splits exactly the header printed above it');
  assert.equal(j.total.usdSplitUnavailable, null);
  assert.equal(j.aggCoversDateRange, true);
});

test('structured total.usd is a split of total.usdTcu under every grouping, or a stated absence', async () => {
  // The field means ONE thing everywhere: the components of the number printed
  // beside it. An undated grouping's total is the scope aggregate, so it
  // carries the aggregate's split; `day` totals Σ bands — a different quantity
  // — and carries none, with the reason.
  const raw = await call('GET', '/api/index');
  for (const group_by of ['none', 'project', 'session', 'day']) {
    const j = (await run({ group_by, structured: true })).structuredContent;
    if (group_by === 'day') {
      assert.equal(j.total.usd, null, 'Σ day bands has no component split');
      assert.match(j.total.usdSplitUnavailable, /no component object/);
      continue;
    }
    assert.ok(j.total.usd, `group_by=${group_by} lost the component split`);
    assert.equal(j.total.usd.total, j.total.usdTcu, `group_by=${group_by} splits a number other than its own total`);
    assert.equal(j.total.usd.total, raw.json.agg.usd.total);
    assert.equal(j.total.usdSplitUnavailable, null);
  }
});

test('a dated grouping with per-row detail labels each row\'s source, and never a whole-scope split', async () => {
  // The same defect, checked on the OTHER dated paths: a day/project row's
  // `usd:` must be the row's own summed bands, and must say the split is not
  // carried rather than borrowing the scope aggregate's.
  const raw = await call('GET', '/api/index');
  const day = raw.json.dayBands[0].localDate;
  for (const group_by of ['day', 'project']) {
    const t = textOf(await run({ since: day, until: day, group_by, detail: true }));
    assert.doesNotMatch(t, /^\s*usd: in \$/m, `a component split is printed under group_by=${group_by} over a date range:\n${t}`);
    assert.match(t, /usd: total \$\S+ \(component split not carried by this source: /,
      `group_by=${group_by} should state the absence per row`);
  }
});

test('every grouping points at the call that carries the per-component USD split', async () => {
  // The split existed only under group_by="none" and nothing said so, which is
  // how a caller ends up writing a script for a figure this tool already has.
  const { SLUG, S1 } = H.fixtures;
  const cases = [
    {},
    { group_by: 'day' },
    { group_by: 'session' },
    { scope: `project:${SLUG}` },
    { scope: `session:${SLUG}/${S1}`, group_by: 'model' },
    { scope: `session:${SLUG}/${S1}`, group_by: 'agent' },
  ];
  for (const args of cases) {
    const t = textOf(await run(args));
    const scopeRaw = args.scope ?? 'store';
    const line = t.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`lens_usage scope="${scopeRaw}" group_by="none" detail=true`));
    assert.ok(line, `no per-component split pointer under ${JSON.stringify(args)}:\n${t}`);
    assert.match(line, /per-component USD split: in\/out\/cacheWrite\/cacheRead\/webSearch/);
  }
  // A group_by=none call that already asked for the split does not point at
  // itself — the hint would be the call the caller just made.
  const already = textOf(await run({ group_by: 'none', detail: true }));
  assert.doesNotMatch(already, /group_by="none" detail=true/);
  // …but one that did NOT ask for it still learns where the split lives.
  assert.match(textOf(await run({ group_by: 'none' })), /group_by="none" detail=true/);
});

// ------------------------------------------------------- the agent model ladder

test('group_by=agent resolves a model the raw payload leaves null, in text AND structured', async () => {
  // The fixture's agents record `resolvedModel: null` with `models[0]` set —
  // the exact shape a workflow-spawned agent has on the real corpus, where 133
  // of 133 agents in one session carry a null resolvedModel.
  const { SLUG, S1 } = H.fixtures;
  const raw = await call('GET', `/api/session/${SLUG}/${S1}`);
  assert.equal(raw.json.agents[0].resolvedModel, null, 'the fixture reproduces the defect shape');

  const r = await run({ scope: `session:${SLUG}/${S1}`, group_by: 'agent', detail: true, structured: true });
  const t = textOf(r);
  assert.match(t, /^\s+model \(recorded\): claude-fable-5$/m);
  for (const g of r.structuredContent.groups) {
    assert.equal(g.model, 'claude-fable-5', 'the JSON carries the same model the text printed');
    assert.equal(g.modelSource, 'models[0]', 'and names which recorded field answered');
  }
});

test('detail:true prints the component USD split where the source carries one', async () => {
  const r = await run({ detail: true, structured: true });
  const t = textOf(r);
  assert.match(t, /^detail \(per group, recorded\):$/m);
  assert.match(t, /^\s+usd: in \$.* · out \$.* · cacheWrite \$.* · cacheRead \$.* · webSearch \$.* · total \$/m);
  assert.match(t, /^\s+tokens: input .* · output .* · cache5m .* · cache1h .* · cacheFlat .* · cacheRead /m);
});

test('detail:true on a LITE source says the split is not carried, rather than printing zeros', async () => {
  const { SLUG } = H.fixtures;
  const t = textOf(await run({ scope: `project:${SLUG}`, group_by: 'session', detail: true }));
  assert.match(t, /usd: total \$\S+ \(component split not carried by this source: session agg \(LITE\)\)/);
});

// ---------------------------------------------------------------- structured

test('structured output is opt-in and carries exact integer tcu', async () => {
  const plain = await run({});
  assert.equal(plain.structuredContent, undefined, 'text-only by default (§7.2)');

  const s = await run({ structured: true });
  assert.equal(s.structuredContent.pricingVersion, H.lens.pricing.PRICING_VERSION);
  assert.equal(s.structuredContent.indexVersion, H.lens.store.INDEX_VERSION);
  assert.equal(s.structuredContent.scope, 'store');
  assert.equal(typeof s.structuredContent.total.usdTcu, 'number');
  assert.ok(Number.isInteger(s.structuredContent.total.usdTcu));
});

// ------------------------------------------------------- honest hints
//
// The same guard lens_search carries, applied to lens_usage. Two of this
// renderer's `next:` hints named lens_rows — `lens_rows scope="turn:…"` under
// a turn/agent scope, and `lens_rows scope="agent:…"` under group_by=agent.
// lens_rows is phase 2 and this server does not register it, so both read as
// callable and dead-ended. See tests/mcp/helpers.mjs assertHonestHints.

test('no lens_usage render offers a phase-2 tool as a callable', async () => {
  const { SLUG, S1, A1 } = H.fixtures;
  const shapes = [
    {},
    { scope: 'store', group_by: 'day' },
    { scope: `project:${SLUG}` },
    { scope: `project:${SLUG}`, group_by: 'session' },
    { scope: `session:${SLUG}/${S1}` },
    { scope: `session:${SLUG}/${S1}`, group_by: 'agent' },
    { scope: `session:${SLUG}/${S1}`, group_by: 'none', detail: true },
    { scope: `turn:${SLUG}/${S1}/1` },
    { scope: `agent:${SLUG}/${S1}/${A1}` },
    // The refusals render text too, and one of them names lens_workflow.
    { group_by: 'workflow' },
    { scope: 'store', group_by: 'agent' },
  ];
  for (const args of shapes) {
    const t = textOf(await run(args));
    assertHonestHints(assert, t, `lens_usage ${JSON.stringify(args)}`);
  }
});

test('the slices that used to point at lens_rows now point at a tool that exists', async () => {
  const { SLUG, S1, A1 } = H.fixtures;

  // A turn scope: the structure it sits in, and the session's per-agent split.
  const turn = textOf(await run({ scope: `turn:${SLUG}/${S1}/1` }));
  assert.ok(turn.includes(`lens_session slug="${SLUG}" id="${S1}"`), turn);
  assert.ok(turn.includes(`lens_usage scope="session:${SLUG}/${S1}" group_by="agent"`), turn);

  // An agent grouping: the agentId stays addressable, through lens_usage.
  const byAgent = textOf(await run({ scope: `session:${SLUG}/${S1}`, group_by: 'agent' }));
  assert.match(byAgent, /lens_usage scope="agent:[^"]+" group_by="model"/, byAgent);
  const top = byAgent.split('\n').find((l) => l.startsWith('next: '));
  assert.ok(top && [A1, H.fixtures.A2].some((a) => top.includes(a)), `the hint addresses a real agentId: ${top}`);
});

test('the lens_usage description does not promise an unbuilt tool as a call', () => {
  const d = tool.config.description;
  for (const name of UNBUILT_TOOLS) {
    assert.ok(!new RegExp(`\b${name}\s+[a-z_]+=`).test(d), `the description renders ${name} as callable`);
  }
  // Every call the description spells out is one this server registers.
  for (const c of literalCalls(d)) assert.ok(PHASE1_TOOLS.includes(c), `description names ${c}`);
});
