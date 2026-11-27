/**
 * What an SSD-streaming MoE runtime has on disk, and the memory plan PortOS
 * shows before a start.
 *
 * A start never downloads weights — an empty cache is reported rather than
 * silently filled. Listing is a local directory walk (no network, no model
 * load). `models: null` means the cache could NOT be read, which is
 * deliberately not the same as `[]` (read, and empty).
 */

import { lstat, readdir, readFile, stat } from 'fs/promises';
import { homedir, totalmem } from 'os';
import { join } from 'path';

/** Floor of the technique: a dense trunk plus a tiny expert pool still runs. */
export const SLOTSTREAM_MEMORY_FLOOR_GB = 6;

/** Measured ~12 tok/s warm decode at a 32 GB target on a 48 GB machine. */
const WARM_DECODE_REF_GB = 32;
const WARM_DECODE_REF_TOKS = 12;

const round1 = (n) => Math.round(n * 10) / 10;

export const SLOTSTREAM_CACHE_DISPLAY = '~/.slotstream/models';

// A removal takes the literal cache entry name, not a Hub repo or a path.
export const isSlotstreamCheckpointId = (id) =>
  typeof id === 'string' && id.length > 0 && id.length <= 255 &&
  id !== '.' && id !== '..' && (process.platform !== 'win32' || !/[. ]$/.test(id)) && !/[\\/:\0]/.test(id);

/**
 * Default on-disk cache. Override with `SLOTSTREAM_MODEL_DIR` or the `cacheDir`
 * test seam — never invent a second location in the manager.
 */
export function slotstreamCacheDir() {
  return process.env.SLOTSTREAM_MODEL_DIR || join(homedir(), '.slotstream', 'models');
}

/** Where a GitHub-release install drops the `slotstream` binary. */
export function slotstreamBinDir() {
  return join(homedir(), '.slotstream', 'bin');
}

/**
 * Auto-size the expert-cache target from host RAM, or honour an explicit cap.
 *
 * Cache size trades speed against memory and never changes output. The default
 * leaves headroom so the rest of PortOS is not paged out; an override skips
 * that check (the user asked for a specific cap).
 *
 * @param {{totalBytes?: number, overrideGb?: number|null}} [options]
 * @returns {{totalRamGb: number, targetGb: number, expectedPeakGb: number, expectedWarmDecodeToks: number, auto: boolean}}
 */
export function planSlotstreamMemory({ totalBytes, overrideGb } = {}) {
  const totalRamGb = (Number.isFinite(totalBytes) ? totalBytes : totalmem()) / (1024 ** 3);
  const autoTarget = Math.max(
    SLOTSTREAM_MEMORY_FLOOR_GB,
    Math.min(totalRamGb * 0.67, Math.max(SLOTSTREAM_MEMORY_FLOOR_GB, totalRamGb - 8)),
  );
  const parsed = Number(overrideGb);
  const hasOverride = Number.isFinite(parsed) && parsed > 0;
  const targetGb = hasOverride ? Math.max(SLOTSTREAM_MEMORY_FLOOR_GB, parsed) : autoTarget;
  return {
    totalRamGb: round1(totalRamGb),
    targetGb: round1(targetGb),
    expectedPeakGb: round1(targetGb),
    expectedWarmDecodeToks: Math.max(1, Math.round(WARM_DECODE_REF_TOKS * (targetGb / WARM_DECODE_REF_GB))),
    auto: !hasOverride,
  };
}

/** Persists across failed transfers, cancellation, restart, and partial-file GC. */
export const SLOTSTREAM_INCOMPLETE_MARKER = '.portos-download-incomplete';

/** Local structural admission, also used before a downloader clears its marker. */
export async function isServableCheckpoint(dir, { ignoreIncomplete = false } = {}) {
  const entries = await readdir(dir).catch(() => null);
  if (!entries || (!ignoreIncomplete && entries.includes(SLOTSTREAM_INCOMPLETE_MARKER))) return false;
  if (entries.some((name) => name.endsWith('.partial') || name.endsWith('.partial.etag'))) return false;
  const nonemptyFile = async (name) => {
    const info = await stat(join(dir, name)).catch(() => null);
    return Boolean(info?.isFile() && info.size > 0);
  };
  if (!(await nonemptyFile('config.json'))) return false;
  const weights = entries.filter((name) => name.endsWith('.safetensors'));
  const indexes = entries.filter((name) => name.endsWith('.safetensors.index.json'));
  if (!weights.length && !indexes.length) return false;
  for (const name of weights) if (!(await nonemptyFile(name))) return false;
  for (const name of indexes) {
    const index = await readFile(join(dir, name), 'utf8').then(JSON.parse).catch(() => null);
    const map = index?.weight_map;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    const shards = Object.values(map);
    if (!shards.length) return false;
    for (const shard of new Set(shards)) {
      // Index values are data: only checkpoint-relative safetensors paths qualify.
      if (typeof shard !== 'string' || !shard.endsWith('.safetensors') ||
          /^[/\\]/.test(shard) || shard.split(/[/\\]/).some((part) => !part || part === '..' || part === '.') ||
          !(await nonemptyFile(shard))) return false;
    }
  }
  return true;
}

// Follow the checkpoint link and linked weight files (Hub snapshots store
// their shards as links), but do not walk linked subdirectories.
async function checkpointSize(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const info = await stat(join(entry.parentPath, entry.name));
    if (info.isFile()) bytes += info.size;
  }
  return bytes;
}

/**
 * Servable checkpoints are launch candidates. Status can also request cache
 * rows for unfinished downloads so interrupted transfers can be removed.
 */
export async function listSlotstreamCachedModels({ cacheDir, includeRows = false } = {}) {
  const dir = cacheDir || slotstreamCacheDir();
  const entries = await readdir(dir).catch((err) => err);
  const rows = [];
  const result = (models, error = null) => ({ models, error, ...(includeRows ? { rows } : {}) });
  if (entries instanceof Error) {
    if (entries.code === 'ENOENT') return result([]);
    return result(null, 'could not read Slotstream cache');
  }

  const models = [];
  for (const name of entries) {
    const full = join(dir, name);
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue;
    const servable = await isServableCheckpoint(full);
    if (servable) models.push({ id: name, path: full });
    if (!includeRows || !isSlotstreamCheckpointId(name)) continue;
    const incomplete = !servable && await lstat(join(full, SLOTSTREAM_INCOMPLETE_MARKER)).catch(() => null);
    if (!servable && !incomplete) continue;
    const entry = await lstat(full).catch(() => null);
    if (!entry) continue;
    const sizeBytes = await checkpointSize(full).catch(() => null);
    rows.push({ id: name, sizeBytes, linked: entry.isSymbolicLink() });
  }
  return result(models);
}

/**
 * The checkpoint id a start should hand `--model`, or null when nothing is
 * servable. Prefers an explicit request; otherwise the first cached directory.
 *
 * @param {object[]|null|undefined} models
 * @param {string|null} [requested]
 * @returns {string|null}
 */
export function pickSlotstreamCachedModel(models, requested = null) {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  if (!Array.isArray(models) || models.length === 0) return null;
  const first = models.find((row) => typeof row?.id === 'string' && row.id);
  return first?.id ?? null;
}
