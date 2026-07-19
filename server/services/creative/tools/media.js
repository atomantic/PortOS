/**
 * Media-domain creative tools (#2183). Conductor wrappers over the media job
 * queue. Each enqueue tags the job's `owner` back to the calling project so the
 * orchestration's renders are attributable via `listJobs({ owner })`.
 */

import { z } from 'zod';
import { enqueueJob } from '../../mediaJobQueue/index.js';
import { ASPECT_PRESETS, QUALITY_PRESETS, presetToRenderParams } from '../../../lib/creativeDirectorPresets.js';
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
async function enforceVideoRenderPreset(params, ctx) {
  if (!ctx?.projectId) return params;
  const { getProject } = await import('../../creativeDirector/local.js');
  const project = await getProject(ctx.projectId).catch(() => null);
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
    if (kind === 'video') params = await enforceVideoRenderPreset(params, ctx);
    else if (kind === 'audio') params = attachMusicBedTag(params, ctx);
    return enqueueJob({ kind, params, owner: resolveOwner(args, ctx) });
  },
});

export const MEDIA_TOOLS = [
  mediaTool('image', 'Image'),
  mediaTool('video', 'Video'),
  mediaTool('audio', 'Audio'),
];
