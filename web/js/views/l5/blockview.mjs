// web/js/views/l5/blockview.mjs — kind-specific rendering of ONE addressed
// block or blockless event (DESIGN §3 L5, top half): text/thinking/tool
// bodies, the image block with its measured base64 length, the structuredPatch
// sidecar, and the event-level fallbacks. Pure DOM building over one event.

import { h, unknown, factList } from '../../lib/dom.mjs';
import { fmtInt, fmtBytes, truncate } from '../../lib/fmt.mjs';
import { textBody, safeStringify } from '../../lib/text.mjs';
import { copyLocator } from '../../lib/locator.mjs';
import { apiUrl } from '../../lib/net.mjs';
import { eventKind, recordedB64, attributeBlob, SERVABLE_MEDIA_TYPES } from '../../lib/blocks.mjs';

/** Rendered-block heading text per kind. */
export function blockHeading(block) {
  switch (block.kind) {
    case 'prompt': return 'prompt (verbatim)';
    case 'text': return 'text';
    case 'thinking': return 'thinking';
    case 'tool_use': return `tool_use${block.node?.name ? ` — ${block.node.name}` : ''}`;
    case 'tool_result': return 'tool_result';
    case 'image': return 'image';
    case 'fallback': return 'fallback';
    default: return block.kind;
  }
}

/** Kind-specific rendered block (DESIGN §3 L5, top half). */
export function renderBlock(block, event, locators, { blocks = null, blobs = null } = {}) {
  const box = h('div', { class: `lens-block lens-block--${String(block.kind).split(':')[0]}` });
  const node = block.node;

  if (block.note) box.appendChild(h('p', { class: 'lens-note', text: block.note }));

  switch (block.kind) {
    case 'prompt':
    case 'text': {
      const t = typeof node === 'string' ? node : node?.text;
      if (t === undefined || t === null) box.appendChild(unknown('no `text` key recorded on this block'));
      else box.appendChild(textBody(t));
      break;
    }
    case 'thinking': {
      const t = node?.thinking ?? node?.text ?? '';
      const sig = node?.signature;
      const sigLen = node?.signatureLength ?? (typeof sig === 'string' ? sig.length : null);
      if (!t) {
        box.appendChild(h('p', {
          class: 'lens-note',
          text: sig !== undefined
            ? `thinking text is empty but a signature is recorded on this block${sigLen ? ` (${fmtInt(sigLen)} chars, dropped by the reader — SPEC §1)` : ''}: the content was withheld from the transcript, not absent from the response.`
            : 'thinking text is empty and no signature is recorded on this block.',
        }));
      } else box.appendChild(textBody(t));
      if (node?.thinking_tokens !== undefined || node?.thinkingTokens !== undefined) {
        box.appendChild(factList([{ label: 'thinking_tokens', value: fmtInt(node.thinking_tokens ?? node.thinkingTokens), source: 'block' }]));
      }
      break;
    }
    case 'tool_use': {
      box.appendChild(factList([
        { label: 'name', value: node?.name ?? null, reason: 'no `name` key recorded', source: 'block' },
        { label: 'id', value: node?.id ?? null, reason: 'no `id` key recorded', source: 'block' },
      ]));
      box.appendChild(h('h4', { class: 'lens-block__sub', text: 'input' }));
      box.appendChild(h('pre', { class: 'lens-json', text: safeStringify(node?.input ?? null) }));
      break;
    }
    case 'tool_result': {
      const isErr = node?.is_error === true;
      box.appendChild(factList([
        { label: 'tool_use_id', value: node?.tool_use_id ?? null, reason: 'no `tool_use_id` key recorded', source: 'block' },
        {
          label: 'is_error',
          value: node?.is_error === undefined ? null : String(node.is_error),
          reason: 'key absent — tri-state; only `=== true` is an error (SPEC §3)',
          source: 'block',
        },
      ]));
      if (isErr) box.appendChild(h('p', { class: 'lens-badge lens-badge--error', text: 'is_error: true' }));
      const content = typeof node === 'string' ? node : node?.content ?? node?.text ?? null;
      if (typeof content === 'string') box.appendChild(textBody(content));
      else if (Array.isArray(content)) {
        box.appendChild(h('p', { class: 'lens-note', text: `${content.length} nested block(s) — each is separately addressable below.` }));
      } else if (content && typeof content === 'object') {
        box.appendChild(h('pre', { class: 'lens-json', text: safeStringify(content) }));
      }
      renderResultSidecar(box, node, event);
      break;
    }
    case 'image': {
      const media = node?.source?.media_type ?? node?.media_type ?? null;
      // The base64 length IS recorded — either still on the node (payloads
      // under SPEC §1's strip threshold are never replaced) or on the
      // payload's blobs[], the same measurement the raw-JSON note below
      // prints. Claiming "not recorded" while that note is on the page would
      // be the assertion-of-absence the design rule forbids.
      const rec = recordedB64(node);
      const b64 = (Array.isArray(blobs) ? blobs : []).filter((b) => b && b.kind === 'base64');
      let lenFact = null;
      if (rec && rec.value.length > 0) {
        lenFact = { value: `${fmtInt(rec.value.length)} chars`, source: 'block' };
      } else {
        const hit = attributeBlob(block, blocks, event, b64);
        if (hit) {
          lenFact = {
            value: `${fmtInt(hit.length)} chars${hit.bytes === null || hit.bytes === undefined ? '' : ` · ${fmtBytes(hit.bytes)} decoded`}`,
            source: 'reader (SPEC §1)',
          };
        } else {
          lenFact = {
            value: null,
            source: 'reader (SPEC §1)',
            reason: !rec
              ? 'this block records no base64 `data` key, so there is no payload length to report'
              : b64.length
                ? `the reader stripped ${fmtInt(b64.length)} base64 span(s) on this line but cannot attribute one to this block address (SPEC §1)`
                : 'no base64 span was stripped on this line',
          };
        }
      }
      // The server never serves a transcript-declared type verbatim; it must
      // name one of the four types the magic-byte sniffer recognises, or the
      // bytes decide. Say so here rather than swap the type behind the
      // reader's back.
      const servedNote = typeof media === 'string' && !SERVABLE_MEDIA_TYPES.has(media.split(';')[0].trim().toLowerCase())
        ? 'the server will NOT serve the image under this type: only image/png, image/jpeg, image/gif and image/webp are served as declared; anything else is sniffed from the bytes, or served as application/octet-stream'
        : null;
      box.appendChild(factList([
        { label: 'media_type', value: media, reason: 'not recorded on this path — sniffed from magic bytes by the server (SPEC §8)', source: 'block', note: servedNote },
        { label: 'recorded base64 length', ...lenFact },
      ]));
      if (locators) {
        const src = apiUrl('/api/image', { slug: locators.slug, id: locators.sid, file: locators.rel, line: locators.line, block: block.bi });
        box.appendChild(h('img', { class: 'lens-image', src, alt: `image at ${copyLocator(locators.rel, locators.line, block.bi)}`, loading: 'lazy' }));
      }
      break;
    }
    case 'fallback': {
      box.appendChild(h('pre', { class: 'lens-json', text: safeStringify(node) }));
      break;
    }
    default: {
      if (String(block.kind).startsWith('unknown:')) {
        box.appendChild(h('p', { class: 'lens-note', text: 'unknown block type — rendered as pretty-printed JSON, never dropped (SPEC §3).' }));
      }
      box.appendChild(h('pre', { class: 'lens-json', text: safeStringify(node) }));
    }
  }
  return box;
}

/** structuredPatch hunks + userModified badge (DESIGN §3 L5). */
function renderResultSidecar(box, node, event) {
  const tur = event?.toolUseResult;
  const src = (tur && typeof tur === 'object' && !Array.isArray(tur)) ? tur : null;
  if (!src) return;
  if (src.userModified === true) {
    box.appendChild(h('p', { class: 'lens-badge lens-badge--modified', title: 'toolUseResult.userModified === true', text: 'userModified' }));
  }
  const patch = src.structuredPatch;
  if (Array.isArray(patch) && patch.length) {
    const wrap = h('div', { class: 'lens-patch' }, h('h4', { class: 'lens-block__sub', text: `structuredPatch — ${fmtInt(patch.length)} hunk(s)` }));
    for (const hunk of patch) {
      const head = `@@ -${hunk.oldStart ?? '?'},${hunk.oldLines ?? '?'} +${hunk.newStart ?? '?'},${hunk.newLines ?? '?'} @@`;
      const pre = h('pre', { class: 'lens-patch__hunk' });
      pre.appendChild(h('span', { class: 'lens-patch__head', text: head + '\n' }));
      for (const ln of hunk.lines ?? []) {
        const cls = ln.startsWith('+') ? 'add' : ln.startsWith('-') ? 'del' : 'ctx';
        pre.appendChild(h('span', { class: `lens-patch__line lens-patch__line--${cls}`, text: ln + '\n' }));
      }
      wrap.appendChild(pre);
    }
    box.appendChild(wrap);
  }
}

/** Attachment / system / queue-operation events have no content blocks. */
export function renderEventLevel(event) {
  const kind = eventKind(event);
  const box = h('div', { class: 'lens-block lens-block--event' });
  if (kind.startsWith('attachment:')) {
    const at = event.attachment ?? {};
    box.appendChild(h('h3', { class: 'lens-block__title', text: `attachment · ${at.type ?? 'unknown type'}` }));
    box.appendChild(h('pre', { class: 'lens-json', text: safeStringify(at) }));
    if (!at.type) box.appendChild(h('p', { class: 'lens-note', text: 'no `type` recorded — rendered as pretty-printed JSON, never dropped (SPEC §3).' }));
    return box;
  }
  if (kind.startsWith('system:')) {
    const sub = event.subtype ?? null;
    box.appendChild(h('h3', { class: 'lens-block__title', text: `system · ${sub ?? 'unknown subtype'}` }));
    const facts = [];
    if (sub === 'api_error') facts.push({ label: 'retryInMs', value: event.retryInMs ?? null, reason: 'not recorded on this event', source: 'event' });
    if (sub === 'model_refusal_fallback') {
      facts.push({ label: 'originalModel', value: event.originalModel ?? null, reason: 'not recorded', source: 'event' });
      facts.push({ label: 'fallbackModel', value: event.fallbackModel ?? null, reason: 'not recorded', source: 'event' });
      facts.push({
        label: 'retractedMessageUuids',
        value: Array.isArray(event.retractedMessageUuids) ? `${fmtInt(event.retractedMessageUuids.length)} recorded` : null,
        reason: 'not recorded', source: 'event',
        note: 'displayed, not acted on (SPEC §3)',
      });
    }
    if (facts.length) box.appendChild(factList(facts));
    if (event.content) box.appendChild(textBody(typeof event.content === 'string' ? event.content : safeStringify(event.content)));
    return box;
  }
  if (kind === 'queue-operation') {
    box.appendChild(h('h3', { class: 'lens-block__title', text: 'queue-operation' }));
    box.appendChild(h('pre', { class: 'lens-json', text: safeStringify(event) }));
    box.appendChild(h('p', { class: 'lens-note', text: 'a real timeline event — the one metadata type that is not a state snapshot (SPEC §3).' }));
    return box;
  }
  box.appendChild(h('h3', { class: 'lens-block__title', text: kind }));
  if (kind.startsWith('unknown:')) {
    box.appendChild(h('p', { class: 'lens-note', text: 'unknown event type — surfaced here and in the inventory, never dropped (SPEC §3).' }));
  } else if (['last-prompt', 'ai-title', 'custom-title', 'mode', 'pr-link', 'frame-link'].includes(kind)) {
    box.appendChild(h('p', {
      class: 'lens-note',
      text: 'a state snapshot, not a timeline row: massively duplicated in the file and shown as latest-value + count on the session facts row (SPEC §3).',
    }));
  }
  box.appendChild(h('pre', { class: 'lens-json', text: safeStringify(event) }));
  return box;
}

/** One-line preview of a block for the all-blocks listing. */
export function peek(block) {
  const n = block.node;
  if (typeof n === 'string') return truncate(n, 80);
  if (n?.text) return truncate(n.text, 80);
  if (n?.thinking) return truncate(n.thinking, 80);
  if (n?.name) return `name: ${n.name}`;
  if (n?.tool_use_id) return `tool_use_id: ${n.tool_use_id}`;
  return '';
}
