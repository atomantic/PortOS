/**
 * Cron FIELD semantics (pure, browser-safe): `matchesCronField(value, expr, fieldMin)`,
 * `expandCronField(expr, min, max)` and `cronWeekdayHours(expr)` → `{days, hours}`.
 *
 * Sibling of `cronValidation.js` (syntax/range only). `matchesCronField` is the matcher
 * `services/eventScheduler.js` walks minute by minute; the schedule planner must share it so it
 * cannot read an hour as free while the walker fires a task in it.
 */

import { CRON_FIELD_BOUNDS, CRON_FIELD_COUNT, isCronShaped } from './cronValidation.js';

/**
 * Whether a value matches one cron field expression (`*`, `5`, `1-5`, `*\/15`, `0,12`).
 * `fieldMin` is the implicit start of a bare `*\/n` step.
 *
 * @param {number} value - The concrete value (hour, day-of-week, …)
 * @param {string} expr - One cron field (`*`, `5`, `1-5`, `*\/15`, `0,12`)
 * @param {number} [fieldMin] - The field's minimum, used as the implicit start of a bare `*\/n` step
 * @returns {boolean}
 */
export function matchesCronField(value, expr, fieldMin = 0) {
  if (expr === '*') return true;

  if (expr.includes(',')) {
    return expr.split(',').some(part => matchesCronField(value, part.trim(), fieldMin));
  }

  // Steps first (`*\/5`, `0/10`, `1-5/2`) — a step expression may also contain
  // a range, so testing `-` before `/` would misread it.
  if (expr.includes('/')) {
    const [rangeExpr, step] = expr.split('/');
    const stepNum = Number(step);
    let startNum = fieldMin;
    let endNum = Infinity;
    if (rangeExpr === '*') {
      startNum = fieldMin;
    } else if (rangeExpr.includes('-')) {
      const [s, e] = rangeExpr.split('-').map(Number);
      startNum = s;
      endNum = e;
    } else {
      startNum = Number(rangeExpr);
    }
    return value >= startNum && value <= endNum && (value - startNum) % stepNum === 0;
  }

  if (expr.includes('-')) {
    const [start, end] = expr.split('-').map(Number);
    return value >= start && value <= end;
  }

  return Number(expr) === value;
}

/**
 * Every value in `[min, max]` (inclusive) a field fires on, ascending.
 *
 * @param {string} expr - One cron field
 * @param {number} min - Inclusive lower bound of the field
 * @param {number} max - Inclusive upper bound of the field
 * @returns {number[]} Matching values, ascending
 */
export function expandCronField(expr, min, max) {
  const values = [];
  for (let value = min; value <= max; value += 1) {
    if (matchesCronField(value, expr, min)) values.push(value);
  }
  return values;
}

/**
 * The weekday/hour cells a 5-field expression can fire in; null when not cron-shaped.
 *
 * Deliberately over-approximates: a `dayOfMonth`/`month` restriction says nothing about weekday,
 * so it reports every weekday at its hours. Guessing low would put work on top of a running job;
 * guessing high only costs a candidate hour.
 *
 * @param {unknown} cronExpr - A 5-field cron expression
 * @returns {{ days: number[], hours: number[] }|null} null when the value is not cron-shaped
 */
export function cronWeekdayHours(cronExpr) {
  if (!isCronShaped(cronExpr)) return null;
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) return null;
  const [, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] = fields;

  const hours = expandCronField(hourExpr, ...CRON_FIELD_BOUNDS[1]);
  const dateRestricted = dayOfMonthExpr !== '*' || monthExpr !== '*';
  const days = dateRestricted
    ? [0, 1, 2, 3, 4, 5, 6]
    // Cron spells Sunday 0 and 7; normalize to the JS 0-6 the planner uses.
    : [...new Set(expandCronField(dayOfWeekExpr, ...CRON_FIELD_BOUNDS[4]).map(day => day % 7))].sort((a, b) => a - b);

  return { days, hours };
}

// Day-of-month ranges for the first four weekday occurrences in a month.
export const MONTHLY_DAY_RANGES = Object.freeze({
  first: '1-7',
  second: '8-14',
  third: '15-21',
  fourth: '22-28',
});
