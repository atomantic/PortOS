// Adapt the shared shot clip request to the board's readiness checks and render lane.

import { buildSceneClipRequest as buildClipRequest, sceneClipNeedsCastMedia } from '../../../server/lib/musicVideo/musicVideoClipRequest.js';
import { musicVideoSceneCastIds } from '../../../server/lib/musicVideo/musicVideoConditioning.js';
import { renderTierVideoSettings } from '../../../server/lib/musicVideo/musicVideoRenderTier.js';

function videoRenderLabel(settings) {
  if (settings?.renderPool?.mode === 'peers') return 'peer';
  if (settings?.renderPool?.mode === 'both') return null;
  return settings?.backend || 'local';
}

/** Why this shot's cast guides block a project-default LTX reference clip, or null. */
function castGuideError(project, scene, castMedia) {
  const ids = musicVideoSceneCastIds(project, scene);
  const failed = ids.find((id) => castMedia?.[id] === null);
  if (failed) {
    const name = (project?.concept?.subjects || []).find((subject) => subject?.ingredientId === failed)?.name || failed;
    return `Cast guides could not be loaded for ${name}. Retry before rendering.`;
  }
  if (ids.every((id) => castMedia?.[id] !== undefined)) return null;
  return 'Cast guides are still loading. Try again in a moment.';
}

/**
 * The clip POST body for one shot, or `{ error }` when a precondition fails.
 * `label` is the lane placeholder ("Rendering grok…").
 */
export function buildSceneClipRequest({ scene, project, card, target, tier, revisionId, videoSettings, castMedia }) {
  const settings = renderTierVideoSettings(target?.backend ?? videoSettings.settings.backend, {
    scene, scenes: project.scenes, videoSettings: videoSettings.settings, override: target, tier,
  });
  const videoBlockedReason = target && videoSettings.blockedReasonFor
    ? videoSettings.blockedReasonFor(settings)
    : videoSettings.videoBlockedReason;
  if (videoBlockedReason) return { error: videoBlockedReason };

  const modelId = settings.modelId || videoSettings.defaultModel;
  const model = videoSettings.models?.find((entry) => entry.id === modelId)
    ?? (videoSettings.activeModel?.id === modelId ? videoSettings.activeModel : null);
  const input = { scene, project, card: card || {}, target, tier, revisionId, settings, model };
  if (sceneClipNeedsCastMedia(input)) {
    const guideError = castGuideError(project, scene, castMedia);
    if (guideError) return { error: guideError };
  }

  const { body, error } = buildClipRequest({ ...input, castMedia, audioReactiveLora: videoSettings.detectedAudioReactiveLora });
  if (error) return { error: error.message };
  return {
    label: videoRenderLabel(settings),
    body: { ...body, ...(tier ? { tier } : {}), musicVideo: JSON.stringify(body.musicVideo) },
  };
}
