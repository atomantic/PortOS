/**
 * Music Video sequence coverage (#14241, #15588): a run of cutaway shots that
 * share a set and protagonist generated in ONE timed request on fal.ai, Grok,
 * or a local model, then cut back onto each scene's existing in/out points
 * (musicVideoSequenceVideoHook.js).
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
  planProjectSequenceCoverage, SEQUENCE_PROMPT_EXPANSION, sequenceGroupInput, sequenceModelId,
} from '../../lib/musicVideoSequenceCoverage.js';

function previewRequest(project, group, { modelId, members, prompt, resolution, promptAdditions }) {
  const backend = project?.videoSettings?.backend;
  if (backend === 'grok') return { seconds: group.requestSec };
  if (backend === 'local') return { seconds: group.durationSec, numFrames: group.numFrames };
  try {
    // Placeholder image URLs: the preview shows the body's shape, not hosted inputs.
    const built = buildFalVideoRequest({
      modelId, prompt, seconds: group.durationSec, resolution,
      referenceImageUrls: members.map((s) => s.referenceImageId || 'pending-frame'),
      promptExpansion: SEQUENCE_PROMPT_EXPANSION,
    });
    return { body: built.body, seconds: built.seconds, estimatedCostUsd: built.estimatedCostUsd, promptAdditions };
  } catch (err) {
    return { refusal: err.message };
  }
}

export function previewSequenceCoverage(project) {
  const modelId = sequenceModelId(project);
  const { groups, perShot } = planProjectSequenceCoverage(project, { modelId });
  return {
    modelId,
    perShot,
    groups: groups.map((group) => {
      const input = sequenceGroupInput(project, group);
      return { ...group, prompt: input.prompt, request: previewRequest(project, group, { modelId, ...input }), spans: input.spans };
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
  const backend = project?.videoSettings?.backend || null;
  const modelId = sequenceModelId(project);
  if (backend !== 'grok' && backend !== 'local' && !modelId) {
    refuse(409, 'SEQUENCE_NEEDS_FAL', 'Sequence coverage renders on fal.ai, Grok, or a local model. This project renders clips on another backend.');
  }
  if (backend === 'local' && !project.videoSettings?.modelId) {
    refuse(409, 'SEQUENCE_NEEDS_MODEL', 'Pick a local video model before rendering this sequence.');
  }
  const wanted = (sceneIds || []).join('\u0000');
  const group = planProjectSequenceCoverage(project, { modelId }).groups.find((g) => g.sceneIds.join('\u0000') === wanted);
  if (!group) refuse(409, 'SEQUENCE_NOT_PLANNED', 'Those shots are not a planned sequence run any more. Reload the sequence preview.');

  // fal records the prompt-expansion chip on the clip itself (videoGen/fal.js falVideoSentPrompt).
  const { members, prompt, resolution, spans } = sequenceGroupInput(project, group);
  const referenceImagePaths = members.map((scene) => {
    assertShotActionContract(scene);
    const path = scene.referenceImageId ? resolveGalleryImage(scene.referenceImageId) : null;
    if (!path) refuse(409, 'PRODUCTION_FRAME_MISSING', `"${scene.label || scene.sceneId}" has no reference frame yet`);
    return path;
  });
  const sequence = { sceneIds: group.sceneIds, startSec: group.startSec, durationSec: group.durationSec, spans };
  const dependencies = Object.fromEntries(members.map((s) => [s.sceneId, captureTakeDependencies(s, basename(s.referenceImageId))]));
  const aspect = musicVideoAspect(project);
  const { enqueueJob } = await import('../mediaJobQueue/index.js');
  let params;
  let loggedSeconds;
  if (backend === 'grok' || backend === 'local') {
    const { getSettings } = await import('../settings.js');
    const settings = await getSettings();
    const present = (value) => (typeof value === 'string' && value.trim() ? value : null);
    params = backend === 'grok'
      ? {
        mode: 'grok',
        prompt,
        duration: group.requestSec,
        sourceImagePath: referenceImagePaths[0],
        ...(present(settings.imageGen?.grok?.grokPath) ? { grokPath: settings.imageGen.grok.grokPath } : {}),
        ...(aspect ? { aspectRatio: aspect } : {}),
        musicVideo: { projectId, sequence },
        musicVideoSequenceDependencies: dependencies,
      }
      : {
        mode: 'image',
        prompt,
        numFrames: group.numFrames,
        modelId: project.videoSettings.modelId,
        fps: 24,
        disableAudio: true,
        sourceImagePath: referenceImagePaths[0],
        ...(present(settings.imageGen?.local?.pythonPath) ? { pythonPath: settings.imageGen.local.pythonPath } : {}),
        musicVideo: { projectId, sequence },
        musicVideoSequenceDependencies: dependencies,
      };
    loggedSeconds = backend === 'grok' ? group.requestSec : group.durationSec;
  } else {
    let built;
    try {
      built = buildFalVideoRequest({
        modelId, prompt, seconds: group.durationSec, resolution, referenceImageUrls: referenceImagePaths, promptExpansion: SEQUENCE_PROMPT_EXPANSION,
      });
    } catch (err) {
      refuse(400, 'VALIDATION_ERROR', err.message);
    }
    params = {
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
      musicVideo: { projectId, sequence },
      musicVideoSequenceDependencies: dependencies,
      ...(Number.isFinite(built.estimatedCostUsd) ? { musicVideoCostUsd: built.estimatedCostUsd, musicVideoCostModelId: modelId } : {}),
    };
    loggedSeconds = built.seconds;
  }
  const { jobId } = await enqueueJob({ kind: 'video', owner: `music-video-sequence:${projectId}`, params });
  console.log(`🎞️ music-video sequence ${projectId.slice(0, 8)} [${group.sceneIds.join(', ')}] → one ${loggedSeconds}s ${backend || 'fal'} request ${jobId.slice(0, 8)}`);
  return { jobId, sceneIds: group.sceneIds, prompt };
}
