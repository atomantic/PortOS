/**
 * Cron FIELD semantics (pure, dependency-free).
 *
 * Sibling of `cronValidation.js`, which answers syntax and range only. This
 * module answers the two questions a reader of an already-valid expression
 * has: does THIS value match that field, and which values does that field
 * fire on?
 *
 * `matchesCronField` is the walker's own matcher (`services/eventScheduler.js`
 * stepped minute by minute using a private copy). It lives here because the
 * schedule PLANNER needs the same reading of `*\/4`, `1-5` and `0,12` — a
 * second implementation would let the planner think an hour is free while the
 * walker fires a task in it.
 *
 * Kept import-free so the browser can use it the way `cronValidation.js` is
 * already used by `client/src/utils/cronHelpers.js`.
 */

import { CRON_FIELD_BOUNDS, CRON_FIELD_COUNT, isCronShaped } from './cronValidation.js';

/**
 * Whether a value matches one cron field expression.
 *
 * @param {number} value - The concrete value (hour, day-of-week, …)
 * @param {string} expr - One cron field (`*`, `5`, `1-5`, `*\/15`, `0,12`)
 * @param {number} [fieldMin] - The field's minimum, used as the implicit start
 *   of a bare `*\/n` step
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
 * Every value in `[min, max]` a field fires on.
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
 * The weekday/hour cells a 5-field expression can fire in — the occupancy view
 * a planner needs to keep a new task out of a running one's way.
 *
 * Deliberately over-approximates rather than under: a `dayOfMonth`/`month`
 * restriction narrows WHICH dates match, but says nothing about weekday, so an
 * expression carrying one is reported as occupying every weekday at its hours.
 * A planner that guesses low would put work on top of a running job; guessing
 * high only costs it a candidate hour.
 *
 * @param {unknown} cronExpr - A 5-field cron expression
 * @returns {{ days: number[], hours: number[] }|null} null when
 *   the value is not cron-shaped
 */
export function cronWeekdayHours(cronExpr) {
  if (!isCronShaped(cronExpr)) return null;
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) return null;
  const [, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] = fields;

  const hours = expandCronField(hourExpr, ...CRON_FIELD_BOUNDS[1]);
  // A restricted date or month lands on an unpredictable weekday, so the whole
  // week is occupied at those hours.
  const dateRestricted = dayOfMonthExpr !== '*' || monthExpr !== '*';
  const days = dateRestricted
    ? [0, 1, 2, 3, 4, 5, 6]
    // Cron spells Sunday 0 and 7; normalize to the JS 0-6 the planner uses.
    : [...new Set(expandCronField(dayOfWeekExpr, ...CRON_FIELD_BOUNDS[4]).map(day => day % 7))].sort((a, b) => a - b);

  return { days, hours };
}
