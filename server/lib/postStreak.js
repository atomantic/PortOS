/**
 * Pure DST-safe POST practice-streak math shared by scored sessions and the training log.
 *
 * the training log once rolled its own raw-`Date` streak with no grace window), plus `computeUnifiedStreak` (a day is active with EITHER a session or a practice entry), `normalizeYmd`, and `recordDayKey` / `withDerivedDayKeys` (re-derive a record's day key from its `startedAt`/`completedAt`/`timestamp` instant, so readers ignore a `date` frozen in a previously-configured timezone). In `server/lib/` so meatspacePostTraining.js can import it without a cycle back into meatspacePost.js.
 */

import { toUserDayKey } from './activeDays.js';

/**
 * Normalize a stored day label or legacy ISO instant.
 *
 * @param {unknown} value - a bare day label or full ISO timestamp
 * @param {string} [timezone] - user timezone for re-keying legacy instants
 * @returns {string|null} a day key, or null for an absent/invalid timezone-aware value
 */
export function normalizeYmd(value, timezone) {
  if (!value) return null;
  const raw = String(value);
  return timezone && raw.includes('T') ? toUserDayKey(raw, timezone) : raw.split('T')[0];
}

// Field order matters: `startedAt` is when the activity happened and is preserved across an idempotent re-submit (the stable anchor); `completedAt` moves on re-submit; `timestamp` is what the training log / Morse rounds carry.
const INSTANT_FIELDS = ['startedAt', 'completedAt', 'timestamp'];

/** Day key for an INSTANT in the user's timezone, or null. A bare `YYYY-MM-DD` is a day LABEL (no zone to re-derive from), so `toUserDayKey` takes it as authored rather than as UTC midnight (a day west of UTC). */
function instantDayKey(instant, timezone) {
  if (!timezone) return null;
  if (typeof instant === 'number' && Number.isFinite(instant)) {
    const at = new Date(instant);
    // Round-trip through ISO so `toUserDayKey` stays the ONE place turning an instant into a user-local day.
    return Number.isNaN(at.getTime()) ? null : toUserDayKey(at.toISOString(), timezone);
  }
  return typeof instant === 'string' ? toUserDayKey(instant, timezone) : null;
}

/**
 * The day key a record belongs to, RE-DERIVED from its instant (`startedAt` / `completedAt` / `timestamp`) rather than the stored `date` (#4168), which is frozen in the timezone configured when written and disagrees with
 * new-zone readers after `settings.timezone` changes (as `meatspacePostReminder.js` `isOnLocalDay` already does). Falls back to the stored `date` only when no usable instant survives (legacy records).
 *
 * @param {object} record - an activity record (session / training entry / round)
 * @param {string} [timezone] - user timezone; without it the stored `date` wins
 * @returns {string|null} a `YYYY-MM-DD` day key, or null when undatable
 */
export function recordDayKey(record, timezone) {
  if (!record || typeof record !== 'object') return null;
  for (const field of INSTANT_FIELDS) {
    const derived = instantDayKey(record[field], timezone);
    if (derived) return derived;
  }
  return normalizeYmd(record.date, timezone);
}

/**
 * Re-stamp activity records with their re-derived day key so every reader (and the client) sees ONE timezone-current `date`. Apply at the read boundary (`getPostSessions`, `getAllTrainingEntries`), never on the write path.
 *
 * @param {Array} records
 * @param {string} [timezone]
 * @returns {Array} records with `date` replaced by the derived key
 */
export function withDerivedDayKeys(records, timezone) {
  if (!Array.isArray(records)) return [];
  return records.map(r => (r && typeof r === 'object' ? { ...r, date: recordDayKey(r, timezone) } : r));
}

// Local-date arithmetic via UTC midnight so day math never drifts across DST (the activity-streak bug class).
export function ymdToUTC(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function ymdShift(s, deltaDays) {
  return new Date(ymdToUTC(s) + deltaDays * 86400000).toISOString().split('T')[0];
}

/**
 * Compute POST practice streaks from records. Pure (takes `todayStr`, so testable without faking the clock); each record needs a `date` (`YYYY-MM-DD` or full ISO) and, for `todayScore`, an optional numeric `score`.
 * `completedToday`: a record dated today; `currentStreak`: consecutive days counting back from today, where a not-yet-done today does NOT break it while yesterday has one (grace window, as `usage.js` `calculateStreak`);
 * `longestStreak`; `lastDate` (null if never active); `todayScore` (best today, null if none).
 *
 * @param {Array} records - activity records with a `date` field
 * @param {string} todayStr - user's local `YYYY-MM-DD` today
 * @param {string} [timezone] - user timezone for legacy ISO dates
 */
export function computePostStreaks(records, todayStr, timezone) {
  const dateSet = new Set((records || []).map(s => recordDayKey(s, timezone)).filter(Boolean));
  const dates = Array.from(dateSet).sort();
  const completedToday = dateSet.has(todayStr);
  const lastDate = dates.length ? dates[dates.length - 1] : null;

  const todayScores = (records || [])
    .filter(s => recordDayKey(s, timezone) === todayStr && typeof s?.score === 'number')
    .map(s => s.score);
  const todayScore = todayScores.length ? Math.max(...todayScores) : null;

  let longestStreak = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    run = prev && ymdToUTC(d) - ymdToUTC(prev) === 86400000 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = d;
  }

  // Anchor the current streak at today, or yesterday if today isn't done yet.
  let cursor = completedToday ? todayStr : ymdShift(todayStr, -1);
  let currentStreak = 0;
  while (dateSet.has(cursor)) {
    currentStreak += 1;
    cursor = ymdShift(cursor, -1);
  }

  return { completedToday, currentStreak, longestStreak, lastDate, todayScore };
}

/**
 * ONE unified streak across scored sessions AND the training log (Morse / memory practice): a day is active with EITHER, reusing `computePostStreaks` for identical grace-window semantics. Returns the progress-API shape (`current` / `longest` / `lastActiveDate`).
 *
 * @param {Array} sessions - scored POST sessions
 * @param {Array} trainingEntries - training-log entries
 * @param {string} todayStr - user's local `YYYY-MM-DD` today
 * @param {string} [timezone] - user timezone for legacy ISO dates
 */
export function computeUnifiedStreak(sessions, trainingEntries, todayStr, timezone) {
  // Project the day key AND the instants it is re-derived from (#4168); a bare `{ date }` would strip the timestamps and fall the unified streak back onto stale stored keys.
  const toActivity = r => ({ date: r?.date, startedAt: r?.startedAt, completedAt: r?.completedAt, timestamp: r?.timestamp });
  const activity = [
    ...(sessions || []).map(toActivity),
    ...(trainingEntries || []).map(toActivity),
  ];
  const { currentStreak, longestStreak, lastDate } = computePostStreaks(activity, todayStr, timezone);
  return { current: currentStreak, longest: longestStreak, lastActiveDate: lastDate };
}
