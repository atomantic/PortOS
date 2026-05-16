/**
 * Storyboards — shot start-frame filename hook.
 *
 * Stamps `startFrameFilename` onto the matching shot record on media-job
 * completion so the UI keeps rendering after mediaJobQueue's 24h archive
 * TTL expires. Legacy scene-level renders (no shot decomposition) use the
 * media-job record directly; only per-shot owners produced by
 * `buildStoryboardsShotOwner` are handled here.
 */

import { parseStoryboardsShotOwner } from './owners.js';
import { createFilenameHook } from './filenameHookFactory.js';

const hook = createFilenameHook({
  name: 'storyboards',
  stageId: 'storyboards',
  parseOwner: parseStoryboardsShotOwner,
  applyFilename: (currentStage, parsed, job, filename) => {
    const scenes = Array.isArray(currentStage?.scenes) ? currentStage.scenes : [];
    const scene = scenes[parsed.sceneIndex];
    const shots = Array.isArray(scene?.shots) ? scene.shots : [];
    const shot = shots[parsed.shotIndex];
    // Skip if THIS job isn't the shot's active render — a re-render that
    // landed between enqueue and this event would otherwise be overwritten
    // with the older filename.
    if (!shot || shot.startFrameJobId !== job.id) return null;
    const nextShots = [...shots];
    nextShots[parsed.shotIndex] = { ...shot, startFrameFilename: filename };
    const nextScenes = [...scenes];
    nextScenes[parsed.sceneIndex] = { ...scene, shots: nextShots };
    return {
      patch: { scenes: nextScenes },
      label: `scene${parsed.sceneIndex}/shot${parsed.shotIndex}`,
    };
  },
});

export const initStoryboardsFilenameHook = hook.init;
export const __testing = hook.__testing;
