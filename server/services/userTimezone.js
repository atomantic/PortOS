/**
 * The user's configured timezone — the settings-backed half of the timezone
 * helpers.
 *
 * These three read `settings.json`, which is why they live in services: the
 * pure conversion primitives they build on (`todayInTimezone`, `getLocalParts`,
 * …) stay in `lib/timezone.js`, which must not import upward into services
 * (issue #4901). Everything here takes its timezone from settings; everything
 * in lib takes it as an argument.
 */

import { getSettings } from './settings.js'
import { todayInTimezone } from '../lib/timezone.js'

/**
 * Get the user's configured timezone, falling back to system timezone.
 * @returns {Promise<string>} IANA timezone string (e.g., 'America/Los_Angeles')
 */
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
 * Get the UTC-ms timestamp at which the user's `timezone` setting last actually
 * changed, or null when it has never been recorded. Stamped by settings.js's
 * write path (`save()`) only when the `timezone` value genuinely differs from
 * the prior on-disk value. Timezone-dependent schedulers use this to avoid
 * replaying a slot that "occurred" under a timezone that was no longer active —
 * see catchUpMissedSlot in meatspacePostReminder.js (#2040).
 *
 * Sentinel discipline: null (not a number, ≤ 0) means "never changed / unset",
 * so callers must NOT treat absence as a floor — an unset value gates nothing.
 * @returns {Promise<number|null>} UTC ms, or null when unset.
 */
export async function getTimezoneUpdatedAt() {
  const settings = await getSettings()
  const ts = settings.timezoneUpdatedAt
  return typeof ts === 'number' && ts > 0 ? ts : null
}

/**
 * Today's `YYYY-MM-DD` in the USER's configured timezone — the
 * resolve-tz-then-derive-today combination every per-day feature keying off the
 * local day needs (POST daily status/streaks in meatspacePost.js &
 * meatspacePostTraining.js, the Daily Driver). It lives in this standalone
 * module so the scored-session service and the training-log service share ONE
 * day boundary without importing each other — they already have a mutual
 * dependency and this avoids adding to it.
 *
 * The server runs `TZ=UTC`, so deriving the day from a bare
 * `new Date().toISOString()` would use the server's UTC day and misfile activity
 * around the local/UTC midnight boundary for non-UTC users (issue #2681).
 * Pass `atDate` (the instant a writer already captured for its timestamp) so the
 * day key derives from the SAME instant, never a fresh `new Date()` sampled after
 * the awaited settings read — which could cross midnight and split the two fields
 * onto different days (issue #2681 r5).
 * @param {Date} [atDate] - instant to key (defaults to now)
 * @returns {Promise<string>}
 */
export async function userLocalToday(atDate = new Date()) {
  return todayInTimezone(await getUserTimezone(), atDate)
}
