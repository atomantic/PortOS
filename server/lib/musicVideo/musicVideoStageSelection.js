/**
 * Music Video stage facts and current-stage selection shared by the summary and `deriveStages` (#18453).
 *
 * Callers pass the inputs only they own (approvals, publish readiness); client decoration and actions stay client-side.
 */
import { composedDrawsLyrics, isLayeredComposition, sceneRenderReady } from './musicVideoLayers.js';
import { blenderShotsReady } from './musicVideoBlender.js';
import { finishedOutside, finishedOutsideCovers } from './musicVideoFinishedOutside.js';
import { shotSheetDoneProgress } from './musicVideoShotSheet.js';

/** A production run in one of these states can still be resumed (or is live). */
export const RESUMABLE_RUN_STATUSES = new Set(['running', 'stopped', 'limit-reached', 'blocked', 'needs-replan', 'awaiting-video']);

/** Footage-optional modes draw their own picture, so scene footage never gates Shots. */
export const FOOTAGE_OPTIONAL_MODES = new Set(['code', 'document', 'eidoverse', 'blender']);

/** Stage ids in the order the director decides them; optional stages are never "current". */
export const STAGE_ORDER = [
  { id: 'story', optional: true },
  { id: 'setup' },
  { id: 'board' },
  { id: 'cast-sets' },
  { id: 'previz', optional: true },
  { id: 'produce' },
  { id: 'review' },
  { id: 'publish' },
];

/** The live production run, else the latest: the run whose cap and status a project shows. */
export const currentRun = (project) => {
  const runs = Array.isArray(project?.productionRuns) ? project.productionRuns : [];
  return runs.find((r) => RESUMABLE_RUN_STATUSES.has(r.status)) || runs[runs.length - 1] || null;
};

/** A footage mode needs at least one scene and every scene render-ready; self-drawn modes skip the gate. */
export function footageReady(project) {
  if (FOOTAGE_OPTIONAL_MODES.has(project?.composition?.mode || 'concat')) return true;
  const scenes = project?.scenes || [];
  const layered = isLayeredComposition(project);
  return scenes.length > 0 && scenes.every((scene) => sceneRenderReady(scene, { layered, scenes }));
}

/** A code video is composed once it was generated or the director holds sections to render. */
export const codeComposed = (project) => {
  const code = project?.composition?.codeVideo;
  return !!code?.generatedAt || (code?.sections || []).length > 0;
};

/** A Blender film is composed once every shot has a complete, current final render (`project.blenderShots`). */
export const blenderShotsDone = (project) => blenderShotsReady(project?.blenderShots);

export function composeDone(project, mode = project?.composition?.mode || 'concat') {
  const composition = project?.composition || {};
  if (mode === 'composed') return composition.noTypography === true || (composition.textCues || []).length > 0 || composedDrawsLyrics(project);
  if (mode === 'document') return !!composition.document;
  if (mode === 'eidoverse') return !!composition.eidoverseScene?.inlineScript;
  if (mode === 'code') return codeComposed(project);
  if (mode === 'blender') return blenderShotsDone(project);
  return true;
}

/**
 * Shots facts. `shotsDone`: storyboard approved, footage in and composition ready. `produceDone`
 * adds the shot sheet (once in use, every shot is marked Done there). `liveRun`: a run parked
 * short of running whose shots are all done since is finished in fact and holds nothing open.
 */
export function shotsFacts(project, { planned, run }) {
  const shotsDone = !!planned && footageReady(project) && composeDone(project);
  const liveRun = !!run && RESUMABLE_RUN_STATUSES.has(run.status) && (run.status === 'running' || !shotsDone);
  return { shotsDone, produceDone: shotsDone && shotSheetDoneProgress(project)?.all !== false, liveRun };
}

/**
 * The first required stage not done; a live run pins Shots. Finished-outside coverage counts as
 * done. `done` is keyed by stage id; a missing key is not done. Falls back to Publish.
 */
export function selectCurrentStage(project, done, { liveRun = false } = {}) {
  if (liveRun) return 'produce';
  const external = !!finishedOutside(project);
  const isDone = (id) => !!done[id] || (external && finishedOutsideCovers(project, id));
  return STAGE_ORDER.find((stage) => !stage.optional && !isDone(stage.id))?.id || 'publish';
}
