/**
 * Cross-domain "active days" set math (#4120).
 *
 * A truthful "days active" is the UNION of the per-day date sets each domain contributes —
 * never the SUM of per-domain day counts, which double-counts every day the user logged in two
 * domains. This module owns that union, plus the one thing that makes it meaningful: agreeing
 * on where a day starts.
 *
 * ## The day boundary
 *
 * PortOS has two day-key conventions in the wild:
 *   - POST (`meatspacePost.js`, `meatspacePostTraining.js`, `meatspacePostMemory.js`) stamps
 *     `date` from `userLocalToday()` — the USER's configured timezone (#2681).
 *   - The health logs (`meatspaceAlcohol/Nicotine/Health.js`) stamp `date` from the
 *     server-local `getDateString()`. The process runs `TZ=UTC`, so those are UTC days.
 *
 * **The user-local day is canonical here**, because it is the boundary every user-facing
 * per-day feature already reads against (POST streaks, the Daily Driver) and the one the human
 * looking at the tile actually lives in.
 *
 * **What that can and cannot fix, precisely:**
 *   - A value carrying an INSTANT (a full ISO timestamp — the pre-#2681 shape some legacy
 *     training-log entries still store in `date`) is re-keyed to the user's timezone here. This
 *     is a real correction: the usual `String(date).split('T')[0]` takes the UTC day, which
 *     files a local-evening practice on tomorrow.
 *   - A value that is already a bare `YYYY-MM-DD` LABEL is taken as authored. There is no
 *     instant left to re-derive from — the health-log records carry no timestamp beside their
 *     day key — so normalizing the stored health keys is not possible on read, and a migration
 *     could not do it either for want of the input. Retro-normalizing stored keys is therefore
 *     explicitly OUT OF SCOPE; the union normalizes what it can and takes the rest as authored.
 *     The residual error is bounded and small: only a health entry logged within the
 *     UTC-vs-local offset window can land on an adjacent key, which shifts one day label rather
 *     than inventing or losing days in bulk.
 *
 * Pure and dependency-light on purpose (mirrors `postStreak.js`): the only import is
 * `todayInTimezone`, itself a pure formatter, so the single source of truth for "which day is
 * this instant in the user's timezone" is not forked.
 */

import { todayInTimezone } from './timezone.js';

// A day key is exactly `YYYY-MM-DD`. Anything else is not a day and must not be counted as one
// — validate rather than coerce, or a junk value inflates the tally by a phantom day.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize one stored date value to a user-local `YYYY-MM-DD` day key.
 *
 * @param {unknown} value - a bare day key, or a full ISO timestamp
 * @param {string} timezone - IANA timezone (from `getUserTimezone()`)
 * @returns {string|null} the day key, or `null` when the value is not a date at all
 */
export function toUserDayKey(value, timezone) {
  if (typeof value !== 'string' || !value) return null;

  // No time component → a day LABEL, not an instant. Take it as authored (see header).
  if (!value.includes('T')) return DAY_KEY_RE.test(value) ? value : null;

  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return todayInTimezone(timezone, at);
}

/**
 * Union several domains' date values into one sorted set of user-local day keys.
 *
 * @param {Array<Array<unknown>|null|undefined>} sources - one array of date values per domain
 * @param {string} timezone - IANA timezone (from `getUserTimezone()`)
 * @returns {string[]} sorted, de-duplicated day keys. `.length` is the honest "days active".
 */
export function unionActiveDayKeys(sources, timezone) {
  const days = new Set();
  for (const source of sources || []) {
    for (const value of source || []) {
      const key = toUserDayKey(value, timezone);
      if (key) days.add(key);
    }
  }
  return [...days].sort();
}
