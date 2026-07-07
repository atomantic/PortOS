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
import { readdir, stat, rm } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { PATHS, formatBytes, dirSize } from '../lib/fileUtils.js';
import {
  isUserModelEntry,
  loadMediaModels,
  patchUserModelEntry,
  removeUserModelEntry,
} from '../lib/mediaModels.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { emptyToUndefined, validateRequest } from '../lib/validation.js';
import { ADDABLE_IMAGE_RUNNERS, ADDABLE_VIDEO_RUNTIMES, searchHuggingfaceModels } from '../lib/huggingfaceModel.js';
import { addModelFromHuggingface } from '../services/mediaModelInstall.js';

const router = Router();
const HF_DEFAULT_HUB = join(homedir(), '.cache', 'huggingface', 'hub');

// HF stores its hub cache under <HF_HOME>/hub/models--<org>--<name>. Honor
// HF_HOME if the user set one, otherwise fall back to HF's own default
// (~/.cache/huggingface/hub).
const HF_HUB_DIR = () =>
  process.env.HF_HOME ? join(process.env.HF_HOME, 'hub') : HF_DEFAULT_HUB;

// Friendly labels for known models, derived from the media-models registry.
// HF stores cache dirs as `models--<org>--<name>` (slashes replaced with --).
// Image gen still has a few well-known repos (Flux) that the registry tracks
// only by short id, so we add those here as a small static fallback.
const buildAppModels = () => {
  const reg = loadMediaModels();
  const out = {
    'black-forest-labs--FLUX.1-schnell': 'Flux 1 Schnell (Image)',
    'black-forest-labs--FLUX.1-dev': 'Flux 1 Dev (Image)',
  };
  const addEntry = (m, suffix) => {
    if (!m.repo) return;
    out[m.repo.replace(/\//g, '--')] = `${m.name} ${suffix}`;
  };
  for (const m of [...(reg.video?.macos || []), ...(reg.video?.windows || [])]) addEntry(m, '(Video)');
  for (const t of (reg.textEncoders || [])) addEntry({ name: t.label, repo: t.repo }, '(Text Encoder)');
  return out;
};
const APP_MODELS = buildAppModels();

router.get('/', asyncHandler(async (_req, res) => {
  const hubDir = HF_HUB_DIR();

  const entries = existsSync(hubDir)
    ? (await readdir(hubDir)).filter((f) => f.startsWith('models--'))
    : [];

  const [models, loras, totalImages, totalVideos] = await Promise.all([
    mapWithConcurrency(entries, 4, async (dirName) => {
      const fullPath = join(hubDir, dirName);
      const modelKey = dirName.replace('models--', '');
      const [org, ...nameParts] = modelKey.split('--');
      const name = nameParts.join('--');
      const size = await dirSize(fullPath);
      return {
        id: dirName,
        org,
        name,
        repo: `${org}/${name}`,
        label: APP_MODELS[modelKey] || null,
        size,
        sizeHuman: formatBytes(size),
      };
    }),
    (async () => {
      const out = [];
      if (!existsSync(PATHS.loras)) return out;
      for (const f of await readdir(PATHS.loras)) {
        if (!f.endsWith('.safetensors')) continue;
        const s = await stat(join(PATHS.loras, f));
        out.push({
          filename: f,
          name: f.replace(/^lora-/, '').replace(/\.safetensors$/, ''),
          size: s.size,
          sizeHuman: formatBytes(s.size),
        });
      }
      return out;
    })(),
    dirSize(PATHS.images),
    dirSize(PATHS.videos),
  ]);
  models.sort((a, b) => b.size - a.size);

  const totalModels = models.reduce((sum, m) => sum + m.size, 0);
  const totalLoras = loras.reduce((sum, l) => sum + l.size, 0);

  res.json({
    models,
    loras,
    hubDir,
    diskUsage: {
      models: formatBytes(totalModels),
      loras: formatBytes(totalLoras),
      images: formatBytes(totalImages),
      videos: formatBytes(totalVideos),
      total: formatBytes(totalModels + totalLoras + totalImages + totalVideos),
    },
  });
}));

// GET /registry — the media-model registry as the manager UI needs it:
// every image + video entry flattened with a `builtIn` flag so the page can
// render built-ins read-only and user-added entries editable/removable. This
// is distinct from `GET /` (which reports on-disk HF *cache* usage) — this
// reports the model *catalog* (what can be picked), including entries whose
// weights aren't downloaded yet.
router.get('/registry', asyncHandler(async (_req, res) => {
  const reg = loadMediaModels();
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
  res.json({
    video: [
      ...flatten(reg.video?.macos, 'video'),
      ...flatten(reg.video?.windows, 'video'),
    ],
    image: flatten(reg.image, 'image'),
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
