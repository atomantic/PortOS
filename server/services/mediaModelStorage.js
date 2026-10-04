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
import {
  getHfCacheRoot, listLinkedSharedBlobs, scanSharedBlobStore,
} from '../lib/hfCache.js';
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

  const linkedBlobs = new Set();
  const models = await mapWithConcurrency(entries, 4, async (dirName) => {
    const modelKey = dirName.replace('models--', '');
    const [org, ...nameParts] = modelKey.split('--');
    const name = nameParts.join('--');
    // A model dir can be mostly links into the shared blob store; count those
    // bytes so the row reflects what deleting it frees (or at least what it uses).
    const [ownSize, linked] = await Promise.all([
      dirSize(join(hubDir, dirName), { strict }),
      listLinkedSharedBlobs(hubDir, dirName),
    ]);
    let sharedSize = 0;
    for (const bytes of linked.values()) sharedSize += bytes;
    const size = ownSize + sharedSize;
    for (const target of linked.keys()) linkedBlobs.add(target);
    return {
      id: dirName,
      org,
      name,
      repo: `${org}/${name}`,
      label: APP_MODELS[modelKey] || null,
      size,
      sizeHuman: formatBytes(size),
      sharedBytes: sharedSize,
    };
  });

  // Shared blobs can back several models, so the total counts each blob once:
  // the per-model own bytes plus the whole shared store (referenced or leaked).
  const store = hubPresent ? await scanSharedBlobStore(hubDir) : { bytes: 0, files: new Map() };
  let unreferencedBytes = 0;
  for (const [target, bytes] of store.files) if (!linkedBlobs.has(target)) unreferencedBytes += bytes;

  models.sort((a, b) => b.size - a.size);
  return {
    hubDir,
    models,
    sharedStore: { bytes: store.bytes, unreferencedBytes },
    totalBytes: models.reduce((sum, model) => sum + model.size - model.sharedBytes, 0) + store.bytes,
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
