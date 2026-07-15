/**
 * Pipeline — Issues CRUD (#2531)
 *
 * Create / read / list / update / delete of Issue records, plus the
 * numbering + season-reassignment passes. Split out of the former monolithic
 * `issues.js`; shares the store facade, per-series write queue, sanitizers, and
 * renumberInline via `./issuesShared.js`. All mutations route through the
 * per-series write tail so concurrent writes to different issues in the same
 * series serialize against the shared series index.
 */

import { randomUUID } from 'crypto';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { UNSCOPED_ANCHOR } from '../../lib/pipelineIssueOrder.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import * as seriesSvc from './series.js';
import {
  store, queueSeriesIssuesWrite, readState, readStateForSeries,
  saveIssueNow, saveIssuesNow, renumberInline, sanitizeIssue,
  snapshotRunHistory, stripRunHistoryFromIssue, makeErr, ISSUE_ID_RE,
  ERR_NOT_FOUND, ERR_VALIDATION, ERR_DUPLICATE, ERR_SEASON_LOCKED,
  TITLE_MAX, SERIES_ID_MAX, ISSUES_PER_RESPONSE_MAX,
} from './issuesShared.js';

export async function listIssues({
  seriesId = null,
  offset = 0,
  limit = ISSUES_PER_RESPONSE_MAX,
  paginated = false,
  withHistory = true,
  includeDeleted = false,
} = {}) {
  // Scope the read to one series when filtering by it — avoids loading every
  // issue in the install just to discard the rest (the `seriesId.localeCompare`
  // tiebreak below is a no-op within a single series).
  const { issues } = seriesId ? await readStateForSeries(seriesId) : await readState();
  const live = includeDeleted ? issues : issues.filter((i) => !i.deleted);
  const filtered = seriesId ? live.filter((i) => i.seriesId === seriesId) : live;
  const sorted = [...filtered].sort((a, b) => {
    if (a.seriesId !== b.seriesId) return a.seriesId.localeCompare(b.seriesId);
    return (a.number || 0) - (b.number || 0);
  });
  const project = withHistory ? (i) => i : stripRunHistoryFromIssue;
  const safeLimit = Math.min(Math.max(1, limit), ISSUES_PER_RESPONSE_MAX);
  const safeOffset = Math.max(0, offset);
  if (paginated) {
    return {
      items: sorted.slice(safeOffset, safeOffset + safeLimit).map(project),
      total: sorted.length,
      offset: safeOffset,
      limit: safeLimit,
    };
  }
  return sorted.slice(0, ISSUES_PER_RESPONSE_MAX).map(project);
}

/**
 * Every live (or, with `includeDeleted`, every) issue id — UNCAPPED.
 *
 * `listIssues` slices at `ISSUES_PER_RESPONSE_MAX` (1000) even unpaginated, so
 * it can't back a "does this id still exist?" membership check: an install with
 * >1000 issues would report ids beyond the cap as missing. Callers that need
 * the complete id set (e.g. the conflict-journal orphan-base-hash sweep, which
 * would otherwise prune a live issue's base hash and silently disable conflict
 * detection for it) use this. Returns ids only — no projection, no history.
 *
 * Sources from the store's `SELECT id` projection (#2540) rather than
 * `readState()` → `loadAll()`, which would pull every issue's full `data` JSONB
 * (up to ~12MB of stage runHistory each) into memory only to read the ids. The
 * PG backend filters tombstones via the mirrored `deleted` column, so the
 * whole-record load is avoided entirely for the default live-membership sweep.
 */
export async function listIssueIds({ includeDeleted = false } = {}) {
  return store().listIds({ includeDeleted });
}

/**
 * Every live issue record — UNCAPPED, unsorted, unpaginated.
 *
 * Same rationale as `listIssueIds`: `listIssues` slices at
 * `ISSUES_PER_RESPONSE_MAX` (1000) even unpaginated, so it cannot back
 * whole-library scans. Callers that group/count issues across ALL series
 * (canon-usage tallies, the orphan-shell sweep's "does this series still have
 * issues?" gate) must use this — with `listIssues({})` an install holding
 * >1000 issues would silently miss the tail, and the orphan sweep could
 * delete a series that still has issues past the cap.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeDeleted=false]
 * @param {boolean} [options.withHistory=true] - false strips per-stage run history
 */
export async function listAllIssues({ includeDeleted = false, withHistory = true } = {}) {
  const { issues } = await readState();
  const live = includeDeleted ? issues : issues.filter((i) => !i.deleted);
  return withHistory ? live : live.map(stripRunHistoryFromIssue);
}

/**
 * Every live issue record for one series — UNCAPPED, sorted by issue number.
 *
 * Same cap rationale as `listAllIssues`/`listIssueIds`: `listIssues({ seriesId })`
 * slices at `ISSUES_PER_RESPONSE_MAX` (1000), so a series holding >1000 issues
 * loses its tail. Per-series scans that MUST see every issue (the editorial
 * runner's storyboard-continuity and comic-lettering projections, #1469) use
 * this — with `listIssues` those checks would silently skip every storyboard
 * scene / comic page past the 1000th issue. Sorted by `number` to match the
 * ordering `listIssues` produces within a single series.
 *
 * @param {string} seriesId
 * @param {object} [options]
 * @param {boolean} [options.includeDeleted=false]
 * @param {boolean} [options.withHistory=true] - false strips per-stage run history
 */
export async function listIssuesForSeries(seriesId, { includeDeleted = false, withHistory = true } = {}) {
  const { issues } = await readStateForSeries(seriesId);
  const live = includeDeleted ? issues : issues.filter((i) => !i.deleted);
  const sorted = [...live].sort((a, b) => (a.number || 0) - (b.number || 0));
  return withHistory ? sorted : sorted.map(stripRunHistoryFromIssue);
}

/**
 * Recently-updated issues across all series. Sorts the FULL issue set by
 * `updatedAt` desc before applying `limit` — unlike `listIssues`, which
 * sorts by `seriesId/number` then caps at `ISSUES_PER_RESPONSE_MAX`. That
 * cap would silently miss the most-recent issues once the dataset grows
 * beyond 1000, so the sidebar's recent-issues view needs this dedicated
 * helper.
 */
export async function listRecentIssues({ limit = 10, withHistory = true, includeDeleted = false } = {}) {
  const { issues } = await readState();
  const live = includeDeleted ? issues : issues.filter((i) => !i.deleted);
  // Coerce in two passes so non-finite inputs ('abc', undefined) fall to
  // the default rather than letting JS's `0 || 10` short-circuit return
  // 10 for an explicit limit=0.
  const raw = Number(limit);
  const fallback = Number.isFinite(raw) ? Math.floor(raw) : 10;
  const clamped = Math.max(1, Math.min(50, fallback));
  const project = withHistory ? (i) => i : stripRunHistoryFromIssue;
  return [...live]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, clamped)
    .map(project);
}

export async function getIssue(id, { includeDeleted = false } = {}) {
  const found = await store().loadOne(id);
  if (!found) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
  if (found.deleted && !includeDeleted) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
  return found;
}

export function createIssue(input = {}, { preloadedSeries = null } = {}) {
  const seriesId = trimTo(input.seriesId, SERIES_ID_MAX);
  if (!seriesId) return Promise.reject(makeErr('seriesId is required', ERR_VALIDATION));
  const title = trimTo(input.title, TITLE_MAX);
  if (!title) return Promise.reject(makeErr(`title is required (1..${TITLE_MAX} chars)`, ERR_VALIDATION));
  return queueSeriesIssuesWrite(seriesId, async () => {
    const state = await readState();
    const next = sanitizeIssue({
      id: `iss-${randomUUID()}`,
      seriesId,
      // Placeholder — `renumberInline` below derives the canonical number.
      number: 0,
      title,
      status: 'draft',
      // Phase 2: optional arc pointers passed by the season-episodes generator
      // (and any future caller wiring an issue to a season at create time).
      seasonId: 'seasonId' in input ? input.seasonId : null,
      arcPosition: 'arcPosition' in input ? input.arcPosition : null,
      arcRole: 'arcRole' in input ? input.arcRole : null,
      lengthProfile: 'lengthProfile' in input ? input.lengthProfile : undefined,
      pageTarget: 'pageTarget' in input ? input.pageTarget : null,
      minutesTarget: 'minutesTarget' in input ? input.minutesTarget : null,
      stages: input.stages || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ephemeral: input.ephemeral === true,
    });
    if (!next) throw makeErr('Invalid issue payload', ERR_VALIDATION);
    state.issues.push(next);
    await renumberInline(state, seriesId, next.seasonId || UNSCOPED_ANCHOR, preloadedSeries);
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
    // New issue = series-level change for any active share subscription.
    emitRecordUpdated('series', next.seriesId);
    return next;
  });
}

export function recomputeIssueNumbersForSeries(seriesId, fromSeasonId = null) {
  return queueSeriesIssuesWrite(seriesId, async () => {
    const state = await readState();
    const changed = await renumberInline(state, seriesId, fromSeasonId);
    if (!changed) return { changed: false };
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
    emitRecordUpdated('series', seriesId);
    return { changed: true };
  });
}

/**
 * Reassign every issue under `(seriesId, fromSeasonId)` to `toSeasonId` in a
 * single collection load → in-memory mutate → per-record save pass.
 * Used by `deleteSeason` (and any future bulk season-move flow) to collapse
 * N per-issue write cycles into one — the legacy N+1 pattern was
 * `for (iss of children) await updateIssue(iss.id, { seasonId: toSeasonId }, { skipRenumber: true })`
 * which paid N read/write round-trips and N debounced re-exports even with
 * `withReexportSuppressed`.
 *
 * Returns `{ reassigned, fromSeasonId, toSeasonId }`. `toSeasonId` may be
 * `null` (un-grouped). A re-export of the parent series is emitted once, after
 * the renumber pass — callers under `withReexportSuppressed` get exactly one
 * `series:updated` event regardless of the issue count.
 */
export function bulkReassignSeason(seriesId, fromSeasonId, toSeasonId = null, { _preloadedSeries = null } = {}) {
  return queueSeriesIssuesWrite(seriesId, async () => {
    // Honor per-season locks — refuse to move issues OUT of or INTO a locked
    // volume. Series lives in a different write queue, so this is best-effort
    // single-user gating, not strict serialization (fine per CLAUDE.md).
    // Callers that already hold a fresh series (e.g. `deleteSeason` reads it
    // for the reassign-target validation) can pass `_preloadedSeries` to skip
    // the duplicate read.
    if (fromSeasonId || toSeasonId) {
      const series = _preloadedSeries || await seriesSvc.getSeries(seriesId);
      const seasons = Array.isArray(series.seasons) ? series.seasons : [];
      const findLocked = (id) => (id ? seasons.find((s) => s.id === id && s.locked === true) : null);
      const blocker = findLocked(fromSeasonId) || findLocked(toSeasonId);
      if (blocker) {
        throw makeErr(
          `Season "${blocker.title || blocker.number}" is locked — unlock it before reassigning issues`,
          ERR_SEASON_LOCKED,
        );
      }
    }
    const state = await readState();
    let reassigned = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < state.issues.length; i += 1) {
      const iss = state.issues[i];
      if (iss.seriesId !== seriesId) continue;
      // Skip tombstones — moving a soft-deleted issue would bump its
      // `updatedAt`, which then loses LWW races with the originator's
      // tombstone and can resurrect the record on every peer.
      if (iss.deleted) continue;
      if ((iss.seasonId || null) !== (fromSeasonId || null)) continue;
      // Re-sanitize through the same pipeline updateIssue uses so the
      // in-memory rewrite gets the same shape guarantees as a route PATCH.
      const merged = sanitizeIssue({
        ...iss,
        seasonId: toSeasonId,
        updatedAt: now,
      });
      if (!merged) continue;
      state.issues[i] = merged;
      reassigned += 1;
    }
    if (reassigned === 0) return { reassigned: 0, fromSeasonId, toSeasonId };
    // One renumber pass after the bulk move — the source AND destination
    // volume both reshuffled, so use the series-wide form (fromSeasonId=null).
    await renumberInline(state, seriesId, null);
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
    emitRecordUpdated('series', seriesId);
    return { reassigned, fromSeasonId, toSeasonId };
  });
}

/**
 * Reassign every live issue from `fromSeriesId` to `toSeriesId` — used by the
 * series-merge engine (recordMerge.js) so a duplicate series' issues survive
 * the merge instead of being orphaned under the tombstoned loser.
 *
 * Issue→season grouping is preserved across the move via `seasonIdMap` — a
 * `{ loserSeasonId: survivorSeasonId }` map the caller (`mergeSeries`) builds by
 * pairing the loser's seasons to the survivor's by `number`. An issue whose
 * `seasonId` resolves through the map lands in the matching survivor season; one
 * with no `seasonId`, or a `seasonId` the map doesn't cover (a stale ref, or a
 * loser season that didn't survive the union), lands UN-GROUPED (`seasonId:
 * null`). A single renumber pass on the survivor sequences the combined set.
 * Returns `{ reassigned }`.
 *
 * Serialized on the SURVIVOR's issues queue so the renumber can't race a
 * concurrent survivor edit. Tombstoned issues are skipped (moving them would
 * bump updatedAt and lose the originator's delete LWW race).
 */
export function reassignIssuesToSeries(fromSeriesId, toSeriesId, { seasonIdMap = {} } = {}) {
  if (!isStr(fromSeriesId) || !isStr(toSeriesId) || fromSeriesId === toSeriesId) {
    return Promise.reject(makeErr('reassignIssuesToSeries: fromSeriesId and toSeriesId must differ', ERR_VALIDATION));
  }
  // This reads/mutates issues belonging to BOTH series (it moves source issues
  // and renumbers the destination), so serialize on both per-series queues, not
  // just the destination — otherwise a concurrent edit/renumber on the source
  // (e.g. a peer-sync merge landing on the loser mid-merge) could interleave and
  // be lost. Acquire in sorted order so a future two-series caller can't deadlock.
  const [first, second] = [fromSeriesId, toSeriesId].sort();
  const body = async () => {
    const state = await readState();
    const now = new Date().toISOString();
    const moved = [];
    for (let i = 0; i < state.issues.length; i += 1) {
      const iss = state.issues[i];
      if (iss.seriesId !== fromSeriesId || iss.deleted) continue;
      // Map the issue's loser season to the survivor's same-number season so the
      // grouping survives; fall back to un-grouped when there's no mapping.
      const seasonId = (iss.seasonId && seasonIdMap[iss.seasonId]) || null;
      const merged = sanitizeIssue({ ...iss, seriesId: toSeriesId, seasonId, updatedAt: now });
      if (!merged) continue;
      state.issues[i] = merged;
      moved.push(merged);
    }
    if (moved.length === 0) return { reassigned: 0 };
    await renumberInline(state, toSeriesId, null);
    // Persist every issue now tagged to the survivor (the moved ones + any the
    // survivor already had, whose numbers may have shifted in the renumber).
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === toSeriesId));
    emitRecordUpdated('series', toSeriesId);
    emitRecordUpdated('series', fromSeriesId);
    return { reassigned: moved.length };
  };
  return queueSeriesIssuesWrite(first, () => queueSeriesIssuesWrite(second, body));
}

/**
 * Insert an issue with a caller-supplied id (used by the share-bucket importer
 * so re-imports of the same issue LWW-merge onto the same local row).
 * Throws ERR_DUPLICATE / ERR_VALIDATION on contract violations.
 */
export function insertIssueWithId(input = {}) {
  if (!isStr(input.id) || !ISSUE_ID_RE.test(input.id)) {
    return Promise.reject(makeErr(`insertIssueWithId: invalid id "${input.id}" (expected iss-<uuid>)`, ERR_VALIDATION));
  }
  const seriesId = trimTo(input.seriesId, SERIES_ID_MAX);
  if (!seriesId) return Promise.reject(makeErr('seriesId is required', ERR_VALIDATION));
  const title = trimTo(input.title, TITLE_MAX);
  if (!title) return Promise.reject(makeErr(`title is required (1..${TITLE_MAX} chars)`, ERR_VALIDATION));
  return queueSeriesIssuesWrite(seriesId, async () => {
    const state = await readState();
    // Tombstone-overwrite: same contract as universeBuilder.insertUniverseWithId.
    const existingIdx = state.issues.findIndex((i) => i.id === input.id);
    if (existingIdx >= 0 && !state.issues[existingIdx].deleted) {
      throw makeErr(`Issue id already exists: ${input.id}`, ERR_DUPLICATE);
    }
    const wasResurrection = existingIdx >= 0;
    const next = sanitizeIssue({ ...input, seriesId, title });
    if (!next) throw makeErr('Invalid issue payload', ERR_VALIDATION);
    if (wasResurrection) {
      console.warn(`♻️  insertIssueWithId: overwriting tombstone for ${input.id}`);
      state.issues[existingIdx] = next;
    } else {
      state.issues.push(next);
    }
    // Imported `number` is a starting hint — local canonical numbering still
    // comes from (volume order, arcPosition) of the local state.
    await renumberInline(state, seriesId, next.seasonId || UNSCOPED_ANCHOR);
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
    // Mirror createIssue's federation side-effect on tombstone-overwrite:
    // issues ride series-level events, so notify peers via the parent series.
    if (wasResurrection) emitRecordUpdated('series', next.seriesId);
    return next;
  });
}

function mergeIssuePatch(cur, patch = {}) {
  // Per-stage merge: a stage patch carries only the fields the caller is
  // changing (e.g. `{ genConfig }` or `{ cover }`). Without this, the top-level
  // spread would replace the entire stage object and silently drop sibling
  // fields like `scenes` / `pages` / `genConfig`. Sanitization then defaults
  // those back to empty arrays/null, erasing work the user (or LLM) just did.
  // Callers that need stage-level changes without touching issue-level fields
  // should use `updateStage`, which does a shallow merge of the patch over the
  // existing stage (`{ ...cur.stages[stageId], ...patch }`) before sanitizing.
  //
  // `cover` and `genConfig` are treated as deep-merge sub-objects: a partial
  // `{ cover: { script } }` patch from a textarea-blur save must not wipe the
  // sibling `imageJobId` / `prompt` that a parallel "Render cover" mutation
  // just persisted. Passing `null` explicitly still clears the sub-object.
  const NESTED_DEEP_MERGE_KEYS = ['cover', 'genConfig'];
  let mergedStages = cur.stages;
  if ('stages' in patch && patch.stages && typeof patch.stages === 'object') {
    mergedStages = { ...cur.stages };
    for (const [stageId, stagePatch] of Object.entries(patch.stages)) {
      const prev = cur.stages?.[stageId];
      if (prev && stagePatch && typeof prev === 'object' && typeof stagePatch === 'object') {
        const merged = { ...prev, ...stagePatch };
        merged.runHistory = snapshotRunHistory(prev, stagePatch, stageId);
        for (const key of NESTED_DEEP_MERGE_KEYS) {
          if (key in stagePatch
              && stagePatch[key] && typeof stagePatch[key] === 'object'
              && prev[key] && typeof prev[key] === 'object') {
            merged[key] = { ...prev[key], ...stagePatch[key] };
          }
        }
        if ('status' in stagePatch && stagePatch.status !== 'error'
            && stagePatch.status !== 'generating'
            && !('errorMessage' in stagePatch)) {
          merged.errorMessage = '';
        }
        mergedStages[stageId] = merged;
      } else {
        mergedStages[stageId] = stagePatch;
      }
    }
  }

  const merged = sanitizeIssue({
    ...cur,
    ...('title' in patch ? { title: patch.title } : {}),
    ...('number' in patch ? { number: patch.number } : {}),
    ...('status' in patch ? { status: patch.status } : {}),
    ...('seasonId' in patch ? { seasonId: patch.seasonId } : {}),
    ...('arcPosition' in patch ? { arcPosition: patch.arcPosition } : {}),
    ...('arcRole' in patch ? { arcRole: patch.arcRole } : {}),
    ...('lengthProfile' in patch ? { lengthProfile: patch.lengthProfile } : {}),
    ...('pageTarget' in patch ? { pageTarget: patch.pageTarget } : {}),
    ...('minutesTarget' in patch ? { minutesTarget: patch.minutesTarget } : {}),
    ...('origin' in patch ? { origin: patch.origin } : {}),
    // Local-only "don't sync" marker. Issues piggyback on their parent
    // series' subscription, so an ephemeral issue is dropped from the
    // series push payload via sanitizeRecordForWire returning null.
    ...('ephemeral' in patch ? { ephemeral: patch.ephemeral } : {}),
    stages: mergedStages,
    updatedAt: new Date().toISOString(),
  });
  if (!merged) throw makeErr('Invalid issue payload', ERR_VALIDATION);
  return merged;
}

export function updateIssue(id, patch = {}, { skipRenumber = false } = {}) {
  const needsRenumber = !skipRenumber && ('seasonId' in patch || 'arcPosition' in patch);
  if (!needsRenumber) {
    // Route through the SERIES tail (see updateStageWithLatest) so a plain
    // field update can't race a concurrent series-wide renumber rewriting this
    // issue. seriesId is immutable, so read it outside the lock to pick the
    // queue, then re-read the issue inside.
    return getIssue(id, { includeDeleted: true }).then((existing) =>
      queueSeriesIssuesWrite(existing.seriesId, async () => {
        const cur = await store().loadOne(id);
        if (!cur) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
        if (cur.deleted) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
        const merged = mergeIssuePatch(cur, patch);
        await saveIssueNow(merged);
        emitRecordUpdated('series', merged.seriesId);
        return merged;
      }),
    );
  }

  return getIssue(id, { includeDeleted: true }).then((existing) =>
    queueSeriesIssuesWrite(existing.seriesId, async () => {
      const state = await readState();
      const idx = state.issues.findIndex((i) => i.id === id);
      if (idx < 0) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
      const cur = state.issues[idx];
      if (cur.deleted) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
      const merged = mergeIssuePatch(cur, patch);
      state.issues[idx] = merged;
      // A seasonId move affects both source and destination volumes, so full
      // renumber. An arcPosition change only reorders within the current volume.
      if ('seasonId' in patch && cur.seasonId !== merged.seasonId) {
        await renumberInline(state, merged.seriesId, null);
      } else if ('arcPosition' in patch && cur.arcPosition !== merged.arcPosition) {
        await renumberInline(state, merged.seriesId, merged.seasonId || UNSCOPED_ANCHOR);
      }
      await saveIssuesNow(state.issues.filter((i) => i.seriesId === merged.seriesId));
      // Issues are exported as part of their parent series — re-export the
      // series so any active subscription picks up the issue change.
      emitRecordUpdated('series', merged.seriesId);
      return merged;
    })
  );
}

export function deleteIssue(id) {
  // Soft-delete — same tombstone-in-record pattern as universes/series. The
  // record stays on disk with `deleted: true` so the next sync propagates the
  // delete to peers; the orchestrator's GC sweep prunes it once all peers ack.
  // `renumberInline` filters tombstones, so surviving issues stay contiguous.
  return getIssue(id, { includeDeleted: true }).then((existing) =>
    queueSeriesIssuesWrite(existing.seriesId, async () => {
      const state = await readState();
      const idx = state.issues.findIndex((i) => i.id === id);
      if (idx < 0) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
      const cur = state.issues[idx];
      if (cur.deleted) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
      const seriesId = cur.seriesId;
      const now = new Date().toISOString();
      state.issues[idx] = { ...cur, deleted: true, deletedAt: now, updatedAt: now };
      await renumberInline(state, seriesId, cur.seasonId || UNSCOPED_ANCHOR);
      await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
      // Series export bundles every issue, so a deletion is an update on the
      // parent series for any active share-bucket subscription.
      emitRecordUpdated('series', seriesId);
      return { id, seriesId };
    }).then(async (result) => {
      // The deleted issue may have owned the series' list thumbnail
      // (`series.coverImage`). Recompute outside the queue (it reads fresh
      // post-delete state) so the Pipeline list falls back to the next eligible
      // cover instead of pointing at a tombstone. Dynamic import dodges the
      // static cycle (seriesCoverImage → issues). Best-effort — a cosmetic
      // thumbnail must never fail the delete.
      const { refreshSeriesCoverImage } = await import('./seriesCoverImage.js');
      await refreshSeriesCoverImage(result.seriesId).catch(() => {});
      return { id: result.id };
    })
  );
}
