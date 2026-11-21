/**
 * Importer Orphan-Shell GC (issue #727)
 *
 * `analyzeImport` creates a brand-new universe + series shell so the analyze
 * preview has stable ids the client can commit/retry against. When the user
 * abandons the import before committing (e.g. an issue-split failure on a
 * fresh universe/series), those shells linger on disk forever.
 *
 * The primary defense is marking analyze-created shells as import drafts
 * (`ephemeral` so they stay out of every sync transport, plus a dedicated
 * `importDraft` marker) and clearing both flags in `commitImport` once the
 * import lands. This sweep is the belt-and-suspenders second half: it deletes
 * shells that are STILL import drafts, hold no committed work (zero issues,
 * zero canon entities, no arc/seasons), and are older than a grace window —
 * so an abandoned analyze self-cleans instead of accreting orphan data.
 *
 * Conservative by construction:
 * - Only `importDraft` records are candidates. `ephemeral` alone is NOT enough
 *   — it's a general user-settable "don't sync / keep local" marker, so a
 *   user's deliberately-private empty universe/series is also `ephemeral` and
 *   must never be swept. `importDraft` is stamped ONLY by analyzeImport and
 *   cleared on commit, so it uniquely identifies an abandoned import shell.
 * - A universe is only swept once its ephemeral series are gone AND it has no
 *   OTHER live (non-deleted) series — so a shared universe is never removed as
 *   a side-effect. `deleteUniverse` also enforces this block-until-empty rule.
 * - The age gate is measured from `updatedAt` (the most recent touch), so a
 *   user mid-flight on a fresh analyze is never swept out from under them.
 *
 * Runs OUTSIDE the Express request lifecycle through eventScheduler, which
 * catches handler failures and records them in scheduler history.
 */

import { listUniverses, deleteUniverse } from './universeBuilder.js';
import { listSeries, deleteSeries } from './pipeline/series.js';
import { issueStore } from './pipeline/issues.js';
import { createSweepScheduler } from './sweepScheduler.js';

// Grace window before an abandoned, never-committed shell is eligible for GC.
// Measured against `updatedAt`. Generous on purpose — the cost of an orphan
// shell lingering an extra day is trivial next to deleting work a user is
// still actively shaping.
export const ORPHAN_SHELL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// How often the sweep runs once started. The shells are cheap to leave around,
// so a slow cadence is fine — daily keeps `data/` tidy without churn.
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const ageMs = (record, now) => {
  const ts = Date.parse(record?.updatedAt || record?.createdAt || '');
  return Number.isFinite(ts) ? now - ts : NaN;
};

// A universe carries no committed canon when every entity registry is empty.
const universeHasCanon = (u) =>
  (Array.isArray(u?.characters) && u.characters.length > 0)
  || (Array.isArray(u?.places) && u.places.length > 0)
  || (Array.isArray(u?.objects) && u.objects.length > 0);

// A series carries committed story work when it has an arc or any seasons.
// (Issues are checked separately via listIssues since they live in their own
// store keyed by seriesId.)
const seriesHasStoryWork = (s) =>
  (s?.arc != null) || (Array.isArray(s?.seasons) && s.seasons.length > 0);

/**
 * One GC pass. Pure-ish: takes `now` so tests can pin the clock. Returns a
 * summary `{ deletedSeries, deletedUniverses }` of ids removed.
 *
 * Order matters: series are swept first because `deleteUniverse` refuses to
 * delete a universe that still has live series (hierarchy invariant). A
 * universe only becomes eligible once its own ephemeral shells are gone.
 */
export async function sweepOrphanShells({ now = Date.now(), maxAgeMs = ORPHAN_SHELL_MAX_AGE_MS } = {}) {
  const deletedSeries = [];
  const deletedUniverses = [];

  // --- Pass 1: ephemeral, empty, aged-out series ---
  const allSeries = await listSeries();
  // Track which series survive so the universe pass can tell whether a
  // universe still has live series — built from the in-memory list rather than
  // a second listSeries() after the deletes below, which would just re-read
  // the same data we already have in hand.
  const survivingSeriesByUniverse = new Map();
  const noteSurvivor = (s) => {
    const key = s.universeId || '';
    survivingSeriesByUniverse.set(key, (survivingSeriesByUniverse.get(key) || 0) + 1);
  };

  // An uncapped projection keeps shells with any live issue, including issues
  // beyond the public list's pagination limit.
  const seriesWithIssues = new Set(await issueStore().listLiveIssueSeriesIds());
  const seriesIsSweepable = (s) => {
    if (s.importDraft !== true || seriesHasStoryWork(s)) return false;
    const age = ageMs(s, now);
    if (!Number.isFinite(age) || age < maxAgeMs) return false;
    return !seriesWithIssues.has(s.id);
  };

  for (const s of allSeries) {
    if (seriesIsSweepable(s)) {
      await deleteSeries(s.id);
      deletedSeries.push(s.id);
    } else {
      noteSurvivor(s);
    }
  }

  // --- Pass 2: import-draft, empty, aged-out universes with no surviving series ---
  const allUniverses = await listUniverses();
  for (const u of allUniverses) {
    if (u.importDraft !== true) continue;
    if (universeHasCanon(u)) continue;
    const age = ageMs(u, now);
    if (!Number.isFinite(age) || age < maxAgeMs) continue;
    // A universe with any surviving (live, non-deleted) series — whether we
    // just spared an ephemeral one above or a committed one shares it — must
    // not be removed. deleteUniverse enforces this too, but checking here
    // keeps us from a noisy throw on the expected case.
    if ((survivingSeriesByUniverse.get(u.id) || 0) > 0) continue;
    await deleteUniverse(u.id);
    deletedUniverses.push(u.id);
  }

  return { deletedSeries, deletedUniverses };
}

/**
 * Log the domain summary for one scheduler-owned sweep.
 */
const runSweep = async () => {
  const { deletedSeries, deletedUniverses } = await sweepOrphanShells();
  if (deletedSeries.length > 0 || deletedUniverses.length > 0) {
    console.log(`🧹 Importer orphan GC: removed ${deletedSeries.length} series + ${deletedUniverses.length} universe shells`);
  }
};

export const {
  start: startOrphanShellGc,
  stop: stopOrphanShellGc,
} = createSweepScheduler({
  id: 'importer-orphan-gc',
  intervalMs: SWEEP_INTERVAL_MS,
  initialDelayMs: 5 * 60 * 1000,
  handler: runSweep,
  source: 'importerOrphanGc',
});
