/**
 * Unified activity streak (#2091) across POST sessions and training practice. Own
 * module because it needs both postSessionHistory.js (sessions) and
 * meatspacePostTraining.js (entries, passed in by the caller): defining it in
 * either would create a circular import.
 */
import { getPostSessions } from './meatspace/postSessionHistory.js';
import { computeUnifiedStreak } from '../lib/postStreak.js';
import { todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';

/**
 * ONE unified streak (#2091): a day is active with a scored session or a
 * training-log entry. Computed over ALL history.
 * @param {Array} training - training-log entries, passed in (see module docblock).
 * @param {string} [todayStr] - defaults to the user's local today.
 * @param {string} [timezone] - defaults to the user's configured timezone.
 */
export async function getUnifiedActivityStreak(training, todayStr, timezone) {
  const atDate = new Date();
  const resolvedTimezone = timezone ?? await getUserTimezone();
  const day = todayStr ?? todayInTimezone(resolvedTimezone, atDate);
  const sessions = await getPostSessions();
  return computeUnifiedStreak(sessions, training, day, resolvedTimezone);
}
