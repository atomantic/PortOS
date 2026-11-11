import { createHash } from 'node:crypto';
import { readFile, readdir, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { atomicWrite, PATHS, rmGuarded } from '../lib/fileUtils.js';

/**
 * Verified Codex rollout projections, one gzip file per source: counters, hashed
 * identity, model and cwd, keyed by a hash of the source path. `ephemeral-file` in
 * docs/STORAGE.md: machine-local, never synced, excluded from backup by `/cache/`.
 * Loss or damage only means a cold rescan, so every failure here reads as a miss.
 * One file per source lets the API server and the backfill worker thread share it
 * through atomic renames, and lets a pass load one session at a time.
 */
// Bump when the projection in codexUsageSources changes; another version reads as cold.
const FORMAT_VERSION = 4;
// Counts small files at their on-disk block size, so the cap also bounds file count.
const MIN_ENTRY_BYTES = 4096;
const SWEEP_FRACTION = 16;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const storeDir = () => join(PATHS.data, 'cache', 'codex-usage-inventory');
const entryPath = sourceKey => join(storeDir(), `${sourceKey}.json.gz`);

// Infinity sweeps once per process, bounding what an earlier run left behind.
let unsweptBytes = Infinity;
let warned = false;
// Error codes only: a filesystem error's message names the private path.
const warnOnce = (action, error) => {
  if (warned) return;
  warned = true;
  console.warn(`⚠️ Codex inventory cache ${action} failed (${error.code ?? 'unknown'}); affected sources stay cold`);
};

export function fingerprintRecords(records) {
  const digest = createHash('sha256');
  for (const record of records) digest.update(`${JSON.stringify(record)}\n`);
  return digest.digest('hex');
}

/** The stored projection of exactly this source revision, or null for anything else. */
export async function readInventorySource(sourceKey, revision) {
  const bytes = await readFile(entryPath(sourceKey)).catch(() => null);
  if (!bytes) return null;
  const stored = await gunzipAsync(bytes).then(text => JSON.parse(text), () => null);
  const valid = stored?.version === FORMAT_VERSION && stored.source === sourceKey && stored.revision === revision
    && typeof stored.id === 'string' && (stored.cwd === null || typeof stored.cwd === 'string')
    && Array.isArray(stored.records) && fingerprintRecords(stored.records) === stored.fingerprint;
  return valid ? stored : null;
}

/** Resolves false when the projection could not be stored; the caller keeps it in memory. */
export async function writeInventorySource(sourceKey, { revision, id, cwd, fingerprint, records, sourceMtimeMs }) {
  try {
    const bytes = await gzipAsync(JSON.stringify({ version: FORMAT_VERSION, source: sourceKey, revision, id, cwd, fingerprint, records }));
    await atomicWrite(entryPath(sourceKey), bytes);
    // Ordered by the source's age, so the sweep keeps what recent windows read.
    const seconds = sourceMtimeMs / 1000;
    await utimes(entryPath(sourceKey), seconds, seconds);
    unsweptBytes += bytes.length;
    return true;
  } catch (error) {
    warnOnce('write', error);
    return false;
  }
}

/** Removes the oldest sources' entries once the store exceeds its byte cap. */
export async function trimInventoryCache(maxBytes) {
  if (unsweptBytes < maxBytes / SWEEP_FRACTION) return;
  unsweptBytes = 0;
  const dir = storeDir();
  const names = await readdir(dir).catch(() => []);
  const entries = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info) entries.push({ name, bytes: Math.max(info.size, MIN_ENTRY_BYTES), mtimeMs: info.mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let kept = 0;
  for (const { name, bytes } of entries) {
    kept += bytes;
    if (kept > maxBytes) await rmGuarded(join(dir, name), { force: true }).catch(error => warnOnce('trim', error));
  }
}
