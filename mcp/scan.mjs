// mcp/scan.mjs — run the lens's own corpus scan (runFind) for tools that list
// events rather than search them (lens_prompts, lens_file).
//
// lens_search keeps its own long-form gate (it owns the cursor and regex
// guards and their reasons). This is the same sequence, short: index gate,
// the lens's scope parser and 404-before-scan resolver, then runFind with the
// scan cap stated back to the caller.

export async function scanEvents(deps, opts) {
  const { ctx, lens } = deps;
  if (!ctx || !ctx.index) return { error: 'the index layer is not wired — this server cannot read the corpus.' };
  if (typeof ctx.index.workerAlive === 'function' && !ctx.index.workerAlive()) {
    return { error: 'the indexer worker is not running. Call lens_status for the indexer state.' };
  }
  let parsed;
  try { parsed = lens.api.parseScope(opts.scope || 'store'); }
  catch (e) { return { error: `${(e && e.message) || 'unparseable scope'} — scope is store | project:<slug> | session:<slug>/<id>` }; }
  let scoped;
  try { scoped = lens.lookup.scopeSessionList(ctx, parsed); }
  catch (e) {
    if (e && e.name === 'HttpError' && e.status === 409) return { pending: true };
    return { error: `${e && e.status ? `${e.status} ${e.code} — ` : ''}${(e && e.message) || e}. lens_sessions lists valid slugs and ids.` };
  }

  const matches = [];
  let progress = null;
  let done = null;
  let errorEv = null;
  const cap = opts.cap ?? lens.limits.FIND_MATCH_CAP;
  const t0 = Date.now();
  try {
    await lens.find.runFind({
      projectsDir: ctx.projectsDir,
      sessions: ctx.index.sessions(),
      fileTable: ctx.index.fileTable(),
      scope: parsed,
      cap,
      ...opts.find,
      emit: (ev, data) => {
        if (ev === 'match') matches.push(data);
        else if (ev === 'progress') progress = data;
        else if (ev === 'done') done = data;
        else if (ev === 'error') errorEv = data;
      },
    });
  } catch (e) {
    if (e && e.name === 'PendingError') return { pending: true };
    return { error: `the scan failed: ${(e && e.message) || e}` };
  }
  if (errorEv) return { error: `${errorEv.code}: ${errorEv.message}` };
  return {
    matches,
    scopeStr: lens.api.scopeString(parsed),
    scopedCount: Array.isArray(scoped) ? scoped.length : null,
    progress,
    capped: !!(done && done.capped),
    cap,
    elapsedMs: Date.now() - t0,
  };
}

/** "scanned N of M sessions · X of Y in Ts" — the coverage every listing states. */
export function coverageLine(render, r) {
  const p = r.progress;
  const sess = p ? `${p.sessionsDone} of ${p.of} sessions` : `${render.UNKNOWN} of ${r.scopedCount ?? render.UNKNOWN} sessions`;
  const bytes = p ? `${render.fmtBytes(p.bytesDone)} of ${render.fmtBytes(p.ofBytes)}` : render.UNKNOWN;
  const cap = r.capped
    ? ` — HIT the ${r.cap}-event cap; the scan runs newest-first, so OLDER events were not reached (narrow since/until or scope)`
    : '';
  return `scanned ${sess} · ${bytes} in ${(r.elapsedMs / 1000).toFixed(1)}s${cap}`;
}

/** The recorded title of a session, from its card. */
export function titleOf(ctx, id) {
  const c = ctx.index.cards().get(id);
  return c ? (c.customTitle || c.aiTitle || c.title || null) : null;
}
