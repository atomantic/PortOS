import { getSettings, updateSettingsWith } from './settings.js';
import { resolveEnabledFamilies } from './providerUsage.js';
import { familyLabel } from '../lib/providerFamilies.js';
import {
  attributeReportCostToFamilies,
  buildSubscriptionSavings,
  resolveSavingsWindow,
  roundCents,
  MAX_MONTHLY_COST
} from '../lib/subscriptionSavings.js';
import { isPlainObject } from '../lib/objects.js';

/**
 * What the user pays for each AI subscription, and what those plans saved
 * against the usage page's estimated API cost.
 *
 * The cost report already prices every recorded token at published API rates.
 * PortOS does not actually pay those rates — it runs on flat-rate quota plans —
 * so the report's headline is an opportunity cost with nothing to compare it
 * against. Recording the monthly price of each plan turns it into the number
 * the user actually wants: "my subscriptions cost $X this week and did $Y of
 * API-rate work."
 *
 * Prices are per-install configuration, stored in `data/settings.json` under
 * `subscriptionCosts` as `{ [familyId]: monthlyUsd }` — a plan price is local
 * to the person paying it and never rides the federation layer.
 */

const SETTINGS_KEY = 'subscriptionCosts';

/**
 * Pure: a stored/incoming plan price as a number, or null for "no plan".
 *
 * ONE definition of the rule, used on both read and write, so a price can never
 * mean different things depending on which side of the store you read it from.
 * 0, negative, unparseable, and above-the-cap all collapse to null — a CLEARED
 * plan, not a $0 plan — so `configured` downstream means "the user told us what
 * this costs", never "we assumed it was free". The route schema rejects an
 * over-cap price outright (400); this is the backstop for a value that reached
 * settings.json some other way.
 */
export function normalizeCost(value) {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0 || cost > MAX_MONTHLY_COST) return null;
  return roundCents(cost);
}

/** Pure: normalize a whole cost map, dropping every cleared/invalid entry. */
export function normalizeSubscriptionCosts(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [family, value] of Object.entries(raw)) {
    const cost = normalizeCost(value);
    if (cost !== null) out[family] = cost;
  }
  return out;
}

/** Stored monthly plan prices, `{ [family]: monthlyUsd }`. */
export async function getSubscriptionCosts() {
  const settings = await getSettings();
  return normalizeSubscriptionCosts(settings?.[SETTINGS_KEY]);
}

/**
 * Merge a patch of plan prices into settings and return the normalized map.
 *
 * Absent key vs. present-but-empty are DIFFERENT (the LLM/merge convention in
 * AGENTS.md applies to user edits too): a family the patch omits keeps its
 * stored price, while a family sent as `null`/`0` is an intentional clear and
 * is deleted. Without that split, an editor that only submits changed rows
 * could never remove a plan the user cancelled.
 */
// `options` is forwarded to `updateSettingsWith` so the operator-action actor
// (#5594) survives: both callers — the Settings PUT and the usage page's price
// editor — are a human, and would otherwise be logged as `system`.
export async function saveSubscriptionCosts(patch, options) {
  const incoming = isPlainObject(patch) ? patch : {};
  const next = await updateSettingsWith((current) => {
    const merged = { ...normalizeSubscriptionCosts(current?.[SETTINGS_KEY]) };
    for (const [family, value] of Object.entries(incoming)) {
      const cost = normalizeCost(value);
      if (cost === null) delete merged[family];
      else merged[family] = cost;
    }
    return { ...current, [SETTINGS_KEY]: merged };
  }, options);
  return normalizeSubscriptionCosts(next?.[SETTINGS_KEY]);
}

/**
 * The families the editor offers, as `{ family, label, enabled }`: every
 * enabled provider family, plus any family that is priced or that ran up API
 * cost inside the report window even though its provider is no longer enabled.
 *
 * Those extras matter. Dropping a priced-but-disabled family would hide — and
 * on the next save, silently discard — the price of a plan whose provider the
 * user merely toggled off. Dropping one with spend in-window would strand that
 * spend in "usage no subscription covers" with no row to price it, so the user
 * could never account for it at all.
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

/**
 * The savings block served alongside the cost report: per-family plan price,
 * prorated cost for the report window, the API-rate cost that window's usage
 * would have run to, and the difference.
 */
export async function getSubscriptionSavings({ report, providers = [], from = null, to = null, firstActivityDay = null, today = utcToday() }) {
  const costs = await getSubscriptionCosts();
  const { byFamily, unmatched } = attributeReportCostToFamilies(report);
  const entries = resolveSubscriptionFamilies(providers, costs, [...byFamily.keys()]).map((f) => ({
    ...f,
    monthlyCost: costs[f.family] ?? 0,
    apiCost: byFamily.get(f.family) || 0
  }));
  return buildSubscriptionSavings({
    entries,
    range: resolveSavingsWindow({ from, to, firstActivityDay, today }),
    unmatchedApiCost: unmatched
  });
}
