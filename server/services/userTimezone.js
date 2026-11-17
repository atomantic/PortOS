/**
 * The user's configured timezone: the settings-backed half of the timezone
 * helpers. The pure conversion primitives stay in `lib/timezone.js`, which must
 * not import upward into services.
 */

import { getSettings } from './settings.js'
import { todayInTimezone } from '../lib/timezone.js'

/** The user's configured timezone, falling back to the system timezone. @returns {Promise<string>} IANA name */
export async function getUserTimezone() {
  const settings = await getSettings()
  const tz = settings.timezone
  if (tz) {
    // Validate the configured timezone; fall back to system timezone if invalid
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {
      console.error(`❌ Invalid configured timezone "${tz}", falling back to system default`)
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * UTC-ms at which the `timezone` setting last actually changed (stamped by
 * settings.js `save()`), or null when never recorded: callers must not treat
 * absence as a floor. Schedulers use it to avoid replaying a slot from a
 * timezone no longer active (catchUpMissedSlot in meatspacePostReminder.js).
 * @returns {Promise<number|null>} UTC ms, or null when unset.
 */
export async function getTimezoneUpdatedAt() {
  const settings = await getSettings()
  const ts = settings.timezoneUpdatedAt
  return typeof ts === 'number' && ts > 0 ? ts : null
}

/**
 * Today's `YYYY-MM-DD` in the user's configured timezone (the server runs
 * `TZ=UTC`, so a bare `toISOString()` misfiles activity near local midnight).
 * Pass `atDate` (the writer's own timestamp instant) so the day key can't cross
 * midnight during the awaited settings read.
 * @param {Date} [atDate] - instant to key (defaults to now)
 * @returns {Promise<string>}
 */
export async function userLocalToday(atDate = new Date()) {
  return todayInTimezone(await getUserTimezone(), atDate)
}
