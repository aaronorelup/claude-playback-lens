// server/api/index.mjs — createApi: wires the cross-route memos and registers
// every route module on the router. The route modules own their handlers;
// this file owns only what must be SHARED for their answers to agree.
//
// createApi(router, ctx) registers every route on a router from http.mjs. All
// group A/B/C modules arrive through ctx (wired by lens.mjs; stubbed by
// tests):
//
// ctx = {
//   appName, appVersion,
//   projectsDir,                    // absolute
//   webDir, sharedDir,
//   pricing,   // shared/pricing.mjs   (group A): PRICING_VERSION, TCU_PER_USD,
//              //   RATES, modelKey, resolveRate, priceRow, formatUsd
//   ledger,    // server/ledger.mjs    (group A): resolveCanonical, aggregate, addCostAgg
//   jsonl,     // server/jsonl.mjs     (group B): stripHeavy, readLineAt, readLineRange
//   config,    // server/config.mjs    (group C): loadConfig, saveConfig, validateDir
//   index: {
//     version(),        // monotonic int, bumped on any index mutation (not persisted)
//     status(),         // { state:'building'|'ready', sessionsDone, sessionsTotal,
//                       //   bytesIndexed, bytesTotal }
//     workerAlive(),    // false -> 503 on index-backed routes
//     fileTable(),      // Map<relFromProjectsDir(POSIX), {size, mtimeMs}>
//     projects(),       // [{ slug, label?, sessionIds, memoryFiles, bytes }]
//     sessions(),       // [{ id, slug, mainRel|null, files:[rel], bytes }]
//     cards(),          // Map<`${slug}/${id}`, SessionCard>
//     detail(slug,id),  // async SessionDetail | null; throws PendingError while unindexed
//     rows(slug,id),    // async BilledRow[] (tokens only); throws PendingError
//     agentRows(slug,id,agentId,{from,count}), // async {agentId, rows, total, ...}
//     turnBars?(),      // [{slug,id,idx,at,endedAt}]
//     pending(),        // [{slug,id}]
//     reindex(),        // forced, ignores fingerprints
//     watchProgress?(slug,id,cb), // optional push source for /api/progress
//   },
// }

import { makeMemo } from './costs.mjs';
import { pendingTo409 } from './session-lookup.mjs';
import { makeIndexView } from './index-view.mjs';
import { registerStoreRoutes } from './routes-store.mjs';
import { registerSessionRoutes } from './routes-session.mjs';
import { registerWorkflowRoutes } from './routes-workflow.mjs';
import { registerProjectRoutes } from './routes-project.mjs';
import { registerContentRoutes } from './routes-content.mjs';
import { registerFindRoutes } from './routes-find.mjs';
import { registerAuditRoutes } from './routes-audit.mjs';
import { registerConfigRoutes } from './routes-config.mjs';

export function createApi(router, ctx) {
  // Cross-route memos, all keyed on the index version: the R2 canonical map
  // and the duplicate-holder map must be THE SAME object for every route, or
  // /api/index and /api/session could badge one session differently.
  const canonMemo = makeMemo();
  const dupMemo = makeMemo();
  // Per-process boot id: `since` is only honoured for THIS process's version
  // counter — a client polling since=V across a restart must get the full
  // payload, never a spurious 204 when the new counter passes through V.
  const BOOT = `${Date.now().toString(36)}-${process.pid.toString(36)}`;

  const { buildIndexView, projectSlice } = makeIndexView(ctx, { canonMemo, boot: BOOT });

  // Route registrars: every handler converts a PendingError into the 409
  // not-indexed-yet envelope at this one seam.
  const G = (route, handler) => router.add('GET', route, async (req, res, x) => {
    try { await handler(req, res, x); } catch (e) { throw pendingTo409(e); }
  });
  const P = (route, handler) => router.add('POST', route, async (req, res, x) => {
    try { await handler(req, res, x); } catch (e) { throw pendingTo409(e); }
  });
  const PUT = (route, handler) => router.add('PUT', route, async (req, res, x) => {
    try { await handler(req, res, x); } catch (e) { throw pendingTo409(e); }
  });

  const route = { G, P, PUT };
  const shared = { canonMemo, dupMemo, boot: BOOT, buildIndexView, projectSlice };

  registerStoreRoutes(route, ctx, shared);
  registerProjectRoutes(route, ctx, shared);
  registerSessionRoutes(route, ctx, shared);
  registerWorkflowRoutes(route, ctx, shared);
  registerContentRoutes(route, ctx, shared);
  registerFindRoutes(route, ctx, shared);
  registerAuditRoutes(route, ctx, shared);
  registerConfigRoutes(route, ctx, shared);

  return router;
}
