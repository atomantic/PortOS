/**
 * Universe Builder Render Orchestration
 *
 * Extracted from routes/universeBuilder.js POST /:id/render.
 * Owns the full render-job flow: settings validation, image-mode resolution,
 * compilePrompts, LoRA resolution, findOrCreateUniverseCollection,
 * registerUniverseBuilderRun, job enqueue loop, run record.
 *
 * The route handler becomes: validate → renderUniverseJobs → res.json.
 */

import { randomUUID } from 'crypto';
import * as svc from './universeBuilder.js';
import { enqueueJob } from './mediaJobQueue/index.js';
import { getSettings } from './settings.js';
import { findOrCreateUniverseCollection } from './mediaCollections.js';
import { buildUniverseRunTag } from './universeRunTag.js';
import { registerUniverseBuilderRun } from './universeBuilderCollectionHook.js';
import { getImageModels, isFlux2 } from '../lib/mediaModels.js';
import { usesDiffusersRunner } from '../lib/runners.js';
import { IMAGE_GEN_MODE, QUEUEABLE_IMAGE_MODES } from './imageGen/modes.js';
import { resolveCloudProviderConfig } from './imageGen/cloudProviderConfig.js';
import { resolveImageCleaners } from './imageGen/index.js';
import { getStylePresetById } from '../lib/writersRoomStylePresets.js';
import { ServerError } from '../lib/errorHandler.js';

/**
 * Orchestrate a full Universe Builder render batch.
 *
 * @param {string} universeId - The universe id.
 * @param {object} body - Validated render request body (renderSchema shape).
 * @param {function} mapServiceError - Error mapper from the route.
 * @returns {Promise<object>} Response payload: { runId, collectionId, collectionName, promptCount, jobIds, entryJobs, mode }
 */
export async function renderUniverseJobs(universeId, body, mapServiceError) {
  const universe = await svc.getUniverse(universeId).catch((err) => { throw mapServiceError(err); });

  // Resolve a style preset (server-side authoritative list) so the embrace
  // tokens are deterministic for this render even if the client sent a stale
  // preset object. Unknown ids are ignored (server is the source of truth).
  const stylePreset = getStylePresetById(body.stylePresetId);
  // `negativePrompt` is the schema field; `extraNegative` is compilePrompts'
  // option name (avoids shadowing `negativePrompt` on each compiled item).
  const compiled = svc.compilePrompts(universe, {
    promptMode: body.promptMode,
    selection: body.selection,
    sheetSelection: body.sheetSelection,
    canonSelection: body.canonSelection,
    batchPerVariation: body.batchPerVariation,
    extraStyle: body.extraStyle,
    extraNegative: body.negativePrompt,
    stylePresetPrompt: stylePreset?.prompt,
    stylePresetNegative: stylePreset?.negativePrompt,
  });
  if (!compiled.length) {
    throw new ServerError('No prompts to render — add canon entries, variations, or composite sheets first', {
      status: 400, code: 'WORLD_BUILDER_EMPTY',
    });
  }

  const settings = await getSettings();
  const mode = body.mode || settings.imageGen?.mode || IMAGE_GEN_MODE.EXTERNAL;

  // Reject `external` mode upfront — batch rendering against a remote SD-API
  // would block this request for the entire batch, and we don't want to leave
  // an orphaned media collection behind when we discover this mid-loop below.
  if (!QUEUEABLE_IMAGE_MODES.includes(mode)) {
    throw new ServerError(
      'Batch render requires local, codex, or grok mode — switch image-gen mode in Settings → Image Gen',
      { status: 400, code: 'WORLD_BUILDER_EXTERNAL_UNSUPPORTED' },
    );
  }

  // Mirror the upfront validation /api/image-gen/generate does so a doomed
  // batch fails before any jobs land in the queue.
  const cloud = resolveCloudProviderConfig(settings, mode);
  if (cloud && !cloud.enabled) throw cloud.disabledError;
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    const py = settings.imageGen?.local?.pythonPath || null;
    const allModels = getImageModels();
    if (body.modelId && !allModels.some((m) => m.id === body.modelId)) {
      throw new ServerError(`Unknown modelId: ${body.modelId}`, { status: 400, code: 'IMAGE_GEN_UNKNOWN_MODEL' });
    }
    const selectedModel = allModels.find((m) => m.id === body.modelId)
      ?? allModels.find((m) => m.id === 'dev')
      ?? allModels[0];
    if (selectedModel && !isFlux2(selectedModel) && !usesDiffusersRunner(selectedModel) && !py) {
      throw new ServerError(
        'Local image generation is not configured (settings.imageGen.local.pythonPath is missing).',
        { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' },
      );
    }
  }

  // Provision the collection up front so renders can be tagged as they
  // complete. The completion hook (universeBuilderCollectionHook) will add
  // each finished image's filename to this collection. Resolution is
  // universeId-first (not name-first) so a re-render finds the existing
  // linked bucket even if the universe was hand-renamed or another
  // universe happens to share the same display name. Name-only matching
  // would either fork the bucket on rename or hijack a foreign universe's
  // collection — the atomic helper rules out both.
  const collection = await findOrCreateUniverseCollection({
    universeId: universe.id,
    universeName: universe.name,
    description: `Universe Builder renders for "${universe.name}"`,
  });

  const runId = randomUUID();
  const jobIds = [];
  // Map cfgScale → guidance the same way /api/image-gen/generate does. The
  // mediaJobQueue calls imageGen/local.generateImage() directly (not the
  // dispatcher), so without this mapping the Universe Builder UI's CFG control
  // would silently no-op for local renders.
  const guidance = body.guidance ?? body.cfgScale;
  // Local image gen reads `loraFilenames` (basenames) + `loraScales` (parallel
  // array of numbers), not the `[{filename, scale}]` UI shape. Convert here so
  // every enqueued job actually applies the user's LoRA selection.
  const loraFilenames = Array.isArray(body.loras) && body.loras.length
    ? body.loras.map((l) => l.filename)
    : undefined;
  const loraScales = Array.isArray(body.loras) && body.loras.length
    ? body.loras.map((l) => l.scale)
    : undefined;
  const baseParams = {
    width: body.width,
    height: body.height,
    steps: body.steps,
    cfgScale: body.cfgScale,
    guidance,
    quantize: body.quantize,
    seed: body.seed,
    loraFilenames,
    loraScales,
  };

  // Parallel-indexed mapping from jobId → entryRef so the client can show a
  // per-entry pending loader (MediaJobThumb-style) on the variation / sheet /
  // canon row that owns this render. Only entries with a stable `id` carry an
  // entryRef in `compiled` (the sanitizer mints ids on every write now, so
  // legacy id-less records are the only gap).
  const entryJobs = [];
  // Register the run BEFORE enqueueing any jobs — the queue may dispatch and
  // emit `completed` synchronously for the first job, and without prior
  // registration the completion hook can't coalesce the run's
  // emitRecordUpdated calls. `compiled.length` is the authoritative expected
  // count (each compiled item produces exactly one job below).
  registerUniverseBuilderRun({ runId, universeId: universe.id, jobCount: compiled.length });
  for (const item of compiled) {
    const params = {
      ...baseParams,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt || undefined,
      // Tag every job so the completion hook can route the result back
      // into the run's collection without us having to thread additional
      // arguments through the queue. `entryRef` (when present — variations
      // and composite sheets gain it once the universe has been written
      // through the current sanitizer) lets the hook also append the
      // rendered filename to the source variation/sheet/canon entry's
      // `imageRefs[]` so the Universe Builder can show the latest render
      // as an avatar next to each item. The pre-resolved `collection` +
      // shared `runId` are passed so each per-item tag reuses them without
      // re-provisioning the collection.
      universeRun: await buildUniverseRunTag({
        universeId: universe.id,
        collection,
        runId,
        category: item.category,
        label: item.label,
        entryRef: item.entryRef,
      }),
    };
    let queued;
    // The queue dispatches directly to imageGen/{codex,local}.generateImage,
    // bypassing imageGen/index.js's dispatcher that resolves cleaners for
    // direct callers. Resolve here so the per-mode cleanC2PA + denoise
    // settings apply to Universe Builder batch renders the same way they
    // do for /api/image-gen/generate and pipeline renders.
    const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
    if (cloud) {
      queued = enqueueJob({
        kind: 'image',
        params: { ...cloud.jobParams, cleanC2PA, denoise, ...params },
      });
    } else {
      // mode === IMAGE_GEN_MODE.LOCAL (validated upfront).
      const py = settings.imageGen?.local?.pythonPath || null;
      queued = enqueueJob({
        kind: 'image',
        params: { pythonPath: py, modelId: body.modelId, cleanC2PA, denoise, ...params },
      });
    }
    jobIds.push(queued.jobId);
    if (item.entryRef) entryJobs.push({ jobId: queued.jobId, entryRef: item.entryRef });
  }

  const run = await svc.recordRun({
    id: runId,
    universeId: universe.id,
    collectionId: collection.id,
    jobIds,
    promptCount: compiled.length,
    createdAt: new Date().toISOString(),
  });

  console.log(`🌍 Universe Builder render — universe=${universe.name} prompts=${compiled.length} mode=${mode} runId=${runId.slice(0, 8)}`);

  return {
    runId: run.id,
    collectionId: collection.id,
    collectionName: collection.name,
    promptCount: compiled.length,
    jobIds,
    // Per-entry mapping for client-side pending-state UI. Empty when the
    // batch only contains entries without stable ids (legacy fallback).
    entryJobs,
    mode,
  };
}
