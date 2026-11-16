/**
  * Subscription-vs-API savings math for the usage page.
  *
  * `resolveSavingsWindow` (clamps an open-ended report range to today / first activity day), `prorateMonthlyCost` (monthly plan price → this window's share via `DAYS_PER_MONTH`, capped by `MAX_MONTHLY_COST`), `savingsPercent` / `costMultiplier` (null, never 0, when undefined), `attributeReportCostToFamilies` (groups report rows by stamped `family`), `roundCents` (the one money rounder), and `buildSubscriptionSavings({ entries, range, unmatchedApiCost })` → per-family rows + totals. Pure, so it unit-tests without a settings file or provider config.
 */

import { ymdToUTC } from './postStreak.js';

/** PortOS runs on flat-rate subscriptions while the cost report prices the same traffic at API rates; the number of interest is what the quota plans saved. Both sides must cover the same window, so a monthly plan price is prorated across the report range rather than compared whole against a 7-day estimate. */

// Average Gregorian month (a plan bills per calendar month; 30 would differ by five days of cost per year, real money on a $200/mo plan).
export const DAYS_PER_MONTH = 365.25 / 12;

// Monthly USD plan price ceiling: a typo guard (a fat-fingered "20000" would swamp every savings figure), not a product limit. Defined here so the route schema and settings normalizer enforce ONE number.
export const MAX_MONTHLY_COST = 100000;

/** Round a dollar amount to whole cents. Shared by every money figure PortOS derives. */
export const roundCents = (n) => Math.round(n * 100) / 100;

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Pure: inclusive day count between two YYYY-MM-DD days (UTC calendar days). */
const inclusiveDays = (start, end) => Math.floor((ymdToUTC(end) - ymdToUTC(start)) / 86400000) + 1;

/**
 * Resolve the window the subscription cost is prorated over as `{ start, end, days }` (days 0 when empty). Each open end of the report range has a different answer: no `to` (or a future `to`) → today (a window to next month's end must
 * not bill next month today); no `from` ("All time") → the first day usage was recorded (today would price all-time savings over one day, epoch would invent years of spend).
 *
 * @param {{ from?: string|null, to?: string|null, firstActivityDay?: string|null, today: string }} args
 */
export function resolveSavingsWindow({ from = null, to = null, firstActivityDay = null, today }) {
  if (!isDay(today)) throw new TypeError('resolveSavingsWindow: today must be a YYYY-MM-DD day');
  const end = isDay(to) && to < today ? to : today;
  const start = isDay(from) ? from : (isDay(firstActivityDay) ? firstActivityDay : null);
  if (!start || start > end) return { start: start || null, end, days: 0 };
  return { start, end, days: inclusiveDays(start, end) };
}

/** Pure: what a monthly plan price costs over `days` days, in whole cents. */
export function prorateMonthlyCost(monthlyCost, days) {
  if (!(monthlyCost > 0) || !(days > 0)) return 0;
  return roundCents((monthlyCost * days) / DAYS_PER_MONTH);
}

/** Percent of the API bill a subscription avoided, or null with no API bill: null rather than 0/100 because "cannot express as a percentage" is not "you saved nothing" (AGENTS.md sentinel convention), and 0% for an unused-but-paid plan is false. */
export function savingsPercent(apiCost, savings) {
  if (!(apiCost > 0)) return null;
  return Math.round((savings / apiCost) * 100);
}

/** API cost ÷ prorated plan cost, rounded to one decimal; null when nothing is being paid (an infinite multiplier isn't renderable). */
export function costMultiplier(apiCost, periodCost) {
  if (!(periodCost > 0)) return null;
  return Math.round((apiCost / periodCost) * 10) / 10;
}

/**
 * Group a cost report's provider rows by the subscription family covering them: `{ byFamily: Map<familyId, usd>, unmatched: usd }`. `buildUsageReport` stamps each row's `family` from live provider config, so this is a plain groupBy;
 * a row with no family (uninstalled provider, `legacy`, `unknown`, pay-as-you-go API) lands in `unmatched` rather than crediting a plan nobody paid for. `sources` carries each family's provenance (`measured` / `estimate` / `mixed`)
 * so the table can say when a plan's API figure is a guess (an estimated row usually UNDERSTATES, reading as a plan that "cost more than it was worth").
 */
export function attributeReportCostToFamilies(report) {
  const byFamily = new Map();
  const sources = new Map();
  let unmatched = 0;
  for (const row of report?.providers || []) {
    const cost = Number(row?.rawEstimatedCost ?? row?.estimatedCost) || 0;
    if (cost <= 0) continue;
    if (!row.family) { unmatched += cost; continue; }
    byFamily.set(row.family, (byFamily.get(row.family) || 0) + cost);
    const source = row.source || 'estimate';
    const seen = sources.get(row.family);
    sources.set(row.family, seen && seen !== source ? 'mixed' : source);
  }
  return { byFamily, sources, unmatched };
}

/**
 * Build the savings block from per-family `{ family, label, monthlyCost, apiCost }` entries and a resolved window (prices already normalized by the settings layer: arithmetic, not validation). Every entry is returned, including
 * plans priced at 0 (the editor's row list: an unpriced family must stay visible and editable); only priced plans (`configured`) feed the totals, so unpriced reads "not counted", never "free". `unmatchedApiCost` (API-billed usage
 * belonging to no family) is reported separately, since counting it as saved would overstate the plans' value.
 *
 * @param {{ entries: Array, range: { start: string|null, end: string, days: number }, unmatchedApiCost?: number }} args
 */
export function buildSubscriptionSavings({ entries = [], range, unmatchedApiCost = 0 }) {
  const days = range?.days || 0;
  const families = entries.map((entry) => {
    const monthlyCost = entry.monthlyCost > 0 ? entry.monthlyCost : 0;
    const apiCost = roundCents(Number(entry.apiCost) || 0);
    const configured = monthlyCost > 0;
    const periodCost = prorateMonthlyCost(monthlyCost, days);
    return {
      family: entry.family,
      label: entry.label,
      enabled: entry.enabled !== false,
      monthlyCost,
      configured,
      periodCost,
      apiCost,
      source: entry.source ?? null,
      savings: configured ? roundCents(apiCost - periodCost) : 0,
      multiplier: configured ? costMultiplier(apiCost, periodCost) : null
    };
  });

  const priced = families.filter((f) => f.configured);
  const periodCost = roundCents(priced.reduce((sum, f) => sum + f.periodCost, 0));
  const apiCost = roundCents(priced.reduce((sum, f) => sum + f.apiCost, 0));
  const savings = roundCents(apiCost - periodCost);

  return {
    range,
    configured: priced.length > 0,
    families,
    unmatchedApiCost: roundCents(Number(unmatchedApiCost) || 0),
    totals: {
      monthlyCost: roundCents(priced.reduce((sum, f) => sum + f.monthlyCost, 0)),
      periodCost,
      apiCost,
      savings,
      savingsPercent: savingsPercent(apiCost, savings),
      multiplier: costMultiplier(apiCost, periodCost)
    }
  };
}
