/**
 * Media-domain creative tools (#2183). Conductor wrappers over the media job
 * queue. Each enqueue tags the job's `owner` back to the calling project so the
 * orchestration's renders are attributable via `listJobs({ owner })`.
 */

import { z } from 'zod';
import { enqueueJob } from '../../mediaJobQueue/index.js';
import { ASPECT_PRESETS, QUALITY_PRESETS, presetToRenderParams } from '../../../lib/creativeDirectorPresets.js';
import { getSettings } from '../../settings.js';
import { IMAGE_GEN_MODE, resolveQueueImageMode } from '../../imageGen/modes.js';
import { resolveCloudProviderConfig } from '../../imageGen/cloudProviderConfig.js';
import { VIDEO_GEN_MODE, VIDEO_GEN_MODES, resolveVideoMode } from '../../videoGen/modes.js';
import { nearestGrokDuration } from '../../../lib/grokVideoClip.js';
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
 * `style`, `durationSeconds`). Only the render geometry is enforced. An
 * unrecognized aspect/quality (hand-edited/legacy project) falls through to the
 * LLM's params untouched — best-effort, never throws.
 */
async function enforceVideoRenderPreset(params, project) {
  // Only a directive-driven CD project locks a preset; a bare enqueue (no
  // recognized aspect/quality) keeps the caller's params as-is.
  if (!project || !ASPECT_PRESETS[project.aspectRatio] || !QUALITY_PRESETS[project.quality]) {
    return params;
  }
  // The planner may legitimately ask for a shorter beat than the project target,
  // so a positive per-step durationSeconds wins; otherwise use the project's.
  const stepDuration = Number(params?.durationSeconds);
  const durationSeconds = stepDuration > 0 ? stepDuration : (project.targetDurationSeconds || 10);
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
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    numFrames: preset.numFrames,
    steps: preset.steps,
    guidanceScale: preset.guidanceScale,
  };
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
function attachMusicBedTag(params, ctx) {
  if (!ctx?.projectId) return params;
  if (params?.creativeDirectorMusicBed) return params;
  return { ...params, creativeDirectorMusicBed: { projectId: ctx.projectId } };
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
  const pin = project?.renderBackend?.[kind];
  if (!pin?.mode) return params;
  const settings = await getSettings().catch(() => null);
  if (!settings) return params;

  if (kind === 'video') {
    const mode = resolveVideoMode(pin.mode, settings);
    if (mode !== VIDEO_GEN_MODE.GROK) {
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
      // asymmetry is the whole point of a pin.
      return pin.modelId ? { ...base, modelId: pin.modelId } : base;
    }
    const grok = settings.imageGen?.grok || {};
    // videoGen/grok.js reads the same `imageGen.grok` slice the image path does
    // (one CLI, one config). `videoMode` carries the semantic the local lane
    // keeps in `mode`, matching what routes/videoGen.js enqueues.
    //
    // Clip length crosses a contract boundary here: the local lane derives frame
    // count from `durationSeconds` (which is what the planner writes and what
    // enforceVideoRenderPreset reconciles), while grok's worker reads `duration`
    // and silently falls back to 6s for anything absent or undeliverable. Without
    // the translation a 10s commission would quietly render a 6s clip. Prefer an
    // explicit `duration` if some caller already set one; else map the step's
    // durationSeconds, else the project's target, through grok's own
    // 6/10-only normalization (lib/grokVideoClip.js) so we snap the same way the
    // provider would rather than passing a length it can't deliver.
    const requestedSeconds = params?.duration ?? params?.durationSeconds ?? project?.targetDurationSeconds;
    return {
      ...params,
      mode: VIDEO_GEN_MODE.GROK,
      videoMode: params?.sourceImagePath ? 'image' : 'text',
      grokPath: grok.grokPath,
      duration: nearestGrokDuration(requestedSeconds),
      ...(grok.aspectRatio ? { aspectRatio: grok.aspectRatio } : {}),
    };
  }

  const mode = resolveQueueImageMode(pin.mode, settings);
  const cloud = resolveCloudProviderConfig(settings, mode);
  if (cloud) return { ...params, ...cloud.jobParams };
  return {
    ...params,
    mode: IMAGE_GEN_MODE.LOCAL,
    pythonPath: settings.imageGen?.local?.pythonPath || null,
    // The user's pinned model wins over the planner's freehand guess.
    ...(pin.modelId ? { modelId: pin.modelId } : {}),
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
      params = attachMusicBedTag(params, ctx);
    } else {
      // Image + video both consult the owning project: video for its locked
      // geometry preset, both for a pinned render backend (#3135).
      const project = await loadOwningProject(ctx);
      if (kind === 'video') params = await enforceVideoRenderPreset(params, project);
      params = await enforceRenderBackendPin(kind, params, project);
    }
    return enqueueJob({ kind, params, owner: resolveOwner(args, ctx) });
  },
});

export const MEDIA_TOOLS = [
  mediaTool('image', 'Image'),
  mediaTool('video', 'Video'),
  mediaTool('audio', 'Audio'),
];
