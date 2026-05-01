/**
 * Creative Director — agent prompt builders.
 *
 * Two cognitive steps require an agent:
 *   - `treatment`: write the story + scene plan
 *   - `evaluate` : judge a freshly-rendered scene against the style spec
 *
 * Both build their prompt text by calling `buildPrompt(stageName, view)`
 * against templates registered in the Prompts Manager
 * (`data/prompts/stages/cd-treatment.md`, `cd-evaluate.md`). The agent text
 * is editable from the UI; this module's only job is to compute the
 * **view object** the template renders against — i.e. the precomputed
 * scalars/sections (aspect dimensions, render params, multi-frame list,
 * timeline-position labels, retry deltas) that the template engine alone
 * can't derive.
 *
 * Programmatic non-cognitive steps (per-scene render orchestration, final
 * stitch) live in services/creativeDirector/{sceneRunner,stitchRunner}.js
 * and never spawn an agent.
 */

import {
  ASPECT_PRESETS,
  QUALITY_PRESETS,
  presetToRenderParams,
} from './creativeDirectorPresets.js';
import { PORTOS_API_URL } from './ports.js';
import { buildPrompt } from '../services/promptService.js';

// Shared project-block view used by both prompt stages. Defaults out
// nullable fields to `''` so the templates' `{{#x}}`/`{{^x}}` Mustache-spec
// emptiness checks fire on missing values without each template having to
// guard `null` separately.
function buildProjectView(project) {
  return {
    id: project.id,
    name: project.name,
    aspectRatio: project.aspectRatio,
    quality: project.quality,
    modelId: project.modelId,
    targetDurationSeconds: project.targetDurationSeconds,
    targetDurationMinutes: Math.round((project.targetDurationSeconds || 0) / 60),
    collectionId: project.collectionId,
    startingImageFile: project.startingImageFile || '',
    styleSpec: project.styleSpec || '',
    userStory: project.userStory || '',
  };
}

function buildTreatmentView(project) {
  const aspect = ASPECT_PRESETS[project.aspectRatio] || { width: 0, height: 0 };
  const quality = QUALITY_PRESETS[project.quality] || { steps: 0, guidance: 0, fps: 0 };
  // The example block in the JSON output contract shows a literal value
  // for `sourceImageFile` — either a quoted filename or `null`. Precompute
  // because the template engine has no quoting helpers.
  const startingImageFileLiteral = project.startingImageFile
    ? `"${project.startingImageFile}"`
    : 'null';
  return {
    project: buildProjectView(project),
    aspect,
    quality,
    apiUrl: PORTOS_API_URL,
    startingImageFileLiteral,
  };
}

export async function buildTreatmentPrompt(project) {
  const view = buildTreatmentView(project);
  return buildPrompt('cd-treatment', view);
}

function frameTimelineLabel(i, total) {
  if (total <= 1) return 'only frame';
  const pct = Math.round((i / (total - 1)) * 100);
  if (i === 0) return 'start (0%)';
  if (i === total - 1) return `end (~${pct}%)`;
  return `~${pct}% through`;
}

function buildEvaluateView(project, scene) {
  const aspect = ASPECT_PRESETS[project.aspectRatio] || { width: 0, height: 0 };
  const quality = QUALITY_PRESETS[project.quality] || { steps: 0, guidance: 0, fps: 0 };
  const renderParams = presetToRenderParams({
    aspectRatio: project.aspectRatio,
    quality: project.quality,
    durationSeconds: scene.durationSeconds,
  });
  const renderedJobId = scene.renderedJobId || '<unknown>';
  const totalScenes = project.treatment?.scenes?.length;
  const positionLabel = totalScenes
    ? `${(scene.order ?? 0) + 1}/${totalScenes}`
    : `${(scene.order ?? 0) + 1}/?`;
  const evaluationFrames = Array.isArray(scene.evaluationFrames) ? scene.evaluationFrames : [];
  const frames = evaluationFrames.map((filename, i) => ({
    position: i + 1,
    filename,
    label: frameTimelineLabel(i, evaluationFrames.length),
  }));
  // Precomputed so the JSON example in the template can render `retryCount`
  // for the next attempt without the engine doing arithmetic.
  const nextRetryCount = (scene.retryCount || 0) + 1;
  const strategy = scene.useContinuationFromPrior
    ? 'continued from prior scene last-frame'
    : (scene.sourceImageFile
        ? `seeded from image \`${scene.sourceImageFile}\``
        : 'text-to-video');
  return {
    project: buildProjectView(project),
    aspect,
    quality,
    apiUrl: PORTOS_API_URL,
    scene: {
      sceneId: scene.sceneId,
      intent: scene.intent,
      promptJson: JSON.stringify(scene.prompt),
      renderedJobId,
      retryCount: scene.retryCount || 0,
      nextRetryCount,
      positionLabel,
      strategy,
    },
    render: renderParams,
    multiFrame: frames.length >= 2,
    evaluationFrames: frames,
  };
}

export async function buildEvaluatePrompt(project, scene) {
  const view = buildEvaluateView(project, scene);
  return buildPrompt('cd-evaluate', view);
}
