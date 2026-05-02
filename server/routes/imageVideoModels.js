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
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { PATHS, formatBytes, dirSize } from '../lib/fileUtils.js';
import { loadMediaModels } from '../lib/mediaModels.js';

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

// Bound concurrent dirSize calls — each one spawns a `du` (or PowerShell)
// child, and a hub with 50+ models would otherwise create a process storm
// that stalls the API.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

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
