/**
 * Subscription plan tier labels ("Max 20x", "Pro") as short free text per provider family: `MAX_PLAN_TIER_LENGTH`, `normalizePlanTier` / `normalizePlanTiers`.
 *
 * Pure (the Zod schema guarding the persisted write needs the cap and can't import a service); persistence lives in `services/subscriptions.js`. Free text, not an enum, since tiers are vendor marketing names that change off the PortOS release cycle (a stale enum would reject the plan being paid for). The price in `services/subscriptionCosts.js` can't say WHICH plan produced it (two $100/mo installs may be on different tiers with different quota ceilings).
 */

import { trimTo } from './textUtils.js';


export const MAX_PLAN_TIER_LENGTH = 60;

/** A stored/incoming tier as a trimmed label, or null for "not recorded": ONE rule on read and write (as `normalizeCost` for prices); empty, whitespace-only and non-string collapse to null (a CLEARED tier, never an empty pill the user can't remove). */
export function normalizePlanTier(value) {
  const tier = trimTo(value, MAX_PLAN_TIER_LENGTH);
  return tier === '' ? null : tier;
}
