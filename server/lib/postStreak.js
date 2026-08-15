/**
 * POST practice-streak math (pure, side-effect-free).
 *
 * Extracted from meatspacePost.js so BOTH scored sessions and the training log
 * (Morse / memory practice) compute streaks with ONE implementation — the DST-
 * safe `computePostStreaks` — instead of the two divergent copies that used to
 * disagree (the training log previously rolled its own raw-`Date` streak with no
 * grace window and no longest-streak). Lives in `server/lib/` (rather than being
 * exported from a service) so meatspacePostTraining.js can import it without a
 * circular dependency back into meatspacePost.js.
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

// Field order matters: `startedAt` is when the activity actually happened, and
// `submitPostSession` deliberately preserves it across an idempotent re-submit,
// so it is the stable anchor. `completedAt` moves on re-submit and `timestamp`
// is what the training log / Morse rounds carry instead.
const INSTANT_FIELDS = ['startedAt', 'completedAt', 'timestamp'];

/**
 * Day key for an INSTANT, in the user's timezone — or null when the value isn't
 * one. A bare `YYYY-MM-DD` string is a day LABEL, not an instant: it carries no
 * zone to re-derive from, so `toUserDayKey` takes it as authored rather than
 * reading it as UTC midnight (which would shift it a day west of UTC).
 */
function instantDayKey(instant, timezone) {
  if (!timezone) return null;
  if (typeof instant === 'number' && Number.isFinite(instant)) {
    const at = new Date(instant);
    // Round-trip through ISO so `toUserDayKey` stays the ONE place that turns an
    // instant into a user-local day (this module keeps its pure, single-import shape).
    return Number.isNaN(at.getTime()) ? null : toUserDayKey(at.toISOString(), timezone);
  }
  return typeof instant === 'string' ? toUserDayKey(instant, timezone) : null;
}

/**
 * The day key a record belongs to, RE-DERIVED from the instant it happened
 * (`startedAt` / `completedAt` / `timestamp`) rather than read off the stored
 * `date` (issue #4168).
 *
 * A stored `date` is frozen in whatever timezone was configured when it was
 * written, so once the user changes `settings.timezone` the old keys disagree
 * with the new-zone readers — a session saved as `2026-07-15` under one zone
 * reads as "not today" under another. Deriving from the instant makes the
 * stored `date` a pure cache the readers ignore, which is what the reminder
 * path (`meatspacePostReminder.js` `isOnLocalDay`) has always done.
 *
 * Falls back to the stored `date` only when no usable instant survives (legacy
 * records written before the timestamps existed) — there is nothing left to
 * re-derive from there, so it is taken as authored.
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
 * Re-stamp a batch of activity records with their re-derived day key, so every
 * downstream reader (and the client, which receives these records verbatim)
 * sees ONE timezone-current `date`. Apply this at the read boundary — the
 * loaders (`getPostSessions`, `getAllTrainingEntries`) — never on the write
 * path, which must keep stamping and preserving the original stored value.
 *
 * @param {Array} records
 * @param {string} [timezone]
 * @returns {Array} records with `date` replaced by the derived key
 */
export function withDerivedDayKeys(records, timezone) {
  if (!Array.isArray(records)) return [];
  return records.map(r => (r && typeof r === 'object' ? { ...r, date: recordDayKey(r, timezone) } : r));
}

// Local-date arithmetic on `YYYY-MM-DD` strings via UTC midnight so day math
// never drifts across DST boundaries (the activity-streak bug class).
export function ymdToUTC(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function ymdShift(s, deltaDays) {
  return new Date(ymdToUTC(s) + deltaDays * 86400000).toISOString().split('T')[0];
}

/**
 * Compute POST practice streaks from activity records. Pure (takes `todayStr`
 * explicitly) so it's unit-testable without faking the clock. Each record only
 * needs a `date` (`YYYY-MM-DD` or a full ISO timestamp — both normalized) and,
 * for `todayScore`, an optional numeric `score`.
 *
 * - `completedToday`  — at least one record dated today
 * - `currentStreak`   — consecutive days with a record counting back from
 *   today; a not-yet-done today does NOT break the streak as long as yesterday
 *   has one (grace window), mirroring `usage.js` `calculateStreak`
 * - `longestStreak`   — longest consecutive-day run in all history
 * - `lastDate`        — most recent record date (null if never active)
 * - `todayScore`      — best record score recorded today (null if none)
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
 * ONE unified streak across scored sessions AND the training log: a day counts
 * as active if it has EITHER a scored session or a training-log entry (Morse /
 * memory practice). Reuses `computePostStreaks` so the DST-safe grace-window
 * semantics are identical to the scored-session streak. Returns the progress-API
 * shape (`current` / `longest` / `lastActiveDate`).
 *
 * @param {Array} sessions - scored POST sessions
 * @param {Array} trainingEntries - training-log entries
 * @param {string} todayStr - user's local `YYYY-MM-DD` today
 * @param {string} [timezone] - user timezone for legacy ISO dates
 */
export function computeUnifiedStreak(sessions, trainingEntries, todayStr, timezone) {
  // Project the day key AND the instants it is re-derived from (#4168) — a bare
  // `{ date }` projection would strip the timestamps and silently fall the whole
  // unified streak back onto the stale stored keys.
  const toActivity = r => ({ date: r?.date, startedAt: r?.startedAt, completedAt: r?.completedAt, timestamp: r?.timestamp });
  const activity = [
    ...(sessions || []).map(toActivity),
    ...(trainingEntries || []).map(toActivity),
  ];
  const { currentStreak, longestStreak, lastDate } = computePostStreaks(activity, todayStr, timezone);
  return { current: currentStreak, longest: longestStreak, lastActiveDate: lastDate };
}
