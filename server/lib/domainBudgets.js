/**
 * Per-domain autonomy budgets (pure helpers).
 *
 * Each domain (brain / memory / cos / messages) can carry a daily cap on
 * `maxActionsPerDay` and `maxMinutesPerDay`; `null` or non-positive means unlimited
 * (the default, so no stored config behaves as unlimited). Token/$ caps are absent
 * because CLI subscription providers expose no per-run metering. Usage ledger and
 * gate wiring live in `services/domainUsage.js`; `domainAutonomy.js` answers whether
 * a domain may act at all.
 */

import { DOMAIN_IDS } from './domainAutonomy.js';

// Single field list shared by the route schema, client UI and normalizer.
export const BUDGET_LIMIT_FIELDS = ['maxActionsPerDay', 'maxMinutesPerDay'];

// No caps: unlimited on every dimension.
export const DEFAULT_DOMAIN_BUDGET = Object.freeze(
  Object.fromEntries(BUDGET_LIMIT_FIELDS.map((f) => [f, null]))
);

const MS_PER_MINUTE = 60_000;

/**
 * Coerce a cap to a positive integer or `null` (unlimited); 0, negatives, NaN and
 * Infinity all clear it so the UI can empty the field.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeBudgetLimit(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Coerce a raw (hand-edited / partial) domainBudgets map into a complete per-domain
 * object; unknown domains are dropped, invalid caps become `null`.
 *
 * @param {unknown} raw
 * @returns {Record<string, {maxActionsPerDay: number|null, maxMinutesPerDay: number|null}>}
 */
export function normalizeDomainBudgets(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const normalized = {};
  for (const id of DOMAIN_IDS) {
    const domainRaw = source[id] && typeof source[id] === 'object' && !Array.isArray(source[id])
      ? source[id]
      : {};
    normalized[id] = {};
    for (const field of BUDGET_LIMIT_FIELDS) {
      normalized[id][field] = normalizeBudgetLimit(domainRaw[field]);
    }
  }
  return normalized;
}

/**
 * Read one domain's budget from a CoS config; missing or invalid values resolve to
 * unlimited.
 *
 * @param {object|null|undefined} config - CoS config (has optional `domainBudgets`)
 * @param {string} domainId - one of DOMAIN_IDS
 * @returns {{maxActionsPerDay: number|null, maxMinutesPerDay: number|null}}
 */
export function getDomainBudget(config, domainId) {
  const domainRaw = config?.domainBudgets?.[domainId];
  const source = domainRaw && typeof domainRaw === 'object' && !Array.isArray(domainRaw) ? domainRaw : {};
  return Object.fromEntries(
    BUDGET_LIMIT_FIELDS.map((field) => [field, normalizeBudgetLimit(source[field])])
  );
}

/**
 * `true` when a domain has at least one active cap (all-unlimited domains can skip
 * the usage read).
 *
 * @param {{maxActionsPerDay: number|null, maxMinutesPerDay: number|null}} budget
 * @returns {boolean}
 */
export function hasBudget(budget) {
  return budget?.maxActionsPerDay != null || budget?.maxMinutesPerDay != null;
}

/**
 * Autonomous actions a domain may still take today, counting in-flight (spawned but
 * unrecorded) runs so a concurrent batch cannot overshoot a small cap. `Infinity`
 * when no action cap is set; never negative.
 *
 * @param {{maxActionsPerDay: number|null}} budget
 * @param {{actions?: number}} usage - today's recorded usage
 * @param {number} [inFlight=0] - autonomous runs spawned today but not yet recorded
 * @returns {number}
 */
export function remainingActionBudget(budget, usage, inFlight = 0) {
  const max = budget?.maxActionsPerDay;
  if (max == null) return Infinity;
  const used = (Number(usage?.actions) || 0) + (Number(inFlight) || 0);
  return Math.max(0, max - used);
}

/**
 * Whether today's usage is within budget. `>=` means a cap of N permits exactly N
 * and blocks the N+1th.
 *
 * @param {{maxActionsPerDay: number|null, maxMinutesPerDay: number|null}} budget
 * @param {{actions?: number, ms?: number}} usage - today's accumulated usage
 * @returns {{withinBudget: boolean, exceeded: 'actions'|'minutes'|null}}
 */
export function evaluateBudget(budget, usage) {
  const actions = Number(usage?.actions) || 0;
  const ms = Number(usage?.ms) || 0;
  const { maxActionsPerDay, maxMinutesPerDay } = budget || DEFAULT_DOMAIN_BUDGET;

  if (maxActionsPerDay != null && actions >= maxActionsPerDay) {
    return { withinBudget: false, exceeded: 'actions' };
  }
  if (maxMinutesPerDay != null && ms / MS_PER_MINUTE >= maxMinutesPerDay) {
    return { withinBudget: false, exceeded: 'minutes' };
  }
  return { withinBudget: true, exceeded: null };
}
