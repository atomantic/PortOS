/**
 * Music Video sequence coverage (#14241): a run of cutaway shots that share a
 * set and protagonist generated in ONE timed fal request, then cut back onto
 * each scene's existing in/out points (musicVideoSequenceVideoHook.js).
 *
 * `previewSequenceCoverage` is read-only: the runs, the exact prompt and fal
 * body, each scene's cut inside the clip, and why other shots stay per-shot.
 * `submitSequenceCoverage` queues one run's request. The preview and the submit
 * build the request with the same code, so what the preview shows is what is sent.
 */

import { basename } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { buildFalVideoRequest } from '../../lib/falVideoModels.js';
import {
  planSequenceCoverage, SEQUENCE_PROMPT_EXPANSION, sequenceGroupInput, sequenceModelId,
} from '../../lib/musicVideoSequenceCoverage.js';

export function previewSequenceCoverage(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const modelId = sequenceModelId(project);
  const { groups, perShot } = planSequenceCoverage(scenes, { modelId });
  return {
    modelId,
    perShot,
    groups: groups.map((group) => {
      const { members, prompt, resolution, promptAdditions, spans } = sequenceGroupInput(project, group);
      let request;
      try {
        // Placeholder image URLs: the preview shows the body's shape, not hosted inputs.
        const built = buildFalVideoRequest({
          modelId, prompt, seconds: group.durationSec, resolution,
          referenceImageUrls: members.map((s) => s.referenceImageId || 'pending-frame'),
          promptExpansion: SEQUENCE_PROMPT_EXPANSION,
        });
        request = { body: built.body, seconds: built.seconds, estimatedCostUsd: built.estimatedCostUsd, promptAdditions };
      } catch (err) {
        request = { refusal: err.message };
      }
      return { ...group, prompt, request, spans };
    }),
  };
}

const refuse = (status, code, message) => { throw new ServerError(message, { status, code }); };

/**
 * Queue the one fal request for the planned run whose scenes are exactly
 * `sceneIds`. Every member needs its reference frame; nothing is sent when the
 * run no longer matches the plan. Returns `{ jobId, sceneIds, prompt }`.
 */
export async function submitSequenceCoverage(projectId, { sceneIds } = {}) {
  const [{ requireProject }, { musicVideoBriefAllowsVideo }, { assertShotActionContract }, { captureTakeDependencies },
    { resolveGalleryImage }, { musicVideoAspect }] = await Promise.all([
    import('./requireProject.js'), import('../../lib/musicVideoMediumPlan.js'), import('../../lib/musicVideoActionContract.js'),
    import('../../lib/musicVideoDependencies.js'), import('../../lib/pathSafety.js'), import('../../lib/musicVideoAspect.js'),
  ]);
  const project = await requireProject(projectId);
  if (!musicVideoBriefAllowsVideo(project)) {
    refuse(409, 'MUSIC_VIDEO_NO_VIDEO_TOOL', 'No video tool is selected in this project\'s brief, so generated footage is not dispatched.');
  }
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const modelId = sequenceModelId(project);
  if (!modelId) refuse(409, 'SEQUENCE_NEEDS_FAL', 'Sequence coverage renders on fal.ai; this project renders clips on another backend.');
  const wanted = (sceneIds || []).join('\u0000');
  const group = planSequenceCoverage(scenes, { modelId }).groups.find((g) => g.sceneIds.join('\u0000') === wanted);
  if (!group) refuse(409, 'SEQUENCE_NOT_PLANNED', 'Those shots are not a planned sequence run any more. Reload the sequence preview.');

  // fal records the prompt-expansion chip on the clip itself (videoGen/fal.js falVideoSentPrompt).
  const { members, prompt, resolution, spans } = sequenceGroupInput(project, group);
  const referenceImagePaths = members.map((scene) => {
    assertShotActionContract(scene);
    const path = scene.referenceImageId ? resolveGalleryImage(scene.referenceImageId) : null;
    if (!path) refuse(409, 'PRODUCTION_FRAME_MISSING', `"${scene.label || scene.sceneId}" has no reference frame yet`);
    return path;
  });
  let built;
  try {
    built = buildFalVideoRequest({
      modelId, prompt, seconds: group.durationSec, resolution, referenceImageUrls: referenceImagePaths, promptExpansion: SEQUENCE_PROMPT_EXPANSION,
    });
  } catch (err) {
    refuse(400, 'VALIDATION_ERROR', err.message);
  }
  const aspect = musicVideoAspect(project);
  const { enqueueJob } = await import('../mediaJobQueue/index.js');
  const { jobId } = await enqueueJob({
    kind: 'video',
    owner: `music-video-sequence:${projectId}`,
    params: {
      mode: 'fal',
      videoMode: 'text',
      modelId,
      prompt,
      negativePrompt: '',
      duration: built.seconds,
      ...(resolution ? { resolution } : {}),
      ...(aspect ? { aspectRatio: aspect, frameAspect: aspect } : {}),
      referenceImagePaths,
      // No sceneId: the per-scene hooks ignore this job; the sequence hook cuts it onto `spans`.
      musicVideo: { projectId, sequence: { sceneIds: group.sceneIds, startSec: group.startSec, durationSec: group.durationSec, spans } },
      musicVideoSequenceDependencies: Object.fromEntries(members.map((s) => [s.sceneId, captureTakeDependencies(s, basename(s.referenceImageId))])),
      ...(Number.isFinite(built.estimatedCostUsd) ? { musicVideoCostUsd: built.estimatedCostUsd, musicVideoCostModelId: modelId } : {}),
    },
  });
  console.log(`🎞️ music-video sequence ${projectId.slice(0, 8)} [${group.sceneIds.join(', ')}] → one ${built.seconds}s fal request ${jobId.slice(0, 8)}`);
  return { jobId, sceneIds: group.sceneIds, prompt };
}
