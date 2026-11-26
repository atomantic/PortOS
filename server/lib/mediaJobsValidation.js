// Zod schemas for media job queue queries, prompt tools, cancellation, and retry overrides.

import { z } from 'zod';
import { a2vLoraStageStrengthsSchema } from './videoLoraStageValidation.js';
import { universeVisualProfileSchema } from './universeVisualProfileValidation.js';
import { CODEX_EFFORT_LEVELS } from './provider/providerModels.js';
import { I2V_REFERENCE_MODES } from './videoReferenceModes.js';
import { VIDEO_TILING_MODES } from './videoTiling.js';
import { DRAFT_DECODE_IDS, isFullDecode } from './videoDraftDecoders.js';
import { VIDEO_STREAMING_MODES, isDefaultVideoStreamingMode } from './videoStreamingMode.js';
import { imageEdgeSchema } from './sharedSchemas.js';
import { MAX_CONTEXT_FRAMES } from './videoContinuity.js';

const optionalTrimmed = z.string().max(256).optional().transform((s) => {
  const v = (s ?? '').trim();
  return v.length > 0 ? v : undefined;
});

export const promptFromMediaSchema = z.object({
  sourceKind: z.enum(['image', 'video', 'upload']),
  filename: z.string().trim().min(1).max(256).optional(),
  videoId: z.string().trim().min(1).max(64).optional(),
  targets: z.array(z.enum(['image', 'video'])).min(1).max(2)
    .refine((arr) => new Set(arr).size === arr.length, { message: 'targets must be unique' }),
  providerId: z.string().trim().min(1).max(128),
  model: optionalTrimmed,
  effort: z.string().max(64).optional().transform((s) => {
    const v = (s ?? '').trim();
    return v.length > 0 ? v : undefined;
  }),
  // Same cap as `refinePromptSchema.maxPromptLength`, but scoped to the VIDEO
  // prompt: the caller sends it when the video backend it is composing for
  // rejects an over-length prompt (reactor.inc fast-h3). The image prompt has
  // no equivalent cap on any current backend.
  maxVideoPromptLength: z.number().int().positive().max(8000).optional(),
}).superRefine((data, ctx) => {
  // A gallery video resolves by history id (the gallery flow) OR by on-disk
  // filename (a mood-board video item's `video:<filename>` ref — #4188).
  if (data.sourceKind === 'video' && !data.videoId && !data.filename) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'videoId or filename is required for a gallery video', path: ['videoId'] });
  }
  if ((data.sourceKind === 'image' || data.sourceKind === 'upload') && !data.filename) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filename is required', path: ['filename'] });
  }
});

export const resumeHoldParamsSchema = z.object({ holdId: z.string().uuid() });

export const resumeHoldBodySchema = z.object({}).strict();

// Whitelist of params the UI can edit on retry. Anything else (python paths,
// session ids, internal flags) rides through unchanged from the original
// job.params so a user can't escape the server's runtime config from the
// retry path. Keep this set small and user-facing.
//
// String fields use a transform that collapses trimmed empty strings to
// `undefined` — without that, an empty `modelId` (e.g. user cleared the
// input) would override the original job's modelId with "" and the gen
// would fail with "Unknown or unsupported model". Returning undefined makes
// the override fall through to the original value at merge time.
const emptyToUndef = (s) => {
  const v = (s ?? '').trim();
  return v.length > 0 ? v : undefined;
};

// Clear-to-default sentinel for the Codex reasoning-effort override. Unlike the
// string fields above, an absent (`undefined`) effort override means "keep the
// job's original effort" — so `emptyToUndef` alone can NEVER express "reset the
// effort back to the shipped default", because the retry route’s drop-undefined merge
// would silently retain the old value. This sentinel is a distinct signal: when
// the retry payload sends `effort: 'default'`, the handler DELETES `params.effort`
// so the render falls back to CODEX_IMAGEGEN_DEFAULT_EFFORT (`low`). A real job
// never stores `'default'` as an effort (it's always a CODEX_EFFORT_LEVELS value),
// so the sentinel can't collide with a legitimate level.
export const EFFORT_CLEAR_SENTINEL = 'default';

const RETRY_OVERRIDE_SCHEMA = z.object({
  visualProfile: universeVisualProfileSchema.optional(),
  visualProfileSource: z.never().optional(),
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  model: z.string().max(200).optional().transform(emptyToUndef),
  modelId: z.string().max(200).optional().transform(emptyToUndef),
  // Codex reasoning-effort override: a valid CODEX_EFFORT_LEVELS value pins the
  // retry to that level; the EFFORT_CLEAR_SENTINEL (`'default'`) resets it to the
  // shipped default; empty/whitespace → undefined (keep the original job's effort).
  effort: z.string().max(20).optional().transform(emptyToUndef).refine(
    (v) => v === undefined || v === EFFORT_CLEAR_SENTINEL || CODEX_EFFORT_LEVELS.includes(v),
    { message: `effort must be one of ${CODEX_EFFORT_LEVELS.join(', ')} or '${EFFORT_CLEAR_SENTINEL}'` },
  ),
  width: z.number().int().min(64).max(4096).optional(),
  height: z.number().int().min(64).max(4096).optional(),
  steps: z.number().int().min(1).max(200).nullable().optional(),
  guidance: z.number().min(0).max(30).optional(),
  guidanceScale: z.number().min(0).max(30).nullable().optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).nullable().optional(),
  numFrames: z.number().int().min(1).max(1024).optional(),
  fps: z.number().int().min(1).max(60).optional(),
  tiling: z.enum(VIDEO_TILING_MODES).optional(),
  disableAudio: z.boolean().optional(),
  imageStrength: z.number().min(0).max(1).nullable().optional(),
  // What the conditioning image promises (#4874). `null` clears it back to the
  // default, like the numeric knobs above — the schema STRIPS unknown keys, so
  // an override missing from here is silently dropped rather than rejected.
  i2vReferenceMode: z.enum(I2V_REFERENCE_MODES).nullable().optional(),
  textEncoderId: z.string().max(64).optional().transform(emptyToUndef),
  // Nullable, unlike textEncoderId: a speed profile OUTRANKS steps/guidanceScale
  // (resolveVideoSampler), so a retry that edits Steps on a profiled job would
  // otherwise be silently ignored. `null` clears it back to the default sampler.
  speedProfileId: z.string().max(64).nullable().optional().transform((v) => (v === '' ? null : v)),
  // Preview-fidelity decode (#5423). Nullable for the same reason speedProfileId
  // is: `null` clears the inherited request back to Full, which an absent key
  // cannot express (the retry route’s drop-undefined merge would retain the old value).
  // A closed enum, and never rejected downstream — the four gates in
  // lib/videoDraftDecoders.js degrade a draft request to a full decode rather
  // than failing the retry.
  // An explicit 'full' is folded to the same clear, because absence and
  // DRAFT_DECODE_FULL are the same request (lib/videoDraftDecoders.js) — merging
  // it as a value would leave the requeued job carrying a knob that changed
  // nothing, which the queue would then echo back into the next editor.
  draftDecode: z.enum(DRAFT_DECODE_IDS).nullable().optional()
    .transform((v) => (v === undefined ? undefined : (isFullDecode(v) ? null : v))),
  // Auto/null clears an explicit memory request; absence inherits it. The
  // render bridge still owns capability checks and refuses unsupported Stream.
  streamingMode: z.enum(VIDEO_STREAMING_MODES).nullable().optional()
    .transform((v) => (v === undefined ? undefined : (isDefaultVideoStreamingMode(v) ? null : v))),
  chunks: z.number().int().min(1).max(8).optional(),
  chunkPrompts: z.array(z.string().nullable()).max(8).optional(),
  contextFrames: z.number().int().min(0).max(MAX_CONTEXT_FRAMES).optional(),
  continuityStrategy: z.enum(['frame', 'window']).optional(),
  a2vLoraStageStrengths: a2vLoraStageStrengthsSchema.nullable().optional(),
  loras: z.array(z.object({
    filename: z.string().min(1).max(255).regex(/^[^/\\]+\.safetensors$/i, 'filename must be a bare .safetensors basename'),
    name: z.string().max(200).optional(),
    scale: z.number().min(0).max(2).optional(),
  })).max(8).optional(),
}).partial();

export const VIDEO_RETRY_BOUNDS_SCHEMA = z.object({
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  seed: z.number().int().min(0).nullable().optional(),
  numFrames: z.number().int().min(1).max(1024).optional(),
  fps: z.number().int().min(1).max(60).optional(),
}).passthrough();

// Image retries get the same size limits the compose form and POST /image-gen
// enforce (per-edge cap + total-pixel cap). RETRY_OVERRIDE_SCHEMA keeps its wider
// edge range for the video kinds, so image is checked here. Only override values
// are checked: a stored job already past the cap still retries unchanged.
export const IMAGE_RETRY_BOUNDS_SCHEMA = z.object({
  width: imageEdgeSchema,
  height: imageEdgeSchema,
}).passthrough();

export const retryBodySchema = z.object({ params: RETRY_OVERRIDE_SCHEMA.optional() });

export const clearFailedCanceledSchema = z.object({ kind: z.enum(['image', 'video', 'video-upscale']) });

export const videoHoldsQuerySchema = z.object({ offset: z.coerce.number().int().min(0).max(1000000).default(0) });

export const jobParamsSchema = z.object({ id: z.string().uuid() });

// renderConfig is inlined into the LLM prompt via JSON.stringify, so an
// unbounded object would inflate token cost / latency. Cap the serialized
// payload at 4 KB — that's well above any legitimate render-config (which
// is typically <500 bytes) but stops a malicious or buggy caller from
// shipping arbitrarily nested objects through the refiner.
const RENDER_CONFIG_MAX_BYTES = 4096;

// Bind the live queue vocabulary without loading queue execution from lib.
export function createMediaJobQueueSchemas(jobKinds, jobStatuses) {
  const listQuerySchema = z.object({
    status: z.enum(jobStatuses).optional(),
    kind: z.enum(jobKinds).optional(),
    owner: z.string().max(256).optional(),
  });

  const refinePromptSchema = z.object({
    kind: z.enum(jobKinds),
    // Trim before length check — without trim, "   " would slip past min(1)
    // and arrive at the refiner where it'd be cleaned to an empty string, then
    // surface as a confusing "LLM returned an empty prompt" error.
    prompt: z.string().trim().min(1).max(8000),
    negativePrompt: z.string().trim().max(8000).optional(),
    feedback: z.string().trim().max(3000).optional(),
    providerId: z.string().trim().min(1).max(128),
    // Empty/whitespace model → undefined so the refiner's defaultModel /
    // models[0] fallback chain kicks in, instead of a whitespace string
    // bypassing the MODEL_REQUIRED guard and reaching the provider.
    model: z.string().max(256).optional().transform((s) => {
      const v = (s ?? '').trim();
      return v.length > 0 ? v : undefined;
    }),
    effort: z.string().max(64).optional().transform((s) => {
      const v = (s ?? '').trim();
      return v.length > 0 ? v : undefined;
    }),
    // Hard character cap the SELECTED render backend enforces on the prompt it
    // receives — reactor.inc's fast-h3 rejects a prompt over 800 characters
    // outright instead of truncating it, so an enhancement that ignores the cap
    // produces a prompt that cannot be rendered. The caller sends the budget
    // (cap minus whatever a style preset prefixes), the refiner instructs the
    // model with it and clamps the answer. Omitted when the backend has no cap.
    maxPromptLength: z.number().int().positive().max(8000).optional(),
    renderConfig: z.record(z.any())
      .refine((obj) => {
        // JSON.stringify throws on BigInt / circular refs. z.record(z.any())
        // doesn't reject those at parse time, so wrap the size check so a
        // bad payload surfaces as VALIDATION_ERROR (400), not a 500.
        // Measure with the same pretty-printed format the refiner inlines
        // into the LLM prompt (`JSON.stringify(obj, null, 2)`); minified
        // measurement would under-count, letting an indented blob slip past
        // the cap and still inflate the prompt.
        let size;
        try { size = Buffer.byteLength(JSON.stringify(obj, null, 2), 'utf8'); }
        catch { return false; }
        return size <= RENDER_CONFIG_MAX_BYTES;
      }, {
        message: `renderConfig must be JSON-serializable and ≤ ${RENDER_CONFIG_MAX_BYTES} bytes`,
      })
      .optional(),
  });

  const queueQuerySchema = z.object({
    kind: z.enum(jobKinds).optional(),
    owner: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(0).max(100).optional(),
  });

  const cancelQueuedSchema = z.object({ kind: z.enum(jobKinds).optional() });

  return { listQuerySchema, refinePromptSchema, queueQuerySchema, cancelQueuedSchema };
}
