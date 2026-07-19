/**
 * Character Metrics Grid (#2676, epic #2672)
 *
 * The "other stats" block on the Character sheet: current-value engagement tiles read off
 * the same domain signals the skill registry (#2674) already assembles, so the sheet reads
 * like a profile of the human's actual activity rather than a D&D pastiche.
 *
 * **Metrics are not skills.** Skills are *cumulative* — a level, once earned, never
 * un-learns itself. Metrics report the CURRENT value, streaks and rates included, and are
 * free to fall. The two are complementary readings of one signal set: `mentalist` says "you
 * have practiced 200 times"; `postStreakDays` says "you have practiced 4 days running".
 *
 * **A tile must be able to MOVE, and must claim only what its signal carries.** Two traps
 * worth naming, because both produced a plausible-looking tile that was really a constant or
 * an overclaim (caught in review):
 *   - A ratio whose denominator no UI can populate is a decorative constant — see
 *     `goalCompletionRate`, where an `abandoned` status exists in the enum but nothing writes.
 *   - A tally is only as specific as its rows — see `mediaAssets`, an unfiltered count over an
 *     index that deliberately holds downloads and uploads, so it cannot be called "rendered".
 * When picking a new signal, check what the UI actually records before naming the tile.
 *
 * **No new reads.** Every `compute()` composes signals from `characterSignals.js`, the same
 * context the skills fan out over — so the six tiles below add ZERO stat reads to
 * `GET /api/character`, and a domain the user has never touched still costs nothing extra.
 * There is deliberately no new usage-event tracking behind any of this.
 *
 * **Derived on read, never persisted, never federated.** `getCharacter()` attaches these;
 * `saveCharacter()` strips them (`metrics` is in `character.js`'s `DERIVED_FIELDS`) and
 * `getWireCharacter()` keeps them off the wire. Same reasoning as skills: usage differs per
 * machine, so federating a usage-derived value under LWW would let the peer you use *least*
 * overwrite the peer you use *most*.
 *
 * **Three states, never two (sentinel + validate).** A tile is one of:
 *   - a real value        — `{ value: <number>, unavailable: false, notApplicable: false }`,
 *                           and a real 0 is a legitimate answer ("no memories yet")
 *   - not applicable      — `{ value: null, notApplicable: true }`: the metric is a ratio
 *                           with an empty denominator. There is no honest number, and 0 is
 *                           NOT it — "0% of your goals are done" is a lie to tell someone who
 *                           has never filed one.
 *   - unavailable         — `{ value: null, unavailable: true }`: the stat could not be read.
 * Collapsing any of these into a fake 0 is the exact lie the sentinels exist to prevent.
 * Both non-value states are distinct SYMBOLS rather than in-band `null`s, so a getter that
 * resolves `null` because it is broken lands in `unavailable` and cannot pass itself off as
 * a legitimately-empty ratio.
 *
 * See `characterSignals.js` for the read-failure gap the file-backed signals still have
 * (#2726) — it applies identically here, and needs no change in this module when it lands.
 */

import { computeUnifiedStreak } from '../lib/postStreak.js';
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
 *                    never ships a pre-formatted string (formatting is the client's job —
 *                    `client/src/utils/formatters.js`).
 *   - `hint`       — one-line gloss of what the number actually measures, shown as the tile's
 *                    sublabel. Lives here, next to the compute that defines the semantic, so
 *                    the two can't drift.
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
    // The unified sessions-OR-training streak — the same helper (and the same user-timezone
    // day boundary) the Progress page and the dashboard widgets use, so the Character sheet
    // can't quote a different streak than the rest of PortOS (#2091).
    compute: async (read) => {
      const [sessions, training, today] = await Promise.all([
        read('postSessions'),
        read('postTraining'),
        read('postToday'),
      ]);
      return computeUnifiedStreak(sessions, training, today).current;
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
    // "across PortOS", NOT "captured in Brain": the signal is `countMemories({})`, and
    // `filterMemoryIndex` with no options filters by `status: 'active'` ONLY — so agent-, CoS-
    // and API-created memories are all in here, not just the Brain-tagged ones
    // (`sourceAppId: 'brain'`, per brainMemoryBridge.js). The whole store is the more useful
    // number AND the one that matches the `archivist` skill's reading of the same signal;
    // narrowing to Brain would undercount the user's memories and make the two disagree.
    compute: async (read) => read('memoryCount'),
  },
  {
    id: 'mediaAssets',
    label: 'Media Assets',
    unit: 'count',
    hint: 'Images & videos in your media library',
    // Deliberately "assets in your library", NOT "media you rendered". `countAssets()` is an
    // unfiltered COUNT(*) over `media_assets`, which by design holds every on-disk asset:
    // `reconcileMediaAssets()` upserts everything in the gallery at boot (uploads included),
    // and `videoDownload.js` routes downloads through the same index on purpose. Labelling it
    // "Media Rendered" would claim a provenance the row doesn't carry.
    //
    // Deletes decrement live: the in-app delete paths retire the index row with the file
    // (#2738 — `unindexImage`/`unindexVideo` → `removeAsset`). The boot-time
    // `reconcileMediaAssets()` sweep remains the backstop for files removed outside PortOS,
    // so only an out-of-band disk delete can read high until the next restart.
    compute: async (read) => read('assetCount'),
  },
  {
    id: 'goalCompletionRate',
    label: 'Goal Completion',
    unit: 'percent',
    hint: 'Share of your goals that are done',
    emptyLabel: 'No goals filed yet',
    // Denominator is ALL goals, not just "resolved" (completed + abandoned) ones.
    //
    // The resolved-only denominator is tempting — it reads as follow-through and doesn't
    // penalize having ambitious work in flight — but it CANNOT MOVE on this install. The
    // Goals UI (`client/src/components/digital-twin/tabs/GoalsTab.jsx`) offers exactly two
    // terminal actions: Complete (writes `status: 'completed'`) and Delete (drops the record
    // outright). Nothing in the client ever writes `status: 'abandoned'` — it exists in
    // `goalStatusEnum` and is honored by the API and the CyberCity monuments, but no UI
    // produces it. So `abandoned` is always 0, `resolved === completed`, and the tile would
    // read a self-congratulatory constant 100% forever after the first completion.
    //
    // A metric that cannot vary is worse than one with a debatable denominator, so this
    // measures what the UI actually records: of the goals you have filed, how many are done.
    // If an explicit "abandon" outcome ever ships, an abandoned goal naturally lands in the
    // denominator here without a change.
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
 * describes. Failure paths kept distinct on purpose:
 *   - `compute` rejects              → unavailable (the domain could not be read)
 *   - `compute` resolves non-finite  → unavailable (the domain lied; a fake 0 would read as
 *     real activity data)
 *   - `compute` returns the N/A symbol → notApplicable (no honest number exists yet)
 *   - `compute` resolves 0           → a real, earned 0
 */
async function readMetric(metric, read) {
  // `Promise.resolve().then(...)` rather than `metric.compute(read).catch(...)`: a compute
  // declared without `async` that throws synchronously would otherwise escape before `.catch`
  // is attached, rejecting the whole GET instead of degrading this one tile.
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
 * Compute every metric. Signals are read in parallel and each failure is contained to its own
 * tile, so one unreachable domain (Postgres down for the memory/catalog reads, say) degrades
 * that tile to `unavailable` instead of failing the whole `GET /api/character`.
 *
 * `read` is the shared signal context — pass the SAME one the skills got (see
 * `getCharacterSkills`) or the six signals the two registries share get read twice.
 */
export async function getCharacterMetrics(read = createSignalContext()) {
  return Promise.all(METRICS.map((metric) => readMetric(metric, read)));
}
