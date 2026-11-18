import { getSettings, updateSettingsWith } from './settings.js';
import { resolveEnabledFamilies } from './provider/providerUsage.js';
import { familyLabel } from '../lib/provider/providerFamilies.js';
import {
  attributeReportCostToFamilies,
  buildSubscriptionSavings,
  resolveSavingsWindow,
  roundCents,
  MAX_MONTHLY_COST
} from '../lib/subscriptionSavings.js';
import { mergeFamilyMap, normalizeFamilyMap } from '../lib/familySettingsMap.js';

/**
 * Monthly price of each AI subscription plan, compared against the usage page's
 * API-rate cost estimate (PortOS actually runs on flat-rate plans). Stored in
 * `data/settings.json` under `subscriptionCosts` as `{ [familyId]: monthlyUsd }`;
 * local to the payer, never federated.
 */

const SETTINGS_KEY = 'subscriptionCosts';

/**
 * Pure: a plan price as a number, or null for "no plan". Used on both read and
 * write. 0, negative, unparseable and over-cap all collapse to null (a CLEARED
 * plan, not a $0 plan) so `configured` means "the user told us the cost". The
 * route schema rejects over-cap with 400; this backstops values that reached
 * settings.json another way.
 */
export function normalizeCost(value) {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0 || cost > MAX_MONTHLY_COST) return null;
  return roundCents(cost);
}

/** Pure: normalize a whole cost map, dropping every cleared/invalid entry. */
export const normalizeSubscriptionCosts = (raw) => normalizeFamilyMap(raw, normalizeCost);

/** Stored monthly plan prices, `{ [family]: monthlyUsd }`. */
export async function getSubscriptionCosts() {
  const settings = await getSettings();
  return normalizeSubscriptionCosts(settings?.[SETTINGS_KEY]);
}

/**
 * Merge a patch of plan prices into settings and return the normalized map. An
 * omitted family keeps its price; `null`/`0` is an intentional clear
 * (`mergeFamilyMap` owns that rule). `options` is forwarded to
 * `updateSettingsWith` so the human operator actor (#5594) is not logged as `system`.
 */
export async function saveSubscriptionCosts(patch, options) {
  const next = await updateSettingsWith((current) => ({
    ...current,
    [SETTINGS_KEY]: mergeFamilyMap(current?.[SETTINGS_KEY], patch, normalizeCost),
  }), options);
  return normalizeSubscriptionCosts(next?.[SETTINGS_KEY]);
}

/**
 * The editor's families, `{ family, label, enabled }`: every enabled provider
 * family plus any priced or in-window-spend family whose provider is disabled.
 * Dropping those would silently discard a price on next save, or strand spend in
 * "usage no subscription covers" with no row to price it.
 */
export function resolveSubscriptionFamilies(providers, costs = {}, spentFamilyIds = []) {
  const enabled = resolveEnabledFamilies(providers).map((f) => ({ family: f.id, label: f.label, enabled: true }));
  const seen = new Set(enabled.map((f) => f.family));
  const extras = [...new Set([...Object.keys(costs), ...spentFamilyIds])]
    .filter((family) => !seen.has(family))
    .map((family) => ({ family, label: familyLabel(family), enabled: false }));
  return [...enabled, ...extras];
}

/** Today as a UTC `YYYY-MM-DD` — the calendar usage.js keys its day buckets by. */
const utcToday = () => new Date().toISOString().split('T')[0];

/** Savings block served with the cost report: per-family prorated plan cost vs API-rate cost, and the difference. */
export async function getSubscriptionSavings({ report, providers = [], from = null, to = null, firstActivityDay = null, today = utcToday() }) {
  const costs = await getSubscriptionCosts();
  const { byFamily, sources, unmatched } = attributeReportCostToFamilies(report);
  const entries = resolveSubscriptionFamilies(providers, costs, [...byFamily.keys()]).map((f) => ({
    ...f,
    monthlyCost: costs[f.family] ?? 0,
    apiCost: byFamily.get(f.family) || 0,
    source: sources.get(f.family)
  }));
  return {
    ...buildSubscriptionSavings({
    entries,
    range: resolveSavingsWindow({ from, to, firstActivityDay, today }),
    unmatchedApiCost: unmatched
    }),
    costIncomplete: Boolean(report?.totals?.costIncomplete),
  };
}
