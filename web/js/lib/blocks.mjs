// web/js/lib/blocks.mjs — block enumeration over one parsed event (SPEC §3
// row-kind vocabulary, SPEC §8 dotted-bi addressing), spill-reference
// extraction, and the recorded-base64 / stripped-blob attribution rules.
// Pure — no DOM, no fetches.

const BLOCK_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'image', 'fallback']);
// The four types /api/image will serve as declared (server/api.mjs IMAGE_MIME).
// Kept in step by hand — this side only DISCLOSES the server's rule, it does
// not enforce it.
export const SERVABLE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** SPEC §3 closed row-kind vocabulary for one content block. */
export function blockKind(node) {
  if (node === null || node === undefined) return 'unknown:null';
  if (typeof node === 'string') return 'text';
  const t = node.type;
  if (!t) return 'unknown:untyped';
  if (BLOCK_TYPES.has(t)) return t;
  return `unknown:${t}`;
}

/** SPEC §3 closed row-kind vocabulary for one event. */
export function eventKind(event) {
  if (!event || typeof event !== 'object') return 'unknown:null';
  const t = event.type;
  switch (t) {
    case 'assistant': return 'assistant';
    case 'user':
      return event.origin?.kind === 'human' ? 'prompt' : 'user';
    case 'attachment': return `attachment:${event.attachment?.type ?? event.attachmentType ?? 'unknown'}`;
    case 'system': return `system:${event.subtype ?? 'unknown'}`;
    case 'queue-operation': return 'queue-operation';
    case 'last-prompt': case 'ai-title': case 'custom-title': case 'mode':
    case 'pr-link': case 'frame-link':
      return t;
    default: return `unknown:${t ?? 'untyped'}`;
  }
}

/**
 * Enumerate every addressable block of one parsed event, in the dotted-bi
 * grammar (SPEC §8). Pure — the whole L5 addressing surface is testable.
 *
 * Twins (SPEC §8): an image recorded both as a tool_result content block and
 * again in the `toolUseResult` sidecar. Paired positionally and reported as a
 * recorded fact ("recorded twice on this line"); we never claim byte-identity
 * we have not verified here.
 */
export function enumerateBlocks(event) {
  const blocks = [];
  if (!event || typeof event !== 'object') return blocks;

  const content = event.message?.content;
  if (typeof content === 'string') {
    // A string body has no block index — SPEC §8: link to e/<line>, never a
    // fabricated block address.
    blocks.push({
      bi: null, kind: eventKind(event) === 'prompt' ? 'prompt' : 'text',
      node: content, path: ['message', 'content'], parentBi: null, twinOf: null,
      note: 'string content — no block index exists',
    });
  } else if (Array.isArray(content)) {
    content.forEach((b, i) => {
      blocks.push({ bi: String(i), kind: blockKind(b), node: b, path: ['message', 'content', i], parentBi: null, twinOf: null });
      if (b && Array.isArray(b.content)) {
        b.content.forEach((c, j) => {
          blocks.push({
            bi: `${i}.${j}`, kind: blockKind(c), node: c,
            path: ['message', 'content', i, 'content', j], parentBi: String(i), twinOf: null,
          });
        });
      }
    });
  }

  const tur = event.toolUseResult;
  if (Array.isArray(tur)) {
    tur.forEach((c, j) => {
      blocks.push({ bi: `r.${j}`, kind: blockKind(c), node: c, path: ['toolUseResult', j], parentBi: null, twinOf: null, sidecar: true });
    });
  } else if (tur && typeof tur === 'object') {
    const isImage = !!(tur.file && Object.prototype.hasOwnProperty.call(tur.file, 'base64'));
    blocks.push({
      bi: 'r', kind: isImage ? 'image' : 'tool_result', node: tur,
      path: ['toolUseResult'], parentBi: null, twinOf: null, sidecar: true,
    });
  } else if (typeof tur === 'string') {
    blocks.push({
      bi: 'r', kind: 'tool_result', node: tur, path: ['toolUseResult'],
      parentBi: null, twinOf: null, sidecar: true,
      note: 'bare-string toolUseResult — the recorded failure-text form (SPEC §3)',
    });
  }

  // Twin pairing, positional and disclosed.
  const blockImages = blocks.filter((b) => b.kind === 'image' && !b.sidecar);
  const sidecarImages = blocks.filter((b) => b.kind === 'image' && b.sidecar);
  const n = Math.min(blockImages.length, sidecarImages.length);
  for (let k = 0; k < n; k++) {
    sidecarImages[k].twinOf = blockImages[k].bi;
    blockImages[k].twin = sidecarImages[k].bi;
  }
  return blocks;
}

/** Find one block by its dotted bi (null bi = the single unindexed body). */
export function findBlock(blocks, bi) {
  if (bi === null || bi === undefined) return blocks.find((b) => b.bi === null) ?? blocks[0] ?? null;
  return blocks.find((b) => b.bi === String(bi)) ?? null;
}

/** `[` / `]` siblings — blocks of the same event, in enumeration order. */
export function siblingBlocks(blocks, bi) {
  const idx = blocks.findIndex((b) => (bi === null || bi === undefined ? b.bi === null : b.bi === String(bi)));
  if (idx === -1) return { prev: null, next: null, index: -1, total: blocks.length };
  return {
    prev: idx > 0 ? blocks[idx - 1] : null,
    next: idx < blocks.length - 1 ? blocks[idx + 1] : null,
    index: idx,
    total: blocks.length,
  };
}

/* =================================================== spill references == */

const RE_PERSISTED = /<persisted-output>\s*([^<\n]+?)\s*<\/persisted-output>/g;
const RE_PERSISTED_LOOSE = /<persisted-output>[\s\S]*?(?:saved to|path:)?\s*((?:[A-Za-z]:[\\/]|\/)[^\s<"]+)/g;
const RE_BINARY = /\[Binary content \(([^,)]+),\s*([^)]*)\) also saved to ((?:[A-Za-z]:[\\/]|\/)[^\]]+)\]/g;

/**
 * The three RECORDED spill-reference forms (SPEC §8). Pure; returns the
 * recorded absolute paths and which form named them. Link resolution is
 * exact-match and belongs to the server — we never derive a rel from a path.
 */
export function extractSpillRefs(text, toolUseResult) {
  const out = [];
  const seen = new Set();
  const push = (path, form, extra) => {
    const p = String(path ?? '').trim();
    if (!p) return;
    const key = `${form} ${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, form, ...(extra || {}) });
  };

  if (typeof text === 'string' && text) {
    RE_PERSISTED.lastIndex = 0;
    for (let m; (m = RE_PERSISTED.exec(text));) push(m[1], 'persisted-output banner');
    if (!out.length) {
      RE_PERSISTED_LOOSE.lastIndex = 0;
      for (let m; (m = RE_PERSISTED_LOOSE.exec(text));) push(m[1], 'persisted-output banner');
    }
    RE_BINARY.lastIndex = 0;
    for (let m; (m = RE_BINARY.exec(text));) push(m[3], 'binary-content note', { mime: m[1], size: m[2] });
  }

  if (toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)) {
    if (toolUseResult.persistedOutputPath) push(toolUseResult.persistedOutputPath, 'toolUseResult.persistedOutputPath');
  }
  return out;
}

/* ============================================== recorded base64 spans == */

/**
 * Which key held an image block's base64 payload, and what the parsed node
 * still carries under it. `toolUseResult.file.base64` is the one shape that
 * keys its payload `base64`; every other image path keys it `data` (SPEC §8).
 * Returns null when the block records no base64-bearing key at all.
 */
export function recordedB64(node) {
  if (node && node.file && typeof node.file === 'object' && typeof node.file.base64 === 'string') {
    return { key: 'base64', value: node.file.base64 };
  }
  if (node && node.source && typeof node.source.data === 'string') {
    return { key: 'data', value: node.source.data };
  }
  return null;
}

/**
 * Blocks in the order the LINE serialized them. enumerateBlocks emits
 * message.content before toolUseResult; a line whose recorded top-level key
 * order is the other way round serialized its sidecar first, and
 * stripHeavy scans the raw text left to right. Object.keys on the parsed
 * event preserves the recorded key order, so this is read, not assumed.
 */
function serialOrder(blocks, event) {
  const keys = Object.keys(event ?? {});
  const mi = keys.indexOf('message');
  const ti = keys.indexOf('toolUseResult');
  if (ti === -1 || (mi !== -1 && mi < ti)) return blocks;
  return blocks.filter((b) => b.sidecar).concat(blocks.filter((b) => !b.sidecar));
}

/**
 * Attribute one of the line's stripped base64 spans (SPEC §1) to one image
 * block, so the block can print the length the reader actually measured
 * instead of claiming none was recorded.
 *
 * Same rule as server/parse.mjs `imageBlobsByBi`, and deliberately conservative:
 * BY KEY first (the sidecar's `base64` never consumes a content block's `data`
 * blob), then by order within that key group, and ONLY when the group's block
 * count equals its blob count. A mismatch returns null and the caller says what
 * is true rather than picking a blob.
 */
export function attributeBlob(block, blocks, event, blobs) {
  const rec = recordedB64(block?.node);
  if (!rec || rec.value.length > 0) return null;
  const group = (Array.isArray(blobs) ? blobs : []).filter((b) => b && b.kind === 'base64' && b.key === rec.key);
  if (!group.length) return null;
  const peers = serialOrder(Array.isArray(blocks) ? blocks : [], event).filter((b) => {
    if (b.kind !== 'image') return false;
    const r = recordedB64(b.node);
    return r !== null && r.key === rec.key && r.value.length === 0;
  });
  if (peers.length !== group.length) return null;
  const k = peers.indexOf(block);
  return k === -1 ? null : group[k];
}
