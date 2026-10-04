/**
 * LoRA dataset captioning — vision-LLM auto-captions with SSE progress.
 *
 * Sequential loop (vision backends are local; concurrency 1) over the
 * dataset's ready images: read file → base64 data URL →
 * `describeImageDataUrl` (the same provider pathway the voice agent's
 * ui_describe_visually tool uses) → trigger-word prefix → persist. A
 * module-level mutex (`withCaptionVisionLock`) extends that concurrency-1
 * guarantee ACROSS runs, so overlapping caption runs can't fan out parallel
 * requests at a single-GPU backend (see the lock's header for why parallel
 * local vision is pure downside).
 * Progress streams over the shared per-job SSE helpers; the client
 * subscribes via `GET /api/lora-datasets/:id/caption-runs/:runId/events`
 * and refetches the dataset on the terminal frame.
 *
 * Provider/model resolution: request override → `settings.loraTraining.*`
 * → a vision-capable installed model auto-picked across the local backends.
 * A vision model is *required* — captioning sends image content blocks, so a
 * text-only model would 400 per image with a cryptic "Model does not support
 * images". We resolve (and validate) a vision model up front and fail the whole
 * run with one actionable error instead.
 */

import { readFile } from 'fs/promises';
import { ServerError } from '../lib/errorHandler.js';
import { shortId } from '../lib/fileUtils.js';
import { prefixCaption } from '../lib/loraDataset.js';
import { createSseRunner } from '../lib/sseUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { describeImageDataUrlDetailed } from './visionTest.js';
import { getSettings } from './settings.js';
import { listVisionModels } from './localLlm.js';
import { isVisionModel } from '../lib/localModelHeuristics.js';
import { getDataset, updateDataset, datasetImagePath } from './loraDatasets.js';
import { loadDatasetSubject, extractSubjectSignaturePhrases } from './loraDatasetSubject.js';

/**
 * Build the vision-captioning instruction. A LoRA binds whatever the captions
 * DON'T describe to the trigger word, so a strong character/object/place caption
 * names only what changes shot-to-shot (pose, framing, lighting, setting) and
 * deliberately omits the subject's permanent identity — hair, build, signature
 * outfit, recurring props, palette. Captioning those in every shot teaches the
 * model the phrases instead of the trigger, and the bare trigger then renders a
 * generic subject (issue #1320). When the bible knows the subject's signature
 * features, we name them explicitly so the model omits them even when it would
 * have phrased them differently shot-to-shot (the case the post-hoc
 * shared-fragment strip misses, since it matches on exact repeated phrasing).
 *
 * `signaturePhrases` — discrete always-present features (wardrobe, props,
 * palette) to call out by name; empty for uploaded datasets with no bible
 * subject, where the general guidance still applies.
 */
export function buildCaptionPrompt(signaturePhrases = []) {
  const omit = (Array.isArray(signaturePhrases) ? signaturePhrases : [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  return [
    'Describe ONLY what changes from shot to shot in this image, for image-generation training:',
    'pose, body position, camera angle, expression, framing (full body / bust / close-up),',
    'lighting, and background or setting. If the outfit clearly differs from the subject\'s',
    'usual look, name it briefly; otherwise do not describe clothing.',
    'Do NOT describe the subject\'s fixed identity — hair, eyes, skin, body build, signature',
    'outfit, recurring props, or color scheme. Those are bound to the trigger word, and',
    'repeating them in every caption weakens it.',
    omit.length
      ? `In particular, do NOT mention these signature features that are always present: ${omit.join('; ')}.`
      : '',
    'Reply with ONE comma-separated list of short fragments. Do not mention art style,',
    'the subject\'s name, or that this is an illustration.',
  ].filter(Boolean).join(' ');
}

// Base prompt with no bible-derived deny-list — the fallback when a dataset has
// no resolvable subject (uploads), and the shape the tests pin.
export const CAPTION_PROMPT = buildCaptionPrompt();

// A comma-separated caption fits well under 300, but reasoning models (Qwen3,
// thinking Gemma builds) spend tokens on a hidden <think> block FIRST and only
// then emit the caption — at 300 they routinely hit the budget mid-reasoning
// and return empty content. The extra headroom lets those produce a caption
// instead of failing; dedicated VLMs stop well before it, so it costs them
// nothing. The real fix for a reasoning model is to pick a VLM (the failure
// message now says so), but this keeps a borderline case from failing outright.
const CAPTION_MAX_TOKENS = 600;

// Module-level mutex serializing every vision call across ALL caption runs.
// Within one run the loop is already sequential, but nothing stops a user (or
// the UI) from kicking off several runs at once — caption Dataset A + Dataset B,
// re-caption multiple single images, or double-click the button. Each run is a
// detached loop, so concurrent runs would fire N parallel `/chat/completions`
// requests at the same local backend. On a single-GPU Ollama/LM Studio that is
// pure downside: every Ollama parallel slot reserves its own `num_ctx` KV cache
// (PortOS uses 32K), so concurrent vision requests multiply VRAM and risk an
// OOM/model reload, while parallel decoding gives no throughput win on one GPU —
// it just time-slices the same compute and makes each request slower. Funnelling
// every image through this lock keeps backend load at concurrency 1 (predictable
// VRAM, no slower-per-request) regardless of how many runs are in flight. Scoped
// to caption runs only — one-shot vision calls (voice `ui_describe_visually`, the
// vision-test page) deliberately stay off this lock so a long batch run can't
// FIFO-starve an interactive describe.
export const withCaptionVisionLock = createMutex();

// One caption run per dataset: the runner keys its map by datasetId, so a second
// kickoff for the same dataset adopts the in-flight run (identical work) or is
// reported as a conflict (different work) instead of spawning another detached
// loop against the same images. The run's identity is therefore discoverable
// from the dataset alone — a reloaded page / second tab re-attaches to it.
const captionRunner = createSseRunner({ logLabel: 'lora caption run' });

/** Live run record for `datasetId` only when it is still the `runId` asked for. */
const recordFor = (datasetId, runId) => {
  const record = captionRunner.runs.get(datasetId);
  return record && record.runId === runId ? record : null;
};

/**
 * Attach an SSE client to a run. The run must belong to THIS dataset and carry
 * this id — a stale id for an older run (or another dataset's id) never binds
 * onto whatever run currently holds the dataset's slot.
 */
export const attachCaptionSseClient = (datasetId, runId, res) => (
  recordFor(datasetId, runId) ? captionRunner.attachClient(datasetId, res) : false
);

const projectRun = (record) => ({
  runId: record.runId,
  datasetId: record.meta.datasetId,
  status: record.cancelRequested ? 'canceling' : 'running',
  provider: record.meta.provider,
  model: record.meta.model,
  total: record.meta.total,
  done: record.meta.done,
  failed: record.meta.failed,
  startedAt: record.startedAt,
});

/**
 * Bounded projection of the dataset's in-flight caption run, or null. Carries
 * no clients, controller or image content. `status: 'canceling'` means a cancel
 * was requested but the run has not yet emitted its terminal frame (it is still
 * settling an already-issued vision call).
 */
export const getActiveCaptionRun = (datasetId) => {
  const record = captionRunner.runs.get(datasetId);
  return record && !record.finished ? projectRun(record) : null;
};

/**
 * Cancel the dataset's caption run, requiring the run id to match. Throws 404
 * for an unknown/superseded run. A run that already finished (still inside its
 * terminal-replay window) reports `canceled: false` rather than erroring so a
 * late Cancel click is harmless.
 */
export function cancelCaptionRun(datasetId, runId) {
  const record = recordFor(datasetId, runId);
  if (!record) {
    throw new ServerError(`Caption run not found: ${runId}`, { status: 404, code: 'NOT_FOUND' });
  }
  if (record.finished) return { canceled: false, run: null };
  captionRunner.cancel(datasetId);
  return { canceled: true, run: projectRun(record) };
}

const CANCELED = Symbol('caption-canceled');

// Settle with CANCELED as soon as `signal` aborts, without waiting on `promise`.
// The vision adapter takes no AbortSignal, so an already-issued call cannot be
// terminated — the run stops waiting for it and its late result is discarded.
// The original promise keeps its own rejection handler so a late failure is not
// an unhandled rejection.
function raceCancel(promise, signal) {
  promise.catch(() => {});
  if (signal.aborted) return Promise.resolve(CANCELED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(CANCELED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Resolve which provider+model the run captions with, requiring a
 * vision-capable model. Precedence:
 *   1. Explicit request override (providerId/model from the UI picker).
 *   2. Saved `settings.loraTraining.captionProviderId/captionModel`.
 *   3. Auto-pick the first vision-capable installed local model.
 *
 * An explicit non-vision model is rejected (the caller asked for it, so warn
 * loudly rather than silently swap). When nothing is configured and no vision
 * model is installed, throws a 409 with an actionable message — the run never
 * starts, so the user doesn't get N cryptic per-image 400s.
 *
 * Known gap (intentional): the heuristic-first short-circuit accepts a
 * regex-recognized explicit model WITHOUT confirming it's still installed —
 * skipping the two-backend scan is the whole point of the fast path. So a saved
 * `captionModel` that was later uninstalled slips past the up-front 409 and
 * fails per-image at the API instead (surfaced by the run's terminal error).
 * Validating every run against the live model list would defeat the fast path;
 * the picker's own list is the primary defense against a stale selection.
 *
 * `listVision` is injectable for tests; defaults to the localLlm scan.
 */
export async function resolveCaptionModel({
  providerId = null, model = null, settings = null, listVision = listVisionModels,
} = {}) {
  const explicitProvider = providerId || settings?.loraTraining?.captionProviderId || null;
  const explicitModel = model || settings?.loraTraining?.captionModel || null;

  if (explicitModel) {
    // Heuristic-first: the common path (re-caption / caption-all with a picked
    // model) passes a model the id regex already recognizes, so skip the
    // two-backend vision scan entirely. Only scan when the id is opaque — then
    // trust backend metadata (LM Studio `type:'vlm'`) before rejecting.
    if (!isVisionModel(explicitModel)) {
      const visionModels = await listVision().catch(() => []);
      const known = visionModels.some((m) => m.id === explicitModel
        && (!explicitProvider || m.providerId === explicitProvider));
      if (!known) {
        throw new ServerError(
          `Caption model "${explicitModel}" is not vision-capable — pick a vision model (e.g. a Qwen-VL, LLaVA, or Llama 3.2 Vision build).`,
          { status: 409, code: 'LORA_CAPTION_NOT_VISION' },
        );
      }
    }
    return { providerId: explicitProvider || 'lmstudio', model: explicitModel };
  }

  // No explicit model — scan and auto-pick a vision model (preferring the
  // chosen provider when one was set).
  const visionModels = await listVision().catch(() => []);
  const pick = (explicitProvider
    ? visionModels.find((m) => m.providerId === explicitProvider)
    : null) || visionModels[0];
  if (!pick) {
    throw new ServerError(
      'No vision-capable model is installed for captioning. Install one (e.g. Qwen2.5-VL, LLaVA, or Llama 3.2 Vision) from Models → LLMs, then pick it on the dataset.',
      { status: 409, code: 'LORA_CAPTION_NO_VISION_MODEL' },
    );
  }
  return { providerId: pick.providerId, model: pick.id };
}

/**
 * Diagnose WHY a vision reply came back blank, from the response metadata, so
 * the failure message names the real cause instead of always blaming a refusal.
 * `meta` is the `{ finishReason, usage, reasoning }` from describeImageDataUrlDetailed.
 *
 * The three cases we can tell apart:
 *   - Reasoning model burned the budget: it emitted hidden reasoning and the
 *     reply was cut off (`finish_reason: 'length'`) before any caption. The fix
 *     is a dedicated VLM, not a retry — say so.
 *   - Plain truncation: cut off at the budget with no reasoning trace — raising
 *     the budget or a faster model helps.
 *   - Reasoning with room to spare: it chose to only reason — a non-thinking
 *     vision model is the answer.
 * Everything else falls back to the original "it may have refused" wording.
 */
function diagnoseEmptyCaption(meta = {}) {
  const { finishReason = null, usage = null, reasoning = '' } = meta || {};
  const truncated = finishReason === 'length';
  const completionTokens = usage?.completion_tokens ?? null;
  const tokenNote = completionTokens != null ? ` (spent ${completionTokens} completion tokens)` : '';
  if (reasoning && truncated) {
    return `it spent its whole token budget on hidden reasoning${tokenNote} and ran out before writing a caption — this is a reasoning model, not a vision model. Pick a dedicated VLM (Qwen2.5-VL, LLaVA, MiniCPM-V, Llama 3.2 Vision) on the dataset`;
  }
  if (truncated) {
    return `the reply was cut off at the token budget${tokenNote} before any caption text — raise the caption token budget or use a faster vision model`;
  }
  if (reasoning) {
    return `it returned only reasoning and no caption${tokenNote} — use a non-thinking vision model`;
  }
  return 'it may have refused this image; try a different vision model or caption it manually';
}

/**
 * Build the persisted caption from a vision model's raw reply.
 *
 * An empty reply would `prefixCaption` down to just the trigger word — a
 * degenerate "caption" that still counts as success and gets persisted, leaving
 * the image bound but undescribed. Vision models commonly return blank content
 * when they refuse a realistic close-up face (or a thinking model spends its
 * whole token budget reasoning). Throwing here routes blank output through the
 * loop's failure path, so it's surfaced and re-attemptable rather than saved as
 * a trigger-word-only caption. `meta` (when supplied) lets the error name the
 * real cause — refusal vs. token-budget exhaustion by a reasoning model.
 */
export function buildCaption(triggerWord, text, model = 'vision model', meta = null) {
  if (!text || !text.trim()) {
    throw new Error(`${model} returned an empty description — ${diagnoseEmptyCaption(meta)}`);
  }
  return prefixCaption(triggerWord, text);
}

/**
 * Start (or adopt) the dataset's caption run. Returns
 * `{ runId, total, provider, alreadyRunning, conflict? }` immediately; the loop
 * runs detached. `imageIds` limits the run to specific images (single
 * re-caption = one-element array); `overwrite: false` skips images that
 * already have a caption — so starting again after an interrupted run retries
 * only the images that never got one.
 *
 * Identical work (same targets, overwrite mode, provider and model) adopts the
 * in-flight run; different work returns the holder's id with `conflict: true`
 * so the caller can attach to it instead of silently double-booking the images.
 */
export async function startCaptionRun(datasetId, {
  imageIds = null, providerId = null, model = null, overwrite = false,
} = {}) {
  const dataset = await getDataset(datasetId);
  const wanted = new Set(Array.isArray(imageIds) && imageIds.length ? imageIds : null);
  const targets = dataset.images.filter((img) => {
    if (img.status !== 'ready') return false;
    if (wanted.size && !wanted.has(img.id)) return false;
    if (!overwrite && !wanted.size && img.caption) return false;
    return true;
  });
  if (!targets.length) {
    throw new ServerError('No images to caption (all captioned, or none ready)', {
      status: 409, code: 'LORA_DATASET_NOTHING_TO_CAPTION',
    });
  }

  const settings = await getSettings();
  // Resolve (and validate) a vision-capable model BEFORE creating the run, so a
  // missing/non-vision model fails the request synchronously with one clear
  // error instead of N per-image 400s inside the detached loop.
  const { providerId: resolvedProvider, model: resolvedModel } = await resolveCaptionModel({
    providerId, model, settings,
  });

  // Build the captioning instruction once, naming the subject's bible-known
  // signature features so the vision model omits them (they belong to the
  // trigger word, not the per-shot caption). Best-effort: an upload-only
  // dataset or a since-deleted subject just falls back to the general guidance.
  let signaturePhrases = [];
  try {
    const { subject, entryKind } = await loadDatasetSubject(dataset);
    signaturePhrases = extractSubjectSignaturePhrases(subject, entryKind);
  } catch (err) {
    console.log(`🏷️ No bible subject for dataset ${shortId(datasetId)} — captioning with general identity guidance (${err?.message || err})`);
  }
  const captionPrompt = buildCaptionPrompt(signaturePhrases);

  const targetIds = targets.map((img) => img.id);
  const sig = JSON.stringify({
    ids: [...targetIds].sort(), overwrite: !!overwrite, provider: resolvedProvider, model: resolvedModel,
  });
  const meta = {
    datasetId, provider: resolvedProvider, model: resolvedModel, total: targets.length, done: 0, failed: 0, lastError: null,
  };

  // `start` is synchronous (no await between its in-flight check and the map
  // write), so concurrent kickoffs that got past the awaits above cannot both
  // become coordinators.
  const started = captionRunner.start(datasetId, ({ runId, signal, record, broadcast }) => runCaptionLoop({
    runId, signal, meta: record.meta, broadcast, dataset, targets, captionPrompt,
  }), { sig, meta });

  if (started.alreadyRunning) {
    const holder = captionRunner.runs.get(datasetId);
    console.log(`🏷️ Caption run ${shortId(started.runId)} already active for dataset=${shortId(datasetId)} — ${started.conflict ? 'conflicting request attached to it' : 'identical request adopted it'}`);
    return {
      runId: started.runId,
      total: holder.meta.total,
      provider: holder.meta.provider,
      alreadyRunning: true,
      ...(started.conflict ? { conflict: true } : {}),
    };
  }
  console.log(`🏷️ Caption run ${shortId(started.runId)} — dataset=${shortId(datasetId)} images=${targets.length} provider=${resolvedProvider} model=${resolvedModel}`);
  return { runId: started.runId, total: targets.length, provider: resolvedProvider, alreadyRunning: false };
}

/**
 * The detached per-run loop. Runs inside `createSseRunner`'s coordinator, which
 * owns the generic `error` frame and the terminal-replay cleanup; per-image
 * failures are caught here (a boundary outside the request lifecycle) and routed
 * into `progress` frames. Cancellation is checked before and after acquiring the
 * vision mutex, after inference returns, and before each caption is committed.
 */
async function runCaptionLoop({ runId, signal, meta, broadcast, dataset, targets, captionPrompt }) {
  const datasetId = dataset.id;
  const total = targets.length;
  let settling = false;
  const canceled = () => {
    broadcast({ type: 'canceled', runId, done: meta.done, failed: meta.failed, total, settling });
    console.log(`🏷️ Caption run ${shortId(runId)} canceled — ${meta.done}/${total} captioned${settling ? ' (a vision call was still settling; its result is discarded)' : ''}`);
  };

  for (const img of targets) {
    if (signal.aborted) return canceled();
    let caption = null;
    try {
      const bytes = await readFile(datasetImagePath(datasetId, img.file));
      if (signal.aborted) return canceled();
      const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
      // A run canceled while queued behind another dataset's vision call
      // returns here when the mutex frees WITHOUT calling the provider.
      const call = withCaptionVisionLock(() => {
        if (signal.aborted) return CANCELED;
        settling = true;
        return describeImageDataUrlDetailed({
          dataUrl,
          prompt: captionPrompt,
          providerId: meta.provider,
          model: meta.model,
          maxTokens: CAPTION_MAX_TOKENS,
        }).finally(() => { settling = false; });
      });
      const result = await raceCancel(call, signal);
      if (result === CANCELED || signal.aborted) return canceled();
      caption = buildCaption(dataset.triggerWord, result.text, `vision model "${meta.model}"`, result);
    } catch (err) {
      meta.failed += 1;
      meta.lastError = String(err?.message || err);
      console.error(`❌ Caption failed [${shortId(runId)} ${img.id}]: ${err?.message || err}`);
      broadcast({ type: 'progress', runId, done: meta.done, total, imageId: img.id, error: String(err?.message || err) });
      continue;
    }
    try {
      await updateDataset(datasetId, (current) => ({
        ...current,
        images: current.images.map((i) => (i.id === img.id
          ? { ...i, caption, captionSource: 'vision', captionedAt: new Date().toISOString() }
          : i)),
      }));
    } catch (err) {
      meta.failed += 1;
      meta.lastError = String(err?.message || err);
      console.error(`❌ Caption persist failed [${shortId(runId)} ${img.id}]: ${err?.message || err}`);
      broadcast({ type: 'progress', runId, done: meta.done, total, imageId: img.id, error: String(err?.message || err) });
      continue;
    }
    meta.done += 1;
    broadcast({ type: 'progress', runId, done: meta.done, total, imageId: img.id, caption });
  }
  // Terminal frames carry the most recent per-image failure reason: a tab that
  // attached after the `progress` frames were sent only replays this last frame,
  // so the actionable detail (refusal vs. exhausted reasoning budget) must ride it.
  const { done, failed, lastError } = meta;
  broadcast(failed && !done
    ? { type: 'error', runId, message: `All ${failed} caption(s) failed — check the vision provider (${meta.provider})`, lastError }
    : { type: 'complete', runId, done, failed, total, lastError });
  console.log(`🏷️ Caption run ${shortId(runId)} finished — ${done}/${total} captioned, ${failed} failed`);
}
