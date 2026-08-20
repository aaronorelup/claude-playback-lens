// web/js/views/l5/page.mjs — the L5 page itself: resolve the agent's
// transcript rel, fetch /api/line, address the block, and lay out the
// rendered block, cross-references, spill links and the raw-JSON section.
// Route registration for /p/:slug/s/:sid/a/:agentId/e lives here.

import { kit, apiUrl } from '../../lib/net.mjs';
import { h, a, unknown, section, kindChip, copyButton } from '../../lib/dom.mjs';
import { fmtInt, fmtLocalTime, tzLabel, toMs, shortId } from '../../lib/fmt.mjs';
import { routes } from '../../lib/links.mjs';
import { parseLocator, formatLocator, copyLocator } from '../../lib/locator.mjs';
import { enumerateBlocks, findBlock, siblingBlocks, eventKind, extractSpillRefs } from '../../lib/blocks.mjs';
import {
  page, errorCard, pendingCard, statHeader, mountCrumbs, handle404,
  registerSiblings, siblingPager,
} from '../../lib/chrome.mjs';
import { rawJson, safeStringify } from '../../lib/text.mjs';
import { blockHeading, renderBlock, renderEventLevel, peek } from './blockview.mjs';

const _relCache = new Map();      // `${slug}/${sid}/${agentId}` -> {rel, payload}

/**
 * Resolve an agent's transcript rel path. L5 addresses events by agent +
 * 1-based line; /api/line is keyed by `file`, so the rel comes from the agent
 * payload's locators (SPEC §9: "rows without long text + locators").
 */
export async function resolveAgentFile(slug, sid, agentId, signal) {
  const key = `${slug}/${sid}/${agentId}`;
  if (_relCache.has(key)) return _relCache.get(key);
  const K = await kit();
  // STALE-RENDER RULE: the requesting render owns the fetch. Only a resolved
  // rel is memoised, and this is a VALUE cache, never a promise cache, so an
  // aborted call poisons nothing for the next render.
  const payload = await K.api(`/api/agent/${encodeURIComponent(slug)}/${encodeURIComponent(sid)}/${encodeURIComponent(agentId)}`, { from: 0, count: 1 }, { signal });
  if (payload?.pending) return { pending: payload.pending };
  const rel = payload?.rel ?? payload?.file ?? payload?.agent?.rel ?? payload?.meta?.rel ?? payload?.rows?.[0]?.file ?? null;
  const out = { rel, payload };
  if (rel) _relCache.set(key, out);
  return out;
}

export async function renderEvent(ctx) {
  const { body } = page(ctx, 'lens-l5');
  const P = ctx.params ?? {};
  const slug = P.slug, sid = P.sid ?? P.id, agentId = P.agentId ?? P.agent ?? 'main';
  // The router may hand us the tail whole (`:loc`) or pre-split (`:line`/`:bi`).
  // router.compilePattern expands the trailing `e` into :eventRef and splits it
  // on the FIRST '.' after the line number, handing us params.line/params.bi
  // already (SPEC §8). parseLocator re-validates the block path itself, so a
  // syntactically impossible bi is refused here rather than addressed.
  const locRaw = P.eventRefRaw ?? P.eventRef ?? P.loc
    ?? (P.line !== null && P.line !== undefined ? formatLocator(P.line, P.bi ?? null) : null);
  const loc = parseLocator(locRaw);

  mountCrumbs(ctx, [
    { label: 'store', href: routes.store() },
    { label: slug ?? 'project', href: routes.project(slug) },
    { label: `session ${shortId(sid)}`, sub: sid, href: routes.session(slug, sid) },
    { label: agentId === 'main' ? 'main thread' : `agent ${shortId(agentId)}`, sub: agentId === 'main' ? '' : agentId, href: routes.agent(slug, sid, agentId) },
    { label: loc ? `line ${fmtInt(loc.line)}${loc.bi ? ` · block ${loc.bi}` : ''}` : 'event' },
  ]);

  if (!loc) {
    body.appendChild(errorCard({
      status: 400, code: 'bad-locator',
      message: `"${locRaw ?? ''}" is not a valid event address. The grammar is e/<line>[.<bi>] with a 1-based line and a dotted block path (SPEC §8): <i>, <i>.<j>, r, or r.<j>.`,
    }));
    return;
  }

  // DESIGN §7: chrome first.
  statHeader(ctx, { pending: true });

  const K = await kit();
  if (ctx.stale) return;
  let rel = null;
  try {
    const resolved = await resolveAgentFile(slug, sid, agentId, ctx.signal);
    if (ctx.stale) return;
    if (resolved?.pending) { pendingCard(ctx, resolved.pending, () => renderEvent(ctx)); return; }
    rel = resolved.rel;
  } catch (err) {
    // STALE-RENDER RULE: FIRST statement of the catch, ahead of handle404 — a
    // stale 404 continuation banners AND navigates, yanking the reader off the
    // page they are on. The AbortError from the `signal` above lands here too
    // and returns without painting a card nobody is watching.
    if (ctx.stale) return;
    if (handle404(ctx, err, { slug, sid, thing: `agent ${shortId(agentId)}` })) return;
    body.appendChild(errorCard(err, { retry: () => renderEvent(ctx) }));
    return;
  }
  if (!rel) {
    body.appendChild(errorCard({
      code: 'no-file-locator',
      message: `The agent payload for ${agentId} carries no transcript path, so this line cannot be addressed. /api/line is keyed by (slug, id, file, line) — SPEC §9.`,
    }));
    return;
  }

  let payload;
  try {
    payload = await K.api('/api/line', { slug, id: sid, file: rel, line: loc.line }, { signal: ctx.signal });
  } catch (err) {
    if (ctx.stale) return;   // STALE-RENDER RULE — ahead of handle404
    // DESIGN §0: an unaddressable line inside a real session resolves upward.
    if (handle404(ctx, err, { slug, sid, thing: `line ${loc.line} of ${rel}` })) return;
    body.appendChild(errorCard(err, { retry: () => renderEvent(ctx) }));
    return;
  }
  if (ctx.stale) return;
  if (payload?.pending) { pendingCard(ctx, payload.pending, () => renderEvent(ctx)); return; }

  const event = payload.event ?? payload.value ?? payload.json ?? (typeof payload.raw === 'string' ? tryParse(payload.raw) : payload.raw) ?? null;
  const rawText = typeof payload.raw === 'string' ? payload.raw : safeStringify(event);
  const blocks = enumerateBlocks(event);
  const at = toMs(payload.at ?? event?.timestamp ?? null);

  const block = findBlock(blocks, loc.bi);
  const sib = siblingBlocks(blocks, loc.bi);
  const locators = { slug, sid, rel, line: loc.line };

  ctx.setTitle?.(`${copyLocator(rel, loc.line, loc.bi)} — Claude Playback Lens`);

  // Bands 2+3.
  const kindLabel = block ? block.kind : eventKind(event);
  statHeader(ctx, {
    agg: payload.cost ?? null,
    // An event has no per-event cost BY DESIGN — the generic "no priced
    // requests" wording would misread a billed assistant event as unbilled.
    costUnknownReason: payload.cost ? null : 'cost is not computed per event — it lives at this event\'s turn/agent scope',
    scopeSentence: `One recorded event: line ${fmtInt(loc.line)} of ${rel}` +
      (loc.bi ? `, block ${loc.bi} of ${fmtInt(blocks.length)} addressable block(s) on that line` : `, all ${fmtInt(blocks.length)} of its addressable blocks`) +
      `. The raw JSON below is the whole line exactly as stored${payload.stripped || payload.blobs ? ', with base64 and thinking-signature spans replaced by the reader (SPEC §1)' : ''}.`,
    // One event has no span — it has an instant. The statbar's span cell says
    // so rather than showing a zero-length bar.
    span: { label: 'span', ms: null, reason: 'a single event records one timestamp, not two — its recorded instant is printed below' },
    at,
    counts: [{ key: 'blocks', label: 'addressable blocks', value: blocks.length }],
  });

  // Locator strip + siblings.
  const locStr = copyLocator(rel, loc.line, loc.bi);
  const prevHref = sib.prev ? routes.event(slug, sid, agentId, loc.line, sib.prev.bi) : null;
  const nextHref = sib.next ? routes.event(slug, sid, agentId, loc.line, sib.next.bi) : null;
  registerSiblings(ctx, { prev: prevHref, next: nextHref, label: 'block' });
  // DESIGN §5: `\` opens the raw view of the file this event lives in.
  ctx.registerRaw?.(routes.sessionFile(slug, sid, rel));
  ctx.registerScope?.(`agent:${slug}/${sid}/${agentId}`);
  body.appendChild(h('div', { class: 'lens-l5__locbar' },
    kindChip(kindLabel),
    h('code', { class: 'lens-locator', text: locStr }),
    copyButton(locStr, 'copy locator'),
    at === null
      ? unknown('this event type records no timestamp (SPEC §3)')
      : h('span', { class: 'lens-l5__at', text: `${fmtLocalTime(at)} ${tzLabel(at)}` }),
    a(apiUrl('/api/file', { slug, id: sid, rel }), 'raw file', { class: 'lens-link', target: '_blank', rel: 'noreferrer' }),
    a(routes.sessionFile(slug, sid, rel), 'raw view'),
    siblingPager(prevHref, nextHref, {
      prevLabel: 'prev block', nextLabel: 'next block',
      endReason: sib.index === -1 ? 'this block address is not present on this line' : 'no further block on this line — siblings are the blocks of this event (DESIGN §5)',
    })));

  if (loc.bi && !block) {
    body.appendChild(errorCard({
      code: 'block-not-present',
      message: `Line ${loc.line} records ${blocks.length} addressable block(s); ${loc.bi} is not one of them. Addressable here: ${blocks.map((b) => b.bi ?? '(no index)').join(', ') || 'none'}.`,
    }));
  }

  // Rendered block (top).
  const rendered = section(block ? `rendered · ${blockHeading(block)}` : 'rendered event');
  if (block) {
    if (block.twinOf) {
      rendered.appendChild(h('p', {
        class: 'lens-note',
        text: `This is the toolUseResult sidecar copy. The same image is also recorded as block ${block.twinOf} on this line — recorded twice, rendered once (SPEC §8).`,
      }));
      rendered.appendChild(a(routes.event(slug, sid, agentId, loc.line, block.twinOf), `open the block copy (${block.twinOf})`));
    } else if (block.twin) {
      rendered.appendChild(h('p', {
        class: 'lens-note',
        text: `Also recorded as the toolUseResult sidecar at block ${block.twin} on this line — recorded twice, rendered once here (SPEC §8).`,
      }));
    }
    rendered.appendChild(renderBlock(block, event, locators, { blocks, blobs: payload.blobs }));
  } else if (!loc.bi && blocks.length > 1) {
    rendered.appendChild(h('p', { class: 'lens-note', text: 'No block addressed — every addressable block of this line is listed below.' }));
    for (const b of blocks) {
      rendered.appendChild(h('div', { class: 'lens-l5__blockrow' },
        kindChip(b.kind),
        a(routes.event(slug, sid, agentId, loc.line, b.bi), b.bi === null ? '(no block index)' : b.bi),
        h('span', { class: 'lens-l5__peek', text: peek(b) })));
    }
  } else if (!blocks.length) {
    rendered.appendChild(renderEventLevel(event));
  } else {
    rendered.appendChild(renderBlock(blocks[0], event, locators, { blocks, blobs: payload.blobs }));
  }
  body.appendChild(rendered);

  // Cross-links: tool_use ↔ tool_result.
  const cross = crossLinks(payload, block, event, { slug, sid, agentId });
  if (cross) body.appendChild(cross);

  // Spill links (SPEC §8, three recorded forms).
  const spillText = typeof block?.node === 'string' ? block.node
    : typeof block?.node?.content === 'string' ? block.node.content
      : typeof block?.node?.text === 'string' ? block.node.text : '';
  const spills = extractSpillRefs(spillText, event?.toolUseResult).concat(payload.spills ?? []);
  if (spills.length) {
    const box = section(`persisted output — ${fmtInt(spills.length)} recorded reference(s)`);
    for (const sp of spills) {
      const row = h('div', { class: 'lens-spill' },
        h('span', { class: 'lens-spill__form', text: sp.form ?? 'recorded reference' }),
        h('code', { class: 'lens-spill__path', text: sp.path }));
      if (sp.rel) row.appendChild(a(routes.sessionFile(slug, sid, sp.rel), 'open spill file'));
      else row.appendChild(h('span', {
        class: 'lens-note',
        text: 'the recorded reference is an absolute path; this payload carries no session-relative match, so no link is fabricated (SPEC §8: exact-match only)',
      }));
      box.appendChild(row);
    }
    body.appendChild(box);
  }

  // Raw JSON below, addressed block highlighted.
  const rawSec = section('raw event JSON');
  rawSec.appendChild(h('p', { class: 'lens-note', text: `line ${fmtInt(loc.line)} of ${rel}, 1-based as an editor shows it${loc.bi ? ` · highlighting block ${loc.bi}` : ''}` }));
  const rawHost = h('div', { class: 'lens-l5__raw' });
  rawSec.appendChild(rawHost);
  body.appendChild(rawSec);
  await rawJson(rawHost, event ?? rawText, loc.bi);
  if (payload.blobs?.length) {
    rawSec.appendChild(h('p', {
      class: 'lens-note',
      text: `${fmtInt(payload.blobs.length)} heavy span(s) replaced by the reader before parsing: ` +
        payload.blobs.map((b) => `${b.kind} ${fmtInt(b.length)} chars`).join(', ') + ' (SPEC §1).',
    }));
  }
}

function tryParse(text) { try { return JSON.parse(text); } catch { return null; } }

/** tool_use ↔ tool_result cross-links; server-supplied links preferred, never invented. */
function crossLinks(payload, block, event, { slug, sid, agentId }) {
  const links = payload.links ?? payload.crossLinks ?? null;
  const box = section('cross-references');
  let any = false;

  const addLink = (label, l) => {
    if (!l || l.line === undefined) return;
    any = true;
    box.appendChild(h('div', { class: 'lens-xref' },
      h('span', { class: 'lens-xref__label', text: label }),
      a(routes.event(slug, sid, l.agentId ?? agentId, l.line, l.bi ?? null), copyLocator(l.file ?? l.rel ?? '', l.line, l.bi ?? null))));
  };
  addLink('tool_use', links?.toolUse);
  addLink('tool_result', links?.toolResult);

  const id = block?.node?.id ?? block?.node?.tool_use_id ?? null;
  if (id) {
    any = true;
    const which = block.kind === 'tool_use' ? 'its tool_result' : 'its tool_use';
    box.appendChild(h('div', { class: 'lens-xref' },
      h('span', { class: 'lens-xref__label', text: `tool id` }),
      h('code', { text: id }),
      links?.toolUse || links?.toolResult ? null : h('span', { class: 'lens-note', text: `this payload records no resolved locator for ${which} — search the session for the id rather than guess one:` }),
      a(routes.find({ q: id, scope: `session:${slug}/${sid}` }), 'find this id in the session')));
  }
  const uuid = event?.uuid;
  if (uuid) {
    any = true;
    box.appendChild(h('div', { class: 'lens-xref' },
      h('span', { class: 'lens-xref__label', text: 'uuid' }), h('code', { text: uuid })));
  }
  const parentUuid = event?.parentUuid;
  if (parentUuid) {
    box.appendChild(h('div', { class: 'lens-xref' },
      h('span', { class: 'lens-xref__label', text: 'parentUuid' }), h('code', { text: parentUuid }),
      a(routes.find({ q: parentUuid, scope: `session:${slug}/${sid}` }), 'find the parent event')));
  }
  return any ? box : null;
}

/* ---------------------------------------------------------------- routes */

export const routeList = [['/p/:slug/s/:sid/a/:agentId/e', renderEvent]];

export function register(defineRoute) {
  for (const [pattern, render] of routeList) defineRoute(pattern, render);
}
