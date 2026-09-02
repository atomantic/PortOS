/**
 * What an SSD-streaming MoE runtime has on disk, and the memory plan PortOS
 * shows before a start.
 *
 * A start never downloads weights — an empty cache is reported rather than
 * silently filled. Listing is a local directory walk (no network, no model
 * load). `models: null` means the cache could NOT be read, which is
 * deliberately not the same as `[]` (read, and empty).
 */

import { readdir, stat } from 'fs/promises';
import { homedir, totalmem } from 'os';
import { join } from 'path';

/** Floor of the technique: a dense trunk plus a tiny expert pool still runs. */
export const SLOTSTREAM_MEMORY_FLOOR_GB = 6;

/** Measured ~12 tok/s warm decode at a 32 GB target on a 48 GB machine. */
const WARM_DECODE_REF_GB = 32;
const WARM_DECODE_REF_TOKS = 12;

const round1 = (n) => Math.round(n * 10) / 10;

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

/**
 * Cached checkpoints on disk.
 *
 * Each subdirectory of the cache is one checkpoint; the directory name is the
 * id handed to `slotstream serve --model`. No network.
 *
 * @param {{cacheDir?: string}} [options]
 * @returns {Promise<{models: object[]|null, error: string|null}>}
 */
export async function listSlotstreamCachedModels({ cacheDir } = {}) {
  const dir = cacheDir || slotstreamCacheDir();
  const entries = await readdir(dir).catch((err) => err);
  if (entries instanceof Error) {
    if (entries.code === 'ENOENT') return { models: [], error: null };
    return { models: null, error: `could not read Slotstream cache (${entries.code || entries.message})` };
  }

  const models = [];
  for (const name of entries) {
    const full = join(dir, name);
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue;
    models.push({ id: name, path: full });
  }
  return { models, error: null };
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
