/**
 * Share Buckets — registry CRUD.
 *
 * A "bucket" is a local directory the user registers; PortOS reads/writes a
 * stable layout inside it (bucket.json + manifests/ + records/ + assets/),
 * while an external cloud-sync app (Google Drive, Dropbox, iCloud, Syncthing,
 * USB stick…) handles cross-network replication. PortOS is transport-agnostic.
 *
 * The registry itself lives in PortOS's local data/, NOT in the shared bucket —
 * otherwise every peer's settings would overwrite each other.
 */

import { randomUUID } from 'crypto';
import { join, basename } from 'path';
import { access, constants, stat } from 'fs/promises';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { SHARING_SCHEMA_VERSION } from './version.js';

const REGISTRY_PATH = () => join(PATHS.data, 'sharing', 'buckets.json');

export const BUCKET_MODES = Object.freeze(['auto-merge', 'inbox']);

export const NAME_MAX = 120;
export const PATH_MAX = 2000;
export const DISPLAY_NAME_MAX = 120;
export const BIO_MAX = 2000;

export const ERR_NOT_FOUND = 'SHARING_BUCKET_NOT_FOUND';
export const ERR_VALIDATION = 'SHARING_BUCKET_VALIDATION';
export const ERR_PATH_UNUSABLE = 'SHARING_BUCKET_PATH_UNUSABLE';

const makeErr = (message, code) => Object.assign(new Error(message), { code });

const sanitizeBucket = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, NAME_MAX);
  const path = trimTo(raw.path, PATH_MAX);
  if (!name || !path) return null;
  const mode = BUCKET_MODES.includes(raw.mode) ? raw.mode : 'inbox';
  const displayNameOverride = trimTo(raw.displayNameOverride, DISPLAY_NAME_MAX) || null;
  const bioOverride = trimTo(raw.bioOverride, BIO_MAX) || null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  return { id: raw.id, name, path, mode, displayNameOverride, bioOverride, createdAt, updatedAt };
};

async function readRegistry() {
  await ensureDir(join(PATHS.data, 'sharing'));
  const raw = await readJSONFile(REGISTRY_PATH(), { buckets: [] }, { logError: false });
  const buckets = Array.isArray(raw.buckets) ? raw.buckets.map(sanitizeBucket).filter(Boolean) : [];
  return { buckets };
}

async function writeRegistry(state) {
  await ensureDir(join(PATHS.data, 'sharing'));
  await atomicWrite(REGISTRY_PATH(), state);
}

/** Validate that the bucket path is a readable+writable directory. */
async function assertPathUsable(path) {
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    throw makeErr(`Bucket path does not exist or is unreadable: ${path}`, ERR_PATH_UNUSABLE);
  }
  if (!st.isDirectory()) {
    throw makeErr(`Bucket path is not a directory: ${path}`, ERR_PATH_UNUSABLE);
  }
  try {
    await access(path, constants.R_OK | constants.W_OK);
  } catch (err) {
    throw makeErr(`Bucket path is not writable: ${path}`, ERR_PATH_UNUSABLE);
  }
}

/**
 * Path helpers for the per-bucket content-addressed blob store. v2 manifests
 * (`SHARING_SCHEMA_VERSION >= 2`) reference assets via their SHA-256 hash;
 * blobs and their `.metadata.json` sidecars live alongside each other under
 * `assets/blobs/` so storage-layout changes only touch this file.
 *
 * Hashes from manifests are UNTRUSTED — a hostile peer could ship
 * `hash: '../../../../etc/hosts'` to traverse out of the blob dir on import.
 * `isHexHash` enforces the SHA-256 shape (64 lowercase hex chars) so
 * `bucketBlobPath(...)` can never produce a path outside `assets/blobs/`.
 * The path helpers throw on bad input; the importer also drops bad refs at
 * the manifest boundary so a single broken entry doesn't poison a batch.
 */
export const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const HEX_HASH_RE = /^[0-9a-f]{64}$/;
export function isHexHash(v) { return typeof v === 'string' && HEX_HASH_RE.test(v); }
export function bucketBlobsDir(bucketPath) { return join(bucketPath, 'assets', 'blobs'); }
export function bucketBlobPath(bucketPath, hash) {
  if (!isHexHash(hash)) throw makeErr(`Invalid asset hash: ${hash}`, ERR_VALIDATION);
  return join(bucketBlobsDir(bucketPath), hash);
}
export function bucketBlobSidecarPath(bucketPath, hash) {
  if (!isHexHash(hash)) throw makeErr(`Invalid asset hash: ${hash}`, ERR_VALIDATION);
  return join(bucketBlobsDir(bucketPath), `${hash}.metadata.json`);
}
// Sidecar mapping `<sourcePath>:<mtimeMs>:<size> → <hash>` so the exporter can
// skip `sha256File` + `copyFile` on re-export of unchanged assets.
export function bucketBlobIndexPath(bucketPath) { return join(bucketBlobsDir(bucketPath), '.index.json'); }
export function imageSidecarName(filename) { return filename.replace(IMAGE_EXT_RE, '') + '.metadata.json'; }

/**
 * Returns the filename if it's safe to use as a path segment under an asset
 * directory, otherwise null. Rejects path separators, parent-directory
 * tokens, and any value that doesn't match its own basename — the canonical
 * traversal guard for inbound/peer-supplied asset filenames before they hit a
 * `join(dir, name)` FS op. Shared by the peer-sync diff/pull paths
 * (`peerSync.js`, `sidecarSync.js`) so every callsite scrubs identically.
 */
export function sanitizeAssetFilename(name) {
  if (typeof name !== 'string' || !name) return null;
  // Reject separators and exact parent-directory segments (`.` / `..`
  // as the whole basename). A basename like `my..render.png` is
  // legitimate (the gallery filename validator permits `..` inside a
  // basename) — only the path-segment forms are traversal.
  if (name.includes('/') || name.includes('\\')) return null;
  if (name === '.' || name === '..') return null;
  if (basename(name) !== name) return null;
  return name;
}

/** Lay out the canonical bucket structure (idempotent). */
export async function ensureBucketLayout(bucket) {
  const base = bucket.path;
  await ensureDir(base);
  await ensureDir(join(base, 'manifests'));
  await ensureDir(join(base, 'records', 'series'));
  await ensureDir(join(base, 'records', 'issues'));
  await ensureDir(join(base, 'records', 'universes'));
  await ensureDir(join(base, 'records', 'media'));
  await ensureDir(join(base, 'assets', 'images'));
  await ensureDir(join(base, 'assets', 'videos'));
  await ensureDir(join(base, 'assets', 'blobs'));
  const bucketJsonPath = join(base, 'bucket.json');
  const existing = await readJSONFile(bucketJsonPath, null, { logError: false });
  if (!existing) {
    // bucket.json is the shared identity. Stamp the schema version at
    // creation time so peers can tell at a glance which protocol the bucket
    // is operating under. We do NOT bump an existing peer's bucket.json
    // unprompted — if it's there, leave it (the peer's writer follows its
    // local SHARING_SCHEMA_VERSION; the importer compares per-manifest).
    await atomicWrite(bucketJsonPath, {
      id: bucket.id,
      name: bucket.name,
      schemaVersion: SHARING_SCHEMA_VERSION,
      sharingSchemaVersion: SHARING_SCHEMA_VERSION,
      createdAt: bucket.createdAt,
    });
  }
}

/** Read the on-disk bucket.json so routes/UI can report producedBy + schema info. */
export async function readBucketJson(bucket) {
  const bucketJsonPath = join(bucket.path, 'bucket.json');
  return readJSONFile(bucketJsonPath, null, { logError: false });
}

export async function listBuckets() {
  const { buckets } = await readRegistry();
  return [...buckets].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function getBucket(id) {
  const { buckets } = await readRegistry();
  const found = buckets.find((b) => b.id === id);
  if (!found) throw makeErr(`Bucket not found: ${id}`, ERR_NOT_FOUND);
  return found;
}

export async function createBucket(input = {}) {
  const name = trimTo(input.name, NAME_MAX);
  if (!name) throw makeErr(`Bucket name is required (1..${NAME_MAX} chars)`, ERR_VALIDATION);
  const path = trimTo(input.path, PATH_MAX);
  if (!path) throw makeErr('Bucket path is required', ERR_VALIDATION);
  await assertPathUsable(path);
  const state = await readRegistry();
  // Reject duplicate paths so two registry entries can't both attempt to
  // claim the same on-disk folder (they would fight over bucket.json + the
  // watcher would double-fire on every manifest).
  if (state.buckets.some((b) => b.path === path)) {
    throw makeErr(`A bucket is already registered at: ${path}`, ERR_VALIDATION);
  }
  const now = new Date().toISOString();
  const bucket = sanitizeBucket({
    id: `bkt-${randomUUID()}`,
    name,
    path,
    mode: input.mode || 'inbox',
    displayNameOverride: input.displayNameOverride || null,
    bioOverride: input.bioOverride || null,
    createdAt: now,
    updatedAt: now,
  });
  state.buckets.push(bucket);
  await writeRegistry(state);
  await ensureBucketLayout(bucket);
  return bucket;
}

export async function updateBucket(id, patch = {}) {
  const state = await readRegistry();
  const idx = state.buckets.findIndex((b) => b.id === id);
  if (idx < 0) throw makeErr(`Bucket not found: ${id}`, ERR_NOT_FOUND);
  const cur = state.buckets[idx];
  const merged = sanitizeBucket({
    ...cur,
    ...('name' in patch ? { name: patch.name } : {}),
    ...('mode' in patch ? { mode: patch.mode } : {}),
    ...('displayNameOverride' in patch ? { displayNameOverride: patch.displayNameOverride } : {}),
    ...('bioOverride' in patch ? { bioOverride: patch.bioOverride } : {}),
    updatedAt: new Date().toISOString(),
  });
  if (!merged) throw makeErr('Invalid bucket payload', ERR_VALIDATION);
  // `path` is intentionally NOT patchable — if the user wants to move a
  // bucket, they delete and re-register so the registry can re-validate and
  // re-layout the new path.
  state.buckets[idx] = merged;
  await writeRegistry(state);
  return merged;
}

export async function deleteBucket(id) {
  const state = await readRegistry();
  const before = state.buckets.length;
  state.buckets = state.buckets.filter((b) => b.id !== id);
  if (state.buckets.length === before) throw makeErr(`Bucket not found: ${id}`, ERR_NOT_FOUND);
  await writeRegistry(state);
  return { id };
}

