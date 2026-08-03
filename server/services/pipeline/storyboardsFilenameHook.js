/**
 * Storyboards — shot start-frame filename hook.
 *
 * Stamps `startFrameFilename` onto the matching shot record on media-job
 * completion so the UI keeps rendering after mediaJobQueue's 24h archive
 * TTL expires. Legacy scene-level renders (no shot decomposition) use the
 * media-job record directly; only per-shot owners produced by
 * `buildStoryboardsShotOwner` are handled here.
 *
 * Targets resolve by the durable scene/shot ids the owner carries (#3413), so
 * a reorder between enqueue and completion still lands the render on the shot
 * the user asked for. Owners enqueued before that change carry no ids — those
 * fall back to the indexes, which is exactly the behavior they were queued
 * under, so in-flight jobs still attach across the upgrade.
 */

import { parseStoryboardsShotOwner } from './owners.js';
import { resolveStoryboardTarget } from '../../lib/storyboardScenes.js';
import { createFilenameHook } from './filenameHookFactory.js';

const hook = createFilenameHook({
  name: 'storyboards',
  stageId: 'storyboards',
  parseOwner: parseStoryboardsShotOwner,
  applyFilename: (currentStage, parsed, job, filename) => {
    const scenes = Array.isArray(currentStage?.scenes) ? currentStage.scenes : [];
    const sceneHit = resolveStoryboardTarget(scenes, { id: parsed.sceneId, index: parsed.sceneIndex });
    const scene = sceneHit.record;
    if (!scene) return null;
    const shots = Array.isArray(scene.shots) ? scene.shots : [];
    const shotHit = resolveStoryboardTarget(shots, { id: parsed.shotId, index: parsed.shotIndex });
    const shot = shotHit.record;
    // Skip if THIS job isn't the shot's active render — a re-render that
    // landed between enqueue and this event would otherwise be overwritten
    // with the older filename.
    if (!shot || shot.startFrameJobId !== job.id) return null;
    const nextShots = [...shots];
    nextShots[shotHit.index] = { ...shot, startFrameFilename: filename };
    const nextScenes = [...scenes];
    nextScenes[sceneHit.index] = { ...scene, shots: nextShots };
    return {
      patch: { scenes: nextScenes },
      label: `scene${sceneHit.index}/shot${shotHit.index}`,
    };
  },
});

export const initStoryboardsFilenameHook = hook.init;
export const __testing = hook.__testing;
