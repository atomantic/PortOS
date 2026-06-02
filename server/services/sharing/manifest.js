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
import { readdir, rename } from 'fs/promises';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { isPlainObject } from '../../lib/objects.js';
import { SHARING_SCHEMA_VERSION, getProducedByVersion } from './version.js';
import { isStr } from '../../lib/storyBible.js';
import { universeCollectionNameFor, seriesCollectionNameFor } from '../mediaCollections.js';
import { UNKNOWN_INSTANCE_ID } from '../instances.js';

export const MANIFEST_KIND = Object.freeze(['series', 'universe', 'media', 'media-annotations']);

/** Deterministic filename for an instance's annotation manifest in a bucket.
 *  One file per (bucket, instanceId) — re-exports overwrite in place so peers
 *  see updates via chokidar `change` events, same pattern as subscriptions. */
export function annotationManifestFilename(senderInstanceId) {
  const safeId = String(senderInstanceId || UNKNOWN_INSTANCE_ID).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return `annotations-${safeId}.json`;
}

/** @deprecated Use SHARING_SCHEMA_VERSION from ./version.js. Kept exported for back-compat. */
export const MANIFEST_SCHEMA_VERSION = SHARING_SCHEMA_VERSION;

const cursorPath = (bucketId) => join(PATHS.data, 'sharing', 'cursors', `${bucketId}.json`);

/**
 * Cursor shape:
 *   {
 *     processedById: { '<filename>': '<lastSeenManifestId>' },
 *     processed: ['<filename>', ...],            // legacy: pre-content-aware cursor entries
 *     lastProcessedAt: ISO
 *   }
 *
 * The `processedById` map is the content-aware path used for subscription
 * manifests: a fresh `manifestId` inside the same filename means the file's
 * contents changed (the subscription re-exported) and we need to re-import.
 * Legacy `processed[]` entries from buckets created on v1.0..v1.2 still
 * suppress re-import — those were one-shot manifests with random filenames,
 * so they're never going to be re-processed by content anyway.
 */
export async function readCursor(bucketId) {
  await ensureDir(join(PATHS.data, 'sharing', 'cursors'));
  const raw = await readJSONFile(cursorPath(bucketId), { processedById: {}, processed: [] }, { logError: false });
  return {
    processedById: (raw.processedById && typeof raw.processedById === 'object') ? raw.processedById : {},
    processed: Array.isArray(raw.processed) ? raw.processed : [],
    lastProcessedAt: raw.lastProcessedAt || null,
  };
}

export async function writeCursor(bucketId, cursor) {
  await ensureDir(join(PATHS.data, 'sharing', 'cursors'));
  await atomicWrite(cursorPath(bucketId), cursor);
}

/**
 * Mark a manifest filename as processed at the given manifestId. Caps the
 * cursor at 5000 entries so a runaway peer can't grow the file unbounded.
 */
export async function markProcessed(bucketId, manifestFilename, manifestId = null) {
  const cursor = await readCursor(bucketId);
  cursor.processedById[manifestFilename] = manifestId || cursor.processedById[manifestFilename] || '';
  // Drop legacy entry if it was tracked there; the map is now authoritative.
  if (cursor.processed.includes(manifestFilename)) {
    cursor.processed = cursor.processed.filter((f) => f !== manifestFilename);
  }
  const keys = Object.keys(cursor.processedById);
  if (keys.length > 5000) {
    // Drop the lexicographically-smallest 1000 — for timestamp-prefixed
    // one-shot manifests this is the oldest entries. Subscription filenames
    // (sub-…) sort after timestamp-prefixed ones, so they survive a prune
    // even when the cursor is full of legacy one-shot history.
    const drop = new Set(keys.sort().slice(0, keys.length - 5000));
    for (const k of drop) delete cursor.processedById[k];
  }
  cursor.lastProcessedAt = new Date().toISOString();
  await writeCursor(bucketId, cursor);
  return cursor;
}

/**
 * Remove a filename from the cursor entirely (used on `unlink` so a future
 * re-share of the same record under the same filename re-imports cleanly).
 * No-op short-circuit when the filename isn't tracked — chokidar fires
 * `unlink` for arbitrary files in the watched dir, not just our manifests.
 */
export async function forgetProcessed(bucketId, manifestFilename) {
  const cursor = await readCursor(bucketId);
  const inMap = cursor.processedById && manifestFilename in cursor.processedById;
  const inLegacy = cursor.processed.includes(manifestFilename);
  if (!inMap && !inLegacy) return cursor;
  if (inMap) delete cursor.processedById[manifestFilename];
  if (inLegacy) cursor.processed = cursor.processed.filter((f) => f !== manifestFilename);
  await writeCursor(bucketId, cursor);
  return cursor;
}

/**
 * Returns true when we've already imported THIS specific version of the
 * manifest. For subscription manifests, content-aware: a new manifestId on
 * the same filename re-processes. For legacy entries (processed[] array),
 * any subsequent reference to that filename is suppressed.
 */
export function hasBeenProcessed(cursor, manifestFilename, manifestId = null) {
  if (cursor?.processedById && manifestFilename in cursor.processedById) {
    const stored = cursor.processedById[manifestFilename];
    if (!stored) return true; // unknown id → trust filename match (idempotent)
    return manifestId ? stored === manifestId : true;
  }
  return Array.isArray(cursor?.processed) && cursor.processed.includes(manifestFilename);
}

/**
 * Build a fresh manifest. Caller writes it after every record + asset is in
 * place. `producedByVersion` is the PortOS app version; resolve via
 * `getProducedByVersion()` (from ./version.js) and pass in — kept as a
 * parameter so this stays pure + synchronous.
 *
 * `schemaVersion` is the wire-protocol version (the only one importer compat
 * is gated on). `sharingSchemaVersion` is its more descriptive alias kept for
 * forward-compat readability — both carry the same value.
 *
 * `subscription`, when provided as `{ recordKind, recordId }`, marks this
 * manifest as a persistent subscription rather than a one-shot share. The
 * filename is then deterministic per (recordKind, recordId), so re-exports
 * overwrite in place and recipients see updates via chokidar `change`
 * events. Importer cursor keys on the manifest id (fresh per export) so
 * content-changes re-process correctly.
 */
export function buildManifest({
  kind, senderInstanceId, source, sourceBio, recordIds, assetRefs, reviewRefs,
  bucketId, bucketName, note, producedByVersion, subscription, collection,
  portosSchemaVersions,
}) {
  if (!MANIFEST_KIND.includes(kind)) throw new Error(`buildManifest: invalid kind '${kind}'`);
  return {
    id: randomUUID(),
    schemaVersion: SHARING_SCHEMA_VERSION,
    sharingSchemaVersion: SHARING_SCHEMA_VERSION,
    producedByVersion: producedByVersion || 'unknown',
    // Per-category storage layout versions the sender's code expected at
    // export time. The importer compares against its own
    // `PORTOS_SCHEMA_VERSIONS` and refuses to apply a manifest that's
    // ahead — the user is told to upgrade PortOS before the import can
    // proceed. Optional on the wire so legacy manifests (no field) still
    // validate; absent treated as "no contract" by the comparator.
    // Plain-object only: `typeof === 'object'` alone would accept arrays, and
    // `{ ...[] }` spreads into numeric keys, producing a malformed
    // `{ "0": ... }` map the importer's comparator can't read. `isPlainObject`
    // rejects arrays + null (the realistic junk); exotic inputs like a Date
    // spread to a harmless `{}` the comparator treats as "no contract".
    portosSchemaVersions: isPlainObject(portosSchemaVersions)
      ? { ...portosSchemaVersions }
      : null,
    createdAt: new Date().toISOString(),
    kind,                              // 'series' | 'universe' | 'media'
    subscription: subscription && subscription.recordKind && subscription.recordId
      ? { recordKind: subscription.recordKind, recordId: subscription.recordId }
      : null,
    senderInstanceId: senderInstanceId || UNKNOWN_INSTANCE_ID,
    source: source || 'unknown',        // human display name
    sourceBio: sourceBio || null,
    bucketId,
    bucketName: bucketName || bucketId,
    recordIds: Array.isArray(recordIds) ? recordIds : [],
    assetRefs: Array.isArray(assetRefs) ? assetRefs : [],
    // Series ids whose manuscript-review sibling doc (records/reviews/<id>.json)
    // is bundled in this manifest. Declared separately from `recordIds` because
    // the review is keyed by seriesId, not a record id of its own — so the
    // importer can WAIT for the review file to land before markProcessed
    // (cloud-relayed buckets deliver files out of order). Absent on legacy
    // manifests → importer treats as "no declared reviews".
    reviewRefs: Array.isArray(reviewRefs) ? reviewRefs : [],
    // Optional payload for universe/series shares — the linked media
    // collection so recipients gain the same set of generated images and
    // the link is restored on their side. Either `universeId` (universe-
    // owned auto-collection, or a universe-linked series' bundle) OR
    // `seriesId` (per-series auto-collection for universeless series) is
    // present, never both.
    collection: collection && Array.isArray(collection.items)
      && (collection.universeId || collection.seriesId)
      ? {
        name: collection.name
          || (collection.universeId
            ? universeCollectionNameFor(collection.universeId)
            : seriesCollectionNameFor(collection.seriesId)),
        ...(collection.universeId ? { universeId: collection.universeId } : {}),
        ...(collection.seriesId && !collection.universeId ? { seriesId: collection.seriesId } : {}),
        description: collection.description || '',
        items: collection.items.map((it) => ({ kind: it.kind, ref: it.ref, addedAt: it.addedAt || null })),
      }
      : null,
    note: isStr(note) ? note.slice(0, 1000) : null,
  };
}

/** Filename prefix shared by every subscription manifest, regardless of
 *  schema version. The prune filter at `pruneBucketManifests` uses this same
 *  prefix to exempt subscription manifests from archive cleanup. */
export const SUBSCRIPTION_FILE_PREFIX = 'sub-';

/** Filename for a subscription manifest. Used by both the writer (exporter)
 *  and the reader (subscriptions service, watcher) so the formula stays in
 *  one place. The `senderInstanceId` segment keeps two peers' shares of the
 *  same record from colliding; absent senderInstanceId falls back to the
 *  UNKNOWN_INSTANCE_ID sentinel so the filename is always valid. The sender
 *  segment is sanitized with the same allowlist/length cap used by
 *  `annotationManifestFilename` so a malformed persisted instance id
 *  containing path separators can't escape the `manifests` directory. */
export function subscriptionFilename({ recordKind, recordId, senderInstanceId }) {
  const raw = (isStr(senderInstanceId) ? senderInstanceId.trim() : '') || UNKNOWN_INSTANCE_ID;
  const sender = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || UNKNOWN_INSTANCE_ID;
  return `${SUBSCRIPTION_FILE_PREFIX}${recordKind}-${recordId}-${sender}.json`;
}

/** Legacy pre-sharing-v2 subscription filename — kept so we can clean up the
 *  old file when a peer upgrades and switches to the per-sender name. */
export function legacySubscriptionFilename({ recordKind, recordId }) {
  return `${SUBSCRIPTION_FILE_PREFIX}${recordKind}-${recordId}.json`;
}

/**
 * Filename a manifest lives under inside `<bucket>/manifests/`.
 *
 * For subscription manifests we use a deterministic name keyed on the
 * (recordKind, recordId, senderInstanceId) tuple so re-exports overwrite the
 * same file — bucket recipients see updates via chokidar `change` events, not
 * as accumulating new files. Including the senderInstanceId means two peers
 * each subscribed to the same record write to distinct files instead of
 * clobbering each other. For one-shot manifests we use the legacy
 * `<iso-ts>-<source>-<uuid>.json` naming so the watcher's add-order remains
 * lexicographically deterministic.
 */

export function manifestFilename(manifest) {
  if (manifest.kind === 'media-annotations') {
    return annotationManifestFilename(manifest.senderInstanceId);
  }
  if (manifest.subscription?.recordKind && manifest.subscription?.recordId) {
    return subscriptionFilename({
      recordKind: manifest.subscription.recordKind,
      recordId: manifest.subscription.recordId,
      senderInstanceId: manifest.senderInstanceId,
    });
  }
  const ts = manifest.createdAt.replace(/[:.]/g, '-');
  const senderSlug = (manifest.source || manifest.senderInstanceId || UNKNOWN_INSTANCE_ID)
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    || UNKNOWN_INSTANCE_ID;
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

/**
 * Default retention cap per bucket per local instance. A long-lived bucket
 * accumulates one manifest per share action, so capping owned manifests at
 * 500 keeps disk + cloud-sync chatter bounded while preserving enough recent
 * history for "did I share this?" forensics in `/sharing/:id/activity`.
 */
export const DEFAULT_MANIFEST_RETENTION = 500;

/**
 * Filenames currently being moved into `<bucket>/.archive/manifests/` by the
 * pruner. The watcher consults this set so its `unlink` handler can skip
 * `handleUnshare` for our own archive moves — those would otherwise reset
 * cursor entries and emit a misleading "peer unshared" socket event.
 *
 * Held for ~5s after each rename to outlast chokidar's awaitWriteFinish
 * debounce; the entry is unref'd from the event loop so it never blocks
 * shutdown.
 */
const pruningInFlight = new Map();

export function isManifestPruning(bucketId, filename) {
  return pruningInFlight.get(bucketId)?.has(filename) || false;
}

function markPruning(bucketId, filename) {
  let set = pruningInFlight.get(bucketId);
  if (!set) {
    set = new Set();
    pruningInFlight.set(bucketId, set);
  }
  set.add(filename);
}

function scheduleUnmark(bucketId, filename, delayMs = 5000) {
  const t = setTimeout(() => {
    const set = pruningInFlight.get(bucketId);
    if (!set) return;
    set.delete(filename);
    if (set.size === 0) pruningInFlight.delete(bucketId);
  }, delayMs);
  t.unref?.();
}

// Cap concurrent readManifest fd usage during classification — long-lived
// buckets can hold thousands of manifests, and `EMFILE: too many open files`
// is real on macOS defaults if we Promise.all the whole list.
const CLASSIFY_CONCURRENCY = 32;

/**
 * Archive older one-shot manifests authored by `localInstanceId` so a bucket
 * that lives long enough does not accumulate manifests indefinitely.
 *
 * Rules:
 *   - Subscription manifests (`sub-*.json`) are never archived — they own a
 *     deterministic filename per (recordKind, recordId) so older ones don't
 *     accumulate, and removing one would replicate as an unshare to peers.
 *   - Manifests authored by other peers are never archived — only the author
 *     of a manifest knows whether it's been superseded, and a cross-peer
 *     delete would replicate as an unshare on the originating peer.
 *   - Owned one-shot manifests in excess of `maxManifests` are moved (oldest
 *     first by ISO-prefixed filename) into `<bucket>/.archive/manifests/`.
 *
 * Returns `{ archived, kept, ownedTotal, skippedForeign, skippedReason }`.
 * When `localInstanceId` is missing or UNKNOWN_INSTANCE_ID, returns a noop
 * result with `skippedReason` set — we never blanket-archive without an
 * author check.
 */
export async function pruneBucketManifests(bucket, opts = {}) {
  const maxManifests = Number.isFinite(opts.maxManifests)
    ? Math.max(0, opts.maxManifests)
    : DEFAULT_MANIFEST_RETENTION;
  const localInstanceId = opts.localInstanceId;
  if (!localInstanceId || localInstanceId === UNKNOWN_INSTANCE_ID) {
    return { archived: 0, kept: 0, ownedTotal: 0, skippedForeign: 0, skippedReason: 'no-local-instance-id' };
  }
  const manifestsDir = join(bucket.path, 'manifests');
  const entries = await readdir(manifestsDir).catch(() => []);
  const candidates = entries
    .filter((f) => f.endsWith('.json') && !f.startsWith(SUBSCRIPTION_FILE_PREFIX) && !f.startsWith('annotations-'))
    .sort();
  // Fast path: if the total candidate count is at or below the cap, no read
  // of any manifest is necessary — owned count cannot exceed total.
  if (candidates.length <= maxManifests) {
    return { archived: 0, kept: candidates.length, ownedTotal: candidates.length, skippedForeign: 0, skippedReason: null };
  }
  // Classify in bounded-concurrency batches so a bucket with thousands of
  // manifests doesn't exhaust file descriptors.
  const owned = [];
  let skippedForeign = 0;
  for (let i = 0; i < candidates.length; i += CLASSIFY_CONCURRENCY) {
    const batch = candidates.slice(i, i + CLASSIFY_CONCURRENCY);
    const reads = await Promise.all(batch.map((filename) => readManifest(bucket.path, filename).catch(() => null)));
    for (let j = 0; j < batch.length; j++) {
      const m = reads[j];
      if (!m) continue;
      if (m.senderInstanceId === localInstanceId) owned.push(batch[j]);
      else skippedForeign += 1;
    }
  }
  if (owned.length <= maxManifests) {
    return { archived: 0, kept: owned.length, ownedTotal: owned.length, skippedForeign, skippedReason: null };
  }
  const archiveDir = join(bucket.path, '.archive', 'manifests');
  await ensureDir(archiveDir);
  const toArchive = owned.slice(0, owned.length - maxManifests);
  for (const filename of toArchive) markPruning(bucket.id, filename);
  const renames = await Promise.all(toArchive.map(async (filename) => {
    try {
      await rename(join(manifestsDir, filename), join(archiveDir, filename));
      return true;
    } catch (err) {
      console.log(`⚠️ sharing.manifest: archive failed for ${filename}: ${err.message}`);
      return false;
    } finally {
      scheduleUnmark(bucket.id, filename);
    }
  }));
  const archived = renames.filter(Boolean).length;
  return { archived, kept: maxManifests, ownedTotal: owned.length, skippedForeign, skippedReason: null };
}
