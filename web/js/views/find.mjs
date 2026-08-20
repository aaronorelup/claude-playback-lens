/**
 * Search (`#/find`) — the server SSE corpus scan.
 * DESIGN §3 (Search), SPEC §9 (find SSE vocabulary, find's corpus).
 *
 * Results are grouped by session and rendered IN SCAN ORDER. The client never
 * re-orders and never ranks: "sessions newest-first, file order within" is the
 * server's scan order, and that is the whole ordering contract (SPEC §9).
 */

import { kit } from '../lib/net.mjs';
import { h, a, clear, unknown, section } from '../lib/dom.mjs';
import { fmtInt, fmtBytes, fmtDur, fmtLocalTime, shortId, truncate, toMs } from '../lib/fmt.mjs';
import { routes } from '../lib/links.mjs';
import { copyLocator } from '../lib/locator.mjs';
import { page, errorCard, mountCrumbs, progressBar } from '../lib/chrome.mjs';
import { classifyRel } from './inv.mjs';

export const RESULT_CAP = 500;
export const CONTEXT_CHARS = 80;

/* ============================================================ pure ==== */

/**
 * Group matches by session, preserving first-appearance (scan) order.
 * Pure — the ordering guarantee is the thing worth testing.
 */
export function groupMatchesByScanOrder(matches = []) {
  const groups = [];
  const index = new Map();
  for (const m of matches) {
    const key = `${m.slug}/${m.id}`;
    let g = index.get(key);
    if (!g) {
      g = { slug: m.slug, id: m.id, key, matches: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.matches.push(m);
  }
  return groups;
}

/** The 80-char context window around a match, when the server ships a longer one. */
export function contextWindow(ctx, chars = CONTEXT_CHARS) {
  const text = String(ctx ?? '');
  if (text.length <= chars) return text;
  return truncate(text, chars);
}

/** Skip report: "N image payloads and M signatures skipped" (SPEC §9). */
export function skipReport(skips = []) {
  let images = 0, signatures = 0, other = 0, bytes = 0;
  for (const sk of skips) {
    bytes += Number(sk.bytes ?? 0) || 0;
    const reason = String(sk.reason ?? '').toLowerCase();
    if (reason.includes('base64') || reason.includes('image')) images++;
    else if (reason.includes('signature')) signatures++;
    else other++;
  }
  return { images, signatures, other, bytes, total: skips.length };
}

export function describeSkips(rep) {
  if (!rep.total) return '0 spans skipped.';
  let text = `${fmtInt(rep.images)} image payloads and ${fmtInt(rep.signatures)} signatures skipped`;
  if (rep.other) text += `, plus ${fmtInt(rep.other)} span(s) skipped for another recorded reason`;
  if (rep.bytes) text += ` (${fmtBytes(rep.bytes)})`;
  return `${text} — find scans each line after the same base64/signature strip the reader applies (SPEC §9).`;
}

/** An L5 address for a match; a match with no block index gets none (SPEC §9). */
export function matchHref(m) {
  const cls = classifyRel(m.file ?? '');
  const agentId = cls.agentId ?? 'main';
  return routes.event(m.slug, m.id, agentId, m.line, m.bi ?? null);
}

/* ============================================================ view ==== */

export async function renderFind(ctx) {
  const { body } = page(ctx, 'lens-find');
  const K = await kit();
  // R14 / STALE-RENDER RULE (BUILD-CONTRACTS): guard after EVERY await. As on
  // the audit page, the abort listener that closes the scan is registered at
  // the END of this function, so a render superseded during `await kit()`
  // would start a whole-corpus scan nothing is left to close.
  if (ctx.stale) return;
  const q0 = ctx.query?.get?.('q') ?? '';
  const re0 = ctx.query?.get?.('re') === '1';
  const case0 = ctx.query?.get?.('case') === '1';
  const scope0 = ctx.query?.get?.('scope') ?? 'store';

  mountCrumbs(ctx, [{ label: 'store', href: routes.store() }, { label: 'find' }]);
  ctx.setTitle?.(q0 ? `find "${truncate(q0, 40)}" — Claude Playback Lens` : 'find — Claude Playback Lens');

  // ---- the form (a real form: submitting rewrites the hash, so a search is a URL)
  const qInput = h('input', { class: 'lens-input lens-find__q', type: 'search', value: q0, placeholder: 'substring, or a regex with the toggle on', 'aria-label': 'search text' });
  const reBox = h('input', { class: 'lens-check', type: 'checkbox', id: 'lens-find-re', ...(re0 ? { checked: true } : {}) });
  const caseBox = h('input', { class: 'lens-check', type: 'checkbox', id: 'lens-find-case', ...(case0 ? { checked: true } : {}) });
  const scopeInput = h('input', { class: 'lens-input lens-find__scope', type: 'text', value: scope0, 'aria-label': 'scope' });
  const form = h('form', {
    class: 'lens-find__form',
    onsubmit: (ev) => {
      ev.preventDefault();
      const href = routes.find({
        q: qInput.value, re: reBox.checked ? '1' : '', case: caseBox.checked ? '1' : '',
        scope: scopeInput.value && scopeInput.value !== 'store' ? scopeInput.value : '',
      });
      if (typeof ctx.navigate === 'function') ctx.navigate(href); else location.hash = href.slice(1);
    },
  },
    qInput,
    h('label', { for: 'lens-find-re' }, reBox, h('span', { text: 'regex' })),
    h('label', { for: 'lens-find-case' }, caseBox, h('span', { text: 'case-sensitive' })),
    h('label', {}, h('span', { text: 'scope' }), scopeInput),
    h('button', { class: 'lens-btn lens-btn--primary', type: 'submit', text: 'scan' }));
  ctx.scopeSentence?.({ extra: [q0
      // The normalization clause is a disclosure, not decoration — the
      // scan compares NFC forms, so "café" finds a decomposed "café", and the
      // two things it deliberately does NOT do are stated rather than left to
      // be inferred from a zero.
      ? `Every byte of the ${scope0 === 'store' ? 'whole store' : scope0} scanned for ${re0 ? 'the regular expression' : 'the substring'} "${truncate(q0, 60)}"${case0 ? ', case-sensitive' : ', case-insensitive'}. `
        + `Text is compared in Unicode NFC${re0 ? ', so composed and decomposed spellings of the same word match — the regular expression itself is left exactly as you typed it, since it is pattern syntax rather than text' : ' — composed and decomposed spellings of the same word match'}; `
        + 'that is canonical equivalence only, so "ﬁ" still does not match "fi". '
        + 'Results are grouped by session in scan order — sessions newest-first, file order within. Nothing is ranked and nothing is re-sorted here.'
      : 'Type a substring (or a regex) and scan. The server streams matches as it reads; results appear grouped by session in scan order, never ranked.'] });
  // No stat header here on purpose: a search result set is not a billing scope,
  // and a statbar over it would invite the reader to add up unrelated sessions.
  // The determinate scan progress below is this page's header instead.
  ctx.registerScope?.(scope0);
  body.appendChild(form);

  if (!q0) {
    body.appendChild(h('p', { class: 'lens-note', text: 'Scope grammar: store · project:<slug> · session:<slug>/<id> · turn:<slug>/<id>/<idx> · agent:<slug>/<id>/<agentId> (SPEC §9).' }));
    return;
  }

  // ---- progress + results
  const prog = progressBar();
  const statusLine = h('p', { class: 'lens-find__status', text: 'starting the scan…' });
  const skipsLine = h('p', { class: 'lens-note lens-find__skips' });
  const results = h('div', { class: 'lens-find__results' });
  const more = h('div', { class: 'lens-find__more' });
  body.append(h('div', { class: 'lens-find__progress' }, prog.el, statusLine), skipsLine, results, more);

  const all = [];
  const skips = [];          // per-file skip events (a real file in `file`)
  let aggregateSkipText = null;   // the server's own '*' summary line, verbatim
  const groupEls = new Map();
  let started = Date.now();
  let stream = null;
  let finished = false;
  let sawEvent = false;

  const drawSkips = (doneSkipped) => {
    // The server's aggregate skip event carries the true
    // counts in its own words; per-file events are counted apart. On done the
    // structured `skipped` object is the authoritative source.
    const parts = [];
    if (doneSkipped && (Number.isFinite(doneSkipped.imagePayloads) || Number.isFinite(doneSkipped.signatures))) {
      parts.push(`${fmtInt(doneSkipped.imagePayloads ?? 0)} image payloads and ${fmtInt(doneSkipped.signatures ?? 0)} signatures skipped`
        + (doneSkipped.bytes ? ` (${fmtBytes(doneSkipped.bytes)})` : '')
        + ' — find scans each line after the same base64/signature strip the reader applies (SPEC §9).');
    } else if (aggregateSkipText) {
      parts.push(aggregateSkipText);
    }
    if (skips.length) parts.push(`${fmtInt(skips.length)} file(s) skipped (unreadable) — their bytes still count toward progress.`);
    skipsLine.textContent = parts.join(' ') || (finished ? describeSkips(skipReport([])) : '');
  };

  const appendMatch = (m) => {
    all.push(m);
    const key = `${m.slug}/${m.id}`;
    let g = groupEls.get(key);
    if (!g) {
      const listing = h('div', { class: 'lens-find__grouprows' });
      const count = h('span', { class: 'lens-find__groupcount', text: '0' });
      const box = h('section', { class: 'lens-find__group' },
        h('h3', { class: 'lens-find__grouphead' },
          a(routes.session(m.slug, m.id), `${m.slug} · session ${shortId(m.id)}`), count),
        listing);
      results.appendChild(box);
      g = { listing, count, n: 0 };
      groupEls.set(key, g);
    }
    g.n++;
    g.count.textContent = `${fmtInt(g.n)} match${g.n === 1 ? '' : 'es'}`;
    const at = toMs(m.at);
    g.listing.appendChild(h('div', { class: 'lens-find__row' },
      a(matchHref(m), copyLocator(m.file ?? '', m.line, m.bi ?? null), { class: 'lens-link lens-find__loc' }),
      at === null ? unknown('this event type records no timestamp') : h('span', { class: 'lens-find__at', text: fmtLocalTime(at) }),
      h('code', { class: 'lens-find__ctx', text: contextWindow(m.ctx) }),
      m.bi === null || m.bi === undefined
        ? h('span', { class: 'lens-note', text: 'match outside any content block — addressed by line only, never a fabricated block index (SPEC §9)' })
        : null));
  };

  const run = (after) => {
    started = Date.now();
    finished = false;
    statusLine.textContent = after ? 'resuming past the cap…' : 'scanning…';
    clear(more);
    stream = K.sse('/api/find', {
      q: q0, re: re0 ? 1 : '', case: case0 ? 1 : '',
      scope: scope0 && scope0 !== 'store' ? scope0 : '', after: after ?? '',
    }, {
      progress: (p) => { sawEvent = true; prog.update(p); },
      match: (m) => { sawEvent = true; if (m) appendMatch(m); },
      skip: (sk) => {
        if (!sk) return;
        if (sk.file === '*') aggregateSkipText = sk.reason ? `${sk.reason} — find scans each line after the same base64/signature strip the reader applies (SPEC §9).` : aggregateSkipText;
        else skips.push(sk);
        drawSkips(null);
      },
      problem: (p) => {
        body.appendChild(h('p', { class: 'lens-note lens-note--problem', text: `problem · ${p?.code ?? 'unknown'} · ${p?.message ?? ''}${p?.affects ? ` · affects ${p.affects}` : ''}` }));
      },
      error: async (e) => {
        finished = true;
        statusLine.textContent = '';
        // find-cursor-stale is a RE-RUN prompt, never a zero (SPEC §9 vocab,
        // the cursor's session/file changed on disk.
        if (e?.code === 'find-cursor-stale') {
          more.appendChild(h('p', { class: 'lens-note lens-note--problem', text: e.message ?? 'the resume cursor no longer resolves — re-run the scan from the start.' }));
          more.appendChild(h('button', {
            class: 'lens-btn lens-btn--primary', text: 're-run the scan from the start',
            onclick: (ev) => { ev.currentTarget.disabled = true; run(null); },
          }));
          return;
        }
        // A transport-level close BEFORE any event may be a pre-stream 4xx the
        // EventSource cannot read (e.g. 400 bad-regex with its rewrite hint) —
        // one diagnostic fetch recovers the server's error envelope. If the
        // request turns out valid, the body is cancelled immediately so the
        // probe never runs a second scan to completion.
        if (e?.code === 'stream-error' && !sawEvent) {
          try {
            // R14 / STALE-RENDER RULE: every fetch carries ctx.signal, so the
            // diagnostic probe dies with the render that asked for it.
            const res = await fetch(stream?.url ?? '', { headers: { accept: 'application/json' }, signal: ctx.signal });
            if (ctx.stale) return;
            if (!res.ok) {
              const bodyJson = await res.json().catch(() => null);
              if (ctx.stale) return;
              const srv = bodyJson?.error;
              more.appendChild(errorCard({ code: srv?.code ?? `http-${res.status}`, message: srv?.message ?? 'the scan could not start' }));
              return;
            }
            try { res.body?.cancel?.(); } catch { /* stream already gone */ }
          } catch { /* fall through to the generic card */ }
        }
        // R14: ahead of the last paint — the abort above lands in the catch and
        // falls through to here, so a superseded scan must stop before it
        // banners an error onto the page the reader moved to.
        if (ctx.stale) return;
        more.appendChild(errorCard({ code: e?.code ?? 'scan-error', message: e?.message ?? 'the scan reported an error' }));
      },
      done: (d) => {
        finished = true;
        const n = all.length;
        const cap = d?.cap ?? RESULT_CAP;   // the server's cap when reported
        prog.done(`${fmtInt(n)} match${n === 1 ? '' : 'es'} · ${fmtDur(Date.now() - started)}`);
        statusLine.textContent = `${fmtInt(n)} match${n === 1 ? '' : 'es'} in ${fmtInt(groupEls.size)} session${groupEls.size === 1 ? '' : 's'}${d?.capped ? ` · capped at ${fmtInt(cap)} per scan` : ''}`;
        if (!n) results.appendChild(h('p', { class: 'lens-note', text: 'no match. This is a real zero: the scan completed and found nothing.' }));
        drawSkips(d?.skipped ?? null);   // a skip-free scan prints "0 spans skipped."
        if (d?.capped) {
          more.appendChild(h('p', { class: 'lens-note', text: `The scan stopped at the ${fmtInt(cap)}-result cap. Keep scanning resumes from the server's cursor — it does not re-scan what you already have.` }));
          more.appendChild(h('button', {
            class: 'lens-btn lens-btn--primary', text: 'keep scanning',
            onclick: (ev) => { ev.currentTarget.disabled = true; run(d.cursor ?? d.after ?? null); },
          }));
          if (!d.cursor && !d.after) {
            clear(more).appendChild(unknown('the server reported a cap but no cursor, so the scan cannot be resumed'));
          }
        }
      },
    });
  };
  run(ctx.query?.get?.('after') ?? null);

  // Close the stream the moment this render is superseded — the
  // router aborts the previous ctx on every navigation, so the abort signal is
  // the ONE correct lifecycle hook (the old isConnected watchdog tested an
  // element that never disconnects).
  ctx.signal?.addEventListener?.('abort', () => { try { stream?.close?.(); } catch { /* already closed */ } });
}

/* ---------------------------------------------------------------- routes */

export const routeList = [['/find', renderFind]];
export function register(defineRoute) {
  for (const [p, r] of routeList) {
    try { defineRoute(p, r); } catch (err) { console.error('defineRoute failed', p, err); }
  }
}
