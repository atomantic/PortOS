/**
 * Cross-domain "days active" set math: `unionActiveDayKeys(sources, timezone)` unions domains' date values
 * into one sorted array of user-local day keys.
 * `toUserDayKey` normalizes one value.
 *
 * Summing per-domain counts would double-count days logged in two domains. POST stamps the user's local day while health
 * logs stamp server-local (UTC): an INSTANT (legacy full ISO) is re-keyed into the user's timezone, a bare day LABEL is
 * taken as authored (no instant left to re-derive from; the residual error is one adjacent day label). Non-day values are
 * dropped, not coerced. Pure; imports only `todayInTimezone`.
 */

import { todayInTimezone } from './timezone.js';

// A day key is exactly `YYYY-MM-DD`. Anything else is not a day and must not be counted as one
// — validate rather than coerce, or a junk value inflates the tally by a phantom day.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize one stored date value (bare day key or full ISO timestamp) to a user-local `YYYY-MM-DD` day key.
 * Returns `null` when the value is not a date at all.
 */
export function toUserDayKey(value, timezone) {
  if (typeof value !== 'string' || !value) return null;

  // A day LABEL (no time component) is taken as authored, but only if it is a real calendar day: `2026-02-30` parses
  // (Date rolls it to March 2), so round-trip through `Date` and require the day to survive unchanged.
  if (!value.includes('T')) {
    if (!DAY_KEY_RE.test(value)) return null;
    const day = new Date(value);
    if (Number.isNaN(day.getTime())) return null;
    return day.toISOString().slice(0, 10) === value ? value : null;
  }

  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return todayInTimezone(timezone, at);
}

/**
 * Union several domains' date values into one sorted set of user-local day keys (`.length` is the honest count).
 * A non-array source contributes nothing rather than throwing; classifying an unreadable domain as `unavailable`
 * (never a confident 0) is the CALLER's job.
 */
export function unionActiveDayKeys(sources, timezone) {
  if (!Array.isArray(sources)) return [];

  const days = new Set();
  for (const source of sources) {
    // `Array.isArray`, not `source || []`: a truthy non-array would make `for...of` throw.
    if (!Array.isArray(source)) continue;
    for (const value of source) {
      const key = toUserDayKey(value, timezone);
      if (key) days.add(key);
    }
  }
  return [...days].sort();
}
