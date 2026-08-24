/**
 * Shared unified-activity-streak computation (issue #2091) — ONE definition of
 * the streak across scored POST sessions AND training-log practice, so every
 * surface (launcher, dashboard widgets, Morse trainer, Progress page) agrees.
 *
 * Lives in its own module rather than meatspacePost.js or
 * meatspacePostTraining.js because it needs data from BOTH: sessions (owned by
 * meatspacePost.js) and training-log entries (owned by meatspacePostTraining.js).
 * Defining it in either of those two would force the other to import it back,
 * creating a static circular dependency between them. Instead this module
 * depends one-way on meatspacePost.js for getPostSessions(), and takes the
 * caller's training entries as a parameter — meatspacePostTraining.js already
 * has them in scope from its own training-log load, so it never needs to import
 * this module's sibling for them.
 */
import { getPostSessions } from './meatspacePost.js';
import { computeUnifiedStreak } from '../lib/postStreak.js';
import { todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';

/**
 * ONE unified activity streak across scored sessions AND the training log — the
 * single number every POST surface (launcher, Morse trainer, dashboard widgets)
 * should show, so they can't disagree (issue #2091). A day is active with EITHER
 * a scored session or a training-log entry (Morse / memory practice). Computed
 * over ALL history, independent of any stats window.
 *
 * @param {Array} training - training-log entries (e.g. from
 *   getAllTrainingEntries() in meatspacePostTraining.js). Taken as a parameter
 *   rather than fetched here so this module doesn't need to import
 *   meatspacePostTraining.js — see the module docblock above.
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
