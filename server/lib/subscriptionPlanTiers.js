import { isPlainObject } from './objects.js';

/**
 * Which TIER of a subscription the user is on — "Max 5x" vs "Max 20x", "Pro"
 * vs "Plus" — as a short free-text label per provider family.
 *
 * The price in `services/subscriptionCosts.js` already answers "what does this
 * plan cost", and that number is what every savings figure is computed from.
 * What it cannot answer is WHICH plan produced it: two installs both paying
 * $100/mo may be on different Claude tiers with different quota ceilings, and
 * the quota scrape reports a window's percentage, not a plan name. Recording
 * the tier keeps that identity next to the price without overloading it — a
 * numeric field can never hold "Max 20x", and a price that silently doubled
 * would be the only trace of an upgrade.
 *
 * Deliberately free text, not an enum: the tiers are each vendor's marketing
 * names and they change on the vendor's schedule, not on PortOS releases. A
 * stale enum would reject the plan the user is actually paying for.
 *
 * Pure by design, like `lib/subscriptionSavings.js` beside it: the Zod schema
 * that guards the persisted write needs the cap, and a schema cannot import a
 * service. Persistence and the merge semantics live in
 * `services/subscriptions.js`.
 */

/**
 * Longest stored tier label. Generous enough for every real plan name
 * ("Claude Max 20x", "ChatGPT Pro"), short enough that the value stays a LABEL
 * — settings.json must not become a notes field, and the row renders inline
 * beside a price input.
 */
export const MAX_PLAN_TIER_LENGTH = 60;

/**
 * Pure: a stored/incoming tier as a trimmed label, or null for "not recorded".
 *
 * ONE definition of the rule, used on both read and write, so a tier can never
 * mean different things depending on which side of the store you read it from
 * (the same contract `normalizeCost` holds for prices). Empty, whitespace-only
 * and non-string all collapse to null — a CLEARED tier, never an empty-string
 * tier that renders as a blank pill the user cannot remove.
 */
export function normalizePlanTier(value) {
  if (typeof value !== 'string') return null;
  const tier = value.trim().slice(0, MAX_PLAN_TIER_LENGTH);
  return tier === '' ? null : tier;
}

/** Pure: normalize a whole tier map, dropping every cleared/invalid entry. */
export function normalizePlanTiers(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [family, value] of Object.entries(raw)) {
    const tier = normalizePlanTier(value);
    if (tier !== null) out[family] = tier;
  }
  return out;
}
