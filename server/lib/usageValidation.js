/**
 * Zod schemas for the usage and subscription routes, including billed-instance and fleet-billing settings.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { PROVIDER_FAMILY_IDS } from './provider/providerFamilies.js';
import { MAX_MONTHLY_COST } from './subscriptionSavings.js';
import { MAX_PLAN_TIER_LENGTH } from './subscriptionPlanTiers.js';

// Shape AND calendar validity — the regex alone accepts impossible dates like
// 2026-02-30, which would silently return an empty report instead of a 400.
const isoDay = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, { message: 'Not a valid calendar date' });

/**
 * Query params for GET /api/usage — either a preset period or an explicit
 * from/to date range (inclusive, YYYY-MM-DD). Explicit dates win over period.
 */
export const usageQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d', 'all']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional()
}).refine((q) => !(q.from && q.to) || q.from <= q.to, { message: 'from must be on or before to' });

/** Params for POST /api/usage/tips/:id/dismiss. */
export const usageTipParamsSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/)
});

/** Query for GET /api/usage/rolling-cost — the chart's span, independent of the report window. */
export const usageRollingCostQuerySchema = z.object({
  range: z.enum(['1m', '3m', '6m', '1y', 'all']).optional()
});

/** Query for GET /api/usage/providers. `family` narrows the read to a single
 * quota card (the per-card Refresh on the usage page) so one slow TUI scrape
 * isn't paid for every provider at once. The peers scope reads only saved
 * peer observations and never starts a local provider read. */
export const providerUsageQuerySchema = z.object({
  refresh: z.enum(['0', '1', 'true', 'false']).optional(),
  family: z.string().regex(/^[a-z0-9-]{1,32}$/, 'family must be a provider family id').optional(),
  period: z.enum(['24h', '7d', '30d', 'week', 'month', 'reset']).optional(),
  scope: z.enum(['instances', 'peers']).optional(),
}).refine((q) => q.scope !== 'peers' || !['1', 'true'].includes(q.refresh),
  { message: 'peers scope only reads saved quota observations' });

/** Body for POST /api/usage/messages — token counts persist forever, so
 * reject non-integer/negative garbage instead of coercing it into counters. */
export const usageMessagesSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().nullish(),
  messageCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative().optional().default(0),
  inputTokenCount: z.number().int().nonnegative().optional().default(0)
});

/**
 * What the user pays monthly for each provider family's quota plan, keyed by
 * family id. Used by BOTH write paths — `PUT /api/usage/subscriptions` (wrapped
 * below) and the `subscriptionCosts` slice of `PUT /api/settings` — so a price
 * can't be written past validation through the generic settings endpoint.
 *
 * Keys are the real family ids, not a loose id pattern: this gates a PERSISTED
 * write, and an arbitrary key would accumulate in settings.json with no editor
 * row that could ever clear it. `null` is accepted and meaningful — it CLEARS a
 * plan's price (the user cancelled it), which an omitted key must not do, since
 * the editor submits only the rows it knows about. Prices are plain USD dollars
 * (cents allowed), capped at `MAX_MONTHLY_COST` so a mistyped extra digit can't
 * swamp every savings figure on the page.
 */
// `partialRecord`, not `record`: with an enum key schema Zod 4's `record` is
// EXHAUSTIVE — it would demand a price for every family on every save, which is
// the opposite of the patch semantics the editor relies on.
export const subscriptionCostsMapSchema = z.partialRecord(
  z.enum(PROVIDER_FAMILY_IDS),
  z.number().min(0).max(MAX_MONTHLY_COST).nullable()
);

/**
 * Which TIER of each family's plan the user is on, keyed by family id. Same
 * key rule and same patch semantics as the price map above — an omitted family
 * keeps its stored tier, `null` (or an empty string, which normalizes to null)
 * CLEARS it. Free text rather than an enum because these are vendor marketing
 * names ("Max 20x", "Pro") that change on the vendor's schedule, not on the
 * PortOS release cycle; the length cap is what keeps settings.json from
 * collecting notes.
 *
 * Used by BOTH write paths — `PUT /api/usage/subscriptions` and the
 * `subscriptionPlanTiers` slice of `PUT /api/settings`.
 */
export const subscriptionPlanTiersMapSchema = z.partialRecord(
  z.enum(PROVIDER_FAMILY_IDS),
  z.string().max(MAX_PLAN_TIER_LENGTH).nullable()
);

/**
 * Body for PUT /api/usage/subscriptions. Both slices are OPTIONAL and
 * independent: the price editor sends only `costs`, the plan editor only
 * `tiers`, and neither save may disturb the other's stored map.
 */
export const subscriptionsUpdateSchema = z.object({
  costs: subscriptionCostsMapSchema.optional(),
  tiers: subscriptionPlanTiersMapSchema.optional(),
});

/**
 * Body for PUT /api/usage/subscriptions/enabled — switch one subscription on or
 * off. `family` is enumerated, not free text, because the handler fans the flag
 * out across every provider record that family owns.
 */
export const subscriptionEnabledSchema = z.object({
  family: z.enum(PROVIDER_FAMILY_IDS),
  enabled: z.boolean(),
});

/**
 * Instances that pay API rates rather than the viewer's subscriptions, so the
 * Across Instances combined total can leave them out. Used by BOTH write
 * paths — `PUT /api/usage/fleet-billing` (the per-row toggle) and the
 * `usageApiBilledInstanceIds` slice of `PUT /api/settings` — so a restore
 * dump can't write an unbounded or non-string list through the generic
 * settings endpoint. Cap matches the stored peer-digest cap (64).
 */
export const usageApiBilledInstanceIdsSchema = z.array(z.string().min(1).max(200)).max(64);

/** Body for PUT /api/usage/fleet-billing. */
export const usageFleetBillingSchema = z.object({
  instanceId: z.string().min(1).max(200),
  usesSubscriptions: z.boolean(),
});
