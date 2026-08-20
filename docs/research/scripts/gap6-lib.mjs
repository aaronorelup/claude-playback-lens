// gap6-lib.mjs — shared helpers for the gap-6 token ledger.
//
// HARD RULES encoded here:
//  1. NEVER node:readline. It splits on U+2028/U+2029 which occur RAW inside JSON
//     string values in this corpus and manufactures phantom parse failures.
//     Split on \n only. (Same contract as scripts/lib-lfreader.mjs.)
//  2. The corpus is LIVE. Every read is capped at a byte length pinned in the
//     snapshot manifest, so all gap6-* scripts see byte-identical input.
//  3. Strip long base64 "data" blobs before JSON.parse.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Corpus root: override with LENS_CORPUS; defaults to the standard location.
export const ROOT = process.env.LENS_CORPUS
  ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.claude', 'projects');
export const OUT = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST = path.join(OUT, 'gap6-manifest.json');

/** Recursive walk returning every .jsonl file with its classification. */
export function walkJsonl(root = ROOT) {
  const out = [];
  const stack = [{ dir: root, rel: '' }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) stack.push({ dir: full, rel: r });
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const st = fs.statSync(full);
        out.push({ rel: r, file: full.replace(/\\/g, '/'), bytes: st.size, mtime: st.mtimeMs, ...classify(r) });
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Classify a corpus-relative .jsonl path into tier + ids. Returns {tier, project, session, workflow, agentId}. */
export function classify(rel) {
  const p = rel.split('/');
  const project = p[0];
  // A: <project>/<session-uuid>.jsonl
  let m = /^([^/]+)\/([0-9a-f-]{36})\.jsonl$/.exec(rel);
  if (m) return { tier: 'main', project, session: m[2], workflow: null, agentId: null };
  // B: <project>/<session>/subagents/agent-<aid>.jsonl
  m = /^([^/]+)\/([0-9a-f-]{36})\/subagents\/agent-([0-9a-f]{17})\.jsonl$/.exec(rel);
  if (m) return { tier: 'plain-agent', project, session: m[2], workflow: null, agentId: m[3] };
  // D: <project>/<session>/subagents/workflows/<wf>/agent-<aid>.jsonl
  m = /^([^/]+)\/([0-9a-f-]{36})\/subagents\/workflows\/(wf_[0-9a-f]{8}-[0-9a-f]{3})\/agent-([0-9a-f]{17})\.jsonl$/.exec(rel);
  if (m) return { tier: 'workflow-agent', project, session: m[2], workflow: m[3], agentId: m[4] };
  // F: journal
  m = /^([^/]+)\/([0-9a-f-]{36})\/subagents\/workflows\/(wf_[0-9a-f]{8}-[0-9a-f]{3})\/journal\.jsonl$/.exec(rel);
  if (m) return { tier: 'journal', project, session: m[2], workflow: m[3], agentId: null };
  return { tier: 'UNCLASSIFIED', project, session: null, workflow: null, agentId: null };
}

/**
 * Stream a file up to `limit` bytes, yielding [lineNo, text].
 * Splits on \n ONLY. The final partial line (no trailing \n before the cap) is
 * yielded too but flagged via the third tuple element `isTail`.
 */
export async function* lfLinesCapped(file, limit) {
  const stream = fs.createReadStream(file, { start: 0, end: limit - 1, highWaterMark: 1 << 22 });
  let carry = Buffer.alloc(0), n = 0;
  for await (const chunk of stream) {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let i, from = 0;
    while ((i = buf.indexOf(0x0a, from)) !== -1) {
      yield [++n, buf.toString('utf8', from, i), false];
      from = i + 1;
    }
    carry = buf.subarray(from);
  }
  if (carry.length) yield [++n, carry.toString('utf8'), true];
}

const B64 = /"data":"[A-Za-z0-9+/=]{500,}"/g;
export function stripB64(line) { return line.replace(B64, '"data":""'); }

export function parseLine(line) {
  if (!line || !line.trim()) return null;
  try { return JSON.parse(stripB64(line)); } catch { return undefined; } // undefined = parse failure
}

export function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

// ---------- token accumulator ----------
export const FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'thinking_tokens'];

export function zeroAcc() {
  return { messages: 0, input_tokens: 0, cache_creation_input_tokens: 0, ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
    thinking_tokens: 0, thinking_absent: 0 };
}
export function addAcc(a, b) {
  a.messages += b.messages;
  for (const f of FIELDS) a[f] += b[f];
  a.thinking_absent += b.thinking_absent;
  return a;
}
/** Fold one billed row (already usage-selected) into an accumulator. */
export function foldRow(acc, row) {
  acc.messages += 1;
  acc.input_tokens += row.input_tokens;
  acc.cache_creation_input_tokens += row.cache_creation_input_tokens;
  acc.ephemeral_5m_input_tokens += row.ephemeral_5m_input_tokens;
  acc.ephemeral_1h_input_tokens += row.ephemeral_1h_input_tokens;
  acc.cache_read_input_tokens += row.cache_read_input_tokens;
  acc.output_tokens += row.output_tokens;
  if (row.thinking_tokens === null) acc.thinking_absent += 1;
  else acc.thinking_tokens += row.thinking_tokens;
  return acc;
}
export function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

/** Extract the flat billed counters from a usage object. thinking_tokens is null when NOT RECORDED. */
export function usageRow(u) {
  const cc = u && u.cache_creation;
  const otd = u && u.output_tokens_details;
  const th = otd && typeof otd.thinking_tokens === 'number' ? otd.thinking_tokens : null;
  return {
    input_tokens: num(u && u.input_tokens),
    cache_creation_input_tokens: num(u && u.cache_creation_input_tokens),
    ephemeral_5m_input_tokens: num(cc && cc.ephemeral_5m_input_tokens),
    ephemeral_1h_input_tokens: num(cc && cc.ephemeral_1h_input_tokens),
    cache_read_input_tokens: num(u && u.cache_read_input_tokens),
    output_tokens: num(u && u.output_tokens),
    thinking_tokens: th,
  };
}
