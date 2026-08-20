// gap6-06-controls.mjs — discipline checks with POSITIVE CONTROLS.
//  1. Cache-TTL (5m vs 1h) split by tier x harness version — is it really the tier?
//  2. Turn-rule controls: the verified rule vs two deliberately-wrong variants.
//     A rule that leaves 0 residue is only meaningful if a wrong rule leaves >0.
//  3. journal.jsonl carries no assistant usage (ABSENT) + the positive control count.
import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, lfLinesCapped, parseLine, usageRow, OUT } from './gap6-lib.mjs';

const man = loadManifest();
const ttl = {};            // tier|version -> {msgs, m5, h1, models:Set}
const turnCtl = {};        // rule -> {openers, attributed, unattributed}
let journalAssistant = 0, otherAssistant = 0;

const RULES = {
  verified: (ev) => ev.type === 'user' && ((ev.origin && ev.origin.kind === 'human') ||
    (ev.origin === undefined && typeof (ev.message && ev.message.content) === 'string' && ev.message.content.startsWith('<command-message>'))),
  humanOriginOnly: (ev) => ev.type === 'user' && ev.origin && ev.origin.kind === 'human',
  stringContentOnly: (ev) => ev.type === 'user' && typeof (ev.message && ev.message.content) === 'string',
  anyAbsentOrigin: (ev) => ev.type === 'user' && ev.origin === undefined,
};
for (const k of Object.keys(RULES)) turnCtl[k] = { openers: 0, attributedMessages: 0, unattributedMessages: 0, sessionsWithZeroOpeners: 0 };

for (const f of man.files) {
  if (f.tier === 'journal') {
    for await (const [, line, t] of lfLinesCapped(f.file, f.bytes)) {
      if (t) continue;
      const ev = parseLine(line);
      if (ev && ev.type === 'assistant' && ev.message && ev.message.usage) journalAssistant++;
    }
    continue;
  }
  const nodes = new Map();
  const openerSets = Object.fromEntries(Object.keys(RULES).map(k => [k, new Set()]));
  const msgLast = new Map();     // message.id -> {uuid, row, model}
  for await (const [, line, t] of lfLinesCapped(f.file, f.bytes)) {
    if (t) continue;
    const ev = parseLine(line);
    if (!ev) continue;
    if (f.tier === 'main' && ev.uuid) {
      nodes.set(ev.uuid, ev.parentUuid ?? null);
      for (const [k, fn] of Object.entries(RULES)) { try { if (fn(ev)) openerSets[k].add(ev.uuid); } catch {} }
    }
    if (ev.type !== 'assistant' || !ev.message || !ev.message.usage || !ev.message.id) continue;
    otherAssistant++;
    const r = usageRow(ev.message.usage);
    if (ev.message.model !== '<synthetic>') {
      const key = f.tier + '|' + (ev.version ?? 'null');
      const a = ttl[key] ||= { lines: 0, m5: 0, h1: 0, models: {} };
      a.lines++; a.m5 += r.ephemeral_5m_input_tokens; a.h1 += r.ephemeral_1h_input_tokens;
      a.models[ev.message.model] = (a.models[ev.message.model] || 0) + 1;
    }
    if (f.tier === 'main') msgLast.set(ev.message.id, { uuid: ev.uuid, synthetic: ev.message.model === '<synthetic>' });
  }
  if (f.tier !== 'main') continue;
  for (const [k, set] of Object.entries(openerSets)) {
    turnCtl[k].openers += set.size;
    if (set.size === 0) turnCtl[k].sessionsWithZeroOpeners++;
    const memo = new Map();
    const find = (u) => {
      const chain = []; let cur = u, g = 0;
      while (cur && g++ < 1e6) {
        if (memo.has(cur)) { const r = memo.get(cur); for (const c of chain) memo.set(c, r); return r; }
        if (set.has(cur)) { for (const c of chain) memo.set(c, cur); memo.set(cur, cur); return cur; }
        chain.push(cur); if (!nodes.has(cur)) break; cur = nodes.get(cur);
      }
      for (const c of chain) memo.set(c, null); return null;
    };
    for (const m of msgLast.values()) {
      if (m.synthetic) continue;
      if (m.uuid && find(m.uuid)) turnCtl[k].attributedMessages++; else turnCtl[k].unattributedMessages++;
    }
  }
}

const out = { snapshotUtc: man.snapshotUtc, cacheTtlByTierVersion: ttl, turnRuleControls: turnCtl,
  journalAssistantEventsWithUsage: journalAssistant, positiveControl_assistantEventsElsewhere: otherAssistant };
fs.writeFileSync(path.join(OUT, 'gap6-controls.json'), JSON.stringify(out, null, 1));
console.log('--- cache TTL by tier|version ---');
for (const [k, v] of Object.entries(ttl).sort()) console.log(k, 'lines', v.lines, '5m', v.m5, '1h', v.h1, 'models', Object.keys(v.models).join(','));
console.log('--- turn rule controls ---');
for (const [k, v] of Object.entries(turnCtl)) console.log(k, JSON.stringify(v));
console.log('journal assistant events with usage:', journalAssistant, '(positive control: assistant events elsewhere =', otherAssistant, ')');
