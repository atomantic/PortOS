/** Preserves the Music Video stage API across its focused modules. */
export {
  changeRequestBlocker, feedbackRevisionScope, openChangeRequests, planShotRows, proofReviewInUse,
  sceneShotName, stageChecklist, stageHasChecklist, stepNotes, summarizeStoryboardProblems,
} from './musicVideoChecklists.js';
export {
  SPEND_ADJUSTMENT_LANES, boardJobEstimate, projectFalSpend, projectSpend, spendLaneLabel,
} from './musicVideoEstimates.js';
export { describePreviewSourceChange, listPreviewSources } from './musicVideoPreviewSources.js';
export {
  ART_DIRECTION_ANCHOR, CAST_CHECKIN_ANCHOR, FOOTAGE_OPTIONAL_MODES, LOOK_GUIDES_ANCHOR, MUSIC_VIDEO_PAGES,
  MUSIC_VIDEO_STAGES, RESUMABLE_RUN_STATUSES, SHOT_SHEET_ANCHOR, STALE_RENDER_MESSAGE, artDirectionGaps,
  autopilotStatus, changedFieldsText, compareMusicVideoProjectsNewestFirst, currentProductionRun,
  deriveNextAction, deriveStages, describeProjectStatus, isFinalRenderCurrent, isFinalRenderStale,
  isStageId, lyricSetupState, problemItemsOf, productionReviewStopGuidance, projectHasAudio,
  projectServicesSummary, projectShotSummary, publishPlatformProgress, publishRowAnchor, resolveStageParam,
  staleApprovalText,
} from './musicVideoStageProgress.js';
