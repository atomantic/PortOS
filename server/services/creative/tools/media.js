/**
 * Media-domain creative tools (#2183). Conductor wrappers over the media job
 * queue. Each enqueue tags the job's `owner` back to the calling project so the
 * orchestration's renders are attributable via `listJobs({ owner })`.
 */

import { z } from 'zod';
import { enqueueJob } from '../../mediaJobQueue/index.js';
import { resolveDefaultMediaRoute, routedJobParams } from '../../federatedMedia/defaultRouting.js';
import { ASPECT_PRESETS, QUALITY_PRESETS, presetToRenderParams } from '../../../lib/creativeDirectorPresets.js';
import { getSettings } from '../../settings.js';
import { IMAGE_GEN_MODE, resolveQueueImageMode } from '../../imageGen/modes.js';
import { renderTargetDefaults, resolveRenderTargetConfig } from '../../imageGen/cloudProviderConfig.js';
import { RENDER_TARGET } from '../../../lib/renderTargets.js';
import { VIDEO_GEN_MODE, VIDEO_GEN_MODES } from '../../videoGen/modes.js';
import { grokVideoJobParams, resolveVideoBackendPin } from '../../videoGen/backendPin.js';
import { getDefaultVideoModelId, getVideoModels } from '../../../lib/mediaModels.js';
import { COST_RENDER, resolveOwner } from './shared.js';

const paramsSchema = z.object({ params: z.record(z.any()).default({}), owner: z.string().optional() });

/**
 * Force a video render's dimensions + quality knobs onto the project's LOCKED
 * preset, overriding whatever the planner LLM authored.
 *
 * The planner (cd-plan) writes `media_enqueueVideoJob` params freehand and has
 * historically guessed an `aspectRatio` string (e.g. "16:9") that the video
 * worker doesn't even read — `generateVideo` consumes `width`/`height`, not
 * `aspectRatio`, and defaults to a 768×512 box when they're absent. That silently
 * dropped the project's chosen 9:16. A project's aspect ratio / quality / target
 * duration are locked at creation (see creativeDirectorPresets.js), so resolve
 * them deterministically here rather than trusting the LLM to reproduce them.
 *
 * The planner still owns the CREATIVE params (`prompt`, `negativePrompt`,
 * `style`). Commission duration is form-locked; a general CD project may use
 * shorter per-step beats. Only render controls are enforced. An
 * unrecognized aspect/quality (hand-edited/legacy project) falls through to the
 * LLM's params untouched — best-effort, never throws.
 */
function enforceVideoRenderPreset(params, project) {
  // Only a directive-driven CD project locks a preset; a bare enqueue (no
  // recognized aspect/quality) keeps the caller's params as-is.
  if (!project || !ASPECT_PRESETS[project.aspectRatio] || !QUALITY_PRESETS[project.quality]) {
    return params;
  }
  // The planner may legitimately ask for a shorter beat than the project target,
  // so a positive per-step durationSeconds wins; otherwise use the project's.
  const targetAbility = project.directive?.constraints?.targetAbility;
  const commissionLocked = targetAbility === 'video' || targetAbility === 'music-video';
  const stepDuration = Number(params?.durationSeconds);
  const durationSeconds = commissionLocked
    ? (project.targetDurationSeconds || 10)
    : (stepDuration > 0 ? stepDuration : (project.targetDurationSeconds || 10));
  const preset = presetToRenderParams({
    aspectRatio: project.aspectRatio,
    quality: project.quality,
    durationSeconds,
  });
  // Drop the worker-ignored `aspectRatio` key so a stale value can't mislead, and
  // force the locked geometry + quality-derived knobs.
  const { aspectRatio: _ignored, ...rest } = params || {};
  return {
    ...rest,
    durationSeconds,
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    numFrames: preset.numFrames,
    steps: preset.steps,
    guidanceScale: preset.guidanceScale,
  };
}

function enforceImageRenderPreset(params, project) {
  const targetAbility = project?.directive?.constraints?.targetAbility;
  if ((targetAbility !== 'image' && targetAbility !== 'music-video')
      || !ASPECT_PRESETS[project.aspectRatio] || !QUALITY_PRESETS[project.quality]) {
    return params;
  }
  const aspect = ASPECT_PRESETS[project.aspectRatio];
  const quality = QUALITY_PRESETS[project.quality];
  const { aspectRatio: _ignored, ...rest } = params || {};
  return {
    ...rest,
    width: aspect.width,
    height: aspect.height,
    steps: quality.steps,
    guidance: quality.guidance,
    cfgScale: quality.guidance,
  };
}

export function reconcileVideoParamsWithModel(params, project, models = getVideoModels()) {
  const locked = enforceVideoRenderPreset(params, project);
  if (locked === params) return params;
  const requestedModelId = locked.modelId || project.modelId || getDefaultVideoModelId();
  const model = models.find((entry) => entry.id === requestedModelId) || null;
  const aspectValue = locked.width / locked.height;
  const resolution = Array.isArray(model?.resolutionOptions) && model.resolutionOptions.length
    ? model.resolutionOptions.reduce((best, option) => {
      const distance = Math.abs((Number(option.w) / Number(option.h)) - aspectValue);
      return !best || distance < best.distance ? { option, distance } : best;
    }, null)?.option
    : null;
  const fpsOptions = Array.isArray(model?.fpsOptions) ? model.fpsOptions.filter(Number.isFinite) : [];
  const fps = fpsOptions.includes(locked.fps) ? locked.fps : (fpsOptions[0] || locked.fps);
  const requestedFrames = Math.max(1, Math.round((locked.numFrames / locked.fps) * fps));
  const frameOptions = Array.isArray(model?.frameOptions) ? model.frameOptions.filter(Number.isFinite) : [];
  const numFrames = frameOptions.length
    ? frameOptions.reduce((best, value) => (
      Math.abs(value - requestedFrames) < Math.abs(best - requestedFrames) ? value : best
    ))
    : locked.numFrames;
  const reconciled = {
    ...locked,
    modelId: requestedModelId,
    width: Number(resolution?.w) || locked.width,
    height: Number(resolution?.h) || locked.height,
    fps,
    numFrames,
  };
  if (model?.samplerLocked) {
    delete reconciled.steps;
    delete reconciled.guidanceScale;
  }
  if (model?.supportsNegativePrompt === false) delete reconciled.negativePrompt;
  if (model?.supportsDisableAudio === false) delete reconciled.disableAudio;
  if (model?.supportsTiling === false) delete reconciled.tiling;
  return reconciled;
}

/**
 * Tag a planner-enqueued audio job so the durable `creativeDirectorMusicBedHook`
 * files the finished track onto the owning project's `musicBed` field (#2772).
 *
 * Without this, a `music` commission's plan step enqueues an audio job that
 * completes with only a job id — `project.musicBed` stays null and the run has
 * no surfaced, rateable output. The first-pass music flow
 * (creativeDirector/firstPassMusicGen.js) already stamps this exact tag; the
 * planner path did not, so the hook never fired for planner-driven audio.
 *
 * Only tags inside a CD project context (`ctx.projectId`) — a bare enqueue with
 * no owning project keeps its params untouched. An explicit
 * `creativeDirectorMusicBed` already on the params (a caller that set its own
 * destination) wins and is left as-is.
 */
async function configureMusicJob(params, ctx) {
  if (!ctx?.projectId) return params;
  const project = await loadOwningProject(ctx);
  if ((ctx.targetAbility === 'music' || ctx.targetAbility === 'music-video') && !project) {
    throw new Error('commission-project-unavailable');
  }
  const { getCommissionMusicContextForProject } = await import('../../creativeCommissions/store.js');
  // Do not collapse a failed local provenance lookup into "not a taste run".
  // That would let planner-authored renderer/prompt guesses escape onto an
  // opted-in commission precisely when the local store is unavailable.
  const context = await getCommissionMusicContextForProject(ctx.projectId);
  if (!context) {
    const targetAbility = project?.directive?.constraints?.targetAbility;
    if (targetAbility !== 'music' && targetAbility !== 'music-video') {
      if (params?.creativeDirectorMusicBed) return params;
      return { ...params, creativeDirectorMusicBed: { projectId: ctx.projectId } };
    }
    const {
      engine: _plannerEngine,
      modelId: _plannerModel,
      repo: _plannerRepo,
      durationSec: _plannerDuration,
      durationMode: _plannerDurationMode,
      provenance: _plannerProvenance,
      ...rest
    } = params || {};
    return {
      ...rest,
      durationSec: project.targetDurationSeconds,
      creativeDirectorMusicBed: { projectId: ctx.projectId },
    };
  }
  if (typeof context.prompt !== 'string' || !context.prompt.trim()) {
    throw new Error('taste-commission-prompt-unavailable');
  }
  const {
    engine: _plannerEngine,
    modelId: _plannerModel,
    repo: _plannerRepo,
    durationSec: _plannerDuration,
    durationMode: _plannerDurationMode,
    provenance: _plannerProvenance,
    ...rest
  } = params || {};
  return {
    ...rest,
    prompt: context.prompt,
    ...context.musicGeneration,
    creativeDirectorMusicBed: { projectId: ctx.projectId },
    provenance: {
      kind: 'creative-commission-music-taste',
      commissionId: context.commissionId,
      runId: context.runId,
      recipeVersion: context.tasteRecipe.version,
      sourceHash: context.tasteRecipe.sourceHash,
    },
  };
}

/**
 * Force an image/video render onto the project's PINNED render backend (#3135),
 * overriding whatever `mode` the planner LLM authored.
 *
 * Backend dispatch in the media job queue is purely `job.params.mode`-driven
 * (`mediaJobQueue/index.js#getGenModuleForJob`). The planner writes these params
 * freehand and — before #3135 — never set `mode` at all, so every plan-driven
 * render silently landed on local diffusion regardless of the user's intent. A
 * creative commission can now pin the backend per commission
 * (`generation.imageMode` / `.videoMode`); `buildRenderBackendPin` carries it onto
 * the project as `renderBackend`, and this is where it beats the LLM.
 *
 * No pin (the default, and every pre-#3135 project) ⇒ returns `params`
 * UNTOUCHED — not "auto-resolved to something", untouched — so the enqueued job
 * is byte-identical to today and dispatch falls through to the install-wide
 * default the same way it always has.
 *
 * A pin is re-resolved against LIVE settings rather than trusted verbatim: the
 * cloud backends are gated on their `imageGen.<mode>.enabled` toggle, which the
 * user can flip off long after pinning. `resolveQueueImageMode` /
 * `resolveVideoMode` degrade an unusable pin to a usable backend (never throw) —
 * a nightly commission must still produce something rather than failing every
 * fire because a toggle moved. Cloud modes additionally need their provider knob
 * bundle (`codexPath`/`model`/`effort`, `grokPath`/`aspectRatio`) in the job
 * params, since the queue dispatches straight to the provider module and skips
 * the imageGen dispatcher that would otherwise assemble them.
 *
 * Deliberately NOT resolved here: the saved `cleanC2PA`/`denoise` post-processing
 * settings (which `pipeline/visualStageHelpers.js#enqueueImageJob` does resolve,
 * for the same skips-the-dispatcher reason). No planner-enqueued render has ever
 * carried them — pinned or not — so resolving them only on the pinned path would
 * make the same commission post-process differently depending on whether a
 * backend happens to be pinned. Fixing it for BOTH paths would break the "auto is
 * byte-identical" contract this change rests on, so it's a separate concern.
 */
async function enforceRenderBackendPin(kind, params, project) {
  const settings = await getSettings().catch(() => null);
  if (!settings) return params;

  // Each lane has a pin ladder (#3231): the project's own renderBackend pin
  // (per-record, wins) → the install-wide creative-agent renderDefaults pin
  // → (video only, Phase 4) the install-wide `settings.videoGen.mode` pin.
  // When NO source pins the lane, params pass through untouched — the "auto
  // is byte-identical" contract above.
  if (kind === 'video') {
    // The video ladder is shared verbatim with the scene-render path via
    // videoGen/backendPin.js, so the two enqueue surfaces resolve identically.
    const videoPin = resolveVideoBackendPin(project, settings);
    if (!videoPin.pinned) return params;
    if (videoPin.mode !== VIDEO_GEN_MODE.GROK) {
      // Local video: `params.mode` is the t2v/i2v SEMANTIC for this lane (see
      // videoGen/modes.js), so a local pin must NOT stamp the backend name over
      // it — overwriting a real semantic ('fflf', 'a2v', 'extend', an IC-LoRA id)
      // would silently drop the caller's keyframes/audio.
      //
      // But the backend discriminator and the semantic SHARE this one key, so a
      // planner-authored BACKEND token has to go: 'grok' would dispatch to grok
      // in defiance of the pin (and defeat the grok-disabled fallback), and
      // 'local' is worse than useless — local.js treats an unrecognized non-empty
      // mode as plain text-to-video, so it would silently ignore the step's
      // sourceImagePath/keyframes. Dropping the key entirely is the correct
      // repair for both: an unset mode makes local.js INFER the semantic from
      // keyframes → sourceImagePath → text.
      const base = VIDEO_GEN_MODES.includes(params?.mode)
        ? (({ mode: _backendToken, ...rest }) => rest)(params)
        : (params || {});
      // The user's pinned model wins over the planner's freehand guess — that
      // asymmetry is the whole point of a pin. The project pin's model wins
      // over the target default's (same precedence as the mode ladder); local
      // is the only video backend that consumes a model id, so no cross-
      // provider leak guard is needed here.
      return videoPin.modelId ? { ...base, modelId: videoPin.modelId } : base;
    }
    // Clip length crosses a contract boundary into the grok lane (see
    // grokVideoJobParams). Prefer an explicit `duration` if some caller already
    // set one; else the step's `durationSeconds` (what the planner writes and
    // what enforceVideoRenderPreset reconciles); else the project's target.
    const requestedSeconds = params?.duration ?? params?.durationSeconds ?? project?.targetDurationSeconds;
    return {
      ...params,
      ...grokVideoJobParams(settings, {
        sourceImagePath: params?.sourceImagePath,
        durationSeconds: requestedSeconds,
      }),
    };
  }

  const pin = project?.renderBackend?.[kind];
  const targetDefaults = renderTargetDefaults(settings, RENDER_TARGET.CREATIVE_AGENT);
  if (!pin?.mode && !targetDefaults.imageMode) return params;

  // Project pin (explicit, per-record) → creative-agent renderDefaults pin —
  // both usability-laddered so a disabled backend degrades instead of failing
  // a nightly commission. One ladder covers text-to-image and edit/reference
  // renders alike: every queueable backend accepts input images.
  const mode = resolveQueueImageMode(pin?.mode || targetDefaults.imageMode, settings);
  // Mode is laddered above; this threads the creative-agent renderDefaults
  // imageModel into the cloud job params (#3231). The project's own
  // `pin.modelId` is deliberately NOT passed as the cloud model override —
  // commissions pick it from the LOCAL diffusion catalog, so it only applies
  // on the local branch below.
  const { cloud } = resolveRenderTargetConfig(settings, RENDER_TARGET.CREATIVE_AGENT, { mode });
  if (cloud) return { ...params, ...cloud.jobParams };
  return {
    ...params,
    mode: IMAGE_GEN_MODE.LOCAL,
    pythonPath: settings.imageGen?.local?.pythonPath || null,
    // The user's pinned model wins over the planner's freehand guess.
    ...(pin?.modelId ? { modelId: pin.modelId } : {}),
  };
}

// Load the owning CD project ONCE per enqueue — both the video preset
// reconciliation and the render-backend pin read from it, and re-reading would
// double the store round-trips per plan step. Null outside a project context (a
// bare enqueue) or when the read fails: both forcing steps treat that as "no
// project locks anything" and pass the caller's params through.
async function loadOwningProject(ctx) {
  if (!ctx?.projectId) return null;
  const { getProject } = await import('../../creativeDirector/local.js');
  return getProject(ctx.projectId).catch(() => null);
}

const mediaTool = (kind, label) => ({
  name: `media_enqueue${label}Job`,
  description: `Enqueue a ${kind} media job. Long-running: returns a job handle; completion arrives via media-job events. Tags the job owner to the calling project.`,
  costClass: COST_RENDER,
  longRunning: true,
  schema: paramsSchema,
  parameters: {
    type: 'object',
    properties: {
      params: { type: 'object', description: `Job parameters for the ${kind} worker.` },
      owner: { type: 'string', description: 'Optional explicit owner tag (defaults to the calling project).' },
    },
    required: ['params'],
  },
  execute: async (args, ctx) => {
    let params = args.params || {};
    if (kind === 'audio') {
      params = await configureMusicJob(params, ctx);
    } else {
      // Image + video both consult the owning project: video for its locked
      // geometry preset, both for a pinned render backend (#3135).
      const project = await loadOwningProject(ctx);
      if (ctx.targetAbility && !project) throw new Error('commission-project-unavailable');
      if (kind === 'video') params = enforceVideoRenderPreset(params, project);
      if (kind === 'image') params = enforceImageRenderPreset(params, project);
      params = await enforceRenderBackendPin(kind, params, project);
      // Resolve the selected local model AFTER the backend ladder has applied
      // project/install pins. The same model-catalog fields that drive Video
      // Gen's visible controls then snap the autonomous job onto that model's
      // canvas/FPS/frame options and remove controls the UI disables (for
      // example MiniMax H3's negative prompt and sampler knobs).
      if (kind === 'video' && params?.mode !== VIDEO_GEN_MODE.GROK) {
        params = reconcileVideoParamsWithModel(params, project);
      }
    }
    // Unattended jobs never name a peer — the planner is an LLM, and letting
    // it pick one is exactly the arbitrary-peer routing the provider contract
    // forbids. Routing comes from this instance's own settings instead, and is
    // resolved LAST so the project/install pin ladder above has already run:
    // a configured remote provider overrides those local backend choices, and
    // a job that would have rendered locally is unaffected.
    const routed = await resolveDefaultMediaRoute({ kind, params });
    if (routed) {
      return enqueueJob({
        kind,
        params: routedJobParams(params, routed),
        owner: resolveOwner(args, ctx),
      });
    }
    return enqueueJob({ kind, params, owner: resolveOwner(args, ctx) });
  },
});

export const MEDIA_TOOLS = [
  mediaTool('image', 'Image'),
  mediaTool('video', 'Video'),
  mediaTool('audio', 'Audio'),
];
