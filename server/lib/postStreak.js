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

// A date key is always the local `YYYY-MM-DD` prefix. Session dates are stored
// that way already; some training-log entries (memory practice) store a full
// ISO timestamp, so normalize both to the day prefix before any set math.
function normalizeYmd(value) {
  if (!value) return null;
  return String(value).split('T')[0];
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
 */
export function computePostStreaks(records, todayStr) {
  const dateSet = new Set((records || []).map(s => normalizeYmd(s?.date)).filter(Boolean));
  const dates = Array.from(dateSet).sort();
  const completedToday = dateSet.has(todayStr);
  const lastDate = dates.length ? dates[dates.length - 1] : null;

  const todayScores = (records || [])
    .filter(s => normalizeYmd(s?.date) === todayStr && typeof s?.score === 'number')
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
 */
export function computeUnifiedStreak(sessions, trainingEntries, todayStr) {
  const activity = [
    ...(sessions || []).map(s => ({ date: s?.date })),
    ...(trainingEntries || []).map(e => ({ date: e?.date })),
  ];
  const { currentStreak, longestStreak, lastDate } = computePostStreaks(activity, todayStr);
  return { current: currentStreak, longest: longestStreak, lastActiveDate: lastDate };
}
