/**
 * Creative Director presets — locked-at-creation aspect ratio + quality
 * settings that map onto the render-API params the LTX/mlx_video pipeline
 * actually consumes.
 *
 * The contract: a project picks an aspectRatio + quality + modelId once;
 * every scene render uses these. Tweaking is intentionally not allowed
 * mid-project — segment-to-segment continuity needs identical resolution
 * and frame budgets. Inert Video drafts can edit these before production.
 */

// Width/height pairs are 64-aligned (videoGen rounds down to multiples of
// 64 anyway) and chosen for sensible LTX defaults.
export const ASPECT_PRESETS = Object.freeze({
  '16:9':     { width: 768, height: 432 },
  '9:16':     { width: 432, height: 768 },
  '1:1':      { width: 512, height: 512 },
  '1:1-small': { width: 384, height: 384 }, // Legacy alias — pre-removal smoke-test fixture
});

/**
 * Look up an aspectRatio's {width,height}, degrading gracefully when the ratio
 * is unrecognized (best-effort callers must not throw on a stale/unknown ratio
 * the way the render path does).
 *
 * `fallback` is caller-owned: prompt views want `{ width: 0, height: 0 }`, while
 * first-pass gen wants `{}` so the image worker applies its own default box.
 * Pass `presetToRenderParams` (throws) when a hard failure is correct.
 */
export function resolveAspectDimensions(aspectRatio, fallback = { width: 0, height: 0 }) {
  return ASPECT_PRESETS[aspectRatio] || fallback;
}

export const QUALITY_PRESETS = Object.freeze({
  draft:    { steps: 8,  guidance: 2.5, fps: 24 },
  standard: { steps: 20, guidance: 3.0, fps: 24 },
  high:     { steps: 30, guidance: 3.5, fps: 30 },
});

export const ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
export const QUALITIES = Object.freeze(['draft', 'standard', 'high']);

export const PROJECT_STATUSES = Object.freeze([
  'draft', 'planning', 'rendering', 'stitching', 'complete', 'paused', 'failed',
]);

// FINISHED project states — any "act on work still in flight" sweep must skip
// them and never rewrite a `complete` project's status.
export const PROJECT_TERMINAL_STATUSES = Object.freeze(new Set(['complete', 'failed']));

// SETTLED agent-run states; anything else is in flight. Re-dispatch guards, the
// boot-recovery reaper and the stop path must share this vocabulary.
export const RUN_TERMINAL_STATUSES = Object.freeze(new Set(['completed', 'failed']));

export const SCENE_STATUSES = Object.freeze([
  'pending', 'rendering', 'evaluating', 'accepted', 'failed',
]);

// Production-plan step states. A step is `pending` until its `dependsOn[]` are
// all terminal-success; `blocked` when its run pauses for human review or the
// orchestrator gate rejects it (off/budget); `skipped` when the re-planner drops it.
export const PLAN_STEP_STATUSES = Object.freeze([
  'pending', 'running', 'blocked', 'done', 'failed', 'skipped',
]);

// `failed` is terminal but not success (dependents never run), so it is excluded.
export const PLAN_STEP_TERMINAL_SUCCESS = Object.freeze(new Set(['done', 'skipped']));

// After a plan step fails the planner may revise the remaining steps at most this
// many times before the project pauses for human review (convergence-pause contract).
export const MAX_REPLAN_ROUNDS = 2;

// Bounded re-dispatch of a COGNITIVE stage (plan / treatment) whose agent keeps
// exiting cleanly without writing its deliverable (a non-tool-calling local
// model narrates and PATCHes nothing). One retry covers a one-off; after this many
// consecutive empty completions the stage surfaces as blocked/paused, naming the
// remedy (assign a tool-capable model).
export const MAX_CONSECUTIVE_MISSED_DELIVERABLES = 2;

/**
 * Map a project's aspectRatio + quality + scene durationSeconds to the
 * concrete render-API body.
 *
 * numFrames is rounded to a multiple of 8 because LTX latent compression
 * is `1 + (frames - 1) / 8` — non-multiples silently break the
 * conditioning shape check on i2v renders. Floor to 8 frames minimum so
 * a 0.3s scene still produces something coherent.
 */
export function presetToRenderParams({ aspectRatio, quality, durationSeconds }) {
  const aspect = ASPECT_PRESETS[aspectRatio];
  if (!aspect) throw new Error(`Unknown aspectRatio '${aspectRatio}'`);
  const q = QUALITY_PRESETS[quality];
  if (!q) throw new Error(`Unknown quality '${quality}'`);
  const requested = Math.max(0.1, Number(durationSeconds) || 1) * q.fps;
  const numFrames = Math.max(8, Math.round(requested / 8) * 8);
  return {
    width: aspect.width,
    height: aspect.height,
    fps: q.fps,
    steps: q.steps,
    guidanceScale: q.guidance,
    numFrames,
  };
}

// Saved policy is inert until revision-specific dispatch support is available.
export const VIDEO_REVIEW_CHECKPOINTS = Object.freeze(['script-shot-plan', 'references', 'rough-cut', 'final-cut']);
