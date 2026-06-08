/**
 * Per-domain autonomy budgets (pure helpers).
 *
 * The third slice of the #711 autonomy-guardrails umbrella. Where
 * `domainAutonomy.js` answers "is this domain allowed to act automatically?",
 * this module answers "has this domain done *too much* automatic work today?".
 * Each of the four domains (brain / memory / cos / messages) can carry a daily
 * cap on two measurable dimensions:
 *
 *   - `maxActionsPerDay`  — count of autonomous actions (thoughts classified,
 *                           memories extracted, agents auto-run, messages sent).
 *   - `maxMinutesPerDay`  — cumulative wall-clock minutes of autonomous work
 *                           (dominated by CoS agent runtime; small but real for
 *                           brain/memory LLM classification).
 *
 * Why only actions + minutes (not "spend" / "tokens")? PortOS runs its AI
 * through CLI *subscription* providers (claude-code, codex, gemini-cli) whose
 * runner returns `{ text, model }` with NO per-run token or cost metering — so a
 * token/dollar cap would be inert (never trip) or require fabricated estimates.
 * Actions and minutes are the dimensions we can measure honestly, so those are
 * the dimensions we enforce.
 *
 * A cap of `null` (or any non-positive value) means *unlimited* — the default
 * for every domain on every dimension, so an install with no stored
 * `domainBudgets` config behaves exactly as before (no migration needed, mirrors
 * the `domainAutonomy` default-of-`execute` pattern).
 *
 * These helpers are side-effect-free: the usage ledger I/O and the gate wiring
 * live in `server/services/domainUsage.js` and at each domain's call site. This
 * module owns the vocabulary, normalization, and the within-budget math.
 */

import { DOMAIN_IDS } from './domainAutonomy.js';

// The budget dimensions a domain can cap. Kept as an enumerable list so the
// route schema, the client UI, and the normalizer all agree on the field set.
export const BUDGET_LIMIT_FIELDS = ['maxActionsPerDay', 'maxMinutesPerDay'];

// A domain with no caps — unlimited on every dimension (historical behavior).
export const DEFAULT_DOMAIN_BUDGET = Object.freeze(
  Object.fromEntries(BUDGET_LIMIT_FIELDS.map((f) => [f, null]))
);

const MS_PER_MINUTE = 60_000;

/**
 * Coerce a single cap value into a positive integer or `null` (unlimited).
 * `0`, negatives, NaN, non-numbers, and Infinity all mean unlimited — so the UI
 * can clear a cap by emptying the field (which sends `null`/`0`/`''`).
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeBudgetLimit(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Coerce a raw (possibly hand-edited / legacy / partial) domainBudgets map into
 * a complete `{ [domainId]: { maxActionsPerDay, maxMinutesPerDay } }` object.
 * Unknown domains are dropped; missing/invalid caps become `null` (unlimited).
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
 * Read a single domain's budget from a CoS config object. Tolerates a missing
 * `config`, a missing `domainBudgets`, and partial/invalid stored values — all
 * resolve to unlimited so absent config reproduces historical behavior.
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
 * `true` when a domain has at least one active cap. Unlimited-on-everything
 * domains can skip the usage read entirely.
 *
 * @param {{maxActionsPerDay: number|null, maxMinutesPerDay: number|null}} budget
 * @returns {boolean}
 */
export function hasBudget(budget) {
  return budget?.maxActionsPerDay != null || budget?.maxMinutesPerDay != null;
}

/**
 * Decide whether today's usage is still within a domain's budget. Pure: callers
 * pass the normalized budget and the day's accumulated usage.
 *
 * Uses `>=` (not `>`) so a cap of N permits exactly N actions/minutes and blocks
 * the N+1th — i.e. the cap is the count you're allowed to reach, and exhausting
 * it stops further autonomous work for the rest of the day.
 *
 * @param {{maxActionsPerDay: number|null, maxMinutesPerDay: number|null}} budget
 * @param {{actions?: number, ms?: number}} usage - today's accumulated usage
 * @returns {{withinBudget: boolean, exceeded: 'actions'|'minutes'|null}}
 */
/**
 * How many more autonomous actions a domain may take today, given its budget,
 * today's recorded usage, and the count of in-flight (spawned-but-not-yet-
 * recorded) autonomous runs. Returns `Infinity` when no action cap is set, and
 * never goes negative. Used by the CoS evaluator to cap a single cycle's
 * autonomous admissions so a small cap can't be overshot by a concurrent batch.
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
