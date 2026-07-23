/**
 * Media Job Queue Routes — read + cancel access to the unified image/video
 * render queue. The actual enqueueing happens in /api/video-gen and
 * /api/image-gen routes; this surface lets the UI show what's pending and
 * cancel something without going through provider-specific endpoints.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { listJobs, getJob, cancelJob, cancelQueuedJobs, enqueueJob, removeArchivedJob, runJobNow, JOB_KINDS, JOB_STATUSES } from '../services/mediaJobQueue/index.js';
import { refineMediaPrompt } from '../services/mediaPromptRefiner.js';
import { CODEX_EFFORT_LEVELS } from '../lib/providerModels.js';

const router = Router();

const listQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  kind: z.enum(JOB_KINDS).optional(),
  owner: z.string().max(256).optional(),
});

// renderConfig is inlined into the LLM prompt via JSON.stringify, so an
// unbounded object would inflate token cost / latency. Cap the serialized
// payload at 4 KB — that's well above any legitimate render-config (which
// is typically <500 bytes) but stops a malicious or buggy caller from
// shipping arbitrarily nested objects through the refiner.
const RENDER_CONFIG_MAX_BYTES = 4096;
const refinePromptSchema = z.object({
  kind: z.enum(JOB_KINDS),
  // Trim before length check — without trim, "   " would slip past min(1)
  // and arrive at the refiner where it'd be cleaned to an empty string, then
  // surface as a confusing "LLM returned an empty prompt" error.
  prompt: z.string().trim().min(1).max(8000),
  negativePrompt: z.string().trim().max(8000).optional(),
  feedback: z.string().trim().min(1).max(3000),
  providerId: z.string().trim().min(1).max(128),
  // Empty/whitespace model → undefined so the refiner's defaultModel /
  // models[0] fallback chain kicks in, instead of a whitespace string
  // bypassing the MODEL_REQUIRED guard and reaching the provider.
  model: z.string().max(256).optional().transform((s) => {
    const v = (s ?? '').trim();
    return v.length > 0 ? v : undefined;
  }),
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

// Sanitize a job before serialization. The internal job record carries
// worker-only data (the python interpreter path, absolute filesystem paths
// to multipart uploads / source images) that the UI doesn't need and that
// shouldn't ride out over the API. Only surface the user-visible params
// the Render Queue UI actually renders (prompt, owner-supplied settings).
const PARAM_ALLOWLIST = new Set([
  'prompt', 'negativePrompt', 'modelId',
  // `model` is the codex-side counterpart to `modelId` (different field name
  // because Codex passes a model string straight to the CLI, while local /
  // video providers carry a registry-id). Without it the UI can't tell which
  // codex model a failed job tried to use — the row would just say "codex".
  'model',
  // `effort` is the Codex per-render reasoning-effort level (`low` by default).
  // Surfacing it lets the Render Queue row show which effort a failed job used
  // and lets the retry editor pre-fill the current level (see the retry-editor
  // Reasoning-effort control). Codex-only; local/external/video jobs never set it.
  'effort',
  'width', 'height', 'numFrames', 'fps', 'steps', 'guidanceScale',
  'seed', 'tiling', 'disableAudio', 'mode', 'imageStrength',
  'cfgScale', 'guidance', 'quantize',
  // Training-kind label fields so the Render Queue UI can title training
  // rows ("Training: Kessa · mflux · 1000 steps") without exposing paths.
  'runId', 'runtime', 'datasetId', 'characterId', 'characterName',
  'triggerWord', 'rank', 'baseModelId',
  // Sprite reference destination tag (#2896) — pure identifiers (record id,
  // target/direction, key hex, mode/model), no filesystem paths. The Sprites
  // UI correlates queued/running renders by it to rehydrate its in-flight
  // guard after a reload.
  'spriteRef',
  // Sprite walk-video destination tag (#2897) — record id, direction, run id,
  // key hex; same rehydration contract as spriteRef, for kind:'video' jobs.
  'spriteWalk',
]);
function sanitizeJob(job) {
  if (!job) return job;
  const safeParams = job.params
    ? Object.fromEntries(Object.entries(job.params).filter(([k]) => PARAM_ALLOWLIST.has(k)))
    : undefined;
  return {
    id: job.id,
    kind: job.kind,
    owner: job.owner,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    position: job.position,
    progress: job.progress,
    statusMsg: job.statusMsg,
    error: job.error,
    result: job.result,
    params: safeParams,
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const filters = validateRequest(listQuerySchema, req.query);
  // Live jobs preserve `listJobs` order — [running, codexRunning, ...queue] —
  // so the UI reads top-to-bottom as "currently rendering, then next in line"
  // (FIFO). A single timestamp DESC sort puts later-queued jobs ahead of an
  // earlier-started running job and confuses the user.
  // Terminal jobs sort by most-recent finish so the "recent" reel surfaces
  // newest-first; the fallback chain handles canceled-while-queued jobs.
  const jobs = listJobs(filters);
  const live = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const terminal = jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
  terminal.sort((a, b) => {
    const ta = new Date(a.completedAt || a.startedAt || a.queuedAt || 0).getTime();
    const tb = new Date(b.completedAt || b.startedAt || b.queuedAt || 0).getTime();
    return tb - ta;
  });
  res.json([...live, ...terminal].map(sanitizeJob));
}));

router.post('/refine-prompt', asyncHandler(async (req, res) => {
  const data = validateRequest(refinePromptSchema, req.body);
  res.json(await refineMediaPrompt(data));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    // Speculative lookups (Pipeline `MediaJobThumb` hydration for old
    // panel/scene jobIds that are past the queue's 24h archive TTL) hit
    // this path constantly. Mark as `warning` so it doesn't surface as a
    // global toast/console.error via useErrorNotifications — the body is
    // unchanged, callers still get a 404 + NOT_FOUND code.
    throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND', severity: 'warning' });
  }
  res.json(sanitizeJob(job));
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const result = await cancelJob(req.params.id);
  if (!result.ok) {
    // Distinguish "no such id" (404) from "exists but already terminal"
    // (409) so consumers can react appropriately — e.g. the UI doesn't
    // need to display "Not found" when the user just clicked Cancel
    // again on a job that already finished.
    const status = result.code === 'ALREADY_TERMINAL' ? 409 : 404;
    throw new ServerError(result.error || 'Cancel failed', { status, code: result.code || 'NOT_FOUND' });
  }
  res.json(result);
}));

// Params that point at multipart-staged temp files under PATHS.uploads. The
// gen modules unlink these on completion/failure, so a job that ran is no
// longer retryable from the persisted params alone (the files are gone, or
// — worse — could collide with a fresh upload at the same path).
const TEMP_UPLOAD_PARAMS = ['uploadedTempPath', 'uploadedTempPaths', 'audioFilePath'];
function hasTempUploadParam(params) {
  if (!params) return false;
  return TEMP_UPLOAD_PARAMS.some((k) => {
    const v = params[k];
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === 'string' && v.length > 0;
  });
}

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
// effort back to the shipped default", because the drop-undefined merge below
// would silently retain the old value. This sentinel is a distinct signal: when
// the retry payload sends `effort: 'default'`, the handler DELETES `params.effort`
// so the render falls back to CODEX_IMAGEGEN_DEFAULT_EFFORT (`low`). A real job
// never stores `'default'` as an effort (it's always a CODEX_EFFORT_LEVELS value),
// so the sentinel can't collide with a legitimate level.
const EFFORT_CLEAR_SENTINEL = 'default';
const RETRY_OVERRIDE_SCHEMA = z.object({
  prompt: z.string().trim().min(1).max(8000).optional(),
  negativePrompt: z.string().trim().max(8000).optional(),
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
  steps: z.number().int().min(1).max(200).optional(),
  guidance: z.number().min(0).max(30).optional(),
  guidanceScale: z.number().min(0).max(30).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  seed: z.number().int().optional(),
  numFrames: z.number().int().min(1).max(2000).optional(),
  fps: z.number().int().min(1).max(120).optional(),
}).partial();

const retryBodySchema = z.object({
  params: RETRY_OVERRIDE_SCHEMA.optional(),
}).optional();

// Re-enqueue a terminal job. Optional `body.params` overrides specific
// user-facing fields (prompt, model, dimensions, etc.) so a user can edit
// a failed job's config in the UI before retrying without losing the rest
// of the original params. Non-listed params (interpreter paths, session ids)
// always inherit from the original job.
router.post('/:id/retry', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  if (job.status === 'queued' || job.status === 'running') {
    throw new ServerError(
      `Job is still ${job.status} — cancel it before retrying`,
      { status: 409, code: 'JOB_NOT_TERMINAL' },
    );
  }
  // Reject retry when the original job referenced a multipart-staged upload —
  // the gen modules unlink those files on completion/failure, so re-enqueueing
  // would either fail with a missing-file error or, worse, act on a stale path
  // that's since been reused by a different upload.
  if (hasTempUploadParam(job.params)) {
    throw new ServerError(
      'Job referenced an uploaded file that has since been cleaned up — re-submit the original request with the file attached instead of retrying',
      { status: 409, code: 'JOB_RETRY_TEMP_UPLOAD' },
    );
  }
  const body = validateRequest(retryBodySchema, req.body ?? {}) ?? {};
  const rawOverrides = body.params ?? {};
  // A `effort: 'default'` override is a clear-to-default signal, not a value to
  // merge — handled by deleting params.effort below so the render falls back to
  // the shipped CODEX_IMAGEGEN_DEFAULT_EFFORT. Exclude it from the merge set.
  const clearEffort = rawOverrides.effort === EFFORT_CLEAR_SENTINEL;
  // Strip undefined override values before merging — Zod's emptyToUndef
  // transform turns "" → undefined for model/modelId/effort, and a naive spread
  // would still set those keys to undefined on the merged params (clobbering
  // the original job's values). Filtering keeps unchanged fields intact.
  const overrides = Object.fromEntries(
    Object.entries(rawOverrides).filter(
      ([k, v]) => v !== undefined && !(k === 'effort' && clearEffort),
    ),
  );
  const params = { ...job.params, ...overrides };
  // Reset Codex effort to the shipped default: dropping the key lets codex.js's
  // fallback (CODEX_IMAGEGEN_DEFAULT_EFFORT) take over, which a merged sentinel
  // string could not do (it would fail the CODEX_EFFORT_LEVELS validation).
  if (clearEffort) delete params.effort;
  const result = enqueueJob({ kind: job.kind, params, owner: job.owner });
  // Drop the original failed/canceled row from archive — the new job inherits
  // its work, and leaving both visible just lets users keep clicking Retry on
  // the dead row and stacking duplicate jobs. If the prune returns false the
  // archive doesn't have this id (unusual — getJob() found it above), so log
  // a warning instead of silently masking duplicate history.
  if (!removeArchivedJob(job.id)) {
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] retry: archive prune found nothing to drop — old row may persist in /api/media-jobs`);
  }
  res.json({ ...result, retriedFrom: job.id });
}));

// Delete a terminal job from the failed/canceled archive. Live jobs
// (queued/running) are rejected — those need cancel first. Returns 404 for
// unknown ids so the UI can prune optimistically without worrying about a
// race with another tab pruning the same row.
router.delete('/:id', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  if (job.status === 'queued' || job.status === 'running') {
    throw new ServerError(
      `Job is still ${job.status} — cancel it before deleting`,
      { status: 409, code: 'JOB_NOT_TERMINAL' },
    );
  }
  const removed = removeArchivedJob(req.params.id);
  if (!removed) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ ok: true });
}));

// Promote a queued Codex job past the lane's parallel limit. GPU jobs are
// rejected — they serialize on the single MLX runtime.
router.post('/:id/run-now', asyncHandler(async (req, res) => {
  const result = runJobNow(req.params.id);
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    throw new ServerError(result.error || 'Run-now failed', { status, code: result.code });
  }
  res.json(result);
}));

// Bulk-cancel every queued job (running jobs are left alone — they need a
// per-id POST to trigger the SIGTERM path). Optional ?kind=image|video filter.
const cancelQueuedSchema = z.object({ kind: z.enum(JOB_KINDS).optional() });
router.post('/cancel-queued', asyncHandler(async (req, res) => {
  const { kind } = validateRequest(cancelQueuedSchema, req.query);
  const result = await cancelQueuedJobs({ kind });
  res.json(result);
}));

export default router;
