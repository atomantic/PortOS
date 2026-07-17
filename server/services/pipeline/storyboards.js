/**
 * Pipeline — Storyboard scene/shot renders + scene prompt refine (#2531)
 *
 * Single-scene video + single-shot start-frame enqueue, plus the storyboard
 * scene prompt refine / N-candidate fan-out. Extracted from the former
 * monolithic `visualStages.js`; shares plumbing via `./visualStageHelpers.js`.
 */

import { enqueueJob } from '../mediaJobQueue/index.js';
import { updateStage, assertStageUnlocked } from './issues.js';
import { buildStoryboardsShotOwner } from './owners.js';
import { ServerError } from '../../lib/errorHandler.js';
import { matchCharactersInText } from '../../lib/scenePrompt.js';
import { getDefaultVideoModelId, getVideoModels } from '../../lib/mediaModels.js';
import { ASPECT_PRESETS } from '../../lib/creativeDirectorPresets.js';
import { runPromptRefine, runImagePromptCandidates } from './refineHelpers.js';
import {
  composeVisualPrompt, resolveMode, enqueueImageJob, loadBibleContext,
  seriesBibleCtx, issueCtx, neighborText, loadRefineContext,
} from './visualStageHelpers.js';

/**
 * Enqueue a single-scene video render for a storyboard scene. Builds the
 * same prompt the episode-video CD treatment would build for this scene
 * (composeVisualPrompt with style notes + world style), then enqueues a
 * video job through the shared mediaJobQueue.
 *
 * Persists the resulting jobId on `stages.storyboards.scenes[index]
 * .sceneVideoJobId` so the UI can reflect it on reload.
 *
 * Returns { jobId, prompt, sceneIndex }.
 */
export async function enqueueStoryboardSceneVideo(issueId, sceneIndex, options = {}) {
  const idx = Number(sceneIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new ServerError('sceneIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_SCENE_BAD_INDEX',
    });
  }
  const { issue, settings, series, world, canon } = await loadBibleContext(issueId);
  assertStageUnlocked(issue, 'storyboards');
  const pythonPath = settings.imageGen?.local?.pythonPath || null;
  if (!pythonPath) {
    throw new ServerError(
      'Local video generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' },
    );
  }
  const scenes = Array.isArray(issue.stages?.storyboards?.scenes)
    ? [...issue.stages.storyboards.scenes]
    : [];
  const scene = scenes[idx];
  if (!scene) {
    throw new ServerError(`sceneIndex ${idx} out of range (have ${scenes.length})`, {
      status: 404, code: 'PIPELINE_SCENE_NOT_FOUND',
    });
  }
  if (!(scene.description || '').trim()) {
    throw new ServerError('scene has no description — add a description before rendering', {
      status: 400, code: 'PIPELINE_SCENE_EMPTY_DESCRIPTION',
    });
  }

  const matchedCharacters = matchCharactersInText(
    `${scene.description || ''} ${scene.slugline || ''}`,
    canon.characters,
  );
  const prompt = composeVisualPrompt({
    series,
    description: scene.description,
    slugline: scene.slugline || '',
    extraStyle: options.extraStyle || '',
    matchedCharacters,
    world,
    canon,
    characterAppearances: scene.characterAppearances,
  });

  const aspectRatio = ASPECT_PRESETS[options.aspectRatio] ? options.aspectRatio : '16:9';
  const { width, height } = ASPECT_PRESETS[aspectRatio];
  const modelId = options.modelId || settings.videoGen?.defaultModelId || getDefaultVideoModelId();
  // Validate the model exists for this platform before enqueueing — otherwise
  // the worker will fail with "Unknown video model" and leave a persisted
  // doomed entry in the queue. Mirrors the same fail-fast pattern as
  // /api/video-gen's route validation.
  if (!getVideoModels().some((m) => m.id === modelId)) {
    throw new ServerError(`Unknown video model "${modelId}"`, {
      status: 400, code: 'PIPELINE_UNKNOWN_VIDEO_MODEL',
    });
  }
  const negativePrompt = options.negativePrompt || 'text, watermark, blur, motion blur, low quality';

  const { jobId } = enqueueJob({
    kind: 'video',
    params: {
      pythonPath,
      prompt,
      negativePrompt,
      modelId,
      width,
      height,
      mode: 't2v',
      disableAudio: true,
      tiling: 'auto',
      chunks: 1,
    },
    owner: `pipeline:${issueId}:storyboards:scene${idx}`,
  });

  scenes[idx] = { ...scene, sceneVideoJobId: jobId };
  const { issue: updatedIssue, stage } = await updateStage(issueId, 'storyboards', {
    status: 'edited',
    scenes,
  });
  console.log(`🎥 Pipeline scene video — issue=${issueId.slice(0, 8)} scene=${idx + 1} jobId=${jobId.slice(0, 8)}`);
  return { jobId, prompt, sceneIndex: idx, issue: updatedIssue, stage };
}

/**
 * Enqueue an image render for a single shot inside a storyboard scene. Mirror
 * of enqueueStoryboardSceneVideo but for IMAGE (start-frame), at shot
 * granularity. Shot description is the primary anchor; falls back to the
 * parent scene's description when the shot is sparse so a fresh shot still
 * renders something coherent.
 */
export async function enqueueStoryboardShotStartFrame(issueId, sceneIndex, shotIndex, options = {}) {
  const sIdx = Number(sceneIndex);
  const tIdx = Number(shotIndex);
  if (!Number.isInteger(sIdx) || sIdx < 0 || !Number.isInteger(tIdx) || tIdx < 0) {
    throw new ServerError('sceneIndex and shotIndex must be non-negative integers', {
      status: 400, code: 'PIPELINE_SHOT_BAD_INDEX',
    });
  }
  const { issue, settings, series, world, canon } = await loadBibleContext(issueId);
  assertStageUnlocked(issue, 'storyboards');
  const scenes = Array.isArray(issue.stages?.storyboards?.scenes)
    ? [...issue.stages.storyboards.scenes]
    : [];
  const scene = scenes[sIdx];
  if (!scene) {
    throw new ServerError(`sceneIndex ${sIdx} out of range (have ${scenes.length})`, {
      status: 404, code: 'PIPELINE_SCENE_NOT_FOUND',
    });
  }
  const shots = Array.isArray(scene.shots) ? [...scene.shots] : [];
  const shot = shots[tIdx];
  if (!shot) {
    throw new ServerError(`shotIndex ${tIdx} out of range (have ${shots.length})`, {
      status: 404, code: 'PIPELINE_SHOT_NOT_FOUND',
    });
  }

  const shotDescription = (shot.description || '').trim();
  const description = shotDescription || (scene.description || '').trim();
  if (!description) {
    throw new ServerError('shot has no description (parent scene also empty) — add a description first', {
      status: 400, code: 'PIPELINE_SHOT_EMPTY_DESCRIPTION',
    });
  }

  const mode = resolveMode(options, settings);
  const matchedCharacters = matchCharactersInText(
    `${description} ${scene.slugline || ''}`,
    canon.characters,
  );
  const prompt = composeVisualPrompt({
    series,
    description,
    slugline: scene.slugline || '',
    extraStyle: options.extraStyle || '',
    matchedCharacters,
    world,
    canon,
    // A shot inherits its parent scene's wardrobe picks.
    characterAppearances: scene.characterAppearances,
  });

  const jobId = enqueueImageJob({
    prompt, world, settings, options, mode,
    owner: buildStoryboardsShotOwner({ issueId, sceneIndex: sIdx, shotIndex: tIdx }),
    logLine: `🎞️ Pipeline shot start-frame — issue=${issueId.slice(0, 8)} scene=${sIdx + 1} shot=${tIdx + 1}`,
  });

  shots[tIdx] = { ...shot, startFrameJobId: jobId };
  scenes[sIdx] = { ...scene, shots };
  const { issue: updatedIssue, stage } = await updateStage(issueId, 'storyboards', {
    status: 'edited',
    scenes,
  });
  return { jobId, mode, prompt, sceneIndex: sIdx, shotIndex: tIdx, issue: updatedIssue, stage };
}

// Validate the scene index, lock, and non-empty description, then build the
// `pipeline-storyboard-image-prompt` template variables. Shared by the 1:1
// refine and the N-candidate fan-out so both feed the LLM identical context.
async function loadStoryboardScenePromptContext(issueId, sceneIndex) {
  const idx = Number(sceneIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new ServerError('sceneIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_SCENE_BAD_INDEX',
    });
  }
  const { issue, series } = await loadRefineContext(issueId);
  assertStageUnlocked(issue, 'storyboards');
  const scenes = Array.isArray(issue.stages?.storyboards?.scenes)
    ? [...issue.stages.storyboards.scenes]
    : [];
  const scene = scenes[idx];
  if (!scene) {
    throw new ServerError(`sceneIndex ${idx} out of range (have ${scenes.length})`, {
      status: 404, code: 'PIPELINE_SCENE_NOT_FOUND',
    });
  }
  if (!(scene.description || '').trim()) {
    throw new ServerError('scene has no description to refine', {
      status: 400, code: 'PIPELINE_SCENE_EMPTY_DESCRIPTION',
    });
  }

  const prev = scenes[idx - 1];
  const next = scenes[idx + 1];
  const variables = {
    series: seriesBibleCtx(series),
    issue: issueCtx(issue),
    sceneNumber: idx + 1,
    sceneCount: scenes.length,
    slugline: (scene.slugline || '').slice(0, 200),
    hasSlugline: !!(scene.slugline || '').trim(),
    description: (scene.description || '').slice(0, 4000),
    hasNeighbors: !!(prev || next),
    previousScene: neighborText(prev),
    nextScene: neighborText(next),
  };
  return { issue, idx, scenes, scene, variables };
}

/**
 * Run the `pipeline-storyboard-image-prompt` template against the current
 * storyboard scene + surrounding context, then persist the refined
 * description on the scene. Returns { scene, issue, stage, runId, changes, providerId }.
 */
export async function refineStoryboardScenePrompt(issueId, sceneIndex, options = {}) {
  const { idx, scenes, scene, variables } = await loadStoryboardScenePromptContext(issueId, sceneIndex);

  const { refined, changes, runId, providerId } = await runPromptRefine({
    templateName: 'pipeline-storyboard-image-prompt',
    variables,
    options,
    source: 'pipeline-storyboard-prompt-refine',
    logTag: `Pipeline scene refine — issue=${issueId.slice(0, 8)} scene=${idx + 1}`,
  });

  scenes[idx] = { ...scene, description: refined };
  const { issue: updatedIssue, stage } = await updateStage(issueId, 'storyboards', {
    status: 'edited',
    scenes,
  });
  return { scene: scenes[idx], issue: updatedIssue, stage, runId, changes, providerId };
}

/**
 * Generate N candidate image-gen prompts for a single storyboard scene
 * WITHOUT mutating the scene (issue #904). Returns
 * { candidates, requested, sceneIndex }.
 */
export async function generateStoryboardSceneImagePrompts(issueId, sceneIndex, { count, ...options } = {}) {
  const { idx, variables } = await loadStoryboardScenePromptContext(issueId, sceneIndex);
  const { candidates, requested } = await runImagePromptCandidates({
    count,
    templateName: 'pipeline-storyboard-image-prompt',
    variables,
    options,
    source: 'pipeline-storyboard-image-prompts',
    logTag: `Pipeline scene image-prompts — issue=${issueId.slice(0, 8)} scene=${idx + 1}`,
  });
  return { candidates, requested, sceneIndex: idx };
}
