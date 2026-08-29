/**
 * ISO-8601 week identity (pure).
 *
 * The one place PortOS turns a date into a `YYYY-Www` week id. Both the CoS
 * productivity week aggregates (`services/productivity.js`) and the weekly digest
 * (`services/weeklyDigest.js`) used to carry their own copy, and both paired
 * the ISO week NUMBER with the CALENDAR year (#3465). Those two disagree at
 * either end of the year, which split one ISO week across two ids (breaking
 * week aggregates and week-over-week lookups) and collided two different weeks onto a
 * single id (a late-December digest overwriting the early-January one).
 *
 * The year here is the ISO week-numbering year — the calendar year of that
 * week's Thursday — so every day of an ISO week shares one id and no id is
 * ever reused. `2025-12-29` (Mon) and `2026-01-01` (Thu) are both `2026-W01`.
 *
 * Dates are read through their LOCAL calendar components (a task completed at
 * 23:00 local belongs to that local day, not the UTC one); the arithmetic then
 * runs in UTC so DST transitions can't shift a day boundary.
 */

const MS_PER_DAY = 86400000;

/**
 * UTC-midnight Date for the Thursday of the ISO week containing `date`.
 * Thursday is the ISO anchor: it always falls in the week's own numbering year.
 */
function isoWeekThursday(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const isoDay = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  return d;
}

/**
 * Split a date into its ISO week-numbering year and week number.
 *
 * @param {Date} [date]
 * @returns {{ year: number, week: number }}
 */
export function isoWeekParts(date = new Date()) {
  const thursday = isoWeekThursday(date);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / MS_PER_DAY + 1) / 7);
  return { year, week };
}

/** ISO week number (1–53) for a date. */
export function getIsoWeekNumber(date = new Date()) {
  return isoWeekParts(date).week;
}

/** ISO week-numbering year for a date — NOT `date.getFullYear()`. */
export function getIsoWeekYear(date = new Date()) {
  return isoWeekParts(date).year;
}

/**
 * Week identifier in `YYYY-Www` form (zero-padded week), keyed on the ISO
 * week-numbering year. Stable and collision-free across a New Year boundary.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function getWeekId(date = new Date()) {
  const { year, week } = isoWeekParts(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Parse a `YYYY-Www` week id. Returns null for anything else, so callers can
 * distinguish "unparseable" from a real week rather than reading NaN.
 *
 * @param {string} weekId
 * @returns {{ year: number, week: number } | null}
 */
export function parseWeekId(weekId) {
  if (typeof weekId !== 'string') return null;
  const match = /^(\d{4})-W(\d{1,2})$/.exec(weekId);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  return { year, week };
}

/**
 * How many ISO weeks a week-numbering year holds — 52, or 53 in a "leap week"
 * year (2015, 2020, 2026, …). December 28th is always in the last ISO week of
 * its own numbering year, so this derives the answer from the same math as
 * every other export rather than re-deriving the leap rule.
 *
 * @param {number} year
 * @returns {number} 52 or 53
 */
export function isoWeeksInYear(year) {
  return isoWeekParts(new Date(year, 11, 28)).week;
}
