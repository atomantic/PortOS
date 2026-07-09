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
  resolveAspectDimensions,
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
    // Catalog cast seeded via "Remix into → Creative Director" (#1808). Each
    // member: { ingredientId, name, type, role, summary? }. Empty array for a
    // bare project so the template's `{{#project.cast}}` section stays hidden.
    cast: Array.isArray(project.cast) ? project.cast : [],
  };
}

function buildTreatmentView(project) {
  const aspect = resolveAspectDimensions(project.aspectRatio);
  const quality = QUALITY_PRESETS[project.quality] || { steps: 0, guidance: 0, fps: 0 };
  // The example block in the JSON output contract shows a literal value
  // for `sourceImageFile` — either a quoted filename or `null`. Precompute
  // because the template engine has no quoting helpers.
  const startingImageFileLiteral = project.startingImageFile
    ? `"${project.startingImageFile}"`
    : 'null';
  // Header-once flag for the template's `## Cast` block — the `{{#project.cast}}`
  // section iterates the members, so a separate boolean renders the heading +
  // intro exactly once (and hides them entirely for a bare project).
  const hasCast = Array.isArray(project.cast) && project.cast.length > 0;
  return {
    project: buildProjectView(project),
    aspect,
    quality,
    apiUrl: PORTOS_API_URL,
    startingImageFileLiteral,
    hasCast,
  };
}

export async function buildTreatmentPrompt(project) {
  const view = buildTreatmentView(project);
  return buildPrompt('cd-treatment', view);
}

// CDO Phase 2 (#2184) — the planner view. `toolSpecs` is the resolved
// getToolSpecs() output from the creative tool registry, passed IN by the
// caller (agentBridge) rather than imported here: the registry is a services
// module and lib must not import it (nor pull its heavy import-time tool graph
// into every prompt build). The template iterates `tools` + renders the
// directive brief + the current plan (present only on a re-plan).
function buildPlanView(project, toolSpecs) {
  const directive = project.directive && typeof project.directive === 'object' ? project.directive : {};
  const deliverables = Array.isArray(directive.deliverables) ? directive.deliverables : [];
  const tools = (Array.isArray(toolSpecs) ? toolSpecs : []).map((s) => ({
    name: s?.function?.name || '',
    description: s?.function?.description || '',
    parametersJson: JSON.stringify(s?.function?.parameters ?? {}),
  }));
  const currentSteps = Array.isArray(project.plan?.steps) ? project.plan.steps : [];
  return {
    project: buildProjectView(project),
    apiUrl: PORTOS_API_URL,
    directive: {
      goal: directive.goal || '',
      hasDeliverables: deliverables.length > 0,
      deliverables: deliverables.map((value) => ({ value })),
      constraintsJson: JSON.stringify(directive.constraints ?? {}),
    },
    tools,
    hasCurrentPlan: currentSteps.length > 0,
    currentPlanJson: JSON.stringify(
      currentSteps.map((s) => ({ stepId: s.stepId, toolName: s.toolName, status: s.status })),
    ),
  };
}

export async function buildPlanPrompt(project, { toolSpecs } = {}) {
  const view = buildPlanView(project, toolSpecs);
  return buildPrompt('cd-plan', view);
}

function frameTimelineLabel(i, total) {
  if (total <= 1) return 'only frame';
  const pct = Math.round((i / (total - 1)) * 100);
  if (i === 0) return 'start (0%)';
  if (i === total - 1) return `end (~${pct}%)`;
  return `~${pct}% through`;
}

function buildEvaluateView(project, scene) {
  const aspect = resolveAspectDimensions(project.aspectRatio);
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
  // Surface the per-scene imageStrength so the evaluator can see what the
  // current setting was (and whether to nudge it on retry). Continuation
  // scenes default to 0.85 in sceneRunner; for the prompt we show the
  // explicit value (if any) so the agent can reason about the actual knob.
  const hasImageStrength = typeof scene.imageStrength === 'number';
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
      hasImageStrength,
      imageStrength: hasImageStrength ? scene.imageStrength : null,
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

// Max render attempts before a scene is given up on. Mirrors the "max 3" the
// cd-evaluate agent template enforces — the server-side vision evaluator must
// make the same accept/retry/fail decision the agent would.
export const CD_MAX_SCENE_RETRIES = 3;

/**
 * Structured-JSON evaluation prompt for the SERVER-SIDE vision path.
 *
 * Unlike `cd-evaluate` (a CLI agent that Reads frame files off disk with its
 * vision tool and then issues an HTTP PATCH), this prompt drives a direct
 * vision-model API call: the sampled frames are attached to the request as
 * image blocks by the runner, and the model must return ONLY a JSON verdict
 * that `applySceneVerdict` maps to the exact same scene transitions the agent's
 * PATCH would (accept → collection add; miss+retries-left → re-render with a
 * refined prompt; miss+exhausted → fail). Kept in code (not a UI-editable stage
 * template) because the output contract must stay machine-parseable.
 *
 * @param {object} project
 * @param {object} scene
 * @param {number} frameCount — how many frames are attached to the call
 * @returns {string}
 */
export function buildEvaluateVisionPrompt(project, scene, frameCount) {
  const total = project.treatment?.scenes?.length;
  const positionLabel = total ? `${(scene.order ?? 0) + 1}/${total}` : `${(scene.order ?? 0) + 1}/?`;
  const styleSpec = (project.styleSpec || '').trim()
    || '(none — judge against a coherent visual language derived from the project name + scene intent)';
  const retryCount = scene.retryCount || 0;
  const retriesLeft = retryCount < CD_MAX_SCENE_RETRIES;
  const strategy = scene.useContinuationFromPrior
    ? 'continued from the prior scene\'s last frame'
    : (scene.sourceImageFile ? 'seeded from a source image (image-to-video)' : 'text-to-video');
  const frameLine = frameCount > 1
    ? `You are shown ${frameCount} frames sampled across the scene's timeline, in order (first = start, last = end).`
    : 'You are shown a single representative frame from the scene.';

  return `You are the creative director for the video project "${project.name}". Evaluate a freshly-rendered scene and decide whether it works.

${frameLine}

## Scene
- Position: ${positionLabel}
- Intent: ${scene.intent || '(unspecified)'}
- Render strategy: ${strategy}
- Attempt: ${retryCount + 1} of ${CD_MAX_SCENE_RETRIES + 1} (${retriesLeft ? 'a retry is still available' : 'this is the final attempt — no retries left'})

## Style spec (apply to every scene)
${styleSpec}

## Judge on three dimensions
1. Style adherence — does it match the style spec across the whole sequence, not just the first frame?
2. Continuity — does it flow from the project's established tone, color, and characters? (If this is scene 1, just check it stands on its own.)
3. Scene intent — does it actually depict "${scene.intent || 'the intended action'}" by the END of the clip? Intent that arrives late still counts as delivered — accept it. Perfect is the enemy of done: accept anything good enough.

## Output — return ONLY this JSON object, no markdown, no prose, no code fences
{
  "accepted": <boolean>,        // true if the render is good enough to keep
  "score": <number 0.0-1.0>,    // overall quality
  "notes": "<one short sentence: why accepted, or what to fix>"${retriesLeft ? `,
  "refinedPrompt": "<ONLY when accepted is false: a revised render prompt that fixes the problem; omit when accepted>",
  "imageStrength": <OPTIONAL number 0.0-1.0 for image-to-video scenes only — lower to let the prompt express more, raise to hug the seed image; omit to leave unchanged>` : ''}
}

${retriesLeft
    ? 'If the render misses the mark, set accepted=false and provide a refinedPrompt so the scene can be re-rendered.'
    : 'Retries are exhausted. Set accepted=true only if the render is acceptable; otherwise accepted=false and the scene will be dropped.'}`;
}
