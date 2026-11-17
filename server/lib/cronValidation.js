/**
 * Cron syntax + field-range validation (pure, dependency-free, import-free so the browser can use it).
 *
 * ONE implementation of "is this a valid 5-field cron expression", shared by the scheduler walker
 * (`services/eventScheduler.js`), every save boundary that persists a cron string, and the
 * browser cron editor, so a save can never accept an expression the walker rejects (#6634).
 *
 * SYNTAX VALIDITY IS NOT "HAS A NEXT OCCURRENCE": `0 0 29 2 *` (leap day) is valid even if the
 * scheduler's bounded search window finds no match, so a save boundary must never treat a null
 * next-run as invalid. Next-occurrence search stays in the scheduler.
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
 * Whether a value has the 5-token SHAPE of a cron expression (vs a named cadence like
 * `on-demand`); says nothing about validity — use `isValidCronExpression`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCronShaped(value) {
  return typeof value === 'string' && value.trim().split(/\s+/).length === CRON_FIELD_COUNT;
}

/** Validate one comma-separated part of a field (`5`, `1-5`, `*`, `*\/15`, `1-5/2`, `0/10`). */
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
 * Validate a single cron field (e.g. `*\/15`, `1-5`) against inclusive bounds.
 *
 * @param {string} expr - One field of a cron expression
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {boolean}
 */
export function isValidCronField(expr, min, max) {
  if (typeof expr !== 'string' || expr === '') return false;
  return expr.split(',').every((part) => isCronPartValid(part, min, max));
}

/**
 * User-facing reason an expression is not a valid cron, or `null` when valid.
 *
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
 * Syntactically valid 5-field cron with every field in range; ignores whether an occurrence exists.
 *
 * @param {unknown} expr
 * @returns {boolean}
 */
export function isValidCronExpression(expr) {
  return findCronExpressionError(expr) === null;
}
