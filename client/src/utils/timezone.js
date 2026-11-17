// Client-side timezone day-key helpers (`dayKeyInTimezone`, `todayKeyInTimezone`): the browser mirror of the server's `todayInTimezone` (server/lib/timezone.js).
//
// POST day-scoped surfaces (the launcher's "completed today", history range bounds) must derive "today" in the user's CONFIGURED timezone to agree with the server, which stamps and windows POST records on the configured local day (#2681);
// a UTC key from `new Date().toISOString()` would disagree around midnight and show a just-saved POST as "not yet completed".

/**
 * `YYYY-MM-DD` for `date` in `timezone` (`en-CA` yields ISO order, matching the server's `todayInTimezone`); an invalid/empty timezone falls back to the browser's local day so callers always get a key.
 * always get a usable key.
 * @param {string} timezone - IANA timezone (e.g. 'America/Los_Angeles')
 * @param {Date} [date] - instant to key (defaults to now)
 */
export function dayKeyInTimezone(timezone, date = new Date()) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined, ...opts }).format(date);
  } catch {
    // Invalid IANA zone → browser-local day (still a valid, usable key).
    return new Intl.DateTimeFormat('en-CA', opts).format(date);
  }
}

/**
 * Today's `YYYY-MM-DD` in `timezone`; alias of {@link dayKeyInTimezone}.
 * @param {string} timezone - IANA timezone
 */
export function todayKeyInTimezone(timezone) {
  return dayKeyInTimezone(timezone, new Date());
}

/**
 * Shift a `YYYY-MM-DD` day key by whole CALENDAR days, the browser mirror of the server's `ymdShift` (server/lib/postStreak.js). Goes through UTC midnight so it never drifts across DST (subtracting `range * 86400000` ms
 * from a wall-clock instant counts elapsed HOURS and lands on the wrong day after a spring-forward; #2681 r4). Use it for window floors.
 * @param {string} dayKey - `YYYY-MM-DD`
 * @param {number} deltaDays - signed day offset
 */
export function shiftDayKey(dayKey, deltaDays) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + deltaDays * 86400000).toISOString().split('T')[0];
}

/**
 * True when `timezone` is a usable IANA zone, so callers can apply the SERVER's UTC fallback for an invalid value rather than drifting to the browser zone (#2681 r4).
 * @param {string} timezone
 */
export function isValidTimezone(timezone) {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
