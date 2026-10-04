/**
 * File-system model stores outside the Hugging Face hub cache and `data/loras/`.
 *
 * Four stores hold tens of gigabytes that Models → Media and the system-resources
 * report used to be blind to: MTPLX checkpoints and its session bank, Hunyuan3D
 * weights, the Hugging Face xet download-chunk cache, and Pixie Forge LoRAs.
 * Each is a first-class inventory backend (`lib/modelInventory.js`), not a generic
 * "other caches" bucket.
 *
 * **The request never supplies a path.** A delete names `<backend>/<key>`; the key
 * must match an item this module just scanned, and the paths removed are the ones
 * the scan recorded. A missing root is an empty store (0 bytes), never an error;
 * any other read failure rejects so the report marks the source unavailable
 * instead of reading it as empty and pruning the manifest.
 */

import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, relative, isAbsolute } from 'path';
import { dirSize, rmGuarded } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { MODEL_STORE_BACKENDS } from '../lib/modelInventory.js';
import { recordModelUninstall } from './modelManifest.js';

export const XET_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const XET_SEARCH_DEPTH = 3;
const SESSION_BANK = 'session-bank';

export const getMtplxRoot = () => process.env.MTPLX_HOME || join(homedir(), '.mtplx');
export const getHy3dgenRoot = () => process.env.HY3DGEN_MODELS || join(homedir(), '.cache', 'hy3dgen');
export const getPixieForgeRoot = () => process.env.PIXIE_FORGE_HOME || join(homedir(), '.pixie-forge');
export const getXetRoot = () => {
  if (process.env.HF_XET_CACHE) return process.env.HF_XET_CACHE;
  const hfHome = process.env.HF_HOME
    || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'huggingface');
  return join(hfHome, 'xet');
};

/** readdir that treats a missing root as an empty store and rethrows anything else. */
const readEntries = (dir) => readdir(dir, { withFileTypes: true }).catch((err) => {
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
  throw err;
});

// Symlinks are skipped on purpose (`isDirectory()` / `isFile()` are false for
// them): a link out of the store must never be sized or removed as if it were
// the store's own weights.
const subdirs = async (dir) => (await readEntries(dir))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name);

const item = ({ key, name, detail, size, root, removePaths, risk, cleanupReason }) => ({
  key, name, detail, size, root, removePaths, risk, cleanupReason,
});

async function scanMtplx() {
  const root = getMtplxRoot();
  const modelsDir = join(root, 'models');
  const items = [];
  for (const dirName of await subdirs(modelsDir)) {
    // Checkpoints are `<org>--<name>`; the key space is shared with the session
    // bank, so a directory that would collide with it is not a checkpoint.
    if (dirName === SESSION_BANK) continue;
    const path = join(modelsDir, dirName);
    items.push(item({
      key: dirName,
      name: dirName.replace('--', '/'),
      detail: 'MTPLX checkpoint',
      size: await dirSize(path, { strict: true }),
      root,
      removePaths: [path],
    }));
  }
  const bankDir = join(root, SESSION_BANK);
  const bankSize = await dirSize(bankDir, { strict: true });
  if (bankSize > 0) {
    items.push(item({
      key: SESSION_BANK,
      name: 'MTPLX session bank',
      detail: 'Session cache — cleared, not deleted',
      size: bankSize,
      root,
      removePaths: (await readEntries(bankDir)).map((entry) => join(bankDir, entry.name)),
      risk: 'low',
      cleanupReason: 'MTPLX rebuilds its session cache the next time it serves a prompt.',
    }));
  }
  return items;
}

async function scanHy3dgen() {
  const root = getHy3dgenRoot();
  const items = [];
  for (const dirName of await subdirs(root)) {
    const path = join(root, dirName);
    items.push(item({
      key: dirName,
      name: dirName,
      detail: 'Hunyuan3D weights',
      size: await dirSize(path, { strict: true }),
      root,
      removePaths: [path],
    }));
  }
  return items;
}

/** Every `chunk-cache` directory under the xet root, to a bounded depth. */
async function findChunkCaches(dir, depth = XET_SEARCH_DEPTH) {
  if (depth <= 0) return [];
  const found = [];
  for (const name of await subdirs(dir)) {
    const path = join(dir, name);
    if (name === 'chunk-cache') found.push(path);
    else found.push(...await findChunkCaches(path, depth - 1));
  }
  return found;
}

async function staleXetLogs(logsDir, now) {
  const logs = [];
  for (const entry of await readEntries(logsDir)) {
    if (!entry.isFile()) continue;
    const path = join(logsDir, entry.name);
    const info = await stat(path);
    if (now - info.mtimeMs > XET_LOG_RETENTION_MS) logs.push({ path, size: info.size });
  }
  return logs;
}

async function scanXetCache({ now = Date.now() } = {}) {
  const root = getXetRoot();
  const chunkCaches = await findChunkCaches(root);
  const chunkSizes = await Promise.all(chunkCaches.map((path) => dirSize(path, { strict: true })));
  const logs = await staleXetLogs(join(root, 'logs'), now);
  const size = chunkSizes.reduce((sum, bytes) => sum + bytes, 0) + logs.reduce((sum, log) => sum + log.size, 0);
  if (size <= 0) return [];
  return [item({
    key: 'chunk-cache',
    name: 'Hugging Face xet cache',
    detail: 'Download chunk cache + logs older than 7 days — cleared, not deleted',
    size,
    root,
    removePaths: [...chunkCaches, ...logs.map((log) => log.path)],
  })];
}

async function scanPixieForge() {
  const root = join(getPixieForgeRoot(), 'loras');
  const items = [];
  for (const entry of await readEntries(root)) {
    if (!entry.isFile() || !entry.name.endsWith('.safetensors')) continue;
    const path = join(root, entry.name);
    items.push(item({
      key: entry.name,
      name: entry.name.replace(/^lora-/, '').replace(/\.safetensors$/, ''),
      detail: 'Pixie Forge LoRA adapter',
      size: (await stat(path)).size,
      root,
      removePaths: [path],
    }));
  }
  return items;
}

const SCANNERS = {
  mtplx: scanMtplx,
  hy3dgen: scanHy3dgen,
  'hf-xet-cache': scanXetCache,
  'pixie-forge': scanPixieForge,
};

export const isModelStoreBackend = (backend) => Object.hasOwn(SCANNERS, backend);

/**
 * Scan one store. Rejects on an unreadable root; a missing root is `totalBytes: 0`.
 *
 * @param {string} backend One of `MODEL_STORE_BACKENDS`
 * @returns {Promise<{ items: Array<Object>, totalBytes: number }>}
 */
export async function listModelStore(backend) {
  if (!isModelStoreBackend(backend)) throw new ServerError('Unknown model store', { status: 400, code: 'VALIDATION_ERROR' });
  const items = (await SCANNERS[backend]()).sort((a, b) => b.size - a.size);
  return { items, totalBytes: items.reduce((sum, entry) => sum + entry.size, 0) };
}

/** A key is a single path segment; anything else is refused before any scan. */
export const isSafeModelStoreKey = (key) => typeof key === 'string'
  && key.length > 0
  && key !== '.'
  && !/[\\/\0]/.test(key)
  && !key.includes('..');

const isWithin = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Delete (or clear) one scanned item and drop its manifest entry.
 *
 * @returns {Promise<{ ok: true, freedBytes: number }>}
 */
export async function removeModelStoreItem(backend, key) {
  if (!isSafeModelStoreKey(key)) throw new ServerError('Invalid model store key', { status: 400, code: 'VALIDATION_ERROR' });
  const { items } = await listModelStore(backend);
  const target = items.find((entry) => entry.key === key);
  if (!target) throw new ServerError('Model not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🗑️ Removing ${MODEL_STORE_BACKENDS[backend].label} store item: ${key}`);
  for (const path of target.removePaths) {
    if (!isWithin(target.root, path)) throw new ServerError('Refusing to remove a path outside its model store', { status: 400, code: 'VALIDATION_ERROR' });
    await rmGuarded(path, { recursive: true, force: true });
  }
  await recordModelUninstall({ backend, key });
  return { ok: true, freedBytes: target.size };
}
