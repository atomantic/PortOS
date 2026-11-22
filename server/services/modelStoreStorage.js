/**
 * File-system model stores outside the Hugging Face hub cache and `data/loras/`.
 *
 * Every root declared in `lib/modelRoots.js` other than the hub cache is scanned
 * here: MTPLX checkpoints and its session bank, Hunyuan3D weights, the Hugging Face
 * xet download-chunk cache, Pixie Forge LoRAs, Slotstream checkpoints, converted
 * FastVideo MLX checkpoints, AuK voice checkpoints, a retired runtime's leftovers,
 * and the two hand-placed directories (`~/.portos/models` and the checkout's
 * `models/`). Each is a first-class inventory backend (`lib/modelInventory.js`),
 * not a generic "other caches" bucket.
 *
 * **Unmanaged weights.** A hand-placed directory is not a layout PortOS writes, so
 * any entry in it holding a weight file of 1 GiB or more is flagged `unmanaged`:
 * reported and deletable through the same guarded path, never moved automatically.
 *
 * **The request never supplies a path.** A delete names `<backend>/<key>`; the key
 * must match an item this module just scanned, and the paths removed are the ones
 * the scan recorded. A missing root is an empty store (0 bytes), never an error;
 * any other read failure rejects so the report marks the source unavailable
 * instead of reading it as empty and pruning the manifest.
 */

import { lstat, readFile, readdir, readlink, stat } from 'fs/promises';
import { basename, dirname, join, relative, isAbsolute, resolve } from 'path';
import { dirSize, rmGuarded } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { MODEL_STORE_BACKENDS } from '../lib/modelInventory.js';
import { recordModelUninstall } from './modelManifest.js';

export const XET_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const XET_SEARCH_DEPTH = 3;
const SESSION_BANK = 'session-bank';
export const UNMANAGED_WEIGHT_MIN_BYTES = 1024 ** 3;
const WEIGHT_FILE = /\.(safetensors|gguf|bin|pt)$/i;
const WEIGHT_WALK_DEPTH = 4;

// Every root path lives in the registry (`lib/modelRoots.js`). It loads on the first
// scan, not at module load: scanning is a rare, user-triggered path, and a static
// import would add the registry to every boot (the closure budget in
// `lib/importScoping.test.js`).
const rootPath = async (id) => (await import('../lib/modelRoots.js')).modelRootPath(id);
const rootFor = async (backend) => (await import('../lib/modelRoots.js')).modelRootForBackend(backend);

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

/** True only for a real directory — a symlink named like a store subdirectory is not one. */
const isRealDirectory = (path) => lstat(path).then(
  (info) => info.isDirectory(),
  (err) => {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
    throw err;
  },
);

const item = ({ key, name, detail, size, root, removePaths, risk, cleanupReason, unmanaged, sourcePrune = null }) => ({
  key, name, detail, size, root, removePaths, risk, cleanupReason, unmanaged,
  ...(sourcePrune ? { sourcePrune } : {}),
});

/** Shown on a converted checkpoint whose source the runtime does not read. */
const SOURCE_PRUNE_PHRASE = 'source weights (re-downloadable; needed only to re-convert)';
const PRUNABLE_SOURCE_NAMES = new Set(['transformer', 'transformer_ref']);

async function readSourceSidecar(dir) {
  const raw = await readFile(join(dir, 'portos-source.json'), 'utf8').catch((err) => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

const sourceRevisionLabel = (revision) => (
  typeof revision === 'string' && /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 8) : null
);

/**
 * FastVideo records the hub snapshot it converted. The row names that source
 * and offers prune only while the weights directory is still there. AuK is
 * not this path: the runtime reads those source directories at start.
 */
async function annotateFastvideoSources(items) {
  for (const entry of items) {
    const doc = await readSourceSidecar(join(entry.root, entry.key));
    if (!doc) continue;
    const repo = typeof doc.sourceRepo === 'string' && doc.sourceRepo ? doc.sourceRepo : null;
    const rev = sourceRevisionLabel(doc.sourceRevision);
    const sourceLabel = repo ? `${repo}${rev ? `@${rev}` : ''}` : null;
    entry.detail = [entry.detail, sourceLabel, SOURCE_PRUNE_PHRASE].filter(Boolean).join(' · ');
    const weights = typeof doc.sourceWeights === 'string' ? doc.sourceWeights : '';
    const { getHfCacheRoot } = await import('../lib/hfCache.js');
    const insideHub = weights ? resolvedWithin(getHfCacheRoot(), weights) : null;
    const present = insideHub && PRUNABLE_SOURCE_NAMES.has(basename(insideHub))
      ? await stat(insideHub).then((info) => info.isDirectory(), () => false)
      : false;
    if (doc.prunable === true && present) {
      entry.sourcePrune = { backend: 'fastvideo-mlx', key: entry.key };
    }
  }
  return items;
}

/**
 * AuK source directories are what the runtime opens (`config.yaml` and the
 * Qwen preprocessor). Name the repo; never offer prune, even if a sidecar
 * claims the directory is disposable.
 */
async function annotateAukSources(items) {
  const { AUK_WEIGHT_SOURCES } = await import('./voice/aukRuntime.js');
  const byDir = new Map(AUK_WEIGHT_SOURCES.map((row) => [row.directory, row]));
  const repos = AUK_WEIGHT_SOURCES.map((row) => row.repo).join(', ');
  for (const entry of items) {
    const source = byDir.get(entry.key);
    if (source) {
      entry.detail = `${entry.detail} · ${source.repo} · the AuK runtime reads these weights`;
    } else if (entry.key === 'mlx') {
      entry.detail = `${entry.detail} · converted from ${repos}`;
    }
  }
  return items;
}

const NO_WEIGHTS = { count: 0, bytes: 0 };

/**
 * Weight files of at least `UNMANAGED_WEIGHT_MIN_BYTES` under `path`, to a bounded
 * depth. Symlinks and dot-entries are skipped: a link must never be counted as
 * the store's own weights, and `.cache` dirs hold download bookkeeping, not weights.
 */
async function largeWeights(path, depth = WEIGHT_WALK_DEPTH) {
  const info = await lstat(path);
  if (info.isFile()) {
    return WEIGHT_FILE.test(path) && info.size >= UNMANAGED_WEIGHT_MIN_BYTES ? { count: 1, bytes: info.size } : NO_WEIGHTS;
  }
  if (!info.isDirectory() || depth <= 0) return NO_WEIGHTS;
  let count = 0;
  let bytes = 0;
  for (const entry of await readEntries(path)) {
    if (entry.name.startsWith('.')) continue;
    const found = await largeWeights(join(path, entry.name), depth - 1);
    count += found.count;
    bytes += found.bytes;
  }
  return { count, bytes };
}

/**
 * One item per top-level entry of a declared root: a directory, or (`files`) a
 * loose weight file. A root PortOS does not manage flags entries holding large
 * weights as unmanaged, except the names `ownedNames` returns (a layout PortOS
 * itself writes inside an otherwise hand-placed directory). A missing root is an
 * empty store.
 */
async function scanRootEntries(backend, { detail, files = false, ownedNames = null }) {
  const { path: root, managed } = await rootFor(backend);
  const items = [];
  if (!await isRealDirectory(root)) return items;
  const owned = ownedNames ? await ownedNames() : new Set();
  for (const entry of await readEntries(root)) {
    if (entry.name.startsWith('.')) continue;
    const isDir = entry.isDirectory();
    if (!isDir && !(files && entry.isFile() && WEIGHT_FILE.test(entry.name))) continue;
    const path = join(root, entry.name);
    const presetOwned = owned.has(entry.name);
    const weights = managed || presetOwned ? NO_WEIGHTS : await largeWeights(path);
    const unmanaged = weights.count > 0;
    items.push(item({
      key: entry.name,
      name: entry.name,
      detail: presetOwned ? 'llama-server preset weights' : unmanaged
        ? `${detail} · ${weights.count} weight file${weights.count === 1 ? '' : 's'} of 1 GiB or more outside the Hugging Face cache`
        : detail,
      size: isDir ? await dirSize(path, { strict: true }) : (await stat(path)).size,
      root,
      removePaths: [path],
      unmanaged,
    }));
  }
  return items;
}

// Models → Runtimes downloads a preset's weights to `models/<file>` relative to the
// checkout (`lib/specDecodePresets.js`), so those files are a layout PortOS writes.
async function presetModelFileNames() {
  const { SPEC_DECODE_PRESETS, SPEC_MODEL_ROLES } = await import('../lib/specDecodePresets.js');
  const names = new Set();
  for (const preset of SPEC_DECODE_PRESETS) {
    for (const role of SPEC_MODEL_ROLES) {
      const path = preset[role]?.path;
      if (typeof path === 'string' && path.startsWith('models/')) names.add(path.slice('models/'.length).split('/')[0]);
    }
  }
  return names;
}

// The retired HunyuanVideo MLX runtime (migration 315) was never migrated off
// disk. The whole checkout is one item: nothing reads it, and its snapshot links
// into the hub cache dangle once those weights are gone.
async function scanLegacyRuntime() {
  const { path: dir } = await rootFor('legacy-runtime');
  if (!await isRealDirectory(dir)) return [];
  return [item({
    key: 'hunyuan-video-mlx',
    name: 'HunyuanVideo MLX runtime',
    detail: 'Retired runtime: checkout, venv and text encoders',
    size: await dirSize(dir, { strict: true }),
    root: dirname(dir),
    removePaths: [dir],
  })];
}

async function scanMtplx() {
  const root = await rootPath('mtplx');
  const modelsDir = join(root, 'models');
  const items = [];
  for (const dirName of await isRealDirectory(modelsDir) ? await subdirs(modelsDir) : []) {
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
  const bankSize = await isRealDirectory(bankDir) ? await dirSize(bankDir, { strict: true }) : 0;
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
  const root = await rootPath('hy3dgen');
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

/** Every xet chunk-cache directory under the xet root, to a bounded depth. */
async function findChunkCaches(dir, depth = XET_SEARCH_DEPTH) {
  if (depth <= 0) return [];
  const found = [];
  for (const name of await subdirs(dir)) {
    const path = join(dir, name);
    // The Hugging Face xet client writes `chunk_cache`; `chunk-cache` is accepted too.
    if (name === 'chunk_cache' || name === 'chunk-cache') found.push(path);
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
  const root = await rootPath('hf-xet-cache');
  const chunkCaches = await findChunkCaches(root);
  const chunkSizes = await Promise.all(chunkCaches.map((path) => dirSize(path, { strict: true })));
  const logsDir = join(root, 'logs');
  const logs = await isRealDirectory(logsDir) ? await staleXetLogs(logsDir, now) : [];
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
  const root = join(await rootPath('pixie-forge'), 'loras');
  const items = [];
  for (const entry of await isRealDirectory(root) ? await readEntries(root) : []) {
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
  slotstream: () => scanRootEntries('slotstream', { detail: 'Slotstream checkpoint' }),
  'fastvideo-mlx': async () => annotateFastvideoSources(await scanRootEntries('fastvideo-mlx', { detail: 'Converted MLX checkpoint, rebuilt from the hub weights on the next render' })),
  'auk-ckpts': async () => annotateAukSources(await scanRootEntries('auk-ckpts', { detail: 'AuK voice runtime checkpoint' })),
  'portos-models': () => scanRootEntries('portos-models', { detail: 'Hand-placed model weights', files: true }),
  'repo-models': () => scanRootEntries('repo-models', { detail: 'Hand-placed model weights in the checkout', files: true, ownedNames: presetModelFileNames }),
  'legacy-runtime': scanLegacyRuntime,
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

const resolvedWithin = (root, target) => {
  const base = resolve(root);
  const candidate = resolve(target);
  const rel = relative(base, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? candidate : null;
};

/** Repo directory (`models--…`) that contains `weights`, or null. */
function repoDirOf(hubRoot, weights) {
  let current = weights;
  const hub = resolve(hubRoot);
  while (current.startsWith(hub) && current !== hub) {
    if (basename(current).startsWith('models--')) return current;
    current = dirname(current);
  }
  return null;
}

async function symlinkTargets(dir, accept) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await readlink(path).catch(() => null);
      if (!link) continue;
      const abs = resolve(dirname(path), link);
      if (accept(abs)) found.push(abs);
    } else if (entry.isDirectory()) {
      found.push(...await symlinkTargets(path, accept));
    }
  }
  return found;
}

async function stillLinked(dir, target) {
  const wanted = await stat(target).then(() => resolve(target), () => null);
  if (!wanted) return false;
  const links = await symlinkTargets(dir, (abs) => resolve(abs) === wanted);
  return links.length > 0;
}

/**
 * Delete one converted checkpoint's source weights.
 *
 * Only FastVideo. The path comes from the sidecar this scan recorded, and it
 * must be a `transformer` or `transformer_ref` directory inside the hub cache.
 * The converted checkpoint is not touched. A symlink is removed as a link.
 * Blobs that snapshot links point at are removed only when nothing else in
 * that repo still links them.
 *
 * @returns {Promise<{ ok: true, freedBytes: number }>}
 */
export async function pruneConvertedSource(backend, key) {
  if (backend !== 'fastvideo-mlx') {
    throw new ServerError('This checkpoint source is not prunable — the runtime reads it.', { status: 409, code: 'SOURCE_NOT_PRUNABLE' });
  }
  if (!isSafeModelStoreKey(key)) throw new ServerError('Invalid model store key', { status: 400, code: 'VALIDATION_ERROR' });
  const { path: root } = await rootFor(backend);
  const checkpoint = join(root, key);
  const doc = await readSourceSidecar(checkpoint);
  if (!doc) throw new ServerError('Converted checkpoint has no recorded source', { status: 404, code: 'NOT_FOUND' });
  if (doc.prunable !== true) {
    throw new ServerError('This checkpoint source is not prunable — the runtime reads it.', { status: 409, code: 'SOURCE_NOT_PRUNABLE' });
  }
  const { getHfCacheRoot, listLinkedSharedBlobs, releaseSharedBlobs } = await import('../lib/hfCache.js');
  const hub = getHfCacheRoot();
  const weights = typeof doc.sourceWeights === 'string' ? resolvedWithin(hub, doc.sourceWeights) : null;
  if (!weights || !PRUNABLE_SOURCE_NAMES.has(basename(weights))) {
    throw new ServerError('Recorded source is not a prunable transformer directory in the hub cache', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const info = await lstat(weights).catch(() => null);
  if (!info) return { ok: true, freedBytes: 0 };
  const repoDir = repoDirOf(hub, weights);
  const repoName = repoDir ? basename(repoDir) : null;
  const shared = repoName ? await listLinkedSharedBlobs(hub, repoName).catch(() => new Map()) : new Map();
  const localBlobs = info.isSymbolicLink() || !info.isDirectory()
    ? []
    : await symlinkTargets(weights, (abs) => repoDir && resolvedWithin(join(repoDir, 'blobs'), abs));
  let freed = 0;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    freed = await dirSize(weights).catch(() => 0);
  }
  console.log(`🗑️ Pruning converted-checkpoint source: fastvideo-mlx/${key}`);
  await rmGuarded(weights, { recursive: !info.isSymbolicLink(), force: true });
  if (repoDir) {
    for (const blob of localBlobs) {
      if (await stillLinked(repoDir, blob)) continue;
      const blobInfo = await stat(blob).catch(() => null);
      await rmGuarded(blob, { force: true });
      if (blobInfo?.isFile()) freed += blobInfo.size;
    }
  }
  if (shared.size) {
    const released = await releaseSharedBlobs(hub, shared);
    freed += released.freedBytes;
  }
  return { ok: true, freedBytes: freed };
}
