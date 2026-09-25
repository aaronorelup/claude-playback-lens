// mcp/tools/pricing.mjs — lens_pricing: see and repair the rate table.
//
// The one tool on this server that writes. What it writes is the user's own
// rate file (server/user-pricing.mjs), never a transcript and never the shipped
// table. It exists so a model released after the table was cut can be priced
// the same hour — by an agent that reads the published price and cites it —
// instead of silently vanishing from every dollar figure until a release.

import { z } from 'zod';
import { unratedModels } from '../pricing-gap.mjs';

const DESCRIPTION = 'Show and repair the price table the lens uses for $ figures. action "list" (default) shows which recorded models have NO rate — their spend is excluded from every dollar total — plus every user-added rate and its source. action "set" adds or replaces a model\'s rate: look the price up on the official Anthropic pricing page first and pass that page as source_url; never guess a price. action "remove" deletes a user-added rate. Rates are stored per user (~/.claude/playback-lens/pricing.json) and take effect for every session immediately.';

const U_PER_USD = 2000;
const usd = (u) => `$${(u / U_PER_USD).toFixed(2).replace(/\.00$/, '')}`;

export function register(server, deps) {
  const { ctx, lens, render, userPricing } = deps;

  server.registerTool(
    'lens_pricing',
    {
      title: 'Price table',
      description: DESCRIPTION,
      inputSchema: z.object({
        action: z.enum(['list', 'set', 'remove']).default('list'),
        model: z.string().optional()
          .describe('Model id as recorded, e.g. "claude-fable-5-1" or "fable-5-1". Required for set/remove.'),
        input_usd_per_mtok: z.number().positive().optional()
          .describe('Base input price, USD per million tokens (whole cents). Cache reads (x0.1) and writes (x1.25 / x2) derive from it.'),
        output_usd_per_mtok: z.number().positive().optional()
          .describe('Output price, USD per million tokens.'),
        cache_read_usd_per_mtok: z.number().positive().optional()
          .describe('Cache hit price, USD per million tokens — pass it whenever the pricing page lists one that is not exactly 10% of input (e.g. Fable 5.1: $0.25). Omitted = 0.1 x input.'),
        source_url: z.string().optional()
          .describe('URL of the published pricing page the numbers were read from. Required for set.'),
        effective_from: z.string().optional()
          .describe('YYYY-MM-DD. Only for a price CHANGE to a model that already has a user rate: the old price ends the day before.'),
        fast: z.boolean().default(false)
          .describe('Set the fast-mode (speed:"fast") rate instead of the standard one.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (a) => {
      if (!userPricing) return render.errorResult('lens_pricing: this process holds no rate table.');
      const pricing = lens.pricing;
      const lines = [];

      if (a.action === 'set') {
        if (!a.model || a.input_usd_per_mtok == null || a.output_usd_per_mtok == null || !a.source_url) {
          return render.errorResult('lens_pricing set needs model, input_usd_per_mtok, output_usd_per_mtok and source_url (the page you read the price from).');
        }
        try {
          const r = await userPricing.set({
            model: a.model,
            inputUsdPerMtok: a.input_usd_per_mtok,
            outputUsdPerMtok: a.output_usd_per_mtok,
            cacheReadUsdPerMtok: a.cache_read_usd_per_mtok ?? null,
            source: a.source_url,
            from: a.effective_from ?? null,
            fast: a.fast,
          });
          if (typeof deps.onPricingChanged === 'function') deps.onPricingChanged();
          lines.push(`set ${r.key}: input ${usd(Math.round(a.input_usd_per_mtok * U_PER_USD))}/Mtok, output ${usd(Math.round(a.output_usd_per_mtok * U_PER_USD))}/Mtok — source ${a.source_url}`);
          lines.push(`saved to ${r.file}. In effect now for every session; re-run the cost query.`);
          lines.push('');
        } catch (e) {
          return render.errorResult(`lens_pricing set refused: ${(e && e.message) || e}`);
        }
      } else if (a.action === 'remove') {
        if (!a.model) return render.errorResult('lens_pricing remove needs model.');
        const r = await userPricing.remove(a.fast ? `${a.model}@fast` : a.model);
        if (typeof deps.onPricingChanged === 'function') deps.onPricingChanged();
        lines.push(r.removed ? `removed user rate for ${r.key}` : `no user rate for ${r.key} — nothing removed (shipped rates cannot be removed)`);
        lines.push('');
      }

      const st = userPricing.state();
      lines.push(`shipped table: ${pricing.PRICING_VERSION} (${Object.keys(pricing.RATES).length} model keys)`);
      lines.push(`user rate file: ${st.file}`);
      if (st.problem) lines.push(`  PROBLEM: ${st.problem} — the previous user rates stay in effect`);
      const user = Object.entries(pricing.USER_RATES);
      if (user.length === 0) lines.push('  (no user-added rates)');
      for (const [key, list] of user) {
        for (const iv of list) {
          const span = iv.from || iv.to ? ` [${iv.from ?? '…'} → ${iv.to ?? '…'}]` : '';
          lines.push(`  ${key}${span}: in ${usd(iv.inputU)} / out ${usd(iv.outputU)}${iv.readU ? ` / cache read ${usd(iv.readU)}` : ''} per Mtok — ${iv.source ?? 'no source'}${iv.retrieved ? ` (read ${iv.retrieved})` : ''}${pricing.RATES[key] ? ' — OVERRIDES shipped' : ''}`);
        }
      }
      lines.push('');
      const gaps = unratedModels(ctx, pricing);
      if (gaps.length === 0) {
        lines.push('every recorded model has a rate.');
      } else {
        lines.push(`${gaps.length} recorded model${gaps.length === 1 ? '' : 's'} with NO rate (their spend is missing from every $ total):`);
        for (const g of gaps) lines.push(`  ${g.model}  → key "${g.key}", in ${g.sessions} session${g.sessions === 1 ? '' : 's'}`);
        lines.push('Fix: read the price from https://platform.claude.com/docs/en/about-claude/pricing, then lens_pricing {action:"set", model, input_usd_per_mtok, output_usd_per_mtok, source_url}.');
      }
      return render.textResult(lines.join('\n'));
    },
  );
}
