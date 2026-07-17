/**
 * Character Signal Context (#2676, epic #2672)
 *
 * ONE read per domain stat, shared by every surface `getCharacter()` derives on read.
 *
 * The Character sheet now derives two things from the same domain stats: the per-domain
 * `skills` (#2674) and the `metrics` grid (#2676). Six of the nine signals below feed BOTH —
 * Wordsmith and `recordsCreated` are the same three reads, Mentalist and `postStreakDays` are
 * the same two, and so on. Letting each registry call the getters itself would have doubled
 * the fan-out of a route the CyberCity HUD polls every 15s, so the reads moved here and both
 * registries now take a `read` function instead of importing the getters directly.
 *
 * **Per-request, never module-level.** `createSignalContext()` mints a fresh cache per
 * `getCharacter()` call. A module-level cache would be a correctness bug, not an
 * optimization: these stats change as the user uses PortOS, and a sheet that never notices
 * the session you just logged is worse than a slow one.
 *
 * **Failures propagate; they are not classified here.** A reader that rejects makes `read()`
 * reject with the same error, and the *consumer* decides what that means (both registries
 * turn it into an explicit `unavailable`, never a fake 0 — see `readSkill` / `readMetric`).
 * This module stays a cache, not a policy: the memoized entry settles to a discriminated
 * `{ ok }` result so a cached rejection can never surface as an unhandled rejection, and
 * `read()` re-throws it fresh to each caller.
 *
 * **Known gap (#2726).** Only the DB-backed readers (`universeCount`, `workCount`,
 * `catalogStats`, `memoryCount`, `assetCount`) actually reject on failure. `postSessions`,
 * `postTraining`, `loggingStats`, and `goals` bottom out in `readJSONFile`, which returns its
 * default on *every* read error — so an unreadable file is indistinguishable here from an
 * empty one. Documented at length in `characterSkills.js`; the strict-read variants that
 * close it are tracked in #2726. Nothing here changes when they land — the moment a getter
 * starts rejecting, both registries already classify it correctly.
 */

import { countUniverses } from './universeBuilder.js';
import { countWorks } from './writersRoom/local.js';
import { getCatalogStats } from './catalogDB.js';
import { getPostSessions } from './meatspacePost.js';
import { getAllTrainingEntries } from './meatspacePostTraining.js';
import { getLoggingStats } from './meatspaceLoggingStats.js';
import { getGoals } from './identity/goals.js';
import { countMemories } from './memoryBackend.js';
import { countAssets } from './mediaAssetIndex/db.js';
import { userLocalToday } from '../lib/timezone.js';

/**
 * Every domain stat the derived Character surfaces are allowed to read, keyed by signal id.
 * Adding a signal here is the ONLY way to add a read — a registry that reaches for a getter
 * directly re-opens the duplicate-read hole this module exists to close.
 *
 * All nine are tallies or already-aggregated summaries, never listings: `countUniverses` /
 * `countWorks` / `countMemories` / `countAssets` are `COUNT(*)`s (#2729), so no consumer can
 * accidentally materialize every record just to read a `.length`.
 */
export const SIGNAL_READERS = {
  universeCount: () => countUniverses(),
  workCount: () => countWorks(),
  catalogStats: () => getCatalogStats(),
  postSessions: () => getPostSessions(),
  postTraining: () => getAllTrainingEntries(),
  // Today's `YYYY-MM-DD` in the USER's configured timezone — the same day boundary
  // meatspacePost.js anchors its streaks to. Deriving "today" from the server's local clock
  // instead would let the Character sheet's POST streak disagree with the Progress page's by
  // a day for any user whose configured timezone isn't the server's.
  postToday: () => userLocalToday(),
  loggingStats: () => getLoggingStats(),
  goals: () => getGoals(),
  memoryCount: () => countMemories({}),
  assetCount: () => countAssets(),
};

/**
 * Mint a read-once context. Returns `read(signalId)` → a promise of that signal's value,
 * resolving the underlying getter at most once no matter how many skills/metrics ask.
 *
 * Throws synchronously on an unknown signal id. That is deliberate rather than a rejection:
 * a rejection would be caught by the caller's `unavailable` classification and a typo'd id
 * would masquerade as "this domain is down" forever. The registry suites drive every
 * skill/metric through a fully-stubbed context and assert nothing comes back unavailable,
 * which turns such a typo into a red test instead of a silent lie.
 */
export function createSignalContext() {
  const cache = new Map();

  return function read(signalId) {
    const reader = SIGNAL_READERS[signalId];
    if (!reader) throw new Error(`Unknown character signal: ${signalId}`);

    if (!cache.has(signalId)) {
      // Settle to `{ ok }` so the MEMOIZED promise never rejects: a cached rejected promise
      // that a later consumer doesn't await would surface as an unhandled rejection and (under
      // Node's default policy) take the process down. `Promise.resolve().then(reader)` also
      // normalizes a getter that throws synchronously into a rejection.
      cache.set(
        signalId,
        Promise.resolve()
          .then(reader)
          .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
      );
    }

    // A fresh derived promise per call, rejecting with the original error — so every consumer
    // sees the failure and classifies it itself.
    return cache.get(signalId).then((result) => {
      if (!result.ok) throw result.error;
      return result.value;
    });
  };
}
