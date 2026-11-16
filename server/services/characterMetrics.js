/**
 * Character Metrics Grid
 *
 * The "other stats" block on the Character sheet: current-value engagement tiles read off
 * the same domain signals the skill registry already assembles.
 *
 * **Metrics are not skills.** Skills are *cumulative* (a level, once earned, never
 * un-learns). Metrics report the CURRENT value, streaks and rates included, and are free to
 * fall: `mentalist` says "you have practiced 200 times"; `postStreakDays` says "you have
 * practiced 4 days running".
 *
 * **A tile must be able to MOVE, and must claim only what its signal carries.**
 *   - A ratio whose denominator no UI can populate is a decorative constant; see
 *     `goalCompletionRate`, where an `abandoned` status exists in the enum but nothing writes it.
 *   - A tally is only as specific as its rows; see `mediaAssets`, an unfiltered count over an
 *     index that holds downloads and uploads, so it cannot be called "rendered".
 * When picking a new signal, check what the UI actually records before naming the tile.
 *
 * **No new DOMAIN reads.** Every `compute()` composes signals from `characterSignals.js`, the
 * same context the skills fan out over, so `GET /api/character` gains no stat reads.
 * (`daysActive` adds the one non-domain signal, `userTimezone`, because a cross-domain day
 * union has to pick a day boundary.) No new usage-event tracking sits behind any of this.
 *
 * **Derived on read, never persisted, never federated.** `getCharacter()` attaches these;
 * `saveCharacter()` strips them (`metrics` is in `character.js`'s `DERIVED_FIELDS`) and
 * `getWireCharacter()` keeps them off the wire. Usage differs per machine, so federating a
 * usage-derived value under LWW would let the peer you use *least* overwrite the one you use
 * *most*.
 *
 * **Three states, never two (sentinel + validate).** A tile is one of:
 *   - a real value   — `{ value: <number>, unavailable: false, notApplicable: false }`; a
 *                      real 0 is a legitimate answer ("no memories yet")
 *   - not applicable — `{ value: null, notApplicable: true }`: a ratio with an empty
 *                      denominator. 0 is NOT an honest number there ("0% of your goals are
 *                      done" for someone who never filed one).
 *   - unavailable    — `{ value: null, unavailable: true }`: the stat could not be read.
 * Both non-value states are distinct SYMBOLS rather than in-band `null`s, so a getter that
 * resolves `null` because it is broken lands in `unavailable` and cannot pass itself off as
 * a legitimately-empty ratio.
 *
 * See `characterSignals.js` for the read-failure gap the file-backed signals still have; it
 * applies identically here.
 */

import { computeUnifiedStreak } from '../lib/postStreak.js';
import { unionActiveDayKeys } from '../lib/activeDays.js';
import { createSignalContext } from './characterSignals.js';

// Returned by a compute() whose ratio has an empty denominator. A unique Symbol (not null/0)
// so it can never be mistaken for a real value a domain reported, nor for a failed read.
export const METRIC_NOT_APPLICABLE = Symbol('metric-not-applicable');

// Sentinel for a failed stat read. Mirrors characterSkills.js — same reasoning, and kept
// module-private in both so neither can leak into a response payload.
const STAT_UNAVAILABLE = Symbol('stat-unavailable');

/**
 * The registry. Each entry is `{ id, label, unit, hint, emptyLabel?, compute }`:
 *
 *   - `unit`       — `count` | `days` | `percent`. The client formats off this; the server
 *                    never ships a pre-formatted string.
 *   - `hint`       — one-line gloss of what the number measures, shown as the tile's
 *                    sublabel. Lives beside the compute that defines the semantic.
 *   - `emptyLabel` — what to say when compute returns METRIC_NOT_APPLICABLE. Only a ratio
 *                    metric needs one.
 *   - `compute(read)` — resolves to a non-negative number, or METRIC_NOT_APPLICABLE.
 */
export const METRICS = [
  {
    id: 'postStreakDays',
    label: 'POST Streak',
    unit: 'days',
    hint: 'Consecutive days of POST practice',
    // The unified sessions-OR-training streak: the same helper and user-timezone day boundary
    // the Progress page and dashboard widgets use, so the sheet can't quote a different streak.
    compute: async (read) => {
      const [sessions, training, today, timezone] = await Promise.all([
        read('postSessions'),
        read('postTraining'),
        read('postToday'),
        read('userTimezone'),
      ]);
      return computeUnifiedStreak(sessions, training, today, timezone).current;
    },
  },
  {
    id: 'healthLoggingStreak',
    label: 'Health Streak',
    unit: 'days',
    hint: 'Consecutive days with a health log',
    compute: async (read) => (await read('loggingStats')).currentStreak,
  },
  {
    id: 'daysActive',
    label: 'Days Active',
    unit: 'days',
    hint: 'Distinct days with any logged activity',
    // A UNION of day sets, never a SUM of per-domain day counts: summing would double-count
    // every day the user both practiced POST and logged a health entry.
    //
    // The two domains disagree about where a day starts (POST stamps `userLocalToday()`, health
    // logs stamp the server-local `getDateString()`), so the union standardizes on the
    // USER-local day and normalizes on read. `server/lib/activeDays.js` owns that decision;
    // notably a stored bare day LABEL is taken as authored, since no instant survives to
    // re-derive it. The shared streak helper re-keys legacy full-ISO entries through the same
    // boundary.
    //
    // Missing keys are a FAILED read, not an idle install: each source is validated as an array
    // and a throw lands in `readMetric`'s `unavailable`, so a shape mismatch never renders as a
    // confident "0 days active" for someone with years of history.
    compute: async (read) => {
      const [logging, postEnabled, timezone] = await Promise.all([
        read('loggingStats'),
        read('postEnabled'),
        read('userTimezone'),
      ]);
      if (!Array.isArray(logging?.activeDayKeys)) throw new Error('logging stats reported no activeDayKeys');

      if (!postEnabled) return unionActiveDayKeys([logging.activeDayKeys], timezone).length;

      const [sessions, training] = await Promise.all([
        read('postSessions'),
        read('postTraining'),
      ]);
      if (!Array.isArray(sessions)) throw new Error('POST sessions unreadable');
      if (!Array.isArray(training)) throw new Error('POST training log unreadable');

      return unionActiveDayKeys([
        logging.activeDayKeys,
        sessions.map((s) => s?.date),
        training.map((e) => e?.date),
      ], timezone).length;
    },
  },
  {
    id: 'recordsCreated',
    label: 'Records Created',
    unit: 'count',
    hint: 'Universes, works, catalog entries & scraps',
    // Same four tallies Wordsmith levels off — reported raw here rather than on the log
    // curve. Shares every read with that skill via the signal context.
    compute: async (read) => {
      const [universeCount, workCount, catalog] = await Promise.all([
        read('universeCount'),
        read('workCount'),
        read('catalogStats'),
      ]);
      return universeCount + workCount + catalog.total + catalog.scraps;
    },
  },
  {
    id: 'memoryCount',
    label: 'Memories',
    unit: 'count',
    hint: 'Active memories across PortOS',
    // "across PortOS", NOT "captured in Brain": `countMemories({})` filters by `status: 'active'`
    // ONLY, so agent-, CoS- and API-created memories are included, not just Brain-tagged ones
    // (`sourceAppId: 'brain'`). The whole store matches the `archivist` skill's reading of the
    // same signal; narrowing to Brain would undercount and make the two disagree.
    compute: async (read) => read('memoryCount'),
  },
  {
    id: 'mediaAssets',
    label: 'Media Assets',
    unit: 'count',
    hint: 'Images & videos in your media library',
    // Deliberately "assets in your library", NOT "media you rendered": `countAssets()` is an
    // unfiltered COUNT(*) over `media_assets`, which holds every on-disk asset (uploads included
    // via `reconcileMediaAssets()`, downloads via `videoDownload.js`). "Media Rendered" would
    // claim a provenance the row doesn't carry.
    //
    // In-app deletes decrement live (`unindexImage`/`unindexVideo` → `removeAsset`); the boot-time
    // `reconcileMediaAssets()` sweep is the backstop, so only an out-of-band disk delete can
    // read high until the next restart.
    compute: async (read) => read('assetCount'),
  },
  {
    id: 'goalCompletionRate',
    label: 'Goal Completion',
    unit: 'percent',
    hint: 'Share of your goals that are done',
    emptyLabel: 'No goals filed yet',
    // Denominator is ALL goals, not just "resolved" (completed + abandoned) ones. The
    // resolved-only denominator reads as follow-through but CANNOT MOVE here: the Goals UI
    // (`client/src/components/digital-twin/tabs/GoalsTab.jsx`) offers only Complete
    // (`status: 'completed'`) and Delete (drops the record). Nothing writes
    // `status: 'abandoned'` (it exists in `goalStatusEnum` and the API/monuments honor it),
    // so `resolved === completed` and the tile would read a constant 100% after the first
    // completion.
    //
    // A metric that cannot vary is worse than one with a debatable denominator, so this
    // measures what the UI records: of the goals filed, how many are done. If an "abandon"
    // outcome ships, abandoned goals land in the denominator without a change here.
    compute: async (read) => {
      const { goals } = await read('goals');
      const all = goals || [];
      // No goals at all → there is no rate. That is NOT 0% (see the header's three states):
      // "0% of your goals are done" is a lie to tell someone who has never filed one.
      if (all.length === 0) return METRIC_NOT_APPLICABLE;
      const completed = all.filter((g) => g?.status === 'completed').length;
      return Math.round((completed / all.length) * 100);
    },
  },
];

/**
 * Resolve one metric to its response shape, classifying the three states the header
 * describes:
 *   - `compute` rejects                → unavailable (the domain could not be read)
 *   - `compute` resolves non-finite    → unavailable (a fake 0 would read as real data)
 *   - `compute` returns the N/A symbol → notApplicable (no honest number exists yet)
 *   - `compute` resolves 0             → a real, earned 0
 */
async function readMetric(metric, read) {
  // `Promise.resolve().then(...)` rather than `metric.compute(read).catch(...)`: a compute
  // declared without `async` that throws synchronously would otherwise reject the whole GET
  // instead of degrading this one tile.
  const raw = await Promise.resolve().then(() => metric.compute(read)).catch((err) => {
    // `err?.message ?? err` — a non-Error rejection (a thrown string, a rejected `undefined`)
    // would otherwise throw *inside* the catch and defeat the per-metric containment below.
    console.warn(`⚠️ Character metric ${metric.id}: stat read failed — ${err?.message ?? err}`);
    return STAT_UNAVAILABLE;
  });

  // One uniform shape across all three states — every key is always present, so a consumer
  // never has to distinguish "absent key" from "null value" on top of everything else.
  const base = {
    id: metric.id,
    label: metric.label,
    unit: metric.unit,
    hint: metric.hint,
    emptyLabel: metric.emptyLabel ?? null,
  };

  if (raw === METRIC_NOT_APPLICABLE) {
    return { ...base, value: null, unavailable: false, notApplicable: true };
  }

  if (raw === STAT_UNAVAILABLE || !Number.isFinite(raw) || raw < 0) {
    if (raw !== STAT_UNAVAILABLE) {
      console.warn(`⚠️ Character metric ${metric.id}: stat returned a non-countable value`);
    }
    // value stays null — NOT 0 — so no consumer can render an unread domain as an idle one.
    return { ...base, value: null, unavailable: true, notApplicable: false };
  }

  return { ...base, value: raw, unavailable: false, notApplicable: false };
}

/**
 * Compute every metric. Signals are read in parallel and each failure is contained to its
 * own tile, so one unreachable domain degrades that tile to `unavailable` instead of failing
 * the whole `GET /api/character`.
 *
 * `read` is the shared signal context; pass the SAME one the skills got (see
 * `getCharacterSkills`) or the signals the two registries share get read twice.
 */
export async function getCharacterMetrics(read = createSignalContext()) {
  const postEnabled = await read('postEnabled');
  const metrics = postEnabled ? METRICS : METRICS.filter((metric) => metric.id !== 'postStreakDays');
  return Promise.all(metrics.map((metric) => readMetric(metric, read)));
}
