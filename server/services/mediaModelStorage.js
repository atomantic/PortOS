/**
 * Read-only storage inventory for downloaded media models.
 *
 * The Media Models route and System Resources report both need the same view of
 * Hugging Face cache directories. Keep that knowledge here so cache overrides,
 * friendly labels, and byte totals cannot drift between the two surfaces.
 */

import { existsSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, dirSize, formatBytes } from '../lib/fileUtils.js';
import { getHfCacheRoot } from '../lib/hfCache.js';
import { loadMediaModels } from '../lib/mediaModels.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';

const buildAppModels = () => {
  const registry = loadMediaModels();
  const labels = {
    'black-forest-labs--FLUX.1-schnell': 'Flux 1 Schnell (Image)',
    'black-forest-labs--FLUX.1-dev': 'Flux 1 Dev (Image)',
  };
  const addEntry = (entry, suffix) => {
    if (!entry.repo) return;
    labels[entry.repo.replace(/\//g, '--')] = `${entry.name} ${suffix}`;
  };
  for (const model of [...(registry.video?.macos || []), ...(registry.video?.windows || [])]) {
    addEntry(model, '(Video)');
  }
  for (const encoder of registry.textEncoders || []) {
    addEntry({ name: encoder.label, repo: encoder.repo }, '(Text Encoder)');
  }
  return labels;
};

const APP_MODELS = buildAppModels();

export async function listHfModelStorage({ strict = false } = {}) {
  const hubDir = getHfCacheRoot();
  const hubPresent = strict
    ? await stat(hubDir).then(
        (entry) => entry.isDirectory(),
        (err) => {
          if (err?.code === 'ENOENT') return false;
          throw err;
        },
      )
    : existsSync(hubDir);
  const entries = hubPresent
    ? (await readdir(hubDir)).filter((name) => name.startsWith('models--'))
    : [];

  const models = await mapWithConcurrency(entries, 4, async (dirName) => {
    const modelKey = dirName.replace('models--', '');
    const [org, ...nameParts] = modelKey.split('--');
    const name = nameParts.join('--');
    const size = await dirSize(join(hubDir, dirName), { strict });
    return {
      id: dirName,
      org,
      name,
      repo: `${org}/${name}`,
      label: APP_MODELS[modelKey] || null,
      size,
      sizeHuman: formatBytes(size),
    };
  });

  models.sort((a, b) => b.size - a.size);
  return {
    hubDir,
    models,
    totalBytes: models.reduce((sum, model) => sum + model.size, 0),
  };
}

export async function listLoraStorage({ strict = false } = {}) {
  const rootPresent = strict
    ? await stat(PATHS.loras).then(
        (entry) => entry.isDirectory(),
        (err) => {
          if (err?.code === 'ENOENT') return false;
          throw err;
        },
      )
    : existsSync(PATHS.loras);
  if (!rootPresent) return { loras: [], totalBytes: 0 };
  const loras = [];
  for (const filename of await readdir(PATHS.loras)) {
    if (!filename.endsWith('.safetensors')) continue;
    const info = await stat(join(PATHS.loras, filename));
    loras.push({
      filename,
      name: filename.replace(/^lora-/, '').replace(/\.safetensors$/, ''),
      size: info.size,
      sizeHuman: formatBytes(info.size),
    });
  }
  loras.sort((a, b) => b.size - a.size);
  return {
    loras,
    totalBytes: loras.reduce((sum, lora) => sum + lora.size, 0),
  };
}

export async function getMediaModelStorage() {
  const [hf, loraStorage, totalImages, totalVideos] = await Promise.all([
    listHfModelStorage(),
    listLoraStorage(),
    dirSize(PATHS.images),
    dirSize(PATHS.videos),
  ]);

  return {
    models: hf.models,
    loras: loraStorage.loras,
    hubDir: hf.hubDir,
    diskUsage: {
      models: formatBytes(hf.totalBytes),
      loras: formatBytes(loraStorage.totalBytes),
      images: formatBytes(totalImages),
      videos: formatBytes(totalVideos),
      total: formatBytes(hf.totalBytes + loraStorage.totalBytes + totalImages + totalVideos),
    },
  };
}
