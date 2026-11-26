/**
 * Character Signal Context: ONE read per domain stat, shared by the `skills` and `metrics` registries
 * (they take a `read` function so the OpenWorld HUD's 15s poll isn't doubled).
 * Per-request, never module-level: stats change as the user uses PortOS.
 * Failures propagate; the consumer turns a rejection into `unavailable`, never a fake 0.
 * Readers must be able to report failure (#2726): file-backed ones pass `{ strict: true }` (ENOENT stays a trustworthy empty).
 */

import { countUniverses } from './universeBuilder.js';
import { countWorks } from './writersRoom/local.js';
import { getCatalogStats } from './catalog/catalogDB.js';
import { getPostSessions } from './meatspace/postSessionHistory.js';
import { getAllTrainingEntries } from './meatspace/meatspacePostTraining.js';
import { getLoggingStats } from './meatspace/meatspaceLoggingStats.js';
import { getGoals } from './identity/goals.js';
import { countMemories } from './memoryBackend.js';
import { countAssets } from './mediaAssetIndex/db.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';
import { getUserTimezone, userLocalToday } from './userTimezone.js';

/**
 * Every domain stat the derived Character surfaces may read, keyed by signal id. Tallies or aggregates,
 * never listings (#2729); `activeDayKeys` is the one bounded exception (#4120). Keep `{ strict: true }`
 * on any reader whose source can swallow a read error, or the signal silently becomes a lie.
 */
export const SIGNAL_READERS = {
  universeCount: () => countUniverses(),
  workCount: () => countWorks(),
  catalogStats: () => getCatalogStats(),
  postSessions: () => getPostSessions(undefined, undefined, { strict: true }),
  postTraining: () => getAllTrainingEntries({ strict: true }),
  postEnabled: () => isInstanceFeatureEnabled('post'),
  // Today's `YYYY-MM-DD` in the USER's configured timezone, the same boundary postSessionHistory.js anchors streaks to.
  postToday: () => userLocalToday(),
  // The user's IANA timezone, for consumers that re-key a stored INSTANT to the user's day
  // (`daysActive`, `postStreakDays`); keeps the day-boundary decision in ONE place.
  userTimezone: () => getUserTimezone(),
  // `withActiveDayKeys` (#4120): raw union of health-log day keys for the cross-domain `daysActive` metric; opt-in so the polled endpoint doesn't ship a growing list it never reads.
  loggingStats: () => getLoggingStats({ strict: true, withActiveDayKeys: true }),
  goals: () => getGoals({ strict: true }),
  memoryCount: () => countMemories({}),
  assetCount: () => countAssets(),
};

/** Mint a read-once context: `read(signalId)` resolves each getter at most once. Throws synchronously on an unknown id so a typo can't masquerade as "domain is down". */
export function createSignalContext() {
  const cache = new Map();

  return function read(signalId) {
    const reader = SIGNAL_READERS[signalId];
    if (!reader) throw new Error(`Unknown character signal: ${signalId}`);

    // `Promise.resolve().then(reader)` turns a SYNCHRONOUS throw into a rejection so the consumer's
    // `.catch()`-based unavailable classification always sees it. A settled promise re-delivers to every later awaiter.
    if (!cache.has(signalId)) cache.set(signalId, Promise.resolve().then(reader));

    return cache.get(signalId);
  };
}
