// gap6-04-readline.mjs — CORRECTION (a): the exact cost of NOT reading LF-only.
//
// node:readline splits on \n, \r\n, U+2028 and U+2029. Only the last two can appear
// RAW inside a JSON string in this corpus, so readline and an LF-only splitter can
// differ ONLY in files that contain U+2028 or U+2029. Step 1 finds those files by a
// raw byte scan (UTF-8 e2 80 a8 / e2 80 a9). Step 2 runs BOTH readers over exactly
// those files and reports the delta in parse failures, assistant lines and tokens.
// Everything is capped at the pinned snapshot byte length.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadManifest, lfLinesCapped, parseLine, usageRow, zeroAcc, foldRow, OUT } from './gap6-lib.mjs';

const man = loadManifest();
const SEP = [Buffer.from([0xe2, 0x80, 0xa8]), Buffer.from([0xe2, 0x80, 0xa9])];

// ---- step 1: which files contain U+2028 / U+2029 (raw byte scan) ----
const affected = [];
for (const f of man.files) {
  const fd = fs.openSync(f.file, 'r');
  const CH = 1 << 22;
  let pos = 0, prev = Buffer.alloc(0), c28 = 0, c29 = 0;
  const buf = Buffer.alloc(CH);
  while (pos < f.bytes) {
    const want = Math.min(CH, f.bytes - pos);
    const got = fs.readSync(fd, buf, 0, want, pos);
    if (got <= 0) break;
    const win = Buffer.concat([prev, buf.subarray(0, got)]);
    for (const [i, s] of SEP.entries()) {
      let at = 0;
      while ((at = win.indexOf(s, at)) !== -1) { if (i === 0) c28++; else c29++; at += 3; }
    }
    prev = win.subarray(Math.max(0, win.length - 2));
    pos += got;
  }
  fs.closeSync(fd);
  if (c28 || c29) affected.push({ rel: f.rel, file: f.file, bytes: f.bytes, tier: f.tier, u2028: c28, u2029: c29 });
}

// ---- step 2: both readers over the affected files ----
function finish(r) {
  r.dedup = zeroAcc();
  for (const row of r.keepLast.values()) foldRow(r.dedup, row);
  return r;
}
async function readLF(f) {
  const r = { lines: 0, parseFail: 0, assistant: 0, acc: zeroAcc(), ids: new Set(), keepLast: new Map() };
  for await (const [, line, isTail] of lfLinesCapped(f.file, f.bytes)) {
    if (isTail) continue;
    r.lines++;
    if (!line.trim()) continue;
    const ev = parseLine(line);
    if (ev === undefined) { r.parseFail++; continue; }
    if (ev && ev.type === 'assistant' && ev.message && ev.message.usage) {
      r.assistant++; r.ids.add(ev.message.id); foldRow(r.acc, usageRow(ev.message.usage));
      r.keepLast.set(ev.message.id, usageRow(ev.message.usage));
    }
  }
  return finish(r);
}
async function readRL(f) {
  const r = { lines: 0, parseFail: 0, assistant: 0, acc: zeroAcc(), ids: new Set(), keepLast: new Map() };
  const rl = readline.createInterface({
    input: fs.createReadStream(f.file, { encoding: 'utf8', start: 0, end: f.bytes - 1 }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    r.lines++;
    if (!line.trim()) continue;
    const ev = parseLine(line);
    if (ev === undefined) { r.parseFail++; continue; }
    if (ev && ev.type === 'assistant' && ev.message && ev.message.usage) {
      r.assistant++; r.ids.add(ev.message.id); foldRow(r.acc, usageRow(ev.message.usage));
      r.keepLast.set(ev.message.id, usageRow(ev.message.usage));
    }
  }
  return finish(r);
}

const rows = [];
const tot = { lf: { lines: 0, parseFail: 0, assistant: 0, acc: zeroAcc(), dedup: zeroAcc() }, rl: { lines: 0, parseFail: 0, assistant: 0, acc: zeroAcc(), dedup: zeroAcc() } };
for (const f of affected) {
  const lf = await readLF(f), rl = await readRL(f);
  rows.push({
    rel: f.rel, tier: f.tier, u2028: f.u2028, u2029: f.u2029,
    lf: { lines: lf.lines, parseFail: lf.parseFail, assistant: lf.assistant, ids: lf.ids.size, out: lf.acc.output_tokens, cr: lf.acc.cache_read_input_tokens },
    rl: { lines: rl.lines, parseFail: rl.parseFail, assistant: rl.assistant, ids: rl.ids.size, out: rl.acc.output_tokens, cr: rl.acc.cache_read_input_tokens },
    lostAssistantLines: lf.assistant - rl.assistant,
    lostIds: [...lf.ids].filter(i => !rl.ids.has(i)),
  });
  for (const k of ['lines', 'parseFail', 'assistant']) { tot.lf[k] += lf[k]; tot.rl[k] += rl[k]; }
  foldRow2(tot.lf.acc, lf.acc); foldRow2(tot.rl.acc, rl.acc);
  foldRow2(tot.lf.dedup, lf.dedup); foldRow2(tot.rl.dedup, rl.dedup);
  rows[rows.length - 1].lf.dedup = lf.dedup; rows[rows.length - 1].rl.dedup = rl.dedup;
}
function foldRow2(a, b) { a.messages += b.messages; for (const k of ['input_tokens', 'cache_creation_input_tokens', 'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'thinking_tokens']) a[k] += b[k]; a.thinking_absent += b.thinking_absent; return a; }

// positive control: readline MUST tear at least one record, otherwise this test proves nothing
const control = { tornRecords: tot.rl.parseFail, fired: tot.rl.parseFail > 0 && tot.lf.parseFail === 0 };

const out = { snapshotUtc: man.snapshotUtc, filesScanned: man.files.length, affectedFiles: affected.length, affected: rows, totals: tot, positiveControl: control };
fs.writeFileSync(path.join(OUT, 'gap6-readline.json'), JSON.stringify(out, null, 1));
console.log('files with U+2028/U+2029:', affected.length, JSON.stringify(affected.map(a => ({ rel: a.rel, u2028: a.u2028, u2029: a.u2029 })), null, 1));
console.log('LF   :', JSON.stringify(tot.lf));
console.log('RL   :', JSON.stringify(tot.rl));
console.log('LF dedup (keep-last):', JSON.stringify(tot.lf.dedup));
console.log('RL dedup (keep-last):', JSON.stringify(tot.rl.dedup));
console.log('DEDUPED DELTA (LF - RL):', JSON.stringify(Object.fromEntries(Object.keys(tot.lf.dedup).map(k => [k, tot.lf.dedup[k] - tot.rl.dedup[k]]).filter(([k, v]) => v !== 0))));
console.log('positive control (readline tears, LF does not):', JSON.stringify(control));
for (const r of rows) console.log(r.rel, 'lines', r.lf.lines, '->', r.rl.lines, 'parseFail', r.lf.parseFail, '->', r.rl.parseFail,
  'assistant', r.lf.assistant, '->', r.rl.assistant, 'lostIds', r.lostIds.length, 'Δoutput', r.lf.out - r.rl.out, 'Δcache_read', r.lf.cr - r.rl.cr);
