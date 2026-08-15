/**
 * POST training-log storage primitives — read/write of
 * data/meatspace/post-training-log.json.
 *
 * Extracted out of meatspacePostTraining.js so the raw data access has no
 * dependency on that module. meatspacePost.js (via postActivityStreak.js)
 * needs training-log entries for the unified-streak/progress aggregation;
 * importing them from meatspacePostTraining.js would create a static
 * circular dependency, since meatspacePostTraining.js also needs
 * getUnifiedActivityStreak (which needs meatspacePost.js's session data).
 * This module sits below both, with no imports of either.
 */

import { join } from 'path';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { withDerivedDayKeys } from '../lib/postStreak.js';
import { getUserTimezone } from '../lib/timezone.js';

const MEATSPACE_DIR = PATHS.meatspace;
const TRAINING_LOG_FILE = join(MEATSPACE_DIR, 'post-training-log.json');

/**
 * @param {{ strict?: boolean }} [options] - `strict: true` throws when the training
 *   log is present-but-unreadable/corrupt rather than falling back to an empty log.
 *   See `loadSessions` in meatspacePost.js for the rationale (#2726).
 */
export async function loadTrainingLog({ strict = false } = {}) {
  const data = await readJSONFile(TRAINING_LOG_FILE, { entries: [] }, { allowArray: false, strict });
  if (strict && !Array.isArray(data?.entries)) {
    throw new Error(`POST training log malformed: ${TRAINING_LOG_FILE}`);
  }
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

export async function saveTrainingLog(data) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(TRAINING_LOG_FILE, data);
}

/**
 * All training-log entries in chronological (append) order — the feed the
 * unified progress aggregation reads (both meatspacePostTraining and
 * meatspacePostMemory practice write to the same `post-training-log.json`).
 *
 * Each entry's `date` is RE-DERIVED from its `timestamp` in the user's CURRENT
 * timezone (issue #4168), so a `settings.timezone` change re-keys existing
 * practice history on read rather than leaving it frozen in the zone that was
 * active when it was written. `loadTrainingLog` above stays raw — the write
 * paths must round-trip the stored record untouched.
 *
 * @param {{ strict?: boolean }} [options] - `strict: true` throws rather than
 *   reporting an unreadable log as zero entries (#2726).
 */
export async function getAllTrainingEntries(options) {
  const data = await loadTrainingLog(options);
  return withDerivedDayKeys(data.entries, await getUserTimezone());
}
