/**
 * Settings (`#/settings`) — projects dir (validate + counts preview), the
 * read-only pricing table (interval lists + PRICING_VERSION + both sources +
 * retrieval date), cache info, and the keyboard sheet.
 * DESIGN §3 (Settings), §5 (keyboard), §6; SPEC §6 (pricing), §9 (config API).
 *
 * Rates are NOT editable here — editing them is a code change (SPEC §6). That
 * is deliberate: the audit's A === B cannot validate the rate table, so the
 * table's provenance (version + sources + retrieval date) is the control, and
 * a UI edit would silently invalidate it.
 */

import { kit, sendJson } from '../lib/net.mjs';
import { h, a, clear, unknown, section, factList } from '../lib/dom.mjs';
import { fmtInt, fmtBytes, fmtDur, fmtLocalTime, toMs } from '../lib/fmt.mjs';
import { routes } from '../lib/links.mjs';
import { page, errorCard, mountCrumbs } from '../lib/chrome.mjs';

/* ============================================================ pure ==== */

/**
 * The client's copy of server/config.mjs's validateDir vocabulary.
 *
 * The server owns the wording and now ships it as `message`; this map is the
 * fallback so an older server (or a hand-rolled response) still says which of
 * the four recorded reasons applies instead of collapsing them into one
 * sentence. Exported so a test can pin that the two vocabularies agree.
 */
export const REASON_TEXT = Object.freeze({
  empty: 'type a path first',
  missing: 'no such path exists',
  'not-a-directory': 'that path is a file, not a folder',
  unreadable: 'that path exists but could not be read',
});

export const TCU_PER_USD_DEFAULT = 2e9;

/** Rate units (1/20 cent per Mtok) → USD per 1M tokens. Exact by construction. */
export function unitsToUsdPerM(units, tcuPerUsd = TCU_PER_USD_DEFAULT) {
  if (units === null || units === undefined || !Number.isFinite(Number(units))) return null;
  return (Number(units) * 1e6) / tcuPerUsd;
}

/**
 * Flatten the interval rate table for display (R10): one row per model per
 * interval, with the four effective rates the multipliers produce.
 * Pure — the multiplier arithmetic printed on the page is testable here.
 */
export function pricingRows(RATES = {}, tcuPerUsd = TCU_PER_USD_DEFAULT) {
  const rows = [];
  for (const [key, intervals] of Object.entries(RATES)) {
    for (const iv of (Array.isArray(intervals) ? intervals : [intervals])) {
      const inU = iv.inputU ?? iv.input ?? null;
      const outU = iv.outputU ?? iv.output ?? null;
      rows.push({
        key,
        from: iv.from ?? iv.effectiveFrom ?? null,
        to: iv.to ?? iv.effectiveTo ?? null,
        input: unitsToUsdPerM(inU, tcuPerUsd),
        output: unitsToUsdPerM(outU, tcuPerUsd),
        cacheWrite5m: unitsToUsdPerM(inU === null ? null : inU * 1.25, tcuPerUsd),
        cacheWrite1h: unitsToUsdPerM(inU === null ? null : inU * 2, tcuPerUsd),
        cacheRead: unitsToUsdPerM(inU === null ? null : inU * 0.1, tcuPerUsd),
        inputU: inU, outputU: outU,
      });
    }
  }
  return rows.sort((x, y) => String(x.key).localeCompare(String(y.key)) || String(x.from ?? '').localeCompare(String(y.from ?? '')));
}

export function fmtRate(usdPerM) {
  if (usdPerM === null || usdPerM === undefined) return null;
  const v = Number(usdPerM);
  return `$${v % 1 === 0 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}/M`;
}

export function fmtInterval(from, to) {
  if (!from && !to) return 'always (open-ended both ways)';
  if (!from) return `… → ${to}`;
  if (!to) return `${from} → …`;
  return `${from} → ${to}`;
}

/* ------------------------------------------------- projects-dir honesty */

/** SPEC §9 precedence, as the label the page prints beside the ACTIVE dir. */
export const SOURCE_LABEL = {
  arg: '--projects command-line flag',
  env: 'CLAUDE_PROJECTS environment variable',
  config: 'config.json',
  default: 'default (~/.claude/projects)',
};
export function sourceLabelOf(cfg) {
  const key = cfg && (cfg.activeSource ?? cfg.projectsDirSource ?? cfg.source);
  return (key && SOURCE_LABEL[key]) || (typeof key === 'string' && key) || null;
}

/**
 * What the page says after a successful PUT /api/config.
 *
 * Never "the indexer is re-reading the store." — false in
 * every running process. Saving rewrites config.json; it does not re-point the
 * live indexer, and POST /api/reindex does not either. Only a restart does,
 * and only when nothing outranks config.json (SPEC §9). Pure so the sentence
 * itself is pinned by a test rather than by reading the DOM.
 */
export function saveMessage(res) {
  const r = res || {};
  const p = r.preview || {};
  const counts = Number.isFinite(p.projects) || Number.isFinite(p.sessions)
    ? `${fmtInt(p.projects ?? null) ?? '—'} projects · ${fmtInt(p.sessions ?? null) ?? '—'} sessions${Number.isFinite(p.bytes) ? ` · ${fmtBytes(p.bytes)}` : ''} — `
    : '';
  const saved = r.savedProjectsDir ?? null;
  const active = r.activeProjectsDir ?? null;
  if (r.savedOutrankedBy) {
    return `${counts}saved to config.json. this instance is reading ${active ?? 'its configured directory'}, and `
      + `${r.savedOutrankedBy} outranks config.json (SPEC §9), so the saved directory will not be used — even after a restart — until that flag or variable is dropped.`;
  }
  if (r.pendingRestart === false && saved && active) {
    return `${counts}saved to config.json. it names the directory this instance is already reading (${active}), so nothing changes.`;
  }
  return `${counts}saved to config.json. this instance is still reading ${active ?? 'its current directory'}`
    + `${saved ? ` — restart the app to read ${saved}` : ' — restart the app to use the saved directory'}.`;
}

/** DESIGN §5, verbatim. */
export const KEYMAP = [
  ['j / k', 'move between rows'],
  ['Enter', 'drill into the selected row'],
  ['u', 'up one level (the control names its destination)'],
  ['[ / ]', 'previous / next sibling — turn at L3, agent at L4, block at L5'],
  ['/', 'find in scope (its label states the 220-char head limit; its primary action scans all bytes)'],
  ['\\', 'raw JSON'],
  ['g0 – g5', 'jump to a level'],
  ['t', 'cycle views'],
  ['?', 'this sheet'],
];

/* ============================================================ view ==== */

export async function renderSettings(ctx) {
  const { body } = page(ctx, 'lens-settings');
  const K = await kit();
  // R14 / STALE-RENDER RULE (BUILD-CONTRACTS): guard after EVERY await. `body`
  // hangs off shell.contentEl, so each of the three awaited sections below is a
  // resume point that would otherwise append settings chrome to whatever page
  // superseded this one.
  if (ctx.stale) return;

  mountCrumbs(ctx, [{ label: 'store', href: routes.store() }, { label: 'settings' }]);
  ctx.setTitle?.('settings — Claude Playback Lens');
  ctx.scopeSentence?.({ extra: ['Where the app reads from, what it prices with, and what it has cached. The app never writes into the projects folder — only into its own cache directory.'] });

  const dirSec = await projectsDirSection(K, ctx);
  if (ctx.stale) return;
  body.appendChild(dirSec);
  const priceSec = await pricingSection(K, ctx);
  if (ctx.stale) return;
  body.appendChild(priceSec);
  const cacheSec = await cacheSection(K, ctx);
  if (ctx.stale) return;
  body.appendChild(cacheSec);
  body.appendChild(keyboardSection());
}

/* ------------------------------------------------------- projects dir */

async function projectsDirSection(K, ctx) {
  const sec = section('projects directory');
  let cfg = null;
  // R14 / STALE-RENDER RULE: every fetch carries ctx.signal. An abandoned
  // config read lands in the catch as an AbortError; the caller's own guard
  // then drops this whole section without appending it.
  try { cfg = await K.api('/api/config', null, { signal: ctx?.signal }); }
  catch (err) { if (ctx?.stale) return sec; sec.appendChild(errorCard(err)); }

  // ACTIVE (what this process serves) and SAVED (what config.json
  // holds) are two facts and are printed as two rows — the old single "current"
  // row read the ACTIVE dir but was labelled with no tense at all, while the
  // response carried a contradicting saved value one key away.
  const current = cfg?.activeProjectsDir ?? cfg?.projectsDir ?? cfg?.dir ?? null;
  const saved = cfg?.savedProjectsDir ?? null;
  // `savedProjectsDir` is a RESOLUTION of what config.json holds, not
  // what it holds. The row labelled "saved in config.json", sourced to
  // "config.json", printed the resolution and so could print a path
  // config.json does not contain — silently, and for exactly the entries
  // (relative ones, saved by pre-R12 code or hand-edited) where the difference
  // matters. Print the raw string on that row and, only when the two differ,
  // the "resolved to" row beside it — the same treatment the active dir gets
  // for the live validate preview, which never fired against the value already
  // on disk at page load.
  const savedRaw = cfg?.savedProjectsDirRaw ?? null;
  const rows = [
    { label: 'active (this instance)', value: current, source: sourceLabelOf(cfg) ?? 'server config', reason: 'the server reports no projects directory' },
    { label: 'saved in config.json', value: savedRaw ?? saved, source: 'config.json', reason: 'config.json names no projects directory' },
  ];
  if (savedRaw !== null && saved !== null && savedRaw !== saved) {
    rows.push({
      label: 'resolved to',
      value: saved,
      source: 'server path resolution',
      note: 'config.json stores a relative path; it is resolved against the directory config.json itself lives in, so it names the same folder from any launch',
    });
  }
  if (cfg?.pendingRestart === true) {
    rows.push({
      label: 'pending',
      value: cfg?.savedOutrankedBy
        ? `config.json names a different directory, but ${cfg.savedOutrankedBy} outranks it — a restart alone will not switch`
        : 'config.json names a different directory — restart the app to read it',
      source: 'active vs saved comparison',
    });
  }
  rows.push(
    { label: 'resolution order', value: '--projects → CLAUDE_PROJECTS → config.json → ~/.claude/projects', source: 'SPEC §9' },
    { label: 'cache directory', value: cfg?.cacheDir ?? null, source: 'server config', reason: 'the server reports no cache directory' },
  );
  sec.appendChild(factList(rows));

  const input = h('input', { class: 'lens-input lens-settings__dir', type: 'text', value: current ?? '', 'aria-label': 'projects directory', size: '60' });
  const preview = h('div', { class: 'lens-settings__preview' });
  const saveBtn = h('button', { class: 'lens-btn', text: 'save', disabled: true });

  const validate = async () => {
    clear(preview).appendChild(h('p', { class: 'lens-note', text: 'checking…' }));
    saveBtn.disabled = true;
    try {
      const res = await sendJson('/api/validate-dir', { dir: input.value }, 'POST', { signal: ctx?.signal });
      if (ctx?.stale) return;
      clear(preview);
      if (res?.ok === false) {
        // The server records exactly WHY (`reason`), and
        // this branch read `res.message` — a field it never sent — so all four
        // reasons rendered one hardcoded sentence that additionally asserted
        // "not readable" about a path the server had successfully read (a
        // file), and about the empty string, which is not a path at all.
        // `message` is now sent; REASON_TEXT keeps an older server degrading
        // sensibly; the generic sentence is the last resort it always was.
        preview.appendChild(h('p', { class: 'lens-note lens-note--problem',
          text: res.message ?? REASON_TEXT[res.reason] ?? 'that path is not a readable Claude projects folder.' }));
        // The real OS error, when validateDir attached one (dirProblem carries
        // e.g. 'Could not read <path> (EPERM)'). An EPERM on a real directory
        // is precisely the case none of the four generic sentences diagnoses.
        const detail = Array.isArray(res.problems) && res.problems[0] && res.problems[0].message
          ? res.problems[0].message : null;
        if (detail) preview.appendChild(h('p', { class: 'lens-note', text: detail }));
        // Failure is where "what you typed is not what the server
        // resolved" bites hardest — a shell-mangled path resolves against the
        // server's cwd and comes back 'missing' for a path nobody typed. The
        // "resolved to" row belongs on this branch too, not only on success.
        preview.appendChild(factList([
          { label: 'resolved to', value: res?.dir ?? null, source: 'server path resolution', reason: 'the server did not report a resolved path' },
        ]));
        return;
      }
      preview.appendChild(factList([
        // The counts below are counts OF A DIRECTORY, and until this
        // row existed the page never said which one. What the user types is
        // not necessarily what the server resolved — a relative path, or the
        // bare drive spec "C:", resolves against the server's own working
        // directory — so the resolved path is the fact that makes the rest of
        // this preview readable, and it is what gets saved.
        { label: 'resolved to', value: res?.dir ?? null, source: 'server path resolution', reason: 'the server did not report a resolved path' },
        { label: 'projects', value: fmtInt(res?.projects ?? null), source: 'directory scan', reason: 'not reported' },
        { label: 'sessions', value: fmtInt(res?.sessions ?? null), source: 'directory scan', reason: 'not reported' },
        { label: 'bytes', value: res?.bytes === undefined ? null : fmtBytes(res.bytes), source: 'directory scan', reason: 'not reported' },
      ]));
      saveBtn.disabled = false;
    } catch (err) {
      if (ctx?.stale) return;   // R14 / STALE-RENDER RULE — FIRST statement of the catch
      clear(preview).appendChild(errorCard(err));
    }
  };

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      // NOTE: no ctx.signal on the PUT itself. This is the one deliberate
      // carve-out: aborting a config WRITE mid-flight would leave the reader
      // unable to say whether config.json was rewritten, and this app never
      // reports a state it does not know. The guards below still keep the
      // superseded render from painting.
      const res = await sendJson('/api/config', { projectsDir: input.value }, 'PUT');
      if (ctx?.stale) return;
      clear(preview);
      // The route answers `saved:false` with saveConfig's recorded problem when
      // config.json could not be rewritten (SPEC §9). saveMessage() opens with
      // "saved to config.json" in EVERY branch, so rendering it unconditionally
      // told the reader the write landed when it had not — the same
      // silent-absence lie the route itself was just fixed for, one layer up.
      // Failure gets what validate()'s failure branch gets: the problem's own
      // message in the page's problem style, and never a blank line.
      if (res?.saved === false) {
        const detail = Array.isArray(res.problems) && res.problems[0] && res.problems[0].message
          ? res.problems[0].message : null;
        preview.appendChild(h('p', {
          class: 'lens-note lens-note--problem',
          // An honest unknown beats a blank: if the server sent no problem, say
          // that no reason was recorded rather than printing nothing at all.
          text: detail ?? 'the save failed, and the server recorded no reason for it.',
        }));
        // Only facts the envelope carries: the write did not complete, and this
        // is the directory the instance is (still) serving. Nothing is claimed
        // about what config.json now contains — the response does not say.
        const active = res.activeProjectsDir ?? null;
        preview.appendChild(h('p', {
          class: 'lens-note',
          text: `the save did not complete${active ? `; this instance is still reading ${active}` : ''}.`,
        }));
        return;
      }
      preview.appendChild(h('p', { class: 'lens-note', text: saveMessage(res) }));
    } catch (err) {
      if (ctx?.stale) return;
      clear(preview).appendChild(errorCard(err));
    }
  });

  sec.append(
    h('div', { class: 'lens-settings__row' }, input,
      h('button', { class: 'lens-btn', text: 'validate', onclick: validate }), saveBtn),
    preview,
    h('p', { class: 'lens-note', text: 'Validate first: the preview counts what the app would find there. Saving rewrites config.json atomically and never writes inside the store itself — but it does not re-point this running instance: the indexer keeps reading the directory it started with until the app is restarted. --projects and CLAUDE_PROJECTS outrank config.json even across a restart (SPEC §9).' }));
  return sec;
}

/* ------------------------------------------------------- pricing */

async function pricingSection(K, ctx) {
  const sec = section('pricing (read-only)');
  let payload = null;
  // R14 / STALE-RENDER RULE — ctx.signal on the fetch; the caller drops the
  // section when the render was superseded.
  try { payload = await K.api('/api/pricing', null, { signal: ctx?.signal }); } catch { payload = null; }

  const RATES = payload?.rates ?? payload?.RATES ?? K.pricing?.RATES ?? null;
  const version = payload?.version ?? payload?.PRICING_VERSION ?? K.PRICING_VERSION ?? null;
  const tcuPerUsd = payload?.tcuPerUsd ?? K.pricing?.TCU_PER_USD ?? TCU_PER_USD_DEFAULT;

  sec.appendChild(factList([
    { label: 'PRICING_VERSION', value: version, source: 'shared/pricing.mjs', reason: 'the server reports no pricing version' },
    { label: 'retrieved', value: payload?.retrievedAt ?? payload?.retrieved ?? version, source: 'the rate table\'s recorded retrieval date', reason: 'not reported' },
    { label: 'source', value: payload?.sources?.[0] ?? 'https://platform.claude.com/docs/en/about-claude/pricing', source: 'SPEC §6' },
    { label: 'cross-checked against', value: payload?.sources?.[1] ?? 'the Anthropic model reference', source: 'SPEC §6' },
    { label: 'unit', value: 'integer rate units = 1/20 cent per Mtok; cost accumulates as tcu = rateUnits × tokens; USD = tcu / ' + fmtInt(tcuPerUsd), source: 'SPEC §6' },
  ]));

  if (!RATES) {
    sec.appendChild(unknown('no rate table is available from /api/pricing or from shared/pricing.mjs'));
    return sec;
  }

  const rows = pricingRows(RATES, tcuPerUsd);
  const t = h('table', { class: 'lens-table lens-table--rates' },
    h('thead', {}, h('tr', {},
      h('th', { text: 'key' }), h('th', { text: 'interval (R10)' }),
      h('th', { class: 'lens-table__num', text: 'input' }), h('th', { class: 'lens-table__num', text: 'output' }),
      h('th', { class: 'lens-table__num', text: 'cache write 5m (×1.25)' }),
      h('th', { class: 'lens-table__num', text: 'cache write 1h (×2)' }),
      h('th', { class: 'lens-table__num', text: 'cache read (×0.1)' }))));
  const tb = h('tbody');
  for (const r of rows) {
    tb.appendChild(h('tr', {},
      h('td', {}, h('code', { text: r.key })),
      h('td', { text: fmtInterval(r.from, r.to) }),
      h('td', { class: 'lens-table__num', text: fmtRate(r.input) }),
      h('td', { class: 'lens-table__num', text: fmtRate(r.output) }),
      h('td', { class: 'lens-table__num', text: fmtRate(r.cacheWrite5m) }),
      h('td', { class: 'lens-table__num', text: fmtRate(r.cacheWrite1h) }),
      h('td', { class: 'lens-table__num', text: fmtRate(r.cacheRead) })));
  }
  t.appendChild(tb);
  sec.appendChild(t);
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: 'Every effective rate above (×1, ×1.25, ×2, ×0.1) is asserted integral in rate units at module load — a future rate that breaks it fails loudly at import rather than silently at runtime. A web-search request bills exactly $0.01; web_fetch is free (R8). A model with no covering interval is never billed $0: its tokens go to the unpriced channel (R7).',
  }));
  sec.appendChild(a(routes.audit(), 'the audit page states exactly what the A === B equality does and does not cover'));
  return sec;
}

/* ------------------------------------------------------- cache */

async function cacheSection(K, ctx) {
  const sec = section('cache');
  let index = null;
  // R14 / STALE-RENDER RULE — ctx.signal on the fetch, guard first in the catch.
  try { index = await K.api('/api/index', null, { signal: ctx?.signal }); }
  catch (err) { if (ctx?.stale) return sec; sec.appendChild(errorCard(err)); }

  const status = index?.status ?? null;
  const sessions = index?.sessions?.length ?? null;
  const built = toMs(index?.builtAt ?? index?.cache?.builtAt ?? null);
  sec.appendChild(factList([
    { label: 'index version', value: index?.version ?? null, source: '/api/index', reason: 'not reported' },
    { label: 'state', value: typeof status === 'string' ? status : status?.state ?? null, source: '/api/index status', reason: 'not reported' },
    { label: 'sessions in the index', value: sessions === null ? null : fmtInt(sessions), source: '/api/index', reason: 'not reported' },
    { label: 'denominator', value: status?.of ? `${fmtInt(status.done ?? status.sessionsDone ?? 0)} of ${fmtInt(status.of)} sessions` : null, source: 'indexer progress', reason: 'the index is complete, so no denominator is reported' },
    { label: 'cache entries', value: index?.cache?.entries === undefined ? null : fmtInt(index.cache.entries), source: 'index store', reason: 'not reported' },
    { label: 'cache bytes', value: index?.cache?.bytes === undefined ? null : fmtBytes(index.cache.bytes), source: 'index store', reason: 'not reported' },
    { label: 'built', value: built === null ? null : `${fmtLocalTime(built)} (${fmtDur(Date.now() - built)} ago)`, source: 'index store', reason: 'not reported' },
  ]));

  const out = h('p', { class: 'lens-note' });
  sec.append(h('button', {
    class: 'lens-btn', text: 're-index (ignores fingerprints)',
    onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      out.textContent = 're-indexing…';
      // Same write carve-out as the config PUT above: the POST is NOT given
      // ctx.signal, because an aborted mutation leaves the app unable to say
      // whether the server started re-indexing, and this app never prints a
      // state it does not know. The stale guards keep the superseded render
      // from painting either outcome.
      try {
        await sendJson('/api/reindex', {}, 'POST');
        if (ctx?.stale) return;
        out.textContent = 're-index started — the store view shows determinate progress while it runs.';
      } catch (err) {
        if (ctx?.stale) return;
        out.textContent = `re-index failed: ${err?.message ?? err}`;
      } finally { ev.currentTarget.disabled = false; }
    },
  }), out);
  sec.appendChild(h('p', {
    class: 'lens-note',
    text: 'The cache stores tokens only, never dollars — which is what makes "a pricing edit never invalidates the cache" true. A session is keyed by a sha1 fingerprint over its whole file tree (rel, size, mtimeMs), so a changed session misses naturally.',
  }));
  return sec;
}

/* ------------------------------------------------------- keyboard */

function keyboardSection() {
  const sec = section('keyboard');
  const t = h('table', { class: 'lens-table lens-table--keys' },
    h('thead', {}, h('tr', {}, h('th', { text: 'key' }), h('th', { text: 'does' }))));
  const tb = h('tbody');
  for (const [key, does] of KEYMAP) {
    tb.appendChild(h('tr', {}, h('td', {}, h('kbd', { text: key })), h('td', { text: does })));
  }
  t.appendChild(tb);
  sec.appendChild(t);
  return sec;
}

/* ---------------------------------------------------------------- routes */

export const routeList = [['/settings', renderSettings]];
export function register(defineRoute) {
  for (const [p, r] of routeList) {
    try { defineRoute(p, r); } catch (err) { console.error('defineRoute failed', p, err); }
  }
}
