// ACC-5 — cross-project fragment dirs: Path B walks them at session scope,
// routes them at project scope; Path A's file census covers the same set, so
// A === B on a store whose session spans two project dirs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from '../server/audit.mjs';
import * as pricing from './fixtures/api/stubs/pricing.mjs';

const ROOT = path.join(os.tmpdir(), `lens-fix-frag-${process.pid.toString(36)}`);
const SLUG_A = 'C--frag-owner';
const SLUG_B = 'C--frag-holder';
const SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const AGENT = 'af000000000000001d'.slice(0, 17); // 'a' + 16 hex

const asst = (msgId, out) => JSON.stringify({
  type: 'assistant', uuid: `u-${msgId}`, timestamp: '2026-08-01T10:00:00.000Z', sessionId: SID,
  message: {
    id: msgId, model: 'claude-fable-5', stop_reason: 'end_turn',
    usage: {
      input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      iterations: [{ input_tokens: 10, output_tokens: out }],
    },
  },
}) + '\n';

before(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  // main transcript lives in slug A; an AGENT TRANSCRIPT lives in a fragment
  // dir under slug B (SPEC §2 case a — the live-possibility the corpus's
  // script-only fragments haven't exercised yet)
  await fsp.mkdir(path.join(ROOT, SLUG_A), { recursive: true });
  await fsp.mkdir(path.join(ROOT, SLUG_B, SID, 'subagents'), { recursive: true });
  await fsp.writeFile(path.join(ROOT, SLUG_A, `${SID}.jsonl`), asst('msg_main', 100));
  await fsp.writeFile(path.join(ROOT, SLUG_B, SID, 'subagents', `agent-${AGENT}.jsonl`), asst('msg_frag', 50));
});
after(async () => { await fsp.rm(ROOT, { recursive: true, force: true }); });

function collect() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }) };
}
const inv = (events, name) => events.find((e) => e.event === 'invariant' && e.data.name === name)?.data;

test('session scope: Path B walks the foreign fragment dir, bills its agent, and discloses the extra root', async () => {
  const { events, emit } = collect();
  const sum = await runAudit({ projectsDir: ROOT, scope: { kind: 'session', slug: SLUG_A, id: SID }, pricing, emit });
  assert.equal(sum.fileCensus.files, 2, 'main + fragment agent transcript');
  assert.equal(sum.totals.requests, 2, 'the fragment agent bills into ITS session');
  const key = `${SLUG_A}/${SID}`;
  assert.ok(sum.sessions[key], 'one session, keyed at the OWNING slug');
  assert.equal(sum.sessions[key].requests, 2);
  const disclosed = events.find((e) => e.event === 'problem' && e.data.code === 'session-fragment');
  assert.ok(disclosed, 'the extra walk root is disclosed, never silent');
});

test('session scope: Path A census over the session file set === Path B census (A===B end to end)', async () => {
  // Path A shaped exactly as api.mjs buildPathA now produces it: censuses over
  // the session's FULL file set (main + cross-slug fragments).
  const pathA = {
    fileCensus: { files: 2, bytes: null },
    agentCount: 1,
    sessions: { [`${SLUG_A}/${SID}`]: { requests: 2, usdTotal: 10 * 20000 * 2 + 150 * 100000 } },
    totals: { requests: 2, usdTotal: 10 * 20000 * 2 + 150 * 100000 },
  };
  const probe = collect();
  const first = await runAudit({ projectsDir: ROOT, scope: { kind: 'session', slug: SLUG_A, id: SID }, pricing, emit: probe.emit });
  pathA.fileCensus.bytes = first.fileCensus.bytes;
  const { events, emit } = collect();
  await runAudit({ projectsDir: ROOT, scope: { kind: 'session', slug: SLUG_A, id: SID }, pricing, pathA, emit });
  assert.equal(inv(events, 'file-census').pass, true, 'both censuses cover the same 2 files');
  assert.equal(inv(events, 'agents-enumerated').pass, true);
  assert.equal(inv(events, 'ab-total').pass, true, 'A === B including the fragment transcript');
});

test('project scope of the HOLDING slug: the foreign-owned fragment is routed OUT, disclosed', async () => {
  const { events, emit } = collect();
  const sum = await runAudit({ projectsDir: ROOT, scope: { kind: 'project', slug: SLUG_B }, pricing, emit });
  assert.equal(sum.totals.requests, 0, 'the fragment bills to its owning project, not the holder');
  assert.equal(sum.fileCensus.files, 0, 'census follows the routing');
  const disclosed = events.filter((e) => e.event === 'problem' && e.data.code === 'session-fragment');
  assert.ok(disclosed.length >= 1, 'routing out is disclosed');
});

test('project scope of the OWNING slug: the fragment is unioned IN', async () => {
  const { emit } = collect();
  const sum = await runAudit({ projectsDir: ROOT, scope: { kind: 'project', slug: SLUG_A }, pricing, emit });
  assert.equal(sum.totals.requests, 2, 'main + fragment agent');
  assert.equal(sum.fileCensus.files, 2);
  assert.equal(sum.counts.fragments.unioned, 1);
});
