// web/js/lib/text.mjs — text bodies and their persisted preferences: the
// localStorage pref store, the dependency-free escape-first markdown renderer
// behind the per-row "render markdown" toggle (DESIGN §3), safeStringify and
// the raw-JSON mount.

import { h } from '../format.mjs';
import { jsonview } from '../components/jsonview.mjs';

export function getPref(key, dflt) {
  try {
    const v = localStorage.getItem(`lens.${key}`);
    return v === null ? dflt : JSON.parse(v);
  } catch { return dflt; }
}

export function setPref(key, value) {
  try { localStorage.setItem(`lens.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
}

/* =================================================== markdown (opt-in) ==
 * DESIGN §3: raw text is the default everywhere; "render markdown" is a
 * per-row toggle that persists. Escape-first, no dependency, no HTML passthrough.
 */

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let inCode = false, listType = null, para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const inline = (t) => escapeHtml(t)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noreferrer noopener">$1</a>');

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) {
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { flushPara(); closeList(); out.push('<pre class="lens-md__code"><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(raw) + '\n'); continue; }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { flushPara(); closeList(); out.push(`<h${head[1].length}>${inline(head[2])}</h${head[1].length}>`); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (line === '') { flushPara(); closeList(); continue; }
    para.push(line);
  }
  if (inCode) out.push('</code></pre>');
  flushPara(); closeList();
  return out.join('\n');
}

/** A text body with a persisted per-row "render markdown" toggle. */
export function textBody(text, { prefKey = 'markdown', className = 'lens-body' } = {}) {
  const box = h('div', { class: className });
  const pre = h('pre', { class: `${className}__raw`, text: String(text ?? '') });
  const md = h('div', { class: `${className}__md lens-md` });
  const apply = (on) => {
    if (on) { md.innerHTML = renderMarkdown(text); pre.hidden = true; md.hidden = false; }
    else { pre.hidden = false; md.hidden = true; }
  };
  const initial = !!getPref(prefKey, false);
  const btn = h('button', {
    class: 'lens-btn lens-btn--toggle',
    'aria-pressed': String(initial),
    text: initial ? 'raw text' : 'render markdown',
    onclick: () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? 'raw text' : 'render markdown';
      setPref(prefKey, on);
      apply(on);
    },
  });
  box.append(h('div', { class: `${className}__tools` }, btn), pre, md);
  apply(initial);
  return box;
}

/* =================================================== raw JSON view == */

/** jsonview takes a dotted `bi` directly (it owns its own biToPath). */
export async function rawJson(el, value, highlightBi) {
  try { return jsonview(el, { value, highlightPath: highlightBi ?? null }); }
  catch (err) {
    console.error('jsonview failed', err);
    const pre = h('pre', { class: 'lens-json', text: safeStringify(value) });
    el.appendChild(pre);
    return { update() {}, destroy() { pre.remove(); } };
  }
}

export function safeStringify(value) {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}
