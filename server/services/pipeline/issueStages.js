/**
 * Pipeline — Issue stage merge / history / restore (#2531)
 *
 * Per-stage writes (updateStage / updateStageWithLatest / updateStagesWithLatest)
 * plus run-history restore. Split out of the former monolithic `issues.js`.
 * Stage writes route through the SAME per-series write tail as CRUD (see
 * `./issuesShared.js`) so a stage save can't interleave with a series-wide
 * renumber/bulk write that rewrites the same issue — one mutex per series.
 */

import { isPlainObject } from '../../lib/objects.js';
import { isStr } from '../../lib/storyBible.js';
import { pickRenderedFilename } from '../../lib/renderSlot.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { getIssue } from './issueCrud.js';
import {
  store, queueSeriesIssuesWrite, readState, saveIssueNow, saveIssuesNow,
  sanitizeIssue, sanitizeTextStage, sanitizeVisualStage, sanitizeAudioStage,
  snapshotRunHistory, makeErr,
  ERR_NOT_FOUND, ERR_VALIDATION,
  STAGE_IDS, TEXT_STAGE_IDS, VISUAL_STAGE_IDS, AUDIO_STAGE_IDS,
} from './issuesShared.js';

/**
 * Partial update to a single stage on an issue. Use this from generators so
 * a stage write doesn't have to load the full issue, mutate, and re-validate.
 * Patch keys: status, input, output, lastRunId, errorMessage, and (for
 * visual stages) pages/scenes/cdProjectId/videoPath.
 *
 * When the patch depends on the current stage value (e.g. cover preservation),
 * use `updateStageWithLatest` instead so the decision is made against the
 * freshest persisted record inside the serialized write region.
 */
export function updateStage(issueId, stageId, patch = {}) {
  return updateStageWithLatest(issueId, stageId, () => patch);
}

function mergeStagePatch(currentStage, stageId, patch, { snapshotPrior = false } = {}) {
  const isVisual = VISUAL_STAGE_IDS.includes(stageId);
  const isAudio = AUDIO_STAGE_IDS.includes(stageId);
  const nextRunHistory = snapshotRunHistory(currentStage, patch, stageId, { force: snapshotPrior });
  const merged = {
    ...currentStage,
    ...patch,
    runHistory: nextRunHistory,
    updatedAt: new Date().toISOString(),
  };
  if (isVisual) return sanitizeVisualStage(merged, stageId);
  if (isAudio) return sanitizeAudioStage(merged);
  return sanitizeTextStage(merged);
}

export function updateStagesWithLatest(seriesId, updates = [], { snapshotPrior = false } = {}) {
  if (!isStr(seriesId) || !seriesId) {
    return Promise.reject(makeErr('seriesId is required', ERR_VALIDATION));
  }
  if (!Array.isArray(updates) || updates.length === 0) {
    return Promise.resolve([]);
  }
  for (const { stageId } of updates) {
    if (!STAGE_IDS.includes(stageId)) {
      return Promise.reject(makeErr(`Unknown stage: ${stageId}`, ERR_VALIDATION));
    }
  }

  return queueSeriesIssuesWrite(seriesId, async () => {
    const state = await readState();
    const results = [];
    let changed = false;
    let frontCoverChanged = false;
    // Index once: `state.issues` is the INSTALL-wide list, and a bulk caller can
    // pass one update per (issue, stage) — a per-update findIndex would make the
    // write O(updates × issues in the install). Rebuilt in step with the
    // in-place `state.issues[idx] = …` writes below (index positions are stable).
    const indexById = new Map(state.issues.map((i, idx) => [i.id, idx]));
    for (const update of updates) {
      const idx = indexById.get(update.issueId) ?? -1;
      if (idx < 0) throw makeErr(`Issue not found: ${update.issueId}`, ERR_NOT_FOUND);
      const cur = state.issues[idx];
      if (cur.deleted || cur.seriesId !== seriesId) throw makeErr(`Issue not found: ${update.issueId}`, ERR_NOT_FOUND);
      const currentStage = cur.stages[update.stageId];
      const patch = update.computeFn(currentStage);
      if (isPlainObject(patch) && Object.keys(patch).length === 0) {
        results.push({ issue: cur, stage: currentStage });
        continue;
      }
      const nextStage = mergeStagePatch(currentStage, update.stageId, patch, { snapshotPrior });
      if (update.stageId === 'comicPages'
        && pickRenderedFilename(currentStage?.cover) !== pickRenderedFilename(nextStage?.cover)) {
        frontCoverChanged = true;
      }
      const mergedIssue = sanitizeIssue({
        ...cur,
        stages: { ...cur.stages, [update.stageId]: nextStage },
        updatedAt: new Date().toISOString(),
      });
      if (!mergedIssue) throw makeErr('Invalid issue payload', ERR_VALIDATION);
      state.issues[idx] = mergedIssue;
      results.push({ issue: mergedIssue, stage: mergedIssue.stages[update.stageId] });
      changed = true;
    }
    if (changed) {
      await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
      emitRecordUpdated('series', seriesId);
    }
    return { results, frontCoverChanged };
  }).then(async ({ results, frontCoverChanged }) => {
    if (frontCoverChanged) {
      // A manual clear/replacement does not pass through the media filename
      // hook, so it previously left series.coverImage pointing at stale art.
      // Recompute after the serialized issue write and outside its queue.
      const { refreshSeriesCoverImage } = await import('./seriesCoverImage.js');
      await refreshSeriesCoverImage(seriesId).catch(() => {});
    }
    return results;
  });
}

/**
 * Restore a prior `runHistory` snapshot as the active stage state. Looks up the
 * snapshot by `runId` against the freshest persisted record (so a concurrent
 * generate can't make the chosen snapshot disappear out from under the call).
 * The previous active state is itself snapshotted into runHistory by the normal
 * lastRunId-changed trigger in `updateStageWithLatest`, so restore is just
 * another version event — there's no special "rollback" semantics.
 *
 * Resolves with `{ issue, stage }`. Rejects with ERR_VALIDATION when the runId
 * isn't present in the current runHistory.
 */
export function restoreStageFromHistory(issueId, stageId, runId) {
  if (!TEXT_STAGE_IDS.includes(stageId)) {
    return Promise.reject(makeErr(`Stage "${stageId}" does not support history restore`, ERR_VALIDATION));
  }
  if (!isStr(runId) || !runId) {
    return Promise.reject(makeErr('runId is required', ERR_VALIDATION));
  }
  return updateStageWithLatest(issueId, stageId, (cur) => {
    const snapshot = (cur?.runHistory || []).find((entry) => entry.runId === runId);
    if (!snapshot) throw makeErr(`Snapshot not found in stage history: ${runId}`, ERR_VALIDATION);
    return {
      status: 'edited',
      input: snapshot.input || '',
      output: snapshot.output || '',
      lastRunId: snapshot.runId,
      errorMessage: '',
    };
  });
}

/**
 * Like `updateStage`, but the patch is computed from the *latest* persisted
 * stage inside the serialized write region. Use this when the patch value
 * depends on the current stage state (e.g. cover preservation) so a concurrent
 * write that lands between the outer `getIssue` read and this call is not
 * silently overwritten.
 *
 * `computeFn(currentStage) → patch` — called with the freshest stage record
 * inside the queue; its return value is shallow-merged over the stage exactly
 * as `updateStage` merges a static patch.
 */
export function updateStageWithLatest(issueId, stageId, computeFn, { snapshotPrior = false } = {}) {
  if (!STAGE_IDS.includes(stageId)) {
    // Validate before queueing so the caller gets an immediate rejection
    // rather than waiting in line for an error it already knows about.
    return Promise.reject(makeErr(`Unknown stage: ${stageId}`, ERR_VALIDATION));
  }
  // Serialize on the SERIES tail (not the per-id queue) so a stage save can't
  // interleave with a series-wide renumber/bulk write that rewrites this same
  // issue — both share one mutex per series. The per-record split (migrations
  // 035/036) otherwise left renumbers on the series queue and stage saves on
  // the per-id queue (two independent mutexes over the same shared resource);
  // see CLAUDE.md "single tail per shared file". seriesId is immutable, so read
  // it outside the lock to pick the queue, then re-read the issue INSIDE the
  // lock for the freshest stage.
  const work = async () => {
    const cur = await store().loadOne(issueId);
    if (!cur) throw makeErr(`Issue not found: ${issueId}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Issue not found: ${issueId}`, ERR_NOT_FOUND);
    const currentStage = cur.stages[stageId];
    const patch = computeFn(currentStage);
    // Empty-patch fast path: a computeFn that returns `{}` is a "decided not
    // to write" signal (e.g. stale media-job completion against a re-rendered
    // page). Skip the disk write + emitRecordUpdated so it doesn't trigger
    // a re-export storm in share subscriptions for late no-op events.
    if (isPlainObject(patch) && Object.keys(patch).length === 0) {
      return {
        result: { issue: cur, stage: currentStage },
        frontCoverChanged: false,
      };
    }
    // Snapshot the prior `{ runId, input, output }` into runHistory when this
    // patch carries a fresh lastRunId (i.e. a generate just replaced prior
    // content). Computed BEFORE the spread so it reads pre-merge state.
    const next = mergeStagePatch(currentStage, stageId, patch, { snapshotPrior });
    const frontCoverChanged = stageId === 'comicPages'
      && pickRenderedFilename(currentStage?.cover) !== pickRenderedFilename(next?.cover);
    const mergedIssue = sanitizeIssue({
      ...cur,
      stages: { ...cur.stages, [stageId]: next },
      updatedAt: new Date().toISOString(),
    });
    await saveIssueNow(mergedIssue);
    emitRecordUpdated('series', mergedIssue.seriesId);
    return {
      result: { issue: mergedIssue, stage: mergedIssue.stages[stageId] },
      frontCoverChanged,
    };
  };
  return getIssue(issueId, { includeDeleted: true }).then((existing) =>
    queueSeriesIssuesWrite(existing.seriesId, work).then(async ({ result, frontCoverChanged }) => {
      if (frontCoverChanged) {
        const { refreshSeriesCoverImage } = await import('./seriesCoverImage.js');
        await refreshSeriesCoverImage(result.issue.seriesId).catch(() => {});
      }
      return result;
    }),
  );
}
