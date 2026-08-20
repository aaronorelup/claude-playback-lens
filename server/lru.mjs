// server/lru.mjs — the parsed-session LRU (SPEC §9).
//
// The key is `${slug}/${id}@${fingerprint}`. That trailing fingerprint is the
// whole invalidation strategy: when a session's files change its fingerprint
// changes, the old key is simply never asked for again, and the stale entry
// ages out on its own. There is no invalidate() to forget to call.
//
// Two budgets, either of which can bind (limits.mjs: LRU_MAX_ENTRIES /
// LRU_MAX_BYTES). The byte figure is an ESTIMATE from the size proxy in
// SPEC §9 — not measured heap — so it is deliberately conservative rather
// than clever.

import { LRU_MAX_ENTRIES, LRU_MAX_BYTES } from './limits.mjs';

/**
 * SPEC §9 size proxy:
 *   sizeBytes = Σ(row.head.length) × 2 + rows × 120 + offsetTableBytes
 *
 * Walks the row containers a parsed session actually has (main + agents) and
 * counts any retained offset tables. Returns at least 1 so that an entry never
 * looks free.
 */
export function defaultSizeOf(value) {
  if (!value || typeof value !== 'object') return 1;
  if (Number.isFinite(value.sizeBytes) && value.sizeBytes > 0) return Math.ceil(value.sizeBytes);

  let heads = 0;
  let rows = 0;

  const countRows = (arr) => {
    if (!Array.isArray(arr)) return;
    rows += arr.length;
    for (const r of arr) {
      const h = r && typeof r.head === 'string' ? r.head.length : 0;
      heads += h;
    }
  };

  countRows(value.rows);
  if (value.main) countRows(value.main.rows);
  if (Array.isArray(value.agents)) for (const a of value.agents) countRows(a && a.rows);
  if (Array.isArray(value.journalOnly)) countRows(value.journalOnly);

  let offsetTableBytes = 0;
  if (Number.isFinite(value.offsetTableBytes)) {
    offsetTableBytes = value.offsetTableBytes;
  } else if (value.offsetTables) {
    const tables = value.offsetTables instanceof Map ? value.offsetTables.values() : Object.values(value.offsetTables);
    for (const t of tables) offsetTableBytes += offsetBytesOf(t);
  }

  return Math.max(1, Math.ceil(heads * 2 + rows * 120 + offsetTableBytes));
}

function offsetBytesOf(t) {
  if (!t) return 0;
  const table = t.offsets ?? t;
  if (ArrayBuffer.isView(table)) return table.byteLength;
  if (Array.isArray(table)) return table.length * 8;
  if (Number.isFinite(t.bytes)) return t.bytes;
  return 0;
}

/**
 * @param {{maxEntries?:number, maxBytes?:number, sizeOf?:(value:any,key:string)=>number,
 *          onEvict?:(key:string, value:any, reason:string)=>void}} [opts]
 */
export function createLru(opts = {}) {
  const { maxEntries = LRU_MAX_ENTRIES, maxBytes = LRU_MAX_BYTES, sizeOf = defaultSizeOf, onEvict = null } = opts;

  // A Map iterates in insertion order, so delete+set is the recency bump and
  // the first key is always the least-recently-used one.
  const map = new Map();
  let bytes = 0;
  const stats = { hits: 0, misses: 0, sets: 0, evictions: 0, evictedByEntries: 0, evictedByBytes: 0 };

  function fire(key, entry, reason) {
    stats.evictions += 1;
    if (reason === 'entries') stats.evictedByEntries += 1;
    else if (reason === 'bytes') stats.evictedByBytes += 1;
    if (typeof onEvict === 'function') {
      try {
        onEvict(key, entry.value, reason);
      } catch { /* eviction must not throw into the caller */ }
    }
  }

  function evictOldest(reason) {
    const oldest = map.keys().next();
    if (oldest.done) return false;
    const key = oldest.value;
    const entry = map.get(key);
    map.delete(key);
    bytes -= entry.bytes;
    fire(key, entry, reason);
    return true;
  }

  function trim() {
    // Both limits can bind. Never evict the entry we just inserted: an lru whose
    // set() is immediately followed by an undefined get() is worse than one that
    // overshoots its byte estimate by one oversized session.
    while (map.size > maxEntries && map.size > 1) {
      if (!evictOldest('entries')) break;
    }
    while (bytes > maxBytes && map.size > 1) {
      if (!evictOldest('bytes')) break;
    }
    if (map.size > maxEntries && map.size === 1) {
      // maxEntries < 1 — degenerate config; honour it.
      if (maxEntries < 1) evictOldest('entries');
    }
  }

  return {
    /** `${slug}/${id}@${fingerprint}` */
    key(slug, id, fingerprint) {
      return `${slug}/${id}@${fingerprint}`;
    },

    get(key) {
      const entry = map.get(key);
      if (!entry) {
        stats.misses += 1;
        return undefined;
      }
      stats.hits += 1;
      map.delete(key);
      map.set(key, entry); // most recently used
      entry.hits += 1;
      return entry.value;
    },

    /** Peek without changing recency (for diagnostics / tests). */
    peek(key) {
      const entry = map.get(key);
      return entry ? entry.value : undefined;
    },

    has(key) {
      return map.has(key);
    },

    /**
     * @param {string} key
     * @param {*} value
     * @param {{bytes?:number}} [entryOpts] explicit size, bypassing sizeOf
     */
    set(key, value, entryOpts = {}) {
      if (typeof key !== 'string' || !key) return false;
      const existing = map.get(key);
      if (existing) {
        bytes -= existing.bytes;
        map.delete(key);
      }
      let size = Number.isFinite(entryOpts.bytes) ? entryOpts.bytes : null;
      if (size === null) {
        try {
          size = sizeOf(value, key);
        } catch {
          size = 1;
        }
      }
      if (!Number.isFinite(size) || size < 1) size = 1;
      const entry = { value, bytes: Math.ceil(size), hits: 0, at: Date.now() };
      map.set(key, entry);
      bytes += entry.bytes;
      stats.sets += 1;
      trim();
      return true;
    },

    delete(key) {
      const entry = map.get(key);
      if (!entry) return false;
      map.delete(key);
      bytes -= entry.bytes;
      return true;
    },

    clear() {
      map.clear();
      bytes = 0;
    },

    /** Keys, least-recently-used first. */
    keys() {
      return Array.from(map.keys());
    },

    get size() {
      return map.size;
    },
    get bytes() {
      return bytes;
    },
    get limits() {
      return { maxEntries, maxBytes };
    },
    get stats() {
      return { ...stats, size: map.size, bytes };
    },
  };
}
