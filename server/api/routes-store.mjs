// server/api/routes-store.mjs — store-level routes: /api/hello, /api/index,
// /api/progress, /api/reindex, /api/pricing. The routes that must answer (or
// degrade honestly) even while the indexer is down.

import { httpError } from '../errors.mjs';
import { sendJson, sendNoContent, sseOpen } from '../http.mjs';
import { SSE_HEARTBEAT_MS, PROGRESS_POLL_MS } from '../limits.mjs';
import { intParam, strParam } from './params.mjs';
import { requireIndex, requireIndexLayer, findSession } from './session-lookup.mjs';

export function registerStoreRoutes({ G, P }, ctx, { boot, buildIndexView }) {
  // ---------- hello (port probe / focus)
  G('/api/hello', (_req, res) => {
    sendJson(res, 200, { app: ctx.appName, version: ctx.appVersion, pid: process.pid });
  });

  // ---------- index
  G('/api/index', async (_req, res, { query }) => {
    requireIndexLayer(ctx); // answers degraded while the worker is down
    const version = ctx.index.version();
    const since = intParam(query, 'since', { def: null });
    const sinceBoot = strParam(query, 'boot');
    // 204 only for an exact current match FROM THIS PROCESS (boot id): a
    // stale `since` (previous server run, possibly higher) gets the full
    // payload, never a spurious 204.
    if (since !== null && since === version && sinceBoot === boot) { sendNoContent(res); return; }

    const view = await buildIndexView(version);
    sendJson(res, 200, view);
  });

  // ---------- SSE: parse progress
  G('/api/progress/:slug/:id', async (_req, res, { params }) => {
    requireIndex(ctx);
    // Open the stream FIRST: a not-yet-indexed session must arrive as a
    // `pending` EVENT, not a 409 body that EventSource reads as a fatal
    // transport error. An unknown session is still a pre-stream 404.
    let pendingInfo = null;
    try {
      findSession(ctx, params.slug, params.id);
    } catch (e) {
      if (e && e.status === 409) pendingInfo = e.detail ?? {};
      else throw e;
    }
    const stream = sseOpen(res, { heartbeatMs: ctx.heartbeatMs ?? SSE_HEARTBEAT_MS });
    if (pendingInfo) stream.event('pending', pendingInfo);
    let stopped = false;
    stream.onClientClose(() => { stopped = true; });
    if (ctx.index.watchProgress) {
      await new Promise((resolve) => {
        const off = ctx.index.watchProgress(params.slug, params.id, (ev) => {
          if (stopped) { off?.(); resolve(); return; }
          stream.event(ev.done ? 'done' : 'progress', ev);
          if (ev.done) { off?.(); resolve(); }
        });
      });
    } else {
      // poll fallback: report index-level bytes until the session's card
      // lands. BOUNDED: when the index reaches ready (or failed) WITHOUT this
      // session's card, the session did not index — say so and stop, never
      // emit 2 events/s forever.
      const t0 = Date.now();
      while (!stopped) {
        const st = ctx.index.status();
        stream.event('progress', {
          sessionsDone: st.sessionsDone, of: st.sessionsTotal,
          bytesDone: st.bytesIndexed, ofBytes: st.bytesTotal, elapsedMs: Date.now() - t0,
        });
        if (ctx.index.cards().has(params.id)) { stream.event('done', {}); break; } // cards keyed by bare id (SPEC §2)
        if (st.state !== 'building') {
          stream.event('error', {
            code: 'session-not-indexed',
            message: `index is ${st.state} but session ${params.id} has no card — it may have failed to parse (see problems)`,
          });
          break;
        }
        await new Promise((r) => setTimeout(r, PROGRESS_POLL_MS));
      }
    }
    stream.close();
  });

  // ---------- pricing / reindex
  G('/api/pricing', (_req, res) => {
    if (!ctx.pricing) throw httpError(503, 'indexer-down', 'pricing module is not wired');
    sendJson(res, 200, {
      version: ctx.pricing.PRICING_VERSION,
      tcuPerUsd: ctx.pricing.TCU_PER_USD,
      rates: ctx.pricing.RATES,
      problems: [],
    });
  });

  P('/api/reindex', async (_req, res) => {
    requireIndexLayer(ctx); // the escape hatch must work while the worker is down
    await ctx.index.reindex();
    sendJson(res, 200, { ok: true, workerAlive: ctx.index.workerAlive(), problems: [] });
  });
}
