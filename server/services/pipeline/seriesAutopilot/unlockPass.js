/**
 * Series Autopilot — "unlock everything this series owns" pre-pass.
 *
 * Opt-in via the `unlockForRun` run option. A user who wants the autopilot to
 * act on the editorial findings END-TO-END (rewrite the arc, re-cut volumes,
 * re-describe a character the checks flagged as thin) otherwise has to hunt
 * down every lock toggle by hand first — a locked arc/season/stage/canon entry
 * makes the corresponding fix path throw or silently skip, and the run pauses
 * on findings it was never allowed to resolve. This pass clears those locks
 * once, at the top of the run.
 *
 * TWO HARD BOUNDARIES, both the point of the feature:
 *
 * 1. SERIES SCOPE. Universe canon and world fields are shared across every series
 *    linked to that universe, so canon is filtered by ownership
 *    (`isSeriesScopedCanonEntry`, which owns the `sourceSeriesId` rule), and the
 *    universe's world-field locks (no per-series ownership) are cleared ONLY when
 *    this series is the universe's sole series. Arc, arc fields, seasons and issue
 *    stages are wholly series-owned and unlock unconditionally.
 *
 * 2. NEVER DESTRUCTIVE. Only `locked` bits are cleared; no canon entry, season,
 *    issue or catalog ingredient is removed. Removal is a human catalog ARCHIVE; the
 *    autopilot has no deletion path and must not grow one. Seasons: the autopilot
 *    sets `preserveDroppedSeasons` (`arcPlanner/arcCore.js#commitSeasonsWithRemap`)
 *    on every arc-rewriting call once this pass has run, so a regenerated arc can't
 *    make a volume vanish.
 *
 * Locks are NOT restored when the run ends: re-freezing records the autopilot just
 * rewrote would make the lock state lie. The pass reports what it changed (SSE
 * frame + log) so re-locking is an informed choice.
 */

import { BIBLE_KEYS, } from '../../../lib/storyBible.js';
import { getUniverse } from '../../universeBuilder.js';
import { setCanonLocksForSeries } from '../../universeCanon.js';
import { getSeries, updateSeries, listSeries } from '../series.js';
import { listIssues, updateStagesWithLatest, STAGE_IDS } from '../issues.js';
import { broadcast } from './session.js';

// THE definition of "which of this issue's stages are frozen", shared by the dry-run
// count and the sweep so they can't enumerate different stage sets.
const lockedStageIds = (issue) => STAGE_IDS.filter((id) => issue?.stages?.[id]?.locked === true);

// Every lock on the SERIES records this pass would clear, split by scope. ONE
// definition for the dry-run total and the pass's per-scope report, so a new lock
// surface can't be counted in one place and cleared in the other. Universe-side
// locks are excluded: they need an async read and the dry-run plan is synchronous.
// `=== true` throughout so an unsanitized record can't split promise from report.
export function seriesLockBreakdown(series, issues) {
  const locked = series?.locked || {};
  return {
    arc: locked.arc === true ? 1 : 0,
    arcFields: Object.values(locked.arcFields || {}).filter((v) => v === true).length,
    seasons: (Array.isArray(series?.seasons) ? series.seasons : []).filter((s) => s?.locked === true).length,
    stages: (Array.isArray(issues) ? issues : []).reduce((n, issue) => n + lockedStageIds(issue).length, 0),
  };
}

export const countSeriesLocks = (series, issues) =>
  Object.values(seriesLockBreakdown(series, issues)).reduce((a, b) => a + b, 0);

// Clear `series.locked` (arc freeze + per-field arc locks) AND every volume lock in
// ONE patch: `updateSeries` applies `locked` and `seasons` as independent replaces
// inside its write queue, so one call is one read/write/peer-emit with no re-read window.
async function unlockSeriesRecord(series) {
  const { arc, arcFields, seasons: lockedSeasons } = seriesLockBreakdown(series, null);
  if (arc === 0 && arcFields === 0 && lockedSeasons === 0) return { arc: 0, arcFields: 0, seasons: 0 };
  const seasons = Array.isArray(series.seasons) ? series.seasons : [];
  await updateSeries(series.id, {
    ...(arc || arcFields ? { locked: {} } : {}),
    ...(lockedSeasons ? { seasons: seasons.map((s) => (s?.locked === true ? { ...s, locked: false } : s)) } : {}),
  });
  return { arc, arcFields, seasons: lockedSeasons };
}

// Clear `locked` on every stage of every issue as a single serialized write.
async function unlockIssueStages(seriesId, issues) {
  const updates = issues.flatMap((issue) => lockedStageIds(issue).map((stageId) => ({
    issueId: issue.id,
    stageId,
    // computeFn re-reads the freshest stage inside the write queue — a stage
    // unlocked between our read and the write yields `{}` (a no-op).
    computeFn: (cur) => (cur?.locked === true ? { locked: false } : {}),
  })));
  if (updates.length === 0) return 0;
  await updateStagesWithLatest(seriesId, updates);
  return updates.length;
}

// Shared by the no-universe and read-failed paths so an SSE frame read field by
// field keeps one key set.
const NO_UNIVERSE_UNLOCKS = Object.freeze({ canon: 0, canonForeignKept: 0, worldFields: 0, worldFieldsKept: 0 });

// The starter idea is the author's originating creative contract; autopilot has no
// write path for it, so "full control" keeps its lock and the UI still shows which
// premise is human-owned.
const AUTOPILOT_PROTECTED_WORLD_LOCKS = Object.freeze(['starterPrompt']);

// Is this series the ONLY one linked to `universeId`? Gates every universe-side
// unlock, so it FAILS CLOSED: a `listSeries()` that throws must not read as "no
// siblings" (`[]` would permit clearing canon a sibling depends on). Uncertain
// linkage returns false, keeping the locks (the recoverable direction). It loads
// every series, so callers gate it on a locked record existing.
async function isSoleSeriesOfUniverse(seriesId, universeId) {
  const all = await listSeries().catch((err) => {
    console.log(`⚠️ autopilot unlock: could not list series to prove sole-universe ownership (${err.message}) — keeping universe-side locks`);
    return null;
  });
  if (!Array.isArray(all)) return false;
  return !all.some((s) => s.id !== seriesId && s.universeId === universeId);
}

// Only a locked canon entry makes the install-wide sole-series read worth paying for.
const hasLockedCanon = (universe) => BIBLE_KEYS.some((key) =>
  (Array.isArray(universe?.[key]) ? universe[key] : []).some((e) => e?.locked === true));

// Clear locks on the universe-side records this series owns: its canon entries plus
// the universe's world fields (the foundation gate pauses with "every refinable world
// field is locked"). BOTH are gated on sole-series ownership and live on the universe
// record, so they go out as ONE write (a second updateUniverse would re-sanitize and
// emit a second peer-sync `recordUpdated`).
async function unlockUniverseFor(seriesId, universeId) {
  const universe = await getUniverse(universeId).catch(() => null);
  if (!universe) return NO_UNIVERSE_UNLOCKS;
  const lockedWorldKeys = Object.entries(universe.locked || {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  const protectedWorldLocked = lockedWorldKeys
    .filter((key) => AUTOPILOT_PROTECTED_WORLD_LOCKS.includes(key)).length;
  const worldLocked = lockedWorldKeys.length - protectedWorldLocked;
  // One install-wide read at most, only when a locked record depends on it.
  const soleSeries = (worldLocked > 0 || hasLockedCanon(universe))
    && await isSoleSeriesOfUniverse(seriesId, universeId);
  const canon = await setCanonLocksForSeries(universeId, seriesId, false, {
    soleSeries,
    clearWorldLocks: worldLocked > 0 && soleSeries,
    preserveWorldLockKeys: AUTOPILOT_PROTECTED_WORLD_LOCKS,
  });
  return {
    canon: canon.changed,
    canonForeignKept: canon.foreignKept,
    worldFields: soleSeries ? worldLocked : 0,
    worldFieldsKept: soleSeries ? protectedWorldLocked : lockedWorldKeys.length,
  };
}

/**
 * Run the unlock pass for a series. Returns per-scope counts plus `failures[]` for
 * scopes that threw (both ride the `unlock:applied` SSE frame). Idempotent.
 *
 * Scopes are SEPARATELY settled, not `Promise.all`-ed: they write to independent
 * stores, so one rejecting does not undo the others, and a propagated rejection
 * would claim "locked records stay frozen" after some locks were cleared. Each
 * scope reports its own outcome so the report matches the disk.
 */
export async function unlockSeriesForAutopilot(seriesId) {
  const [series, issues] = await Promise.all([getSeries(seriesId), listIssues({ seriesId })]);
  // Independent stores: run concurrently.
  const [record, stages, universe] = await Promise.allSettled([
    unlockSeriesRecord(series),
    unlockIssueStages(seriesId, issues),
    series.universeId
      ? unlockUniverseFor(seriesId, series.universeId)
      : Promise.resolve(NO_UNIVERSE_UNLOCKS),
  ]);
  const failures = [];
  const settled = (result, scope, zero) => {
    if (result.status === 'fulfilled') return result.value;
    failures.push(`${scope} (${result.reason?.message || 'unknown error'})`);
    return zero;
  };
  return {
    ...settled(record, 'series record', { arc: 0, arcFields: 0, seasons: 0 }),
    stages: settled(stages, 'issue stages', 0),
    ...settled(universe, 'universe canon', NO_UNIVERSE_UNLOCKS),
    failures,
  };
}

/**
 * Autopilot step handler: unlock the series, mark the run state so the resolver
 * routes past this step, and report what changed. Never pauses; a failure is
 * surfaced as a note instead.
 */
export async function runUnlockPass(seriesId, record) {
  record.runState.locksUnlocked = true;
  const counts = await unlockSeriesForAutopilot(seriesId).catch((err) => {
    // Only the pre-read can land here (write scopes settle individually): nothing cleared.
    broadcast(seriesId, { type: 'note', message: `Could not unlock series records: ${err.message} — locked records stay frozen for this run.` });
    console.log(`⚠️ autopilot: unlock pass failed for ${seriesId.slice(0, 12)}: ${err.message}`);
    return null;
  });
  if (!counts) return {};
  broadcast(seriesId, { type: 'unlock:applied', ...counts });
  if (counts.failures.length) {
    broadcast(seriesId, { type: 'note', message: `Unlock was partial — ${counts.failures.join('; ')} failed, so those records stay frozen for this run.` });
  }
  console.log(`🔓 autopilot unlock — series=${seriesId.slice(0, 12)} arc=${counts.arc} arcFields=${counts.arcFields} seasons=${counts.seasons} stages=${counts.stages} canon=${counts.canon} world=${counts.worldFields} foreignKept=${counts.canonForeignKept} failed=${counts.failures.length}`);
  return {};
}
