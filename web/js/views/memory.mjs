/**
 * Project memory file (`#/p/<slug>/mem/<name>`).
 * DESIGN §3 (L1 memory view links here), SPEC §8 (frontmatter
 * `metadata.originSessionId`: link when it resolves, say "session not on disk"
 * when it dangles — 18 of 71 dangle here, and one resolves into a DIFFERENT
 * project dir, which is a cross-link, not an error), SPEC §9 (`/api/file`
 * with `id` omitted resolves `mem/<name>` against the project dir).
 */

import { kit, apiUrl, fetchRaw } from '../lib/net.mjs';
import { h, a, section, factList } from '../lib/dom.mjs';
import { shortId } from '../lib/fmt.mjs';
import { routes } from '../lib/links.mjs';
import { page, errorCard, statHeader, mountCrumbs } from '../lib/chrome.mjs';
import { textBody } from '../lib/text.mjs';

/* ============================================================ pure ==== */

/**
 * Split YAML frontmatter from a markdown body and parse the small subset that
 * actually occurs here (scalars, one level of nesting, simple lists).
 * Anything it cannot parse is preserved verbatim in `raw` and displayed —
 * the parse is a convenience, never the source of truth.
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '');
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { frontmatter: null, raw: null, body: src, hasFrontmatter: false };
  const raw = m[1];
  const body = src.slice(m[0].length);
  return { frontmatter: parseYamlSubset(raw), raw, body, hasFrontmatter: true };
}

function parseYamlSubset(raw) {
  const out = {};
  const lines = String(raw).split(/\r?\n/);
  let curKey = null, curIndent = 0;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.replace(/^\s*/, '').length;
    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      const value = scalar(trimmed.slice(2));
      if (curKey !== null) {
        const cur = out[curKey];
        if (Array.isArray(cur)) cur.push(value);
        else if (cur === null || cur === '' || cur === undefined) out[curKey] = [value];
        else if (typeof cur === 'object') { /* a list nested under a map is outside this subset — the verbatim block is shown */ }
        else out[curKey] = [cur, value];
      }
      continue;
    }
    const kv = /^([^:]+):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const key = kv[1].trim();
    const rest = kv[2];
    if (indent > curIndent && curKey !== null) {
      if (typeof out[curKey] !== 'object' || out[curKey] === null || Array.isArray(out[curKey])) out[curKey] = {};
      out[curKey][key] = rest === '' ? null : scalar(rest);
      continue;
    }
    curKey = key; curIndent = indent;
    out[key] = rest === '' ? null : scalar(rest);
  }
  return out;
}

function scalar(v) {
  const t = String(v).trim().replace(/^["']|["']$/g, '');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

/** Where an originSessionId is recorded, in the observed order (SPEC §8). */
export function findOriginSessionId(fm) {
  if (!fm || typeof fm !== 'object') return null;
  const direct = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata.originSessionId : undefined;
  const flat = fm.originSessionId;
  const v = direct ?? flat ?? null;
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * Resolve an originSessionId against the index. Returns the recorded outcome —
 * resolved (same project), cross-project, or dangling — never a guess.
 */
export function resolveOrigin(originId, sessions = [], currentSlug = null) {
  if (!originId) return { state: 'none' };
  const hit = sessions.find((sx) => (sx.id ?? sx.sessionId) === originId);
  if (!hit) {
    return {
      state: 'dangling', id: originId,
      message: 'session not on disk — the transcript this memory came from is no longer in the store (18 of 71 dangle here; sessions demonstrably get deleted, SPEC §2).',
    };
  }
  const slug = hit.slug ?? null;
  return {
    state: slug && currentSlug && slug !== currentSlug ? 'cross-project' : 'resolved',
    id: originId, slug, session: hit,
  };
}

/* ============================================================ view ==== */

let _indexSessions = null;
async function indexSessions(K, signal) {
  if (_indexSessions) return _indexSessions;
  try {
    const idx = await K.api('/api/index', null, { signal });
    // R14: a VALUE cache, never a promise cache, and ONLY a real answer is
    // memoised. Now that the requesting render owns the fetch (STALE-RENDER
    // RULE), the old `catch { _indexSessions = []; }` would let one aborted
    // navigation poison every later render into reporting every
    // originSessionId as dangling — the same trap _relCache avoids in l5.
    _indexSessions = idx?.sessions ?? [];
    return _indexSessions;
  } catch { return []; }
}

export async function renderMemory(ctx) {
  const { body } = page(ctx, 'lens-mem');
  const P = ctx.params ?? {};
  const slug = P.slug;
  const name = String(P.name ?? P.mem ?? '');   // already decoded by the router
  const K = await kit();
  if (ctx.stale) return;   // R14 / STALE-RENDER RULE — guard after EVERY await

  mountCrumbs(ctx, [
    { label: 'store', href: routes.store() },
    { label: slug ?? 'project', href: routes.project(slug) },
    { label: 'memory', href: routes.project(slug, { v: 'memory' }) },
    { label: name || 'file' },
  ]);
  ctx.setTitle?.(`${name} — Claude Playback Lens`);

  if (!name) {
    body.appendChild(errorCard({ status: 400, code: 'no-memory-name', message: 'no memory file named in this route.' }));
    return;
  }

  const rel = `mem/${name}`;
  let res;
  // R14 / STALE-RENDER RULE: the render owns its bytes — `{ signal }` so an
  // abandoned memory file stops downloading, and the guard is the FIRST
  // statement of the catch so the AbortError never paints a retry card onto
  // the page the reader moved to.
  try { res = await fetchRaw('/api/file', { slug, rel }, { signal: ctx.signal }); }
  catch (err) {
    if (ctx.stale) return;
    body.appendChild(errorCard(err, { retry: () => renderMemory(ctx) })); return;
  }
  if (ctx.stale) return;

  const { frontmatter, raw, body: mdBody, hasFrontmatter } = parseFrontmatter(res.text);
  const originId = findOriginSessionId(frontmatter);
  const sessions = originId ? await indexSessions(K, ctx.signal) : [];
  if (ctx.stale) return;
  const origin = resolveOrigin(originId, sessions, slug);

  statHeader(ctx, {
    agg: null,
    scopeSentence: `${rel} in project ${slug} — a project-level memory file. It carries no usage and bills nothing; it appears here and in the session inventory's files ledger so that nothing in the store lacks a view.`,
    span: { label: 'span', ms: null, reason: 'a memory file records no timestamps of its own' },
    counts: [
      { key: 'bytes', label: 'bytes', value: res.bytes },
      { key: 'fm', label: 'frontmatter keys', value: hasFrontmatter ? Object.keys(frontmatter ?? {}).length : 0 },
    ],
  });

  body.appendChild(h('div', { class: 'lens-mem__tools' },
    a(apiUrl('/api/file', { slug, rel }), 'raw bytes', { target: '_blank', rel: 'noreferrer' }),
    a(routes.projectFile(slug, rel), 'raw view')));

  // ---- frontmatter
  const fmSec = section('frontmatter');
  if (!hasFrontmatter) {
    fmSec.appendChild(h('p', { class: 'lens-note', text: 'this file records no YAML frontmatter block.' }));
  } else {
    const rows = flatten(frontmatter).map(([label, value]) => ({
      label, value: value === null ? null : String(value), source: 'YAML frontmatter', reason: 'key present with no value recorded',
    }));
    fmSec.appendChild(factList(rows));
    fmSec.appendChild(h('details', { class: 'lens-details' },
      h('summary', { text: 'the frontmatter block, verbatim' }),
      h('pre', { class: 'lens-code', text: raw })));
  }

  // ---- originSessionId
  const origSec = section('origin session');
  switch (origin.state) {
    case 'none':
      origSec.appendChild(h('p', { class: 'lens-note', text: 'no metadata.originSessionId is recorded in this file (19 of 90 memory files here record none).' }));
      break;
    case 'resolved':
      origSec.appendChild(factList([{ label: 'originSessionId', value: origin.id, source: 'frontmatter metadata.originSessionId' }]));
      origSec.appendChild(a(routes.session(origin.slug ?? slug, origin.id), `open session ${shortId(origin.id)}`));
      break;
    case 'cross-project':
      origSec.appendChild(factList([{ label: 'originSessionId', value: origin.id, source: 'frontmatter metadata.originSessionId' }]));
      origSec.appendChild(h('p', { class: 'lens-note', text: `that session lives in a different project directory (${origin.slug}) — a cross-link, not an error.` }));
      origSec.appendChild(a(routes.session(origin.slug, origin.id), `open session ${shortId(origin.id)} in ${origin.slug}`));
      break;
    case 'dangling':
    default:
      origSec.appendChild(factList([{ label: 'originSessionId', value: origin.id, source: 'frontmatter metadata.originSessionId' }]));
      origSec.appendChild(h('p', { class: 'lens-note lens-note--problem', text: origin.message }));
      origSec.appendChild(a(routes.find({ q: origin.id }), 'search the corpus for this id'));
      break;
  }
  body.appendChild(origSec);

  // ---- content (raw is the default; markdown is a persisted toggle)
  const contentSec = section('content');
  contentSec.appendChild(textBody(mdBody, { prefKey: 'markdown.memory' }));
  body.appendChild(contentSec);
}

function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const label = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, label));
    else out.push([label, Array.isArray(v) ? v.join(', ') : v]);
  }
  return out;
}

/* ---------------------------------------------------------------- routes */

export const routeList = [['/p/:slug/mem/:name', renderMemory]];
export function register(defineRoute) {
  for (const [p, r] of routeList) {
    try { defineRoute(p, r); } catch (err) { console.error('defineRoute failed', p, err); }
  }
}
