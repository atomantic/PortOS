import { sceneEndFramePlan } from '../../../../server/lib/musicVideoEndFrame.js';
import { falSceneTake, runwaySceneTake } from '../../lib/musicVideoShotTiming.js';

/**
 * Whether a clip rendered with `settings` (the project's saved renderer, or a
 * scene card's Render on pick merged over it) ends on the scene's end frame:
 * the same model the clip request is built with (useMusicVideoSceneMedia
 * generateSceneVideo), so a saved end-frame upgrade model counts. A local
 * clip's model (the pick, else the install default) decides whether it renders
 * first+last frame (#11258).
 */
export function sceneEndFramePlanFor(scene, settings = {}, { models = [], defaultModel = '' } = {}) {
  const mode = settings.generationMode === 'suppliedAudio' || (settings.backend === 'local' && settings.generationMode === 'audioReactive') ? 'a2v' : 'image';
  const falModelId = settings.backend === 'fal' ? falSceneTake({ scene, videoSettings: settings }).modelId : null;
  const runwayModelId = settings.backend === 'runway' ? runwaySceneTake({ scene, videoSettings: settings }).modelId : null;
  const localRuntime = settings.backend === 'local'
    ? models.find((model) => model.id === (settings.modelId || defaultModel))?.runtime ?? null
    : null;
  return sceneEndFramePlan(scene, { backend: settings.backend || null, falModelId, runwayModelId, mode, localRuntime });
}
