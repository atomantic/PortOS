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
 * This module stays a cache, not a policy. A failed read is cached like any other, so a
 * downed Postgres is hit once per request rather than once per skill AND once per metric
 * that reads it.
 *
 * **Every reader must be able to report failure (#2726).** That propagation is only worth
 * anything if the readers actually reject when they can't read. The DB-backed ones always
 * did (a failed `query()` throws), but the file-backed four bottom out in `readJSONFile`,
 * which returns its default on *every* read error — so an unreadable file arrived here
 * indistinguishable from an empty one and scored a real-looking 0. They now pass
 * `{ strict: true }`, which throws on a present-but-unreadable/corrupt file while still
 * treating a genuinely absent one (ENOENT) as the trustworthy empty it is. This is the ONLY
 * place that opts in: every other caller of those getters keeps the swallow-and-default
 * behavior, which is correct for a UI that should degrade rather than break.
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
 *
 * The file-backed readers pass `{ strict: true }` — see the header. Keep it on any reader
 * added here whose source can swallow a read error, or the signal silently becomes a lie
 * the consumers have no way to detect.
 */
export const SIGNAL_READERS = {
  universeCount: () => countUniverses(),
  workCount: () => countWorks(),
  catalogStats: () => getCatalogStats(),
  postSessions: () => getPostSessions(undefined, undefined, { strict: true }),
  postTraining: () => getAllTrainingEntries({ strict: true }),
  // Today's `YYYY-MM-DD` in the USER's configured timezone — the same day boundary
  // meatspacePost.js anchors its streaks to. Deriving "today" from the server's local clock
  // instead would let the Character sheet's POST streak disagree with the Progress page's by
  // a day for any user whose configured timezone isn't the server's.
  postToday: () => userLocalToday(),
  loggingStats: () => getLoggingStats({ strict: true }),
  goals: () => getGoals({ strict: true }),
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

    // `Promise.resolve().then(reader)` rather than `reader()`: it normalizes a getter that
    // throws SYNCHRONOUSLY into a rejection, so a consumer's `.catch()`-based unavailable
    // classification always sees it instead of the throw escaping `read()` and rejecting the
    // whole GET. A settled promise re-delivers its value (or re-throws its error) to every
    // later awaiter, so caching the promise is all the memoization either case needs.
    if (!cache.has(signalId)) cache.set(signalId, Promise.resolve().then(reader));

    return cache.get(signalId);
  };
}
