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
