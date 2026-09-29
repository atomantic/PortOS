import { ymdToUTC } from './postStreak.js';

/**
 * Subscription-vs-API savings math for the /devtools/usage cost report — pure,
 * so the shape can be unit-tested without a settings file or a provider config.
 *
 * PortOS runs on flat-rate subscriptions (Claude Max, ChatGPT Pro, …) while the
 * cost report prices the same traffic at published API rates. The interesting
 * number is the difference: what the quota plans saved over paying per token.
 * That comparison only means anything if BOTH sides cover the same window, so a
 * monthly plan price is prorated across the report range rather than compared
 * whole against a 7-day API estimate.
 */

// Average Gregorian month. A plan is billed per calendar month, so proration
// uses the average month length rather than 30 — over a year the two differ by
// five days of subscription cost, which is real money on a $200/mo plan.
export const DAYS_PER_MONTH = 365.25 / 12;

// A plan price is a monthly USD figure. The ceiling is a typo guard (a fat-
// fingered "20000" for $200/mo would otherwise silently swamp every savings
// figure on the page), not a product limit. Defined here so the route schema
// and the settings normalizer enforce ONE number.
export const MAX_MONTHLY_COST = 100000;

/** Round a dollar amount to whole cents. Shared by every money figure PortOS derives. */
export const roundCents = (n) => Math.round(n * 100) / 100;

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Pure: inclusive day count between two YYYY-MM-DD days (UTC calendar days). */
const inclusiveDays = (start, end) => Math.floor((ymdToUTC(end) - ymdToUTC(start)) / 86400000) + 1;

/**
 * Resolve the window the subscription cost is prorated over, as
 * `{ start, end, days }` (days is 0 when the window is empty).
 *
 * The report's range is open-ended on both sides, and each open end has a
 * different correct answer:
 * - No `to` (or a `to` in the future) → today. A window that runs to the end of
 *   next month must not bill next month's subscription today.
 * - No `from` ("All time") → the first day usage was actually recorded. Falling
 *   back to today instead would price all-time savings over a single day, and
 *   falling back to epoch would invent years of subscription spend.
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

/**
 * Percent of the API bill a subscription avoided, or null when there is no API
 * bill to compare against. Null rather than 0 or 100 on purpose: "we cannot
 * express this as a percentage" is not "you saved nothing" (see the
 * sentinel-vs-empty convention in AGENTS.md), and a UI that prints 0% for an
 * unused-but-paid-for plan is stating a falsehood about the plan.
 */
export function savingsPercent(apiCost, savings) {
  if (!(apiCost > 0)) return null;
  return Math.round((savings / apiCost) * 100);
}

/**
 * Value returned per dollar of subscription spend (API cost ÷ prorated plan
 * cost), rounded to one decimal. Null when nothing is being paid — an infinite
 * multiplier is not a number a card can render.
 */
export function costMultiplier(apiCost, periodCost) {
  if (!(periodCost > 0)) return null;
  return Math.round((apiCost / periodCost) * 10) / 10;
}

/**
 * Pure: group a cost report's provider rows by the subscription family that
 * covered them, as `{ byFamily: Map<familyId, usd>, unmatched: usd }`.
 *
 * `buildUsageReport` stamps each row's `family` from the live provider config
 * it already had in hand, so this is a plain groupBy — a row with no family
 * (uninstalled provider, `legacy`, `unknown`, a pay-as-you-go API provider)
 * lands in `unmatched` and is reported on its own rather than being credited to
 * a plan no one was paying.
 *
 * `sources` carries each family's provenance (`measured` / `estimate` /
 * `mixed`) so the savings table can say when a plan's API figure is a guess —
 * an estimated row usually UNDERSTATES, which reads as a plan that "cost more
 * than it was worth".
 */
export function attributeReportCostToFamilies(report) {
  const byFamily = new Map();
  const sources = new Map();
  let unmatched = 0;
  for (const row of report?.providers || []) {
    const cost = Number(row?.estimatedCost) || 0;
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
 * Build the savings block from per-family `{ family, label, monthlyCost,
 * apiCost }` entries and a resolved window (prices already normalized by the
 * settings layer — this is arithmetic, not validation).
 *
 * Every entry is returned, including plans priced at 0 — that is the editor's
 * row list, and a family the user has not priced yet must still be visible and
 * editable. Only priced plans (`configured`) contribute to the totals, so an
 * unpriced plan reads as "not counted", never as "free".
 *
 * `unmatchedApiCost` is API-billed usage that belongs to no subscription family.
 * It is reported separately instead of being folded into savings: no plan
 * covered it, so counting it as saved would overstate the plans' value.
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
