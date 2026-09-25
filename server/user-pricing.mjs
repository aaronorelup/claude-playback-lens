// server/user-pricing.mjs — the operator's own rate file (Node only).
//
// WHY THIS EXISTS. The shipped table (shared/pricing.mjs RATES) is frozen at
// PRICING_VERSION. The day a new model ships, every request made on it lands
// in the unpriced channel — correctly, since a missing rate is never $0 — and
// a report that reads only the dollar column silently omits what can be most
// of the bill. This file is the repair path that needs no release: the rate is
// looked up on the published pricing page and written here, with its source,
// and every process that prices rows picks it up.
//
// LOCATION. One file per user, OUTSIDE the package: npx installs the package
// into a hash-named cache directory that changes with every version, so a
// file inside the package would be forgotten on the next upgrade.
//
//   LENS_PRICING_FILE  (env)  >  ~/.claude/playback-lens/pricing.json
//
// FORMAT (human-editable; dollars, not rate units):
//
//   { "version": 1,
//     "models": {
//       "fable-5-1": [
//         { "from": null, "to": null,
//           "inputUsdPerMtok": 10, "outputUsdPerMtok": 50,
//           "cacheReadUsdPerMtok": 0.25,        (optional; default 0.1 x input)
//           "source": "https://platform.claude.com/docs/en/about-claude/pricing",
//           "retrieved": "2026-09-24" } ] } }
//
// Keys are normalised model keys (shared/pricing.mjs modelKey): no `claude-`
// prefix, no date suffix, no `[1m]`. A fast-tier rate is `<key>@fast`.
// Input must be a whole number of cents per Mtok — the cache multipliers
// (x0.1 read, x1.25 5-minute write) must stay integral in rate units, the same
// bar the shipped table meets.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const U_PER_USD = 2000; // rate units per $1/Mtok (shared/pricing.mjs header)

export function userPricingPath() {
  return process.env.LENS_PRICING_FILE
    || path.join(os.homedir(), '.claude', 'playback-lens', 'pricing.json');
}

function usdToU(usd, what, key) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
    throw new Error(`${key}: ${what} must be a positive number of USD per million tokens (got ${JSON.stringify(usd)})`);
  }
  const u = Math.round(usd * U_PER_USD);
  if (Math.abs(u - usd * U_PER_USD) > 1e-6) {
    throw new Error(`${key}: ${what} $${usd}/Mtok is finer than the rate table can hold exactly`);
  }
  return u;
}

/** File JSON -> { [key]: [{from,to,inputU,outputU,source,retrieved}] }. Throws on bad data. */
export function fileToRates(json) {
  if (!json || typeof json !== 'object' || typeof json.models !== 'object' || json.models === null) {
    throw new Error('pricing file must be an object with a "models" map');
  }
  const out = {};
  for (const [key, list] of Object.entries(json.models)) {
    if (!Array.isArray(list)) throw new Error(`${key}: expected a list of intervals`);
    out[key] = list.map((iv) => {
      const inputU = usdToU(iv.inputUsdPerMtok, 'inputUsdPerMtok', key);
      if (inputU % 20 !== 0) {
        throw new Error(`${key}: inputUsdPerMtok must be a whole number of cents (cache read/write multipliers must stay exact)`);
      }
      return {
        from: iv.from ?? null,
        to: iv.to ?? null,
        inputU,
        outputU: usdToU(iv.outputUsdPerMtok, 'outputUsdPerMtok', key),
        ...(iv.cacheReadUsdPerMtok != null ? { readU: usdToU(iv.cacheReadUsdPerMtok, 'cacheReadUsdPerMtok', key) } : {}),
        source: typeof iv.source === 'string' ? iv.source : null,
        retrieved: typeof iv.retrieved === 'string' ? iv.retrieved : null,
      };
    });
  }
  return out;
}

/**
 * createUserPricing(pricing) -> { refresh(), state(), set(), remove() }
 *
 * refresh() is cheap (one stat) and is called before every tool call, so a
 * rate written by ANY process — another session, a hand edit — is in effect on
 * the next call everywhere. It returns true when the table changed, which is
 * the caller's cue to drop priced memos.
 */
export function createUserPricing(pricing) {
  const file = userPricingPath();
  let seenMtime = -1;
  let problem = null;
  let generation = 0;

  function applyJson(json) {
    pricing.setUserRates(fileToRates(json));
  }

  function refresh() {
    let st;
    try { st = fs.statSync(file); } catch { st = null; }
    const mtime = st ? st.mtimeMs : 0;
    if (mtime === seenMtime) return false;
    seenMtime = mtime;
    try {
      if (!st) pricing.setUserRates({});
      else applyJson(JSON.parse(fs.readFileSync(file, 'utf8')));
      problem = null;
    } catch (e) {
      // A broken file must not take the shipped table down with it, and must
      // not be silent: the previous user table stays in effect and the
      // problem is reported by lens_pricing / lens_status.
      problem = `${file}: ${(e && e.message) || e}`;
    }
    generation += 1;
    return true;
  }

  async function readFileJson() {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
    catch (e) {
      if (e && e.code === 'ENOENT') return { version: 1, models: {} };
      throw new Error(`cannot read ${file}: ${e.message}`);
    }
  }

  async function writeFileJson(json) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(json, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, file);
    seenMtime = -1; // force the next refresh to re-read what we just wrote
    refresh();
    if (problem) throw new Error(problem);
  }

  /**
   * set({ model, inputUsdPerMtok, outputUsdPerMtok, source, from }) — add or
   * replace a model's rate. `from` (YYYY-MM-DD) closes the previous open
   * interval the day before and starts a new one — a price CHANGE; without it
   * the model gets one all-time interval.
   */
  async function set({ model, inputUsdPerMtok, outputUsdPerMtok, cacheReadUsdPerMtok = null, source, from = null, fast = false }) {
    let key = pricing.modelKey(String(model || '').trim());
    if (!key) throw new Error('model is required');
    if (fast) key = `${key}@fast`;
    if (!source || !/^https?:\/\//.test(source)) {
      throw new Error('source must be the URL of the published pricing page the rate was read from');
    }
    const json = await readFileJson();
    json.version = 1;
    json.models = json.models || {};
    const today = new Date().toISOString().slice(0, 10);
    const entry = { from: null, to: null, inputUsdPerMtok, outputUsdPerMtok, source, retrieved: today };
    if (cacheReadUsdPerMtok != null) entry.cacheReadUsdPerMtok = cacheReadUsdPerMtok;
    let list;
    if (from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('from must be YYYY-MM-DD');
      const prev = (json.models[key] || []).filter((iv) => iv.from === null || iv.from < from);
      if (prev.length === 0) throw new Error(`${key}: "from" starts a price change, but there is no earlier rate to change from — omit "from"`);
      const last = { ...prev[prev.length - 1] };
      last.to = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      list = [...prev.slice(0, -1), last, { ...entry, from }];
    } else {
      list = [entry];
    }
    // Validate before writing: a rejected rate never reaches the file.
    const candidate = { ...json.models, [key]: list };
    const rates = fileToRates({ models: candidate });
    pricing.assertRateList(key, rates[key]);
    json.models = candidate;
    await writeFileJson(json);
    return { key, file, intervals: list };
  }

  async function remove(model) {
    const raw = String(model || '').trim();
    const key = raw.endsWith('@fast') ? `${pricing.modelKey(raw.slice(0, -5))}@fast` : pricing.modelKey(raw);
    const json = await readFileJson();
    const had = !!(json.models && json.models[key]);
    if (had) { delete json.models[key]; await writeFileJson(json); }
    return { key, removed: had, file };
  }

  refresh();
  return {
    file,
    refresh,
    set,
    remove,
    state: () => ({ file, problem, generation, models: Object.keys(pricing.USER_RATES) }),
  };
}
