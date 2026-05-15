/**
 * Share Bucket — manifest & cursor helpers.
 *
 * A manifest is one JSON file in `<bucket>/manifests/` per share action. It
 * names the records + assets bundled in that share, plus identifying
 * metadata (sender, source display name, timestamp). The cursor tracks which
 * manifest filenames the local PortOS has already processed so the watcher
 * doesn't replay them on restart.
 *
 * Manifest filename convention:
 *   <iso-ts>-<sender-id>-<manifest-id>.json
 *
 * Using an ISO-prefixed timestamp gives chokidar's lexicographic event order a
 * stable replay order if multiple manifests land in the same poll cycle.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';

export const MANIFEST_KIND = Object.freeze(['series', 'universe', 'media']);
export const MANIFEST_SCHEMA_VERSION = 1;

const isStr = (v) => typeof v === 'string';

const cursorPath = (bucketId) => join(PATHS.data, 'sharing', 'cursors', `${bucketId}.json`);

export async function readCursor(bucketId) {
  await ensureDir(join(PATHS.data, 'sharing', 'cursors'));
  return readJSONFile(cursorPath(bucketId), { processed: [] }, { logError: false });
}

export async function writeCursor(bucketId, cursor) {
  await ensureDir(join(PATHS.data, 'sharing', 'cursors'));
  await atomicWrite(cursorPath(bucketId), cursor);
}

/**
 * Mark a manifest filename as processed. Keeps the last 5000 entries — the
 * cursor file would otherwise grow unbounded if a single bucket lives for
 * years. 5000 is well past any sensible "is this duplicate?" lookback window
 * for a single user's collaborator group.
 */
export async function markProcessed(bucketId, manifestFilename) {
  const cursor = await readCursor(bucketId);
  if (cursor.processed.includes(manifestFilename)) return cursor;
  cursor.processed.push(manifestFilename);
  if (cursor.processed.length > 5000) {
    cursor.processed = cursor.processed.slice(-5000);
  }
  cursor.lastProcessedAt = new Date().toISOString();
  await writeCursor(bucketId, cursor);
  return cursor;
}

export function hasBeenProcessed(cursor, manifestFilename) {
  return Array.isArray(cursor?.processed) && cursor.processed.includes(manifestFilename);
}

/** Build a fresh manifest. Caller writes it after every record + asset is in place. */
export function buildManifest({ kind, senderInstanceId, source, sourceBio, recordIds, assetRefs, bucketId, bucketName, note }) {
  if (!MANIFEST_KIND.includes(kind)) throw new Error(`buildManifest: invalid kind '${kind}'`);
  return {
    id: randomUUID(),
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    kind,                              // 'series' | 'universe' | 'media'
    senderInstanceId: senderInstanceId || 'unknown',
    source: source || 'unknown',        // human display name
    sourceBio: sourceBio || null,
    bucketId,
    bucketName: bucketName || bucketId,
    recordIds: Array.isArray(recordIds) ? recordIds : [],
    assetRefs: Array.isArray(assetRefs) ? assetRefs : [],
    note: isStr(note) ? note.slice(0, 1000) : null,
  };
}

export function manifestFilename(manifest) {
  const ts = manifest.createdAt.replace(/[:.]/g, '-');
  const senderSlug = (manifest.source || manifest.senderInstanceId || 'unknown')
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    || 'unknown';
  return `${ts}-${senderSlug}-${manifest.id}.json`;
}

export async function writeManifest(bucketPath, manifest) {
  await ensureDir(join(bucketPath, 'manifests'));
  const filename = manifestFilename(manifest);
  await atomicWrite(join(bucketPath, 'manifests', filename), manifest);
  return filename;
}

export async function readManifest(bucketPath, filename) {
  return readJSONFile(join(bucketPath, 'manifests', filename), null, { logError: false });
}

/** List every manifest filename in a bucket, newest first by ISO-prefixed name. */
export async function listManifestFilenames(bucketPath) {
  const dir = join(bucketPath, 'manifests');
  const entries = await readdir(dir).catch(() => []);
  return entries.filter((f) => f.endsWith('.json')).sort().reverse();
}
