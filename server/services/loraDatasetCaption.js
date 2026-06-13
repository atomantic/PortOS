/**
 * LoRA dataset captioning — vision-LLM auto-captions with SSE progress.
 *
 * Sequential loop (vision backends are local; concurrency 1) over the
 * dataset's ready images: read file → base64 data URL →
 * `describeImageDataUrl` (the same provider pathway the voice agent's
 * ui_describe_visually tool uses) → trigger-word prefix → persist.
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
import { v4 as uuidv4 } from '../lib/uuid.js';
import { prefixCaption } from '../lib/loraDataset.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { describeImageDataUrl } from './visionTest.js';
import { getSettings } from './settings.js';
import { listVisionModels } from './localLlm.js';
import { isVisionModel } from '../lib/localModelHeuristics.js';
import { getDataset, updateDataset, datasetImagePath } from './loraDatasets.js';

export const CAPTION_PROMPT = [
  'Describe the person or character in this image for image-generation training:',
  'pose, camera angle, expression, clothing, visible accessories, and framing',
  '(full body / bust / close-up). Reply with ONE comma-separated list of short',
  'fragments. Do not mention art style, the character\'s name, or that this is',
  'an illustration.',
].join(' ');

const CAPTION_MAX_TOKENS = 300;

// runId → { clients: [], lastPayload } — same shape the imageGen/videoGen
// SSE helpers operate on.
const captionRuns = new Map();

export const attachCaptionSseClient = (runId, res) => attachSse(captionRuns, runId, res);

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
      'No vision-capable model is installed for captioning. Install one (e.g. Qwen2.5-VL, LLaVA, or Llama 3.2 Vision) from Settings → Local LLM, then pick it on the dataset.',
      { status: 409, code: 'LORA_CAPTION_NO_VISION_MODEL' },
    );
  }
  return { providerId: pick.providerId, model: pick.id };
}

const emit = (runId, payload) => {
  const run = captionRuns.get(runId);
  if (run) broadcastSse(run, payload);
};

/**
 * Start a caption run. Returns `{ runId, total }` immediately; the loop
 * runs detached. `imageIds` limits the run to specific images (single
 * re-caption = one-element array); `overwrite: false` skips images that
 * already have a caption.
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

  const runId = uuidv4();
  captionRuns.set(runId, { clients: [], lastPayload: null });
  console.log(`🏷️ Caption run ${shortId(runId)} — dataset=${shortId(datasetId)} images=${targets.length} provider=${resolvedProvider} model=${resolvedModel}`);

  // Detached loop — runs outside the request lifecycle, so each iteration
  // wraps its fallible work in try/catch (the async-boundary exception to
  // the no-try/catch rule) and failures route into the SSE error frames.
  (async () => {
    let done = 0;
    let failed = 0;
    for (const img of targets) {
      let caption = null;
      try {
        const bytes = await readFile(datasetImagePath(datasetId, img.file));
        const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
        const text = await describeImageDataUrl({
          dataUrl,
          prompt: CAPTION_PROMPT,
          providerId: resolvedProvider,
          model: resolvedModel,
          maxTokens: CAPTION_MAX_TOKENS,
        });
        caption = prefixCaption(dataset.triggerWord, text);
      } catch (err) {
        failed += 1;
        console.error(`❌ Caption failed [${shortId(runId)} ${img.id}]: ${err?.message || err}`);
        emit(runId, { type: 'progress', done, total: targets.length, imageId: img.id, error: String(err?.message || err) });
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
        failed += 1;
        console.error(`❌ Caption persist failed [${shortId(runId)} ${img.id}]: ${err?.message || err}`);
        emit(runId, { type: 'progress', done, total: targets.length, imageId: img.id, error: String(err?.message || err) });
        continue;
      }
      done += 1;
      emit(runId, { type: 'progress', done, total: targets.length, imageId: img.id, caption });
    }
    const terminal = failed && !done
      ? { type: 'error', message: `All ${failed} caption(s) failed — check the vision provider (${resolvedProvider})` }
      : { type: 'complete', done, failed, total: targets.length };
    emit(runId, terminal);
    console.log(`🏷️ Caption run ${shortId(runId)} finished — ${done}/${targets.length} captioned, ${failed} failed`);
    closeJobAfterDelay(captionRuns, runId);
  })();

  return { runId, total: targets.length, provider: resolvedProvider };
}
