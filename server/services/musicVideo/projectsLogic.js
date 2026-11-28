/** Storage-independent Music Video project transforms used by the stores and callers. */
export {
  CLEARED_VOCAL_STEM,
  mirrorStatus,
  buildProjectRecord,
  cloneProjectRecord,
  applyProjectPatch,
  setAudioAnalysis,
  setAnalysisSections,
  setMidiTranscription,
  afterLoad,
  beforeSave,
  toStored,
  mirrorTimestamp,
  mergeProjectRecord,
} from './projectRecordLogic.js';
export {
  addScene,
  addScenes,
  replaceScenes,
  applyStoryboardShotSync,
  applySceneUpdate,
  varySceneWipes,
  removeScene,
  reorderScenes,
  splitScene,
  applySceneSplit,
  cutScenesOnLyricWords,
  mergeNextScene,
  mergePreviousScene,
} from './sceneListLogic.js';

// Archived review evidence is only needed by full reads. Keep the current
// approvals, draft and proof for readiness and list presentation.
export const summaryReadOmissions = { field: 'productionReview', keys: ['reviewedRevisions', 'approvalHistory'] };
