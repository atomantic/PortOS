/**
 * Cron syntax + field-range validation (pure, dependency-free).
 *
 * ONE implementation of "is this a valid 5-field cron expression", shared by
 * the runtime walker (`services/eventScheduler.js`), every save boundary that
 * persists a cron string (CoS global schedule routes, per-app task-type
 * overrides, the generic app-update schema), and the browser cron editor.
 *
 * Before this module those four surfaces disagreed: the walker rejected
 * out-of-range fields by returning `null`, while the save routes only counted
 * five whitespace-separated tokens — so `99 9 * * *` could be saved on an
 * ENABLED schedule that then never fired (#6634).
 *
 * SYNTAX VALIDITY IS NOT "HAS A NEXT OCCURRENCE". `0 0 29 2 *` (leap day) is
 * syntactically valid even though the scheduler's bounded two-year search
 * window may find no match; a save boundary must never use a null next-run
 * result as its invalidity signal. Next-occurrence search stays in the
 * scheduler; this module answers syntax and range only.
 *
 * Kept free of imports (Zod included) so the browser can import it directly,
 * the way `client/src/utils/cronHelpers.js` already imports pure scheduling
 * vocabulary out of `server/lib/`.
 */

/** Field order of a 5-field cron expression. */
export const CRON_FIELD_NAMES = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'];

/**
 * Inclusive [min, max] bounds per field. `dayOfWeek` allows 7 as a second
 * spelling of Sunday (the walker matches both 0 and 7).
 */
export const CRON_FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

export const CRON_FIELD_COUNT = 5;

/**
 * Whether a value has the 5-token SHAPE of a cron expression — the detector
 * that distinguishes a cron string from a named cadence like `on-demand`. It
 * says nothing about syntax validity; use `isValidCronExpression` for that.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCronShaped(value) {
  return typeof value === 'string' && value.trim().split(/\s+/).length === CRON_FIELD_COUNT;
}

/**
 * Validate one comma-separated part of a field (`5`, `1-5`, `*`, `*\/15`,
 * `1-5/2`, `0/10`).
 */
function isCronPartValid(part, min, max) {
  const [range, step] = part.split('/');
  // Only ONE `/` is legal — `1/2/3` splits into 3 and must not pass.
  if (part.split('/').length > 2) return false;
  if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) return false;
  if (range === '*') return true;
  const bounds = range.split('-');
  if (bounds.length > 2) return false;
  const [a, b] = bounds;
  if (!/^\d+$/.test(a)) return false;
  const av = Number(a);
  if (av < min || av > max) return false;
  if (b !== undefined) {
    if (!/^\d+$/.test(b)) return false;
    const bv = Number(b);
    if (bv < min || bv > max || bv < av) return false;
  }
  return true;
}

/**
 * Validate a single cron field against its bounds.
 * @param {string} expr - One field of a cron expression (e.g. `*\/15`, `1-5`)
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {boolean}
 */
export function isValidCronField(expr, min, max) {
  if (typeof expr !== 'string' || expr === '') return false;
  return expr.split(',').every((part) => isCronPartValid(part, min, max));
}

/**
 * Describe why an expression is not a valid cron, or `null` when it is valid.
 * Returned as a user-facing string so the editor can explain the rejection
 * rather than only disabling Save.
 * @param {unknown} expr
 * @returns {string|null}
 */
export function findCronExpressionError(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') {
    return 'Enter a 5-field cron expression (minute hour dayOfMonth month dayOfWeek)';
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    return 'Enter a 5-field cron expression (minute hour dayOfMonth month dayOfWeek)';
  }
  for (let i = 0; i < CRON_FIELD_COUNT; i += 1) {
    const [min, max] = CRON_FIELD_BOUNDS[i];
    if (!isValidCronField(fields[i], min, max)) {
      return `Invalid ${CRON_FIELD_NAMES[i]} field "${fields[i]}" — allowed range is ${min}-${max}`;
    }
  }
  return null;
}

/**
 * Whether a value is a syntactically valid 5-field cron expression with every
 * field inside its range. Does NOT consider whether an occurrence exists in any
 * particular search window.
 * @param {unknown} expr
 * @returns {boolean}
 */
export function isValidCronExpression(expr) {
  return findCronExpressionError(expr) === null;
}
