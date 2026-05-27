/**
 * Share Bucket — importer.
 *
 * Reads a manifest dropped into `<bucket>/manifests/` and either:
 *   - bucket.mode === 'auto-merge' → apply records into local pipeline /
 *     universe / media state directly, using LWW by updatedAt against any
 *     existing local record of the same id.
 *   - bucket.mode === 'inbox' → write a pending-import entry into
 *     `data/sharing/inbox/<bucketId>.json` for the user to review + promote.
 *
 * Once required asset blobs are present, the cursor records the manifest
 * filename so the watcher doesn't replay it on restart. If cloud sync delivers
 * the manifest before its assets, the importer applies/copies what is available
 * and leaves the manifest retryable until the remaining blobs arrive.
 *
 * Asset blobs referenced by the manifest are copied from the bucket into the
 * local `data/{images,videos}/` directories (skip-if-present). v2+ manifests
 * use a content-addressed source at `assets/blobs/<hash>`; legacy v1 manifests
 * fall back to `assets/{images,videos}/<filename>`. Media-job records bundled
 * in `records/media/` are merged into `data/media-jobs.json` so re-render
 * workflows have the prompt + params.
 */

import { join, basename } from 'path';
import { copyFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { PATHS, ensureDir, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { isSafeRecordId } from '../../lib/validation.js';
import { getBucket, bucketBlobPath, bucketBlobSidecarPath, imageSidecarName, isHexHash } from './buckets.js';
import { readManifest, markProcessed, readCursor, hasBeenProcessed, forgetProcessed } from './manifest.js';
import { SHARING_SCHEMA_VERSION, isManifestCompatible } from './version.js';
import { PORTOS_SCHEMA_VERSIONS, RECORD_KIND_SCHEMA_CATEGORIES, compareSchemaVersions, scopeVersionDiff, formatVersionGap } from '../../lib/schemaVersions.js';
import { insertSeriesWithId, updateSeries, getSeries } from '../pipeline/series.js';
import { insertIssueWithId, updateIssue, getIssue } from '../pipeline/issues.js';
import { insertUniverseWithId, updateUniverse, getUniverse } from '../universeBuilder.js';
import { applyLegacySeriesCanonToUniverse } from '../pipeline/migrateSeriesCanon.js';
import { findOrCreateUniverseCollection, findOrCreateSeriesCollection, addItem as addCollectionItem, ERR_DUPLICATE as COLLECTION_ERR_DUPLICATE } from '../mediaCollections.js';
import { adoptImportedSubscription, withReexportSuppressed } from './subscriptions.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from '../instances.js';
import { mergePeerAnnotations } from '../mediaAnnotations.js';
import { isStr } from '../../lib/storyBible.js';
import { isPlainObject } from '../../lib/objects.js';
import { maybeJournalBeforeOverwrite, flushBaseHashes, setSyncBaseHash, contentHashForRecord } from '../../lib/conflictJournal.js';

function isSelfAuthored(senderInstanceId, localInstanceId) {
  return !!localInstanceId
    && !!senderInstanceId
    && senderInstanceId !== UNKNOWN_INSTANCE_ID
    && senderInstanceId === localInstanceId;
}

export const sharingEvents = new EventEmitter();

const inboxPath = (bucketId) => join(PATHS.data, 'sharing', 'inbox', `${bucketId}.json`);

async function readInbox(bucketId) {
  await ensureDir(join(PATHS.data, 'sharing', 'inbox'));
  return readJSONFile(inboxPath(bucketId), { items: [] }, { logError: false });
}

async function writeInbox(bucketId, inbox) {
  await ensureDir(join(PATHS.data, 'sharing', 'inbox'));
  await atomicWrite(inboxPath(bucketId), inbox);
}

/** Newer of two ISO timestamps wins (LWW). Equal → keep local. */
function remoteWins(localTs, remoteTs) {
  return (remoteTs || '') > (localTs || '');
}

/**
 * Merge a manifest's `collection` payload into local state. Find-or-create
 * the universe-linked OR series-linked collection via the id-first helper
 * (universeId wins when both are present), then add each remote item via
 * `addItem` — `ERR_DUPLICATE` errors are expected and swallowed (the item
 * already exists locally; nothing to do).
 *
 * Routing is by `universeId` / `seriesId`, never by name — a manifest from
 * a peer whose universe or series happens to share a display name with a
 * local one of a different id must NOT silently land in the local bucket.
 *
 * The asset blobs are NOT copied here — `copyAssetsLocally` (called in
 * `processManifest`) already pulled every available asset entry. This function
 * only persists collection membership for items whose blobs are present so the
 * UI does not point at files that Google Drive has not synced yet.
 */
async function mergeCollectionPayload(payload, availableAssetKeys = null) {
  if (!payload || !Array.isArray(payload.items)) return { itemsAdded: 0 };
  if (!payload.universeId && !payload.seriesId) return { itemsAdded: 0 };

  // Resolve the local owner record (universe OR series). Defer the merge
  // until it exists locally — creating a stamped (rename-locked) collection
  // for an owner we haven't imported yet leaves the user with an unfixable
  // orphan. processManifest re-runs the merge on each pass, so a deferred
  // merge applies as soon as the owner record lands.
  let collection;
  if (payload.universeId) {
    const localUniverse = await getUniverse(payload.universeId, { includeDeleted: true }).catch(() => null);
    if (!localUniverse) {
      return { itemsAdded: 0, itemsDeferred: payload.items.length, missingUniverse: true };
    }
    if (localUniverse.deleted) {
      // Universe exists on disk but is tombstoned — not a transient missing-record
      // situation. Return a distinct sentinel (the universe id) so the caller does
      // NOT loop pending forever (the bug: tombstone looks like missing → never resolves).
      return { itemsAdded: 0, itemsDeferred: payload.items.length, tombstonedUniverse: localUniverse.id };
    }
    // Use the LOCAL owner's name (authoritative for the linked collection's
    // locked name) over the manifest's `payload.name`. A peer exporting a
    // stale or tampered collection payload must not be able to mint a
    // locked collection on the receiver with the wrong visible name —
    // once the id is stamped, no cascade fixes it. Fall back to a
    // sanitized payload.name only when the local name is unusable.
    const fallbackRaw = typeof payload.name === 'string' ? payload.name : '';
    const fallbackName = fallbackRaw.replace(/^Universe:\s*/i, '').trim() || payload.universeId;
    const universeName = typeof localUniverse.name === 'string' && localUniverse.name.trim()
      ? localUniverse.name
      : fallbackName;
    collection = await findOrCreateUniverseCollection({
      universeId: payload.universeId,
      universeName,
      description: payload.description || '',
    }).catch((err) => {
      console.log(`⚠️ sharing.importer: findOrCreateUniverseCollection failed: ${err.message}`);
      return null;
    });
  } else {
    const localSeries = await getSeries(payload.seriesId).catch(() => null);
    if (!localSeries) {
      return { itemsAdded: 0, itemsDeferred: payload.items.length, missingSeries: true };
    }
    // If the local series has since been linked to a universe (peer's
    // manifest is from an older universeless phase, or local user linked it
    // after the manifest was produced), re-route into the universe
    // collection — same contract the exporter and cover filer enforce.
    // Minting a fresh seriesId-stamped collection here would leave a
    // rename-locked stale per-series bucket attached to a linked series.
    if (localSeries.universeId) {
      const localUniverse = await getUniverse(localSeries.universeId, { includeDeleted: true }).catch(() => null);
      if (!localUniverse) {
        // Dangling universe link — defer so a later sync of the universe
        // record unblocks the merge under the universe contract. Treat as
        // missingSeries (same defer semantics) so the manifest stays pending.
        return { itemsAdded: 0, itemsDeferred: payload.items.length, missingSeries: true };
      }
      if (localUniverse.deleted) {
        // Universe is tombstoned — same as the direct-universeId tombstone case.
        // Return the universe id so the caller can surface it without needing to
        // re-resolve the series→universe link.
        return { itemsAdded: 0, itemsDeferred: payload.items.length, tombstonedUniverse: localUniverse.id };
      }
      collection = await findOrCreateUniverseCollection({
        universeId: localUniverse.id,
        universeName: localUniverse.name,
        description: payload.description || '',
      }).catch((err) => {
        console.log(`⚠️ sharing.importer: findOrCreateUniverseCollection (series re-route) failed: ${err.message}`);
        return null;
      });
    } else {
      const fallbackRaw = typeof payload.name === 'string' ? payload.name : '';
      const fallbackName = fallbackRaw.replace(/^Series:\s*/i, '').trim() || payload.seriesId;
      const seriesName = typeof localSeries.name === 'string' && localSeries.name.trim()
        ? localSeries.name
        : fallbackName;
      collection = await findOrCreateSeriesCollection({
        seriesId: payload.seriesId,
        seriesName,
        description: payload.description || '',
      }).catch((err) => {
        console.log(`⚠️ sharing.importer: findOrCreateSeriesCollection failed: ${err.message}`);
        return null;
      });
    }
  }
  if (!collection) return { itemsAdded: 0 };
  let added = 0;
  let deferred = 0;
  for (const item of payload.items) {
    if (!item?.kind || !item?.ref) continue;
    if (availableAssetKeys && !availableAssetKeys.has(`${item.kind}:${basename(item.ref)}`)) {
      deferred += 1;
      continue;
    }
    const result = await addCollectionItem(collection.id, item).catch((err) => {
      if (err?.code === COLLECTION_ERR_DUPLICATE) return null;
      console.log(`⚠️ sharing.importer: addCollectionItem failed for ${item.ref}: ${err.message}`);
      return null;
    });
    if (result) added += 1;
  }
  return { itemsAdded: added, itemsDeferred: deferred };
}

// `image-ref` covers files under data/image-refs/ (character reference
// sheets). Unknown kinds collapse to 'image' for back-compat with v1
// peers that only emitted 'image' / 'video'.
const KNOWN_ASSET_KINDS = new Set(['video', 'image', 'image-ref']);

function manifestAssetRefs(manifest) {
  const refs = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw || !isStr(raw.ref)) return;
    const kind = KNOWN_ASSET_KINDS.has(raw.kind) ? raw.kind : 'image';
    const filename = basename(raw.ref);
    if (!filename || filename !== raw.ref) return;
    const key = `${kind}:${filename}`;
    if (seen.has(key)) return;
    seen.add(key);
    // hash is optional — only v2+ manifests carry it. Collection items have
    // never carried per-item hashes (they reference filenames in the user's
    // local data dir), so the legacy filename path covers them.
    //
    // Hashes are UNTRUSTED peer input. Accept only well-formed SHA-256
    // (64 lowercase hex chars) so `bucketBlobPath(bucketPath, hash)` can't
    // be coerced into a `path.join('.../assets/blobs', '../../etc/hosts')`
    // path-traversal primitive that would `copyFile` an arbitrary file from
    // the user's filesystem into `data/{images,videos}/`. A malformed hash
    // means the manifest is broken or hostile — drop the ref entirely
    // rather than fall back to the legacy filename path (a v2 manifest
    // that sets a bogus hash isn't a v1 manifest).
    const entry = { kind, ref: filename };
    if (raw.hash !== undefined && raw.hash !== null) {
      if (!isHexHash(raw.hash)) {
        console.log(`⚠️ sharing.importer: dropping asset ref with invalid hash: ${kind}/${filename}`);
        return;
      }
      entry.hash = raw.hash;
    }
    refs.push(entry);
  };
  for (const ref of manifest?.assetRefs || []) push(ref);
  // Universe collection payloads are also asset membership. Import from the
  // payload so late-arriving Drive files can be copied and added incrementally
  // even if assetRefs was incomplete in an older manifest.
  for (const item of manifest?.collection?.items || []) push(item);
  return refs;
}

/**
 * Resolve the bucket-side blob + optional sidecar paths for an asset ref.
 * v2 manifests carry `hash` and read from `assets/blobs/`; legacy v1
 * manifests fall back to `assets/{images,videos}/<filename>`. Videos have no
 * sidecar convention.
 */
function resolveBucketAssetPaths(bucketPath, ref) {
  const isVideo = ref.kind === 'video';
  if (ref.hash) {
    return {
      blobPath: bucketBlobPath(bucketPath, ref.hash),
      sidecarPath: isVideo ? null : bucketBlobSidecarPath(bucketPath, ref.hash),
    };
  }
  const legacyDir = join(bucketPath, 'assets', isVideo ? 'videos' : 'images');
  return {
    blobPath: join(legacyDir, ref.ref),
    sidecarPath: isVideo ? null : join(legacyDir, imageSidecarName(ref.ref)),
  };
}

// Local target dir per asset kind. 'image-ref' covers character reference
// sheets (data/image-refs/). Unknown kinds route to the gallery for
// safety — peer manifests using a kind we don't recognize land there.
const LOCAL_TARGET_DIRS = Object.freeze({
  video: PATHS.videos,
  image: PATHS.images,
  'image-ref': PATHS.imageRefs,
});

/** Copy bundled assets from the bucket into local data dirs. Runs in parallel. */
async function copyAssetsLocally(bucketPath, assetRefs) {
  await ensureDir(PATHS.images);
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.imageRefs);
  const copied = [];
  const available = [];
  const missing = [];
  await Promise.all((assetRefs || []).map(async (ref) => {
    if (!ref || !isStr(ref.ref)) return;
    const filename = basename(ref.ref);
    const kind = ref.kind;
    const targetDir = LOCAL_TARGET_DIRS[kind] || PATHS.images;
    const targetPath = join(targetDir, filename);
    const { blobPath, sidecarPath } = resolveBucketAssetPaths(bucketPath, ref);
    if (!existsSync(blobPath)) {
      missing.push({ kind, ref: filename });
      return;
    }
    available.push({ kind, ref: filename });
    if (!existsSync(targetPath)) {
      await copyFile(blobPath, targetPath);
      copied.push({ kind, ref: filename });
    }
    if (sidecarPath && existsSync(sidecarPath)) {
      const sidecarTarget = join(targetDir, imageSidecarName(filename));
      if (!existsSync(sidecarTarget)) await copyFile(sidecarPath, sidecarTarget);
    }
  }));
  return { copied, available, missing };
}

async function processAnnotationManifest(bucket, manifest) {
  const recordId = (manifest.recordIds || [])[0] || manifest.senderInstanceId;
  if (!recordId) return { applied: 0, missing: true, reason: 'no-record-id' };
  if (!isSafeRecordId(recordId)) return { applied: 0, missing: true, reason: 'bad-record-id' };
  const recordPath = join(bucket.path, 'records', 'media-annotations', `${recordId}.json`);
  const record = await readJSONFile(recordPath, null, { logError: false });
  if (!record) return { applied: 0, missing: true, reason: 'record-not-synced' };
  // record.instanceId is the source-of-truth for the author; fall back to the
  // manifest envelope for older records that omit it.
  const payload = {
    instanceId: record.instanceId || manifest.senderInstanceId,
    authorName: record.authorName || manifest.source,
    annotations: record.annotations || {},
  };
  const { changed, projections } = await mergePeerAnnotations(payload);
  for (const key of changed) {
    sharingEvents.emit('annotation-updated', { key, entry: projections.get(key) });
  }
  return { applied: changed.length, changedKeys: changed };
}

/** Merge bucket-bundled media-job records into local data/media-jobs.json. */
async function mergeMediaJobRecords(bucketPath, recordIds) {
  const mediaDir = join(bucketPath, 'records', 'media');
  if (!existsSync(mediaDir)) return;
  const persistedPath = join(PATHS.data, 'media-jobs.json');
  const [persisted, incoming] = await Promise.all([
    readJSONFile(persistedPath, { jobs: [] }, { logError: false }),
    Promise.all((recordIds || []).map(async (id) => {
      if (!isSafeRecordId(id)) return null;
      const recordPath = join(mediaDir, `${id}.json`);
      if (!existsSync(recordPath)) return null;
      return readJSONFile(recordPath, null, { logError: false });
    })),
  ]);
  const byId = new Map((persisted.jobs || []).map((j) => [j.id, j]));
  let changed = false;
  for (const job of incoming) {
    if (!job?.id || byId.has(job.id)) continue;
    byId.set(job.id, job);
    changed = true;
  }
  if (changed) {
    await atomicWrite(persistedPath, { jobs: Array.from(byId.values()) });
  }
}

/**
 * Read the records referenced by a manifest. `missing` lists recordIds whose
 * JSON file hasn't synced into the bucket yet — the caller defers
 * markProcessed until that list is empty, otherwise a manifest delivered
 * ahead of its records would be silently dropped forever. Bible-prefixed ids
 * (chr-/set-/obj-) are sub-records of universes and never standalone, so they
 * are skipped without being tracked as missing.
 */
async function readReferencedRecords(bucketPath, manifest) {
  const records = { series: [], issues: [], universes: [], media: [] };
  const missing = [];
  const resolveOne = async (id) => {
    if (!isSafeRecordId(id)) return { kind: 'missing', id };
    if (id.startsWith('ser-')) {
      const r = await readJSONFile(join(bucketPath, 'records', 'series', `${id}.json`), null, { logError: false });
      return r ? { kind: 'series', record: r } : { kind: 'missing', id };
    }
    if (id.startsWith('iss-')) {
      const r = await readJSONFile(join(bucketPath, 'records', 'issues', `${id}.json`), null, { logError: false });
      return r ? { kind: 'issues', record: r } : { kind: 'missing', id };
    }
    if (id.startsWith('chr-') || id.startsWith('set-') || id.startsWith('obj-')) {
      // Bible entries — never standalone, just skip.
      return { kind: 'skip' };
    }
    // UUID-only — could be a universe or a media job. Try both.
    const uni = await readJSONFile(join(bucketPath, 'records', 'universes', `${id}.json`), null, { logError: false });
    if (uni) return { kind: 'universes', record: uni };
    const med = await readJSONFile(join(bucketPath, 'records', 'media', `${id}.json`), null, { logError: false });
    if (med) return { kind: 'media', record: med };
    return { kind: 'missing', id };
  };
  const resolved = await Promise.all((manifest.recordIds || []).map(resolveOne));
  for (const r of resolved) {
    if (r.kind === 'missing') missing.push(r.id);
    else if (r.kind === 'series') records.series.push(r.record);
    else if (r.kind === 'issues') records.issues.push(r.record);
    else if (r.kind === 'universes') records.universes.push(r.record);
    else if (r.kind === 'media') records.media.push(r.record);
  }
  return { records, missing };
}

/**
 * Which `PORTOS_SCHEMA_VERSIONS` categories does this manifest actually carry?
 * Used to scope the per-category schema gate so a sender ahead on an unrelated
 * category doesn't reject an import that never touches it. Derived from the
 * manifest's declared `recordIds` + `kind` + bundled `collection` — NOT from
 * reading the record files (the gate runs before any record read, and a
 * manifest delivered ahead of its records still declares what it carries).
 *
 * Id-prefix → kind mirrors `readReferencedRecords` above (`ser-` → series,
 * `iss-` → issue, `chr-`/`set-`/`obj-` → universe bible sub-records); a UUID is
 * a universe record EXCEPT on a `media` manifest, where UUIDs are media-job
 * records. Media-job records are intentionally NOT gated: they have no
 * versioned storage layout, and `mergeMediaJobRecords` is insert-only by id
 * (never overwrites, stores the record verbatim, readers use optional
 * chaining) — so a future-shape job degrades gracefully rather than corrupting,
 * exactly like the unlisted `videoHistory` category. `media-annotations`
 * manifests bypass the records pipeline entirely and carry no versioned layout
 * → never gated.
 */
function relevantSchemaCategoriesForManifest(manifest) {
  if (manifest?.kind === 'media-annotations') return [];
  const categories = new Set();
  const add = (keys) => { for (const k of keys) categories.add(k); };
  const ids = Array.isArray(manifest?.recordIds) ? manifest.recordIds : [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    if (id.startsWith('ser-')) add(RECORD_KIND_SCHEMA_CATEGORIES.series);
    else if (id.startsWith('iss-')) add(RECORD_KIND_SCHEMA_CATEGORIES.issue);
    else if (id.startsWith('chr-') || id.startsWith('set-') || id.startsWith('obj-')) add(RECORD_KIND_SCHEMA_CATEGORIES.universe);
    else if (manifest?.kind !== 'media') add(RECORD_KIND_SCHEMA_CATEGORIES.universe);
  }
  // Mirror peerSync's gate predicate: a bundled collection only counts as a
  // mediaCollections transfer when it's a live record (a tombstone collection
  // carries only delete fields, safe at any version). Today's exporter never
  // bundles a deleted collection, so this is defensive consistency.
  if (isPlainObject(manifest?.collection) && manifest.collection.deleted !== true) {
    add(RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection);
  }
  return [...categories];
}

/**
 * Auto-merge mode: apply records into live state.
 *
 * Each record either inserts under its manifest id (via insertWithId) on
 * first arrival, or LWW-overwrites the existing local record when the
 * remote updatedAt is newer. Ids are preserved across peers so a subsequent
 * re-share of the same record merges onto the same local row instead of
 * accumulating duplicates.
 *
 * `overridden` counts records whose local copy was newer-than-zero-but-older
 * than remote and got replaced — surfaced via the socket event so the user
 * is notified when auto-merge clobbers local edits.
 */
async function applyAutoMerge(bucket, manifest, records, { availableAssetKeys = null } = {}) {
  let applied = 0;
  const overridden = [];
  // Records whose insert threw an UNEXPECTED (non-duplicate) error — they did
  // NOT land. Surfaced as a pending condition (like legacyCanonPendingFailures)
  // so processManifest leaves the cursor un-advanced and the watcher retries,
  // instead of marking the manifest processed and silently dropping the record.
  const failedInserts = [];
  const inboundSub = manifest.subscription?.recordKind && manifest.subscription?.recordId
    ? { bucketId: bucket.id, recordKind: manifest.subscription.recordKind, recordId: manifest.subscription.recordId }
    : null;
  const inboundRecordsForKind = (recordKind) => {
    if (recordKind === 'series') return records.series;
    if (recordKind === 'universe') return records.universes;
    return [];
  };

  const mergeOne = async ({ kind, record, getFn, insertFn, updateFn, label }) => {
    const suppressKind = kind === 'issue' ? 'series' : kind;
    const suppressId = kind === 'issue' ? record.seriesId : record.id;
    const existing = await getFn(record.id).catch(() => null);
    if (!existing) {
      // Suppress re-export around the insert exactly like the UPDATE branch:
      // insertXxxWithId now fires emitRecordUpdated on the tombstone-resurrection
      // path, which would otherwise echo the just-imported record straight back
      // into the bucket we're importing from. The peer-sync propagation that
      // resurrection ALSO triggers (autoSubscribeRecordToAllPeers) is a separate
      // mechanism and stays intact — only the bucket re-export is suppressed.
      const insertOk = await withReexportSuppressed(suppressKind, suppressId, () => insertFn(record))
        .then(() => true)
        .catch((err) => {
          // Duplicate id is benign — a parallel manifest already inserted it, so
          // the record IS present; count it as applied.
          if (err?.code?.endsWith('_DUPLICATE')) return true;
          // Unexpected failure: the record did NOT land. Record it so the
          // manifest stays pending and retries — incrementing `applied` and
          // advancing the cursor here would silently drop the record.
          console.log(`⚠️ sharing.importer: insertWithId(${kind}=${record.id}) failed: ${err.message}`);
          failedInserts.push(`${kind}:${record.id}`);
          return false;
        });
      if (insertOk) {
        applied++;
        // Seed the conflict-journal base hash for a freshly-imported record so
        // its FIRST cross-install divergence is journaled (the sync merge paths
        // seed on their insert branch too; without this a bucket-imported
        // record has base==null and the first conflict would be missed). Hash
        // the STORED record so the base matches a future `local` hash exactly.
        if (kind === 'universe' || kind === 'series') {
          const stored = await getFn(record.id).catch(() => null);
          if (stored) await setSyncBaseHash(kind, record.id, contentHashForRecord(kind, stored));
        }
      }
      return;
    }
    if (remoteWins(existing.updatedAt, record.updatedAt)) {
      // A remote series that arrived without a universe link (an orphan on the
      // sender — older peer, or a record whose link was cleared before the
      // hierarchy rule shipped) must NOT clear the local link: updateSeries now
      // refuses to unlink a linked series and would throw, aborting the whole
      // manifest. Preserve the existing link (a *move* to a different non-empty
      // universe still applies). Mirrors the legacy-canon re-stamp above, but
      // for every series — not just ones carrying legacy canon arrays.
      if (kind === 'series' && !record.universeId && existing.universeId) {
        record = { ...record, universeId: existing.universeId };
      }
      // Non-blocking conflict journal for the two synced top-level kinds — a
      // share-bucket import that LWW-overwrites a locally-diverged record
      // archives the losing local version first. Issues ride LWW silently
      // (child-issue conflict journaling is a v1 follow-up).
      if (kind === 'universe' || kind === 'series') {
        await maybeJournalBeforeOverwrite({
          kind, id: record.id, local: existing, remote: record,
          source: { via: 'share-bucket', bucketId: bucket.id, peerId: manifest.senderInstanceId ?? null },
        });
      }
      await withReexportSuppressed(suppressKind, suppressId, () => updateFn(existing.id, record));
      overridden.push({ kind, id: record.id, label });
      applied++;
    }
  };

  // Universes first — series may reference them via universeId.
  // Wrap updateUniverse in a mutator form so the service-side
  // `referenceSheetImageRef` preservation guard (gated on `!isMutator`) is
  // skipped: sync's intent is that the remote's newer record wins LWW,
  // including server-owned operational pointers like the rendered sheet
  // filename. A literal-patch call would let the local stale pointer
  // overwrite the remote's freshly-rendered one.
  for (const uni of records.universes) {
    await mergeOne({
      kind: 'universe', record: uni, label: uni.name,
      getFn: getUniverse, insertFn: insertUniverseWithId,
      updateFn: (id, record) => updateUniverse(id, () => record),
    });
  }
  // Pre-B.4 peers ship series records with legacy canon arrays (`characters /
  // settings|places / objects`) that `sanitizeSeries` strips on insert —
  // silent data loss for cross-peer imports authored before the B.4 schema
  // teardown. Mirror the CLI migration here, so the canon lands on the
  // linked (or freshly-created) universe before mergeOne writes the
  // sanitized series. Both `settings` (pre-022) and `places` (post-022) wire
  // names are recognized; the helper coalesces them. No-op for post-B.4
  // records (the helper returns 'no-legacy' immediately).
  //
  // If the migration can't land the canon (helper threw, OR the peer linked
  // to a universe that isn't in this manifest and isn't local), skip the
  // sanitized-series insert for that record — otherwise the canon arrays
  // get silently stripped by `sanitizeSeries` and the bug we just fixed
  // recurs. The bucket record stays untouched and the relevant pending list
  // surfaces upward to the manifest-pending check, so the watcher retries
  // when the underlying cause resolves instead of cursor-advancing into
  // permanent skip.
  const skipSeriesMerge = new Set();
  const legacyCanonPendingUniverses = [];
  const legacyCanonPendingFailures = [];
  for (const s of records.series) {
    const hasLegacyCanon = ['characters', 'settings', 'places', 'objects']
      .some((field) => Array.isArray(s[field]) && s[field].length > 0);
    if (!hasLegacyCanon) continue;

    // Retry idempotency: when a local series record already exists from a
    // prior pass (manifest is being retried because some OTHER pending
    // condition held the cursor back), reuse its persisted universeId so
    // we don't keep minting fresh "<name> (auto-migrated)" universes per
    // retry. And if LWW would no-op the upcoming series merge, skip the
    // helper entirely — re-merging stale remote canon over a locally-newer
    // universe would just reset provenance.
    const existing = await getSeries(s.id).catch(() => null);
    if (existing) {
      if (!remoteWins(existing.updatedAt, s.updatedAt)) continue;
      if (!s.universeId && existing.universeId) s.universeId = existing.universeId;
    }

    const r = await applyLegacySeriesCanonToUniverse(s).catch((err) => {
      console.log(`⚠️ sharing.importer: legacy series canon migration for ${s.id} failed: ${err.message}`);
      return null;
    });
    if (!r) {
      // Helper threw — keep the manifest retryable so a transient I/O
      // failure doesn't permanently lose this series. The failure id
      // flows through `pendingLegacyCanonFailures` so processManifest
      // leaves the cursor un-advanced.
      skipSeriesMerge.add(s.id);
      legacyCanonPendingFailures.push(s.id);
      continue;
    }
    if (r.skipped === 'missing-universe') {
      console.log(`⚠️ sharing.importer: skipping series ${s.id} merge — missing universe ${r.universeId}`);
      skipSeriesMerge.add(s.id);
      if (r.universeId) legacyCanonPendingUniverses.push(r.universeId);
      continue;
    }
    // Stamp the freshly-created orphan universe id onto the in-memory record
    // so the upcoming insertSeriesWithId call preserves the link. (We can't
    // call updateSeries here like the CLI batch does — the series record
    // hasn't been inserted yet.)
    if (r.universeCreated && r.universeId) {
      s.universeId = r.universeId;
    }
  }

  for (const s of records.series) {
    if (skipSeriesMerge.has(s.id)) continue;
    await mergeOne({
      kind: 'series', record: s, label: s.name,
      getFn: getSeries, insertFn: insertSeriesWithId, updateFn: updateSeries,
    });
  }
  for (const iss of records.issues) {
    await mergeOne({
      kind: 'issue', record: iss, label: iss.title,
      getFn: getIssue, insertFn: insertIssueWithId, updateFn: updateIssue,
    });
  }

  // Universe and series shares can both carry a linked media collection
  // payload. Items are unioned into a local "Universe: <name>" or
  // "Series: <name>" collection so peer-generated images appear alongside
  // the owner record in the recipient's UI.
  let itemsAdded = 0;
  let itemsDeferred = 0;
  let collectionPendingUniverse = null;
  let collectionPendingSeries = null;
  let collectionTombstonedUniverse = null;
  // `isPlainObject` (not bare truthiness) so this apply path agrees exactly
  // with the schema gate's `relevantSchemaCategoriesForManifest`, which only
  // counts a plain-object `collection` as carrying the mediaCollections
  // category. A truthy non-object (corrupt/hand-crafted manifest) must not
  // slip past the gate yet still reach the merge.
  if (isPlainObject(manifest.collection)) {
    // Suppress re-export of the owner record while the collection items
    // land — the items themselves drive recordEvents, which would loop
    // back through the receiver's own subscriptions if not gated.
    const ownerKind = manifest.collection.universeId ? 'universe' : 'series';
    const ownerId = manifest.collection.universeId || manifest.collection.seriesId;
    const r = await withReexportSuppressed(ownerKind, ownerId, () =>
      mergeCollectionPayload(manifest.collection, availableAssetKeys));
    itemsAdded = r.itemsAdded;
    itemsDeferred = r.itemsDeferred || 0;
    if (itemsAdded > 0) applied += itemsAdded;
    // `mergeCollectionPayload` defers when the referenced owner record
    // hasn't been imported locally yet. Propagate that as a pending
    // condition so processManifest leaves the cursor un-advanced and the
    // watcher retries — otherwise the manifest is marked processed and
    // the deferred items never land if the owner record arrives in a
    // later (independent) sync.
    if (r.missingUniverse) collectionPendingUniverse = manifest.collection.universeId;
    if (r.missingSeries) collectionPendingSeries = manifest.collection.seriesId;
    if (r.tombstonedUniverse) collectionTombstonedUniverse = r.tombstonedUniverse;
  }

  let adoptedSubscription = null;
  if (inboundSub && inboundRecordsForKind(inboundSub.recordKind).some((record) => record.id === inboundSub.recordId)) {
    adoptedSubscription = await adoptImportedSubscription({
      ...inboundSub,
      lastManifestId: manifest.id,
    }).catch((err) => {
      console.log(`⚠️ sharing.importer: adopt subscription failed for ${inboundSub.recordKind}/${inboundSub.recordId}: ${err.message}`);
      return null;
    });
  }

  // Persist the batched conflict-journal base-hash updates accumulated above.
  await flushBaseHashes();

  return {
    applied,
    overridden,
    collectionItemsAdded: itemsAdded,
    collectionItemsDeferred: itemsDeferred,
    collectionPendingUniverse,
    collectionPendingSeries,
    collectionTombstonedUniverse,
    legacyCanonPendingUniverses: legacyCanonPendingUniverses.length > 0 ? legacyCanonPendingUniverses : null,
    legacyCanonPendingFailures: legacyCanonPendingFailures.length > 0 ? legacyCanonPendingFailures : null,
    recordImportFailures: failedInserts.length > 0 ? failedInserts : null,
    adoptedSubscription: adoptedSubscription
      ? { id: adoptedSubscription.id, bucketId: adoptedSubscription.bucketId, recordKind: adoptedSubscription.recordKind, recordId: adoptedSubscription.recordId }
      : null,
  };
}

const INBOX_MAX = 1000;

/** Time window after which an inbox row with the same `(recordKind, recordId,
 *  source)` but a DIFFERENT `senderInstanceId` is treated as a rotation
 *  orphan and culled. Post-sharing-v2 the inbox dedup keys on senderInstanceId,
 *  so a peer that rotates its identity (factory reset / new device) re-shares
 *  with a fresh id and the old row never re-matches — without this cull, the
 *  stale row would persist forever as an "active" subscription. 30 days is
 *  conservative; legitimate same-source-different-peer rows (e.g. two devices
 *  both named "MacBook") would only be culled after a month of no updates. */
const ROTATION_CULL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Inbox mode: write the manifest + record refs to the bucket's inbox for review.
 *
 * For subscription manifests we replace any prior inbox entry for the same
 * (recordKind, recordId, senderInstanceId) so a sender's repeated edits don't
 * pile up as N inbox items — the user always sees that sender's latest
 * snapshot. Two peers sharing the same record produce two distinct inbox rows
 * (the per-sender filenames keep them apart on disk). One-shot manifests
 * dedup by manifest id.
 *
 * Cross-sender rotation orphans (same `source` name, same record, DIFFERENT
 * `senderInstanceId`, row older than `ROTATION_CULL_MS`) are culled on every
 * subscription-manifest arrival — they represent the same peer reincarnated
 * with a fresh instance id (factory reset, new device onboarding).
 */
async function applyInbox(bucket, manifest, manifestFilename, records) {
  const inbox = await readInbox(bucket.id);
  inbox.items = Array.isArray(inbox.items) ? inbox.items : [];
  const sub = manifest.subscription;
  // Tracks whether the rotation-orphan cull (or any other pre-write mutation)
  // changed `inbox.items` so early-return paths below can still persist the
  // pruned list. Without this, a cull followed by an `inbox-has-newer` /
  // `already-in-inbox` short-circuit would silently drop the cull removals
  // and the orphan rows would survive until the next non-stale arrival.
  let inboxMutatedPreWrite = false;
  if (sub?.recordKind && sub?.recordId) {
    const senderId = manifest.senderInstanceId || null;
    const incomingSource = manifest.source || null;
    // Cull cross-sender rotation orphans first so the same-sender match
    // below operates on the cleaned-up list. Skip when source is missing
    // — a row with no display name can't be attributed to a peer identity.
    if (incomingSource) {
      const cullThresholdMs = Date.now() - ROTATION_CULL_MS;
      const beforeLen = inbox.items.length;
      inbox.items = inbox.items.filter((it) => {
        if (!it.subscription) return true;
        if (it.subscription.recordKind !== sub.recordKind) return true;
        if (it.subscription.recordId !== sub.recordId) return true;
        if (it.source !== incomingSource) return true;
        if ((it.senderInstanceId || null) === senderId) return true;
        const createdMs = it.createdAt ? Date.parse(it.createdAt) : NaN;
        if (!Number.isFinite(createdMs)) return true;
        if (createdMs >= cullThresholdMs) return true;
        console.log(`🧹 sharing: bucket=${bucket.name} culled rotation-orphan inbox row source="${incomingSource}" recordKind=${sub.recordKind} recordId=${sub.recordId} oldSender=${it.senderInstanceId || 'null'} newSender=${senderId || 'null'}`);
        return false;
      });
      if (inbox.items.length !== beforeLen) inboxMutatedPreWrite = true;
    }
    const existing = inbox.items.find((it) => it.subscription
      && it.subscription.recordKind === sub.recordKind
      && it.subscription.recordId === sub.recordId
      && (it.senderInstanceId || null) === senderId);
    // Freshness gate: during upgrade a bucket may hold both the new
    // `sub-<kind>-<id>-<sender>.json` and the pre-v2 legacy
    // `sub-<kind>-<id>.json` for the same sender, and lexicographic
    // backlog order visits the new file before the legacy one
    // (`-` (0x2D) < `.` (0x2E)). Without a createdAt compare, the
    // older legacy manifest would replace the newer inbox row. Skip
    // when the incoming manifest is older than what we already have.
    if (existing && existing.createdAt && manifest.createdAt
      && existing.createdAt > manifest.createdAt) {
      if (inboxMutatedPreWrite) await writeInbox(bucket.id, inbox);
      return { queued: false, reason: 'inbox-has-newer' };
    }
    if (existing) {
      inbox.items = inbox.items.filter((it) => it !== existing);
    }
  } else if (inbox.items.some((it) => it.manifestId === manifest.id)) {
    if (inboxMutatedPreWrite) await writeInbox(bucket.id, inbox);
    return { queued: false, reason: 'already-in-inbox' };
  }
  inbox.items.push({
    manifestId: manifest.id,
    manifestFilename,
    kind: manifest.kind,
    subscription: sub || null,
    source: manifest.source,
    sourceBio: manifest.sourceBio,
    senderInstanceId: manifest.senderInstanceId || null,
    producedByVersion: manifest.producedByVersion || null,
    sharingSchemaVersion: manifest.sharingSchemaVersion ?? manifest.schemaVersion ?? null,
    createdAt: manifest.createdAt,
    receivedAt: new Date().toISOString(),
    recordIds: manifest.recordIds,
    assetCount: (manifest.assetRefs || []).length,
    collectionItemCount: manifest.collection?.items?.length || 0,
    collectionName: manifest.collection?.name || null,
    note: manifest.note,
    summary: summarizeRecords(records),
  });
  if (inbox.items.length > INBOX_MAX) inbox.items = inbox.items.slice(-INBOX_MAX);
  await writeInbox(bucket.id, inbox);
  return { queued: true };
}

function summarizeRecords(records) {
  const out = [];
  for (const s of records.series) out.push({ kind: 'series', id: s.id, label: s.name || s.id });
  for (const i of records.issues) out.push({ kind: 'issue', id: i.id, label: i.title || i.id });
  for (const u of records.universes) out.push({ kind: 'universe', id: u.id, label: u.name || u.id });
  for (const m of records.media) out.push({ kind: 'media', id: m.id, label: m.params?.prompt?.slice?.(0, 80) || m.id });
  return out;
}

/**
 * Process one manifest file. Idempotent: a second call for the same manifest
 * is a no-op (cursor + inbox dedup). Refuses incompatible (future) versions
 * with a clear reason + socket event so the UI can prompt for upgrade.
 */
export async function processManifest(bucketId, manifestFilename) {
  const bucket = await getBucket(bucketId);
  const manifest = await readManifest(bucket.path, manifestFilename);
  if (!manifest || !manifest.id) {
    return { skipped: true, reason: 'invalid-manifest' };
  }
  const cursor = await readCursor(bucketId);
  // Content-aware dedup: subscription manifests reuse the same filename
  // across updates and a fresh manifestId means the contents changed.
  if (hasBeenProcessed(cursor, manifestFilename, manifest.id)) {
    return { skipped: true, reason: 'already-processed' };
  }
  // Re-importing our own shares would falsely surface them in the inbox
  // (or no-op merge into their own LWW state). Mark processed so the
  // watcher doesn't replay on every file event.
  const localInstanceId = await getInstanceId().catch(() => null);
  if (isSelfAuthored(manifest.senderInstanceId, localInstanceId)) {
    await markProcessed(bucketId, manifestFilename, manifest.id);
    return { skipped: true, reason: 'self-authored' };
  }
  // Read schemaVersion (also accepts the descriptive alias sharingSchemaVersion).
  const remoteVersion = Number.isFinite(manifest.sharingSchemaVersion)
    ? manifest.sharingSchemaVersion
    : (Number.isFinite(manifest.schemaVersion) ? manifest.schemaVersion : null);
  if (remoteVersion !== null && !isManifestCompatible(remoteVersion)) {
    // Mark processed so the watcher doesn't replay it on every file event,
    // but emit a clear signal to the UI so the user knows a peer is on a
    // newer protocol and they should upgrade PortOS to consume their shares.
    await markProcessed(bucketId, manifestFilename, manifest.id);
    sharingEvents.emit('incompatible-manifest', {
      bucketId, manifestId: manifest.id, manifestFilename,
      remoteVersion, localVersion: SHARING_SCHEMA_VERSION,
      producedByVersion: manifest.producedByVersion || 'unknown',
      source: manifest.source || 'unknown',
    });
    console.log(`⚠️ sharing: bucket=${bucket.name} manifest=${manifest.id} schemaVersion=${remoteVersion} > local=${SHARING_SCHEMA_VERSION} — refusing import (peer producedBy=${manifest.producedByVersion || 'unknown'})`);
    return { skipped: true, reason: 'incompatible-version', remoteVersion, localVersion: SHARING_SCHEMA_VERSION };
  }
  // PORTOS SCHEMA-VERSION GATE — even when the share-protocol schemaVersion
  // is compatible, the manifest's per-category storage layout versions
  // (`portosSchemaVersions`, e.g. `{ universes: 5 }`) may exceed what this
  // PortOS can apply. We refuse the import AND mark it processed (see the
  // dedup rationale in the branch below) — so retry-after-upgrade is NOT
  // automatic; the user clears the bucket cursor (or unshare/reshares) once
  // they've upgraded. Emits a `portos-schema-ahead` event the UI uses to
  // render a persistent "Update PortOS to import this share" badge.
  const senderSchemaVersions = isPlainObject(manifest.portosSchemaVersions)
    ? manifest.portosSchemaVersions
    : {};
  // Scope the gate to the categories this manifest actually carries, so an
  // ahead-mismatch on a category the manifest doesn't touch can't refuse the
  // import. Full union diff stays available for diagnostics.
  const portosFullDiff = compareSchemaVersions(senderSchemaVersions, PORTOS_SCHEMA_VERSIONS);
  const portosDiff = scopeVersionDiff(portosFullDiff, relevantSchemaCategoriesForManifest(manifest));
  if (portosDiff.ahead.length > 0) {
    // Mark processed so subsequent chokidar fan-outs (every asset/record
    // file landing under the bucket triggers a backlog scan that re-walks
    // every manifest) don't re-fire this event 100× per bundle. Mirrors
    // the sibling `incompatible-version` branch above. Trade-off: when the
    // user upgrades PortOS, they must clear the cursor entry to retry the
    // import (or unshare/reshare from the sender side). Without this dedup,
    // the event spams logs + the socket channel on every receive cycle.
    await markProcessed(bucketId, manifestFilename, manifest.id);
    sharingEvents.emit('portos-schema-ahead', {
      bucketId, manifestId: manifest.id, manifestFilename,
      ahead: portosDiff.ahead,
      behind: portosDiff.behind,
      producedByVersion: manifest.producedByVersion || 'unknown',
      source: manifest.source || 'unknown',
    });
    console.log(
      `⚠️ sharing: bucket=${bucket.name} manifest=${manifest.id} — ${formatVersionGap(portosDiff)} ` +
      `(producedBy=${manifest.producedByVersion || 'unknown'}). Update PortOS to import; clear the bucket cursor after upgrade to retry.`,
    );
    return {
      skipped: true,
      reason: 'portos-schema-ahead',
      ahead: portosDiff.ahead,
      behind: portosDiff.behind,
      producedByVersion: manifest.producedByVersion || 'unknown',
    };
  }
  // Annotation manifests bypass the records/assets/applyMerge pipeline — they
  // carry a per-instance annotation snapshot at records/media-annotations/<id>.json
  // that merges author-by-author into data/media-annotations.json.
  if (manifest.kind === 'media-annotations') {
    const outcome = await processAnnotationManifest(bucket, manifest);
    // If the per-instance record JSON hasn't synced yet (cloud sync can deliver
    // the manifest before the record), leave the manifest un-cursored so the
    // watcher retries when records/ changes. Mirrors the asset/record pending
    // path below — without this, a manifest delivered before its record would
    // get markProcessed'd permanently and the annotation update would be lost.
    if (outcome.missing) {
      outcome.pendingRecords = [manifest.recordIds?.[0] || manifest.senderInstanceId];
      sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
      console.log(`⏳ sharing: bucket=${bucket.name} manifest=${manifest.id} kind=media-annotations waitingForRecord=${outcome.reason}`);
      return { processed: true, pending: true, manifest, outcome };
    }
    await markProcessed(bucketId, manifestFilename, manifest.id);
    sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
    console.log(`📥 sharing: bucket=${bucket.name} manifest=${manifest.id} kind=media-annotations applied=${outcome.applied}`);
    return { processed: true, manifest, outcome };
  }
  const { records, missing: missingRecords } = await readReferencedRecords(bucket.path, manifest);

  // Always copy assets + media-job records ahead of the merge so canon and
  // pipeline records that reference them point at present files. Asset and
  // record-bundle sync can both lag behind manifest sync in Drive/Dropbox/etc.;
  // apply what exists now and leave the manifest un-cursored until the rest
  // arrives (the watcher re-fires backlog on records/ + assets/ changes).
  const assetCopy = await copyAssetsLocally(bucket.path, manifestAssetRefs(manifest));
  const availableAssetKeys = new Set(assetCopy.available.map((ref) => `${ref.kind}:${ref.ref}`));
  await mergeMediaJobRecords(bucket.path, manifest.recordIds);

  let outcome;
  if (bucket.mode === 'auto-merge') {
    outcome = { mode: 'auto-merge', ...(await applyAutoMerge(bucket, manifest, records, { availableAssetKeys })) };
  } else {
    outcome = { mode: 'inbox', ...(await applyInbox(bucket, manifest, manifestFilename, records)) };
  }
  // A manifest is pending when any of these still need to land before the
  // cursor advances: asset blobs, referenced record JSONs, OR an owner
  // record (universe or series) referenced by the manifest's collection
  // payload that hasn't been imported yet. The last two cases can happen
  // when the owner record failed to import (corrupt JSON, schema-version
  // mismatch) or the manifest references an owner id not listed in
  // `recordIds`.
  const collectionPendingUniverse = outcome?.collectionPendingUniverse || null;
  const collectionPendingSeries = outcome?.collectionPendingSeries || null;
  const collectionTombstonedUniverse = outcome?.collectionTombstonedUniverse || null;
  const legacyCanonPendingUniverses = outcome?.legacyCanonPendingUniverses || null;
  const legacyCanonPendingFailures = outcome?.legacyCanonPendingFailures || null;
  const recordImportFailures = outcome?.recordImportFailures || null;
  // Tombstoned universe: the collection owner IS on disk but locally deleted.
  // Unlike the truly-missing case this will never self-resolve via sync, so we
  // advance the cursor (no infinite pending loop) and emit a clear signal. The
  // user must restore the deleted universe to import the N deferred items.
  if (collectionTombstonedUniverse) {
    await markProcessed(bucketId, manifestFilename, manifest.id);
    sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
    console.log(`⚠️ sharing: bucket=${bucket.name} manifest=${manifest.id} kind=${manifest.kind} collectionUniverse=${collectionTombstonedUniverse} is deleted locally — ${outcome.collectionItemsDeferred ?? 0} item(s) skipped; restore universe to import`);
    return { processed: true, manifest, outcome };
  }
  if (assetCopy.missing.length > 0 || missingRecords.length > 0 || collectionPendingUniverse || collectionPendingSeries || legacyCanonPendingUniverses || legacyCanonPendingFailures || recordImportFailures) {
    if (assetCopy.missing.length > 0) outcome.pendingAssets = assetCopy.missing;
    if (missingRecords.length > 0) outcome.pendingRecords = missingRecords;
    if (collectionPendingUniverse) outcome.pendingCollectionUniverse = collectionPendingUniverse;
    if (collectionPendingSeries) outcome.pendingCollectionSeries = collectionPendingSeries;
    if (legacyCanonPendingUniverses) outcome.pendingLegacyCanonUniverses = legacyCanonPendingUniverses;
    if (legacyCanonPendingFailures) outcome.pendingLegacyCanonFailures = legacyCanonPendingFailures;
    if (recordImportFailures) outcome.pendingRecordImportFailures = recordImportFailures;
    sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
    console.log(`⏳ sharing: bucket=${bucket.name} manifest=${manifest.id} kind=${manifest.kind} mode=${bucket.mode} waitingForAssets=${assetCopy.missing.length} waitingForRecords=${missingRecords.length}${collectionPendingUniverse ? ` waitingForUniverse=${collectionPendingUniverse}` : ''}${collectionPendingSeries ? ` waitingForSeries=${collectionPendingSeries}` : ''}${legacyCanonPendingUniverses ? ` waitingForLegacyCanonUniverses=${legacyCanonPendingUniverses.join(',')}` : ''}${legacyCanonPendingFailures ? ` legacyCanonFailures=${legacyCanonPendingFailures.join(',')}` : ''}${recordImportFailures ? ` recordImportFailures=${recordImportFailures.join(',')}` : ''}`);
    return { processed: true, pending: true, manifest, outcome };
  }
  await markProcessed(bucketId, manifestFilename, manifest.id);

  sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
  console.log(`📥 sharing: bucket=${bucket.name} manifest=${manifest.id} kind=${manifest.kind} mode=${bucket.mode} ${outcome.applied !== undefined ? `applied=${outcome.applied}` : `queued=${outcome.queued}`}`);
  return { processed: true, manifest, outcome };
}

/**
 * Drop inbox items that are no longer importable:
 *   - Self-authored: this instance produced the manifest (pre-fix releases
 *     surfaced these as pending imports). Items predating the
 *     `senderInstanceId` field are backfilled by reading the underlying
 *     manifest.
 *   - Orphan: the manifest file is gone from the bucket. `promoteInboxItem`
 *     would fail anyway; clearing them lets the UI advance instead of
 *     stranding zombie rows the user must hand-dismiss.
 */
async function pruneSelfAuthoredInbox(bucket, localInstanceId) {
  const inbox = await readInbox(bucket.id);
  const items = Array.isArray(inbox.items) ? inbox.items : [];
  if (items.length === 0) return { pruned: 0, orphaned: 0 };

  let changed = false;
  let orphaned = 0;
  const kept = [];
  for (const it of items) {
    const manifestPath = join(bucket.path, 'manifests', it.manifestFilename);
    if (!existsSync(manifestPath)) {
      orphaned += 1;
      changed = true;
      continue;
    }
    let sender = it.senderInstanceId || null;
    let backfilled = it;
    if (!sender) {
      const m = await readManifest(bucket.path, it.manifestFilename).catch(() => null);
      sender = m?.senderInstanceId || null;
      if (sender) {
        backfilled = { ...it, senderInstanceId: sender };
        changed = true;
      }
    }
    if (isSelfAuthored(sender, localInstanceId)) {
      changed = true;
      continue;
    }
    kept.push(backfilled);
  }
  const pruned = items.length - kept.length - orphaned;
  if (changed) {
    inbox.items = kept;
    await writeInbox(bucket.id, inbox);
    if (pruned > 0 || orphaned > 0) {
      sharingEvents.emit('inbox-updated', { bucketId: bucket.id });
      console.log(`🧹 sharing: bucket=${bucket.name} pruned ${pruned} self-authored + ${orphaned} orphan inbox item(s)`);
    }
  }
  return { pruned, orphaned };
}

/** On startup or registration, scan the manifests dir for unprocessed entries. */
export async function processBacklog(bucketId) {
  const bucket = await getBucket(bucketId);
  const localInstanceId = await getInstanceId().catch(() => null);
  await pruneSelfAuthoredInbox(bucket, localInstanceId).catch((err) => {
    console.log(`⚠️ sharing.importer: pruneSelfAuthoredInbox failed: ${err.message}`);
  });
  const manifestsDir = join(bucket.path, 'manifests');
  if (!existsSync(manifestsDir)) return { processed: 0 };
  const filenames = (await readdir(manifestsDir).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .sort();
  let processed = 0;
  for (const f of filenames) {
    const res = await processManifest(bucketId, f).catch((err) => {
      console.log(`⚠️ sharing.importer: processManifest failed for ${f}: ${err.message}`);
      return null;
    });
    if (res?.processed) processed++;
  }
  return { processed };
}

/** Promote a pending inbox item: re-process it via the auto-merge path. */
export async function promoteInboxItem(bucketId, manifestId) {
  const inbox = await readInbox(bucketId);
  const idx = (inbox.items || []).findIndex((it) => it.manifestId === manifestId);
  if (idx < 0) throw Object.assign(new Error(`Inbox item not found: ${manifestId}`), { code: 'SHARING_INBOX_NOT_FOUND' });
  const item = inbox.items[idx];
  const bucket = await getBucket(bucketId);
  const manifest = await readManifest(bucket.path, item.manifestFilename);
  if (!manifest) throw new Error(`Manifest no longer exists in bucket: ${item.manifestFilename}`);
  const { records, missing: missingRecords } = await readReferencedRecords(bucket.path, manifest);
  if (missingRecords.length > 0) {
    throw Object.assign(new Error(`Manifest records are still syncing (${missingRecords.length} missing)`), {
      code: 'SHARING_RECORDS_PENDING',
      missingRecords,
    });
  }
  const assetCopy = await copyAssetsLocally(bucket.path, manifestAssetRefs(manifest));
  if (assetCopy.missing.length > 0) {
    throw Object.assign(new Error(`Manifest assets are still syncing (${assetCopy.missing.length} missing)`), {
      code: 'SHARING_ASSETS_PENDING',
      missingAssets: assetCopy.missing,
    });
  }
  await mergeMediaJobRecords(bucket.path, manifest.recordIds);
  const availableAssetKeys = new Set(assetCopy.available.map((ref) => `${ref.kind}:${ref.ref}`));
  const outcome = await applyAutoMerge(bucket, manifest, records, { availableAssetKeys });
  // Mirror the missing-record/asset gates above: if the collection
  // payload deferred because its owner (universe or series) isn't
  // present locally yet, throw a pending error instead of silently
  // dropping the inbox item. Otherwise the user's "promote" click
  // would consume the inbox row while the collection items never landed.
  if (outcome.collectionTombstonedUniverse) {
    throw Object.assign(new Error(`Universe ${outcome.collectionTombstonedUniverse} was deleted locally; restore it to import ${outcome.collectionItemsDeferred ?? 0} collection item(s)`), {
      code: 'SHARING_UNIVERSE_TOMBSTONED',
      collectionTombstonedUniverse: outcome.collectionTombstonedUniverse,
    });
  }
  if (outcome.collectionPendingUniverse) {
    throw Object.assign(new Error(`Collection payload waiting on universe ${outcome.collectionPendingUniverse} to be imported first`), {
      code: 'SHARING_UNIVERSE_PENDING',
      pendingCollectionUniverse: outcome.collectionPendingUniverse,
    });
  }
  if (outcome.collectionPendingSeries) {
    throw Object.assign(new Error(`Collection payload waiting on series ${outcome.collectionPendingSeries} to be imported first`), {
      code: 'SHARING_SERIES_PENDING',
      pendingCollectionSeries: outcome.collectionPendingSeries,
    });
  }
  // Same gate for the legacy-canon migration: a pre-B.4 series whose linked
  // universe isn't local or whose helper threw transiently must keep the
  // inbox row so the user can re-promote after fixing the missing universe
  // or the transient I/O issue. Without this, the user's "promote" click
  // would consume the inbox row while the series merge silently skipped.
  if (outcome.legacyCanonPendingUniverses) {
    throw Object.assign(new Error(`Legacy series canon waiting on universe ${outcome.legacyCanonPendingUniverses.join(', ')} to be imported first`), {
      code: 'SHARING_LEGACY_CANON_UNIVERSE_PENDING',
      pendingLegacyCanonUniverses: outcome.legacyCanonPendingUniverses,
    });
  }
  if (outcome.legacyCanonPendingFailures) {
    throw Object.assign(new Error(`Legacy series canon migration failed for ${outcome.legacyCanonPendingFailures.join(', ')} — retry after resolving the underlying error`), {
      code: 'SHARING_LEGACY_CANON_FAILED',
      pendingLegacyCanonFailures: outcome.legacyCanonPendingFailures,
    });
  }
  // Drop from inbox.
  inbox.items.splice(idx, 1);
  await writeInbox(bucketId, inbox);
  sharingEvents.emit('inbox-updated', { bucketId });
  return { promoted: true, outcome };
}

/**
 * A subscription file disappeared from the bucket — the upstream peer
 * unsubscribed. We clear the cursor entry so a future re-share of the same
 * record imports cleanly, drop any pending inbox entry for that subscription,
 * and emit a socket signal. We DO NOT delete the local imported record:
 * the recipient keeps whatever they already received.
 */
export async function handleUnshare(bucketId, manifestFilename) {
  const cursor = await readCursor(bucketId);
  const wasTracked = manifestFilename in (cursor.processedById || {})
    || (Array.isArray(cursor.processed) && cursor.processed.includes(manifestFilename));
  const inbox = await readInbox(bucketId);
  const inboxHit = (inbox.items || []).some((it) => it.manifestFilename === manifestFilename);
  // chokidar fires `unlink` for any file under the watched dir. If we never
  // saw the filename as a manifest, treat the unlink as noise — no cursor
  // write, no inbox write, no socket emit.
  if (!wasTracked && !inboxHit) return { handled: true, wasTracked: false };

  await forgetProcessed(bucketId, manifestFilename);
  if (inboxHit) {
    inbox.items = inbox.items.filter((it) => it.manifestFilename !== manifestFilename);
    await writeInbox(bucketId, inbox);
  }
  sharingEvents.emit('unshared', { bucketId, manifestFilename });
  console.log(`📤 sharing: bucket=${bucketId} manifest=${manifestFilename} unshared by peer`);
  return { handled: true, wasTracked };
}

export async function dismissInboxItem(bucketId, manifestId) {
  const inbox = await readInbox(bucketId);
  const before = (inbox.items || []).length;
  inbox.items = (inbox.items || []).filter((it) => it.manifestId !== manifestId);
  if (inbox.items.length === before) throw Object.assign(new Error(`Inbox item not found: ${manifestId}`), { code: 'SHARING_INBOX_NOT_FOUND' });
  await writeInbox(bucketId, inbox);
  sharingEvents.emit('inbox-updated', { bucketId });
  return { dismissed: true };
}

export async function listInbox(bucketId) {
  const inbox = await readInbox(bucketId);
  return Array.isArray(inbox.items) ? inbox.items : [];
}
