/**
 * Models Management — HuggingFace cache + LoRAs.
 *
 * HF models live at HF's standard cache location (~/.cache/huggingface/hub by
 * default). PortOS doesn't move or symlink them — it just reads from there
 * for the Models manager UI, separate from DataManager (which only tracks
 * files inside data/). LoRAs the user drops into data/loras/ are still
 * tracked by DataManager and shown here too.
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';
import { getHfCacheRoot } from '../lib/hfCache.js';
import {
  getImageModels,
  getVideoModels,
  isUserModelEntry,
  patchUserModelEntry,
  removeUserModelEntry,
} from '../lib/mediaModels.js';
import { publicTextEncoderOption, videoTextEncoderOptions } from '../lib/videoTextEncoders.js';
import { emptyToUndefined, validateRequest } from '../lib/validation.js';
import { ADDABLE_IMAGE_RUNNERS, ADDABLE_VIDEO_RUNTIMES, searchHuggingfaceModels } from '../lib/huggingfaceModel.js';
import { addModelFromHuggingface } from '../services/mediaModelInstall.js';
import { getMediaModelStorage } from '../services/mediaModelStorage.js';

const router = Router();

// Keep the manager's directory listing/deletion root identical to the cache
// status probes. In particular, HF_HUB_CACHE and XDG_CACHE_HOME are valid
// Hugging Face overrides too — listing one root while status checks another
// would make a downloaded encoder impossible to delete from this UI.
const HF_HUB_DIR = getHfCacheRoot;

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await getMediaModelStorage());
}));

// GET /registry — the media-model registry as the manager UI needs it:
// every image + video entry flattened with a `builtIn` flag so the page can
// render built-ins read-only and user-added entries editable/removable. It also
// includes the prompt-conditioner choices exposed by installed video runtimes
// (currently MiniMax H3), so their separate multi-GB downloads can be managed
// alongside the models that consume them. This is distinct from `GET /` (which
// reports on-disk HF *cache* usage) — it reports what can be picked, including
// entries whose weights aren't downloaded yet.
router.get('/registry', asyncHandler(async (_req, res) => {
  const flatten = (list, kind) =>
    (Array.isArray(list) ? list : []).map((m) => ({
      id: m.id,
      name: m.name,
      repo: m.repo || null,
      kind,
      runtime: m.runtime || null,
      runner: m.runner || null,
      steps: m.steps ?? null,
      guidance: m.guidance ?? null,
      deprecated: !!m.deprecated,
      broken: m.broken ?? false,
      builtIn: !isUserModelEntry(m),
      source: m.source || null,
      installedAt: m.installedAt || null,
    }));
  // One encoder can be offered by more than one model. Keep one management row
  // per encoder while retaining the model ids it is compatible with, rather
  // than rendering duplicate rows (or arbitrarily hiding one relationship).
  const videoModels = getVideoModels();
  const textEncoderMap = new Map();
  for (const model of videoModels) {
    for (const option of videoTextEncoderOptions(model)) {
      const existing = textEncoderMap.get(option.id);
      if (existing) {
        existing.modelIds.push(model.id);
      } else {
        textEncoderMap.set(option.id, {
          ...publicTextEncoderOption(option),
          modelIds: [model.id],
        });
      }
    }
  }
  // Use the CURRENT platform's video list (getVideoModels) rather than
  // flattening both macos+windows — that matches what's actually pickable here
  // and avoids showing duplicate rows when a shared media-models.json holds the
  // same custom id in both platform lists (macOS+Windows peer). Image entries
  // are single-list.
  res.json({
    video: flatten(videoModels, 'video'),
    image: flatten(getImageModels(), 'image'),
    textEncoders: [...textEncoderMap.values()],
  });
}));

// GET /search — free-text HuggingFace Hub search for candidate base-model
// repos. Backs the manager UI's discovery box; the user adds one by feeding its
// id into POST /install/huggingface (which runs the full classify/refuse pass).
const modelSearchSchema = z.object({
  query: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
  pipeline: z.preprocess(emptyToUndefined, z.string().max(60).optional()),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
router.get('/search', asyncHandler(async (req, res) => {
  const { query, pipeline, limit } = validateRequest(modelSearchSchema, req.query);
  const items = await searchHuggingfaceModels(query || '', { pipeline, limit: limit || 12 });
  res.json({ items });
}));

// POST /install/huggingface — add a custom base model from an HF repo. Strict:
// the classifier refuses GGUF-only, wan/hunyuan, or unclassifiable repos so a
// bad add can't wedge the picker. The (multi-GB) weight download is deferred to
// the existing per-model download SSE once the entry exists — this call is
// metadata-only and returns the new entry. `kind`/`runtime`/`runner` are
// optional overrides for a mis-detected repo; `name`/`steps`/`guidance`
// override the derived defaults. HF token comes from settings/env — never the
// request body.
// runtime/runner enums are built from the classifier's ADDABLE_* allowlists —
// single source of truth so the route can't drift from what the classifier
// (and RUNNER_FAMILIES) actually accept.
const hfAddModelSchema = z.object({
  url: z.string().min(1).max(1024),
  kind: z.enum(['image', 'video']).optional(),
  runtime: z.enum(ADDABLE_VIDEO_RUNTIMES).optional(),
  runner: z.enum(ADDABLE_IMAGE_RUNNERS).optional(),
  name: z.string().min(1).max(200).optional(),
  steps: z.coerce.number().int().min(1).max(200).optional(),
  guidance: z.coerce.number().min(0).max(30).optional(),
});
router.post('/install/huggingface', asyncHandler(async (req, res) => {
  const data = validateRequest(hfAddModelSchema, req.body);
  const result = await addModelFromHuggingface(data);
  res.status(201).json(result);
}));

// PATCH /custom/:id — edit a user-added model's name/steps/guidance. Built-ins
// return 403 MODEL_READONLY.
const patchModelSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  steps: z.coerce.number().int().min(1).max(200).optional(),
  guidance: z.coerce.number().min(0).max(30).optional(),
});
router.patch('/custom/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(patchModelSchema, req.body);
  res.json(patchUserModelEntry(req.params.id, patch));
}));

// DELETE /custom/:id — remove a user-added model. Built-ins return 403
// MODEL_READONLY; unknown ids 404. This removes the registry ENTRY only; any
// downloaded weights stay in the HF cache (deletable via DELETE /hf/:dirName).
router.delete('/custom/:id', asyncHandler(async (req, res) => {
  res.json(removeUserModelEntry(req.params.id));
}));

router.delete('/hf/:dirName', asyncHandler(async (req, res) => {
  const dirName = req.params.dirName;
  if (!dirName.startsWith('models--') || dirName.includes('/') || dirName.includes('\\') || dirName.includes('..')) {
    throw new ServerError('Invalid model directory name', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const fullPath = join(HF_HUB_DIR(), dirName);
  if (!existsSync(fullPath)) throw new ServerError('Model not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🗑️ Deleting HF model cache: ${dirName}`);
  await rm(fullPath, { recursive: true, force: true });
  res.json({ ok: true });
}));

router.delete('/lora/:filename', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  if (!filename.endsWith('.safetensors') || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new ServerError('Invalid filename', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const filePath = join(PATHS.loras, filename);
  if (!existsSync(filePath)) throw new ServerError('LoRA not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🗑️ Deleting LoRA: ${filename}`);
  await rm(filePath, { force: true });
  res.json({ ok: true });
}));

export default router;
