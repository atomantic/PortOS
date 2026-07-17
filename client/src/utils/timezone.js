// Client-side timezone day-key helpers — the browser mirror of the server's
// `todayInTimezone` (server/lib/timezone.js). POST day-scoped surfaces (the
// launcher's "completed today", history range bounds) must derive "today" in the
// user's CONFIGURED timezone so they agree with the server, which now stamps and
// windows POST records on the configured local day (issue #2681). Deriving the
// key from `new Date().toISOString()` (UTC) instead would disagree around the
// local/UTC midnight boundary — showing a just-saved POST as "not yet completed".

/**
 * `YYYY-MM-DD` for `date` evaluated in `timezone`. `en-CA` formats dates in
 * ISO `YYYY-MM-DD` order, matching the server's `todayInTimezone` output. An
 * invalid/empty timezone falls back to the browser's own local day so callers
 * always get a usable key.
 * @param {string} timezone - IANA timezone (e.g. 'America/Los_Angeles')
 * @param {Date} [date] - instant to key (defaults to now)
 * @returns {string}
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
 * Today's `YYYY-MM-DD` in `timezone`. Thin alias over {@link dayKeyInTimezone}
 * for the common "what's today's key" call.
 * @param {string} timezone - IANA timezone
 * @returns {string}
 */
export function todayKeyInTimezone(timezone) {
  return dayKeyInTimezone(timezone, new Date());
}

/**
 * Shift a `YYYY-MM-DD` day key by whole CALENDAR days — the browser mirror of the
 * server's `ymdShift` (server/lib/postStreak.js). Day arithmetic goes through UTC
 * midnight so it never drifts across a DST transition: subtracting
 * `range * 86400000` ms from a wall-clock instant counts elapsed HOURS and, across
 * a spring-forward, lands on the wrong calendar day (issue #2681 r4). Use this for
 * window floors so the client matches the server's DST-safe day windows.
 * @param {string} dayKey - `YYYY-MM-DD`
 * @param {number} deltaDays - signed day offset
 * @returns {string}
 */
export function shiftDayKey(dayKey, deltaDays) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + deltaDays * 86400000).toISOString().split('T')[0];
}

/**
 * True when `timezone` is a usable IANA zone. Lets callers apply the SERVER's
 * fallback (UTC) for an invalid configured value instead of silently drifting to
 * the browser zone (issue #2681 r4).
 * @param {string} timezone
 * @returns {boolean}
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
