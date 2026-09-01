// tests/status.test.mjs — lens_status (src/tools/status.mjs).
//
// lens_status is the orientation tool and the recovery path out of a "still
// building" result, so its renderer is the one place an agent looks when it
// does not yet trust anything else. What is proved here:
//
//  * the version line names all four versions a cost figure is traceable
//    under (app, tools, index, pricing) — a dollar amount without its rate
//    table is not a fact anyone can re-derive,
//  * every count ships its denominator (`N of M sessions`, `over N of M`),
//  * the three index states render as three DIFFERENT sentences, and
//    `building` is a NORMAL result, never isError (SPEC §4.3 / §7.3.6),
//  * a nonzero disclosure counter reaches the output and an all-zero set
//    prints no line at all (§7.3.4),
//  * `rowsSumToHeader` prints even when it FAILS (§7.3.5),
//  * a truncated problems list says how many it dropped (§7.1) — in the TEXT
//    and in `structuredContent`, under the same cap, with `problemsTotal`
//    naming the un-capped number and per-row `sources[]` reduced to a count,
//  * `building` closes the loop it opens by saying when to come back, and says
//    it qualitatively unless the payload recorded an interval,
//  * unknown renders `—` and never a fabricated count (§7.3.2),
//  * `structured` opts in to the JSON and defaults off (§7.2).
//
// The fixture store indexes cleanly and instantly, so it only ever produces
// the `ready` state. Every other state is injected at the dispatcher seam —
// the same technique tests/sessions.test.mjs uses for its 409 and its
// null-agg card — because those shapes exist only on a messier corpus.
//
// DELIBERATELY NOT ASSERTED: the presence or absence of any line naming the
// lens directory or the cache directory. Those are process-local paths, not
// corpus facts, and whether the renderer prints them is a live question; this
// file pins the contract that does not depend on the answer.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as render from '../src/render.mjs';
import { createDispatcher } from '../src/dispatch.mjs';
import { register } from '../src/tools/status.mjs';
import { TOOLS_VERSION } from '../src/context.mjs';
import { fixtureContext, LENS_DIR, MCP_DIR } from './helpers.mjs';

let H;      // { ctx, lens, fixtures, close }
let call;   // the real in-process dispatcher

before(async () => {
  H = await fixtureContext();
  call = createDispatcher(H.lens, H.ctx);
});

after(async () => { if (H) await H.close(); });

// ------------------------------------------------------------------ harness

/**
 * A stand-in for McpServer that parses arguments through the registered zod
 * schema before calling the handler, exactly as the SDK does. The schema's
 * default (`structured: false`) is therefore under test rather than being
 * re-stated by every call site here.
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

// deps as lens-mcp.mjs builds them. `callOverride` substitutes a response at
// the dispatcher seam.
function tool(callOverride = null) {
  const server = fakeServer();
  register(server, {
    ctx: H.ctx,
    lens: H.lens,
    call: callOverride || call,
    render,
    meta: { TOOLS_VERSION, lensDir: LENS_DIR, mcpDir: MCP_DIR },
  });
  return server.get('lens_status');
}

/** A tool whose /api/index 200 body is rewritten on the way through. */
function withView(mutate) {
  const inject = async (method, path, query) => {
    const r = await call(method, path, query);
    if (path === '/api/index' && r.status === 200 && r.json) mutate(r.json);
    return r;
  };
  return tool(inject);
}

/** A tool whose /api/hello 200 body is rewritten on the way through. */
function withHello(mutate) {
  const inject = async (method, path, query) => {
    const r = await call(method, path, query);
    if (path === '/api/hello' && r.status === 200 && r.json) mutate(r.json);
    return r;
  };
  return tool(inject);
}

const textOf = (r) => {
  assert.ok(Array.isArray(r.content) && r.content[0] && r.content[0].type === 'text',
    'result carries one text content block');
  return r.content[0].text;
};

const lineStarting = (text, prefix) =>
  text.split('\n').find((l) => l.startsWith(prefix));

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------ surface

test('registers read-only, with no outputSchema and only `structured`', async () => {
  const t = tool();
  assert.equal(t.config.title, 'Lens status');
  assert.deepEqual(t.config.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  // SPEC §7.2: an outputSchema would oblige every call to ship structuredContent.
  assert.equal(t.config.outputSchema, undefined);
  assert.deepEqual(Object.keys(t.config.inputSchema.shape), ['structured']);
  // The description has to tell an agent WHEN to reach for this tool — it is
  // the documented recovery path out of a "still building" result.
  assert.match(t.config.description, /still building/i);
  assert.match(t.config.description, /Read-only/i);
});

test('register() is repeatable — the stdio transport builds a throwaway server', async () => {
  const a = textOf(await tool().invoke({}));
  const b = textOf(await tool().invoke({}));
  assert.equal(a, b, 'a second registration renders identically');
});

// ------------------------------------------------------------------ ready

test('ready: version line names all four versions', async () => {
  const text = textOf(await tool().invoke({}));
  const expect = `LENS ${H.ctx.appVersion} · tools v${TOOLS_VERSION} · index v${H.lens.store.INDEX_VERSION} · pricing v${H.lens.pricing.PRICING_VERSION}`;
  assert.match(text, new RegExp(`^${esc(expect)}$`, 'm'),
    'a cost figure is only traceable if the rate table and index format are named');
  // …and it is the FIRST line: an agent that reads one line reads this one.
  assert.equal(text.split('\n')[0], expect);
});

test('ready: the app version comes from /api/hello, not from ctx alone', async () => {
  // hello is the identity the lens itself answers a port probe with, so it is
  // the authority on which build answered. ctx.appVersion is only the fallback.
  const t = withHello((h) => { h.version = '9.9.9-probe'; });
  const text = textOf(await t.invoke({}));
  assert.match(text, /^LENS 9\.9\.9-probe · tools v/m);
});

test('ready: the corpus line names the directory AND the ladder rung that won', async () => {
  const text = textOf(await tool().invoke({}));
  const line = lineStarting(text, 'corpus: ');
  assert.ok(line, 'a corpus line is printed');
  assert.ok(line.includes(H.ctx.projectsDir), 'the real resolved corpus root, not a paraphrase');
  assert.ok(line.includes(`(from ${H.ctx.projectsDirSource})`),
    'the winning rung of the config ladder is named — "where is the corpus" has one answer');
});

test('ready: the index line states N of M sessions, bytes and project count', async () => {
  const text = textOf(await tool().invoke({}));
  // The project count is pluralised off the recorded number — `1 projects` is
  // the tell of a count pasted next to a hard-coded noun.
  assert.match(text, /^index: ready — 2 of 2 sessions, [\d.]+ [A-Z]*B, 1 project$/m);
  // A `building` sentence must not also be present — the states are exclusive.
  assert.ok(!text.includes('index: building'));
});

test('ready: the span line reads off dayBands, oldest .. newest, in local days', async () => {
  const idx = await call('GET', '/api/index');
  const bands = idx.json.dayBands;
  const first = bands[bands.length - 1].localDate;
  const last = bands[0].localDate;
  const text = textOf(await tool().invoke({}));
  assert.match(text, new RegExp(`^span: ${esc(first)} \\.\\. ${esc(last)} \\(${bands.length} local day${bands.length === 1 ? '' : 's'}\\)$`, 'm'));
});

test('a corpus with no day bands says so rather than printing an empty range', async () => {
  const t = withView((view) => { view.dayBands = []; });
  const text = textOf(await t.invoke({}));
  assert.match(text, /^span: no day bands recorded$/m);
  assert.ok(!/^span: .* \.\. /m.test(text), 'no fabricated range');
});

test('ready: the store total ships its denominator and the token line under it', async () => {
  const idx = await call('GET', '/api/index');
  const agg = idx.json.agg;
  const usd = H.ctx.pricing.formatUsd(agg.usd.total);
  const text = textOf(await tool().invoke({}));

  assert.match(text, new RegExp(`^store total: 9 requests · ${esc(usd)}   \\(over 2 of 2 sessions\\)$`, 'm'),
    'never a bare total — §7.3.3');
  // The money figure is the ledger's own renderer, byte-identical to the UI's.
  assert.equal(agg.usd.total, H.fixtures.EXPECT.totalTcu, 'fixture precondition');

  // The token line is the shared four-figure summary, indented under the total.
  assert.match(text, new RegExp(`^ {2}${esc(render.tokenSummary(agg.tokens))}$`, 'm'));
});

test('an index with no computable aggregate says UNKNOWN, never $0', async () => {
  const t = withView((view) => { view.agg = null; });
  const text = textOf(await t.invoke({}));
  assert.match(text, /^store total: — \(no session aggregate computable yet — 2 of 2 sessions\)$/m);
  assert.ok(!text.includes('$0.0000'), 'unknown is never rendered as a zero dollar figure');
  // With no agg there is no token mass to summarise either — the line is
  // dropped rather than printed as four dashes.
  assert.ok(!/^ {2}in /m.test(text));
});

test('ready: rowsSumToHeader and lostAgents are printed, both provable', async () => {
  const text = textOf(await tool().invoke({}));
  assert.match(text, /^rows sum to header: ✓ · lostAgents: 0$/m,
    'lostAgents is a census, so a provable zero renders 0 — not —');
});

test('a FAILED cross-check is printed, not hidden', async () => {
  // §7.3.5: hiding a failed rowsSumToHeader would be the worst omission in a
  // tool whose whole value is that its numbers are trustworthy.
  const t = withView((view) => { view.rowsSumToHeader = { delta: 4000000000 }; });
  const text = textOf(await t.invoke({}));
  const line = lineStarting(text, 'rows sum to header:');
  assert.ok(line, 'the cross-check line still ships when it fails');
  assert.match(line, /^rows sum to header: delta \$2\.0000 · lostAgents: 0$/,
    'the delta is rendered in the lens\'s own money renderer, from integer tcu');
});

test('an uncomputable cross-check and a lost-agent census both render honestly', async () => {
  const t = withView((view) => { view.rowsSumToHeader = null; view.lostAgents = null; });
  assert.match(textOf(await t.invoke({})), /^rows sum to header: — · lostAgents: —$/m);
});

// ------------------------------------------------------------------ disclosures

test('every nonzero disclosure counter on the store agg reaches the output', async () => {
  // The fixture records, across its two sessions: inherited 1 req (an R2 copy
  // billed in the other session), unpriced 1 req (a model with no rate),
  // neverFinalized 1, synthetic 1, ttlAssumed 1.
  const text = textOf(await tool().invoke({}));
  const line = lineStarting(text, 'disclosures: ');
  assert.ok(line, 'a disclosures line is printed when any counter is nonzero');
  assert.match(line, /inherited 1 req \(billed in another session\)/);
  assert.match(line, /unpriced 1 req over 1 model/);
  assert.ok(!/unpriced .*\$0/.test(line), 'an unpriced row is never counted as $0');
  assert.match(line, /neverFinalized 1/);
  assert.match(line, /synthetic 1/);
  assert.match(line, /ttlAssumed 1/);
  // R8 metrics are not disclosures and must not clutter the line.
  assert.ok(!line.includes('webSearchRequests'));
  assert.ok(!line.includes('webFetchRequests'));
});

test('an all-zero disclosure set prints NO line — "disclosures: none" would cost tokens to say nothing', async () => {
  const t = withView((view) => {
    const empty = H.lens.ledger.emptyCostAgg();
    view.agg = { ...empty, requests: view.agg.requests, tokens: view.agg.tokens, usd: view.agg.usd };
  });
  const text = textOf(await t.invoke({}));
  assert.ok(!text.includes('disclosures:'), 'the line is omitted entirely, not printed empty');
  // …and the rest of the render is unaffected.
  assert.match(text, /^store total: /m);
});

// ------------------------------------------------------------------ problems

test('ready: the problems line prints the folded code, count and what it affects', async () => {
  const idx = await call('GET', '/api/index');
  assert.equal(idx.json.problems.length, 1, 'fixture precondition: one folded problem');
  const text = textOf(await tool().invoke({}));
  assert.match(text, /^problems: 1 \(torn-line ×1 affects:aggregates\)$/m);
});

test('no recorded problems renders a provable zero', async () => {
  const t = withView((view) => { view.problems = []; });
  assert.match(textOf(await t.invoke({})), /^problems: 0$/m);
});

test('a problems list past 5 is truncated AND says how many it dropped', async () => {
  const t = withView((view) => {
    view.problems = Array.from({ length: 7 }, (_, i) => ({
      code: `code-${i}`, count: i + 1, affects: 'aggregates',
    }));
  });
  const line = lineStarting(textOf(await t.invoke({})), 'problems: ');
  // The COUNT is the full folded total; only the enumeration is cut.
  assert.match(line, /^problems: 7 \(/, 'the headline count is never the truncated one');
  assert.ok(line.includes('code-0 ×1 affects:aggregates'));
  assert.ok(line.includes('code-4 ×5 affects:aggregates'));
  assert.ok(!line.includes('code-5'), 'the sixth is not shown');
  assert.match(line, / · … 2 more\)$/, 'a silent truncation would be a correctness bug');
});

test('a problem missing its count or scope renders its recorded absence', async () => {
  const t = withView((view) => { view.problems = [{ code: 'torn-line' }]; });
  const line = lineStarting(textOf(await t.invoke({})), 'problems: ');
  // `count` absent is assumed to be one occurrence (the fold writes it only
  // when it folded); `affects` absent is UNKNOWN and renders `—`.
  assert.equal(line, 'problems: 1 (torn-line ×1 affects:—)');
});

// ------------------------------------------------------------------ pending parse

test('sessions still waiting on a first parse are named; an empty list prints nothing', async () => {
  assert.ok(!textOf(await tool().invoke({})).includes('pending parse'),
    'the fixture has none, and a provable none is not worth a line');
  const t = withView((view) => { view.pending = [{ id: 'a' }, { id: 'b' }]; });
  assert.match(textOf(await t.invoke({})), /^pending parse: 2 sessions$/m);
});

// ------------------------------------------------------------------ R2

test('a pending R2 resolution is disclosed; the resolved state prints nothing', async () => {
  const t = withView((view) => { view.status = { ...view.status, r2: 'pending' }; });
  assert.match(textOf(await t.invoke({})),
    /^R2 fork resolution: pending — inherited\/forked figures may still change$/m);
  // The fixture index has RESOLVED R2, and a footer on every result is a
  // footer nobody reads.
  assert.ok(!textOf(await tool().invoke({})).includes('R2 fork resolution'));
});

// ------------------------------------------------------------------ building

test('building: progress in bytes AND sessions, and it is a NORMAL result', async () => {
  const t = withView((view) => {
    view.status = {
      ...view.status,
      state: 'building',
      sessionsDone: 1,
      sessionsTotal: 2,
      bytesIndexed: 412 * 1024 * 1024,
      bytesTotal: 1.18 * 1024 * 1024 * 1024,
    };
  });
  const r = await t.invoke({});
  // SPEC §4.3 / §7.3.6 / acceptance criterion 5: a pending index is a STATE.
  // An agent can act on "figures cover what is indexed so far"; it cannot act
  // on an exception.
  assert.notEqual(r.isError, true, 'building is a state, not an error');
  const text = textOf(r);

  assert.match(text, /^index: building — 412 MB of 1\.2 GB \(1 of 2 sessions summarised\); re-check shortly; figures below cover what is indexed so far$/m);

  // The whole point of the sentence is that the figures BELOW it are partial,
  // so they must still be printed, each with its own denominator.
  assert.match(text, /^store total: 9 requests · .*\(over 2 of 2 sessions\)$/m);
  assert.match(text, /^rows sum to header: /m);
  // …and the recovery hint an agent needs next is still there.
  assert.match(text, /^next: lens_sessions/m);
});

test('building with no recorded byte progress renders — rather than 0 B', async () => {
  const t = withView((view) => {
    view.status = { ...view.status, state: 'building', bytesIndexed: null, bytesTotal: null };
  });
  assert.match(textOf(await t.invoke({})), /^index: building — — of — \(2 of 2 sessions summarised\)/m);
});

test('building: the line states WHEN to come back — qualitatively, since no interval is recorded', async () => {
  // lens_status is the documented way out of a "still building" result, so the
  // line has to close the loop it opens. `retryAfterMs` is a field of the 409
  // not-indexed-yet ENVELOPE (server/errors.mjs), NOT of index.status(), which
  // records only state/sessions/bytes — so printing "~1s" here would be a
  // number nobody recorded on this payload.
  const t = withView((view) => { view.status = { ...view.status, state: 'building' }; });
  const line = lineStarting(textOf(await t.invoke({})), 'index: building');
  assert.ok(line.includes('re-check shortly'), line);
  assert.ok(!/retry in ~/.test(line), 'an interval nobody recorded is a fabricated fact');
});

test('building: a retryAfterMs the payload DOES carry is stated as seconds', async () => {
  const t = withView((view) => {
    view.status = { ...view.status, state: 'building', retryAfterMs: 2000 };
  });
  const line = lineStarting(textOf(await t.invoke({})), 'index: building');
  // Same rounding as render.pendingResult(), so the 409 path and this one can
  // never disagree about the same milliseconds.
  assert.ok(line.includes('retry in ~2s'), line);
  assert.ok(!line.includes('re-check shortly'), 'the recorded interval wins');
});

test('building: a sub-second interval rounds UP to 1s rather than to "~0s"', async () => {
  const t = withView((view) => {
    view.status = { ...view.status, state: 'building', retryAfterMs: 250 };
  });
  assert.ok(lineStarting(textOf(await t.invoke({})), 'index: building').includes('retry in ~1s'));
});

test('a nonsense retryAfterMs falls back to the qualitative hint', async () => {
  for (const bad of [-1, NaN, Infinity, '2000', null]) {
    const t = withView((view) => {
      view.status = { ...view.status, state: 'building', retryAfterMs: bad };
    });
    const line = lineStarting(textOf(await t.invoke({})), 'index: building');
    assert.ok(line.includes('re-check shortly'), `${String(bad)} -> ${line}`);
  }
});

// ------------------------------------------------------------------ plurals

test('the project count pluralises off the recorded number, in both directions', async () => {
  const two = withView((view) => { view.projects = [{ slug: 'a' }, { slug: 'b' }]; });
  assert.match(textOf(await two.invoke({})), /, 2 projects$/m);

  const none = withView((view) => { view.projects = []; });
  assert.match(textOf(await none.invoke({})), /, 0 projects$/m);

  // An UNKNOWN count keeps the noun plural: choosing the singular would be a
  // claim about a number nobody recorded.
  const unknown = withView((view) => { delete view.projects; });
  assert.match(textOf(await unknown.invoke({})), /, — projects$/m);
});

// ------------------------------------------------------------------ not running

test('failed: the else branch says the indexer is not running and covers what it has', async () => {
  const t = withView((view) => {
    view.status = { ...view.status, state: 'failed', sessionsDone: 1, sessionsTotal: 2 };
  });
  const r = await t.invoke({});
  assert.notEqual(r.isError, true, 'a down indexer is still a readable state');
  const text = textOf(r);
  assert.match(text, /^index: failed — indexer is not running; totals below cover 1 of 2 sessions$/m);
  assert.ok(!text.includes('ready —'));
  assert.ok(!text.includes('building —'));
});

test('idle/unknown states take the same branch and name the state they were given', async () => {
  const t = withView((view) => { view.status = { ...view.status, state: 'idle' }; });
  assert.match(textOf(await t.invoke({})),
    /^index: idle — indexer is not running; totals below cover 2 of 2 sessions$/m);
});

test('an index reporting no status at all renders — everywhere, never 0', async () => {
  const t = withView((view) => { view.status = {}; });
  const text = textOf(await t.invoke({}));
  assert.match(text, /^index: — — indexer is not running; totals below cover — of — sessions$/m,
    'an unrecorded count is unknown, not zero');
});

// ------------------------------------------------------------------ next:

test('the footer names the literal follow-up calls', async () => {
  const text = textOf(await tool().invoke({}));
  assert.match(text, /^next: lens_sessions {3}\| {3}lens_usage scope="store" group_by="project"$/m,
    '§7.4: a locator an agent can paste, not a description of one');
  assert.equal(text.split('\n').at(-1), 'next: lens_sessions   |   lens_usage scope="store" group_by="project"',
    'the footer is last');
});

// ------------------------------------------------------------------ structured

test('structured:true carries the trimmed JSON; the default carries none', async () => {
  const plain = await tool().invoke({});
  assert.equal(plain.structuredContent, undefined,
    'text-only by default — §7.2, the token doubling this server exists to prevent');

  const r = await tool().invoke({ structured: true });
  const sc = r.structuredContent;
  assert.ok(sc, 'structuredContent is attached when asked for');

  assert.equal(sc.toolsVersion, TOOLS_VERSION);
  assert.equal(sc.indexVersion, H.lens.store.INDEX_VERSION);
  assert.equal(sc.pricingVersion, H.lens.pricing.PRICING_VERSION);
  assert.equal(sc.projectsDir, H.ctx.projectsDir);
  assert.equal(sc.projectsDirSource, H.ctx.projectsDirSource);
  assert.equal(sc.status.state, 'ready');
  assert.equal(sc.status.sessionsDone, 2);
  assert.equal(sc.status.sessionsTotal, 2);
  assert.equal(sc.aggScope.sessions, 2);
  assert.equal(sc.aggScope.of, 2);
  assert.equal(sc.rowsSumToHeader, true);
  assert.equal(sc.lostAgents, 0);
  assert.equal(sc.projectCount, 1);
  assert.equal(sc.app.app, H.ctx.appName);
  // Exact integer tcu, not a rounded dollar string — that is what makes the
  // structured payload worth post-processing at all.
  assert.equal(sc.agg.usd.total, H.fixtures.EXPECT.totalTcu);
  // dayBands is flattened to its labels, not the whole band objects.
  assert.ok(Array.isArray(sc.dayBands) && sc.dayBands.every((d) => typeof d === 'string'));

  // The per-session and per-project arrays — the megabytes on /api/index — are
  // NOT carried. Attaching them to a ~150-token status result would defeat the
  // tool.
  assert.equal(sc.sessions, undefined);
  assert.equal(sc.projects, undefined);
  assert.equal(sc.turnBars, undefined);

  // The text block is still the complete, self-sufficient answer.
  assert.match(textOf(r), /^LENS /m);
});

// -------------------------------------------------- structured problems cap
//
// The index serves up to PROBLEMS_CAP (200) folded rows, each carrying up to
// PROBLEM_SOURCE_CAP (25) source identities. Relaying that array verbatim put
// as many as 5000 objects on a ~150-token tool — an unbounded payload on the
// one result an agent calls to ORIENT itself. The cap matches the text's, and
// `problemsTotal` states what was folded so nothing is hidden silently.

/** N folded rows, each with `srcs` source identities, as the index shapes them. */
const fakeProblems = (n, srcs = 3) => Array.from({ length: n }, (_, i) => ({
  code: `code-${i}`,
  scope: 'store',
  message: `problem ${i}`,
  affects: 'aggregates',
  count: i + 1,
  sourceCount: srcs,
  sources: Array.from({ length: srcs }, (_, j) => ({ slug: 's', id: `id-${j}`, file: 'f.jsonl', line: j })),
}));

test('structured: the problems array is capped at the same 5 the text enumerates', async () => {
  const t = withView((view) => { view.problems = fakeProblems(40); });
  const r = await t.invoke({ structured: true });
  const sc = r.structuredContent;
  assert.equal(sc.problems.length, 5, 'the raw 40-row array never rides a ~150-token result');
  assert.deepEqual(sc.problems.map((p) => p.code), ['code-0', 'code-1', 'code-2', 'code-3', 'code-4']);
  // The text and the JSON enumerate the SAME rows — two different caps would
  // be two different answers to one question.
  const line = lineStarting(textOf(r), 'problems: ');
  for (const p of sc.problems) assert.ok(line.includes(p.code), `${p.code} missing from ${line}`);
  assert.ok(!line.includes('code-5'));
});

test('structured: problemsTotal states the folded count the cap dropped from', async () => {
  const t = withView((view) => { view.problems = fakeProblems(40); });
  const sc = (await t.invoke({ structured: true })).structuredContent;
  assert.equal(sc.problemsTotal, 40, 'a silent truncation is a correctness bug');
  assert.ok(sc.problemsTotal > sc.problems.length, 'the total is the un-capped number');
  // …and it agrees with the headline the text prints.
  assert.match(textOf(await t.invoke({})), /^problems: 40 \(/m);
});

test('structured: each problem keeps its recorded fields but NOT its sources[]', async () => {
  const t = withView((view) => { view.problems = fakeProblems(1, 25); });
  const p = (await t.invoke({ structured: true })).structuredContent.problems[0];
  assert.equal(p.sources, undefined, '25 identities per row is the unbounded part');
  assert.equal(p.sourceCount, 25, 'the count survives — that is the fact worth carrying');
  // Everything else the index recorded is still there.
  assert.equal(p.code, 'code-0');
  assert.equal(p.scope, 'store');
  assert.equal(p.message, 'problem 0');
  assert.equal(p.affects, 'aggregates');
  assert.equal(p.count, 1);
});

test('structured: a row with sources but no sourceCount gets the length, not a guess', async () => {
  const t = withView((view) => {
    view.problems = [{ code: 'torn-line', sources: [{ id: 'a' }, { id: 'b' }] }];
  });
  const p = (await t.invoke({ structured: true })).structuredContent.problems[0];
  assert.equal(p.sourceCount, 2);
  assert.equal(p.sources, undefined);
});

test('structured: a row that recorded no sources at all reports null, never 0', async () => {
  const t = withView((view) => { view.problems = [{ code: 'torn-line', count: 3 }]; });
  const p = (await t.invoke({ structured: true })).structuredContent.problems[0];
  assert.equal(p.sourceCount, null, 'a fabricated 0 would claim the fold found no identities');
});

test('structured: no recorded problems is an empty array and a zero total', async () => {
  const t = withView((view) => { view.problems = []; });
  const sc = (await t.invoke({ structured: true })).structuredContent;
  assert.deepEqual(sc.problems, []);
  assert.equal(sc.problemsTotal, 0);
});

test('structured: an index that reports no problems field at all still answers', async () => {
  const t = withView((view) => { delete view.problems; });
  const sc = (await t.invoke({ structured: true })).structuredContent;
  assert.deepEqual(sc.problems, []);
  assert.equal(sc.problemsTotal, 0);
  assert.match(textOf(await t.invoke({})), /^problems: 0$/m);
});

// ------------------------------------------------------------------ failures

test('a 409 on /api/index renders as a STATE, not an isError', async () => {
  // /api/index normally answers while the indexer is down, so this is not
  // expected — but a route that CAN pend must never be thrown at the model.
  const pending = async (method, path) => {
    if (path === '/api/index') {
      return {
        status: 409,
        headers: {},
        json: {
          error: {
            code: 'not-indexed-yet',
            message: 'index is still building',
            detail: { retryAfterMs: 2000, bytesIndexed: 412 * 1024 * 1024, bytesTotal: 1.18 * 1024 * 1024 * 1024 },
          },
        },
      };
    }
    return call(method, path);
  };
  const r = await tool(pending).invoke({});
  assert.notEqual(r.isError, true, 'pending is a state, not an error');
  const text = textOf(r);
  assert.match(text, /Index is still building — 412 MB of 1\.2 GB done\./);
  assert.match(text, /Re-run this call in ~2s\./);
});

test('a hard failure on /api/index is an error that does NOT point back at lens_status', async () => {
  const boom = async (method, path) => {
    if (path === '/api/index') {
      return { status: 503, headers: {}, json: { error: { code: 'indexer-down', message: 'worker exited' } } };
    }
    return call(method, path);
  };
  const r = await tool(boom).invoke({});
  assert.equal(r.isError, true);
  const text = textOf(r);
  assert.match(text, /lens_status could not read \/api\/index: 503 indexer-down — worker exited/);
  // The generic way-out is "call lens_status" — which from lens_status is a
  // loop, so this tool overrides it.
  assert.match(text, /Check the server's stderr/);
  assert.ok(!/lens_status reports the indexer state/.test(text), 'no self-referential advice');
});

// ------------------------------------------------------------------ budget

test('the render stays inside the ~150-token budget', async () => {
  // SPEC §7.1 puts lens_status at ~150 tokens. The lines naming local
  // directories are excluded from the measurement: their length is a property
  // of this machine's paths, not of the renderer.
  const text = textOf(await tool().invoke({}));
  const body = text.split('\n')
    .filter((l) => !l.startsWith('corpus: ') && !l.startsWith('lens: '))
    .join('\n');
  assert.ok(body.length < 700, `status body is ${body.length} chars — over the ~150-token budget`);
});
