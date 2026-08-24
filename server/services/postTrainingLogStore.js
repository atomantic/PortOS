/**
 * POST training-entry read boundary.
 *
 * Extracted out of meatspacePostTraining.js so the storage read has no
 * dependency on that module. meatspacePost.js (via postActivityStreak.js)
 * needs training-log entries for the unified-streak/progress aggregation;
 * importing them from meatspacePostTraining.js would create a static
 * circular dependency, since meatspacePostTraining.js also needs
 * getUnifiedActivityStreak (which needs meatspacePost.js's session data).
 * This module sits below both, with no imports of either.
 */

import { withDerivedDayKeys } from '../lib/postStreak.js';
import { getUserTimezone } from './userTimezone.js';
import { listStoredTrainingEntries } from './postRunStore.js';

/**
 * All training-log entries in chronological (append) order — the feed the
 * unified progress aggregation reads (both meatspacePostTraining and
 * meatspacePostMemory practice write normalized training runs).
 *
 * Each entry's `date` is RE-DERIVED from its `timestamp` in the user's CURRENT
 * timezone (issue #4168), so a `settings.timezone` change re-keys existing
 * practice history on read rather than leaving it frozen in the zone that was
 * active when it was written. The normalized store keeps the authored day as a
 * cache; readers still derive from the attempt timestamp.
 *
 * @param {{ strict?: boolean }} [options] - file-backend compatibility option;
 *   `strict: true` throws rather than reporting a corrupt legacy log as empty.
 */
export async function getAllTrainingEntries(options) {
  const entries = await listStoredTrainingEntries(options);
  return withDerivedDayKeys(entries, await getUserTimezone());
}
