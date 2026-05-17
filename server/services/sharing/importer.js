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
 * Asset blobs referenced by the manifest are copied from the bucket's
 * `assets/{images,videos}/` into the local `data/{images,videos}/` directories
 * (skip-if-present). Media-job records bundled in `records/media/` are merged
 * into `data/media-jobs.json` so re-render workflows have the prompt + params.
 */

import { join, basename } from 'path';
import { copyFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { PATHS, ensureDir, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { getBucket } from './buckets.js';
import { readManifest, markProcessed, readCursor, hasBeenProcessed, forgetProcessed } from './manifest.js';
import { SHARING_SCHEMA_VERSION, isManifestCompatible } from './version.js';
import { insertSeriesWithId, updateSeries, getSeries } from '../pipeline/series.js';
import { insertIssueWithId, updateIssue, getIssue } from '../pipeline/issues.js';
import { insertUniverseWithId, updateUniverse, getUniverse } from '../universeBuilder.js';
import { findOrCreateCollectionByName, addItem as addCollectionItem, ERR_DUPLICATE as COLLECTION_ERR_DUPLICATE } from '../mediaCollections.js';
import { adoptImportedSubscription, withReexportSuppressed } from './subscriptions.js';
import { getInstanceId } from '../instances.js';
import { mergePeerAnnotations } from '../mediaAnnotations.js';
import { isStr } from '../../lib/storyBible.js';

const UNKNOWN_INSTANCE_ID = 'unknown';

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
 * the collection by `universeId` (with name as a fallback), then add each
 * remote item via `addItem` — `ERR_DUPLICATE` errors are expected and
 * swallowed (the item already exists locally; nothing to do).
 *
 * The asset blobs are NOT copied here — `copyAssetsLocally` (called in
 * `processManifest`) already pulled every available asset entry. This function
 * only persists collection membership for items whose blobs are present so the
 * UI does not point at files that Google Drive has not synced yet.
 */
async function mergeCollectionPayload(payload, availableAssetKeys = null) {
  if (!payload?.universeId || !Array.isArray(payload.items)) return { itemsAdded: 0 };
  const collection = await findOrCreateCollectionByName({
    name: payload.name || `Universe: ${payload.universeId}`,
    description: payload.description || '',
    universeId: payload.universeId,
  }).catch((err) => {
    console.log(`⚠️ sharing.importer: findOrCreateCollectionByName failed: ${err.message}`);
    return null;
  });
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

function manifestAssetRefs(manifest) {
  const refs = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw || !isStr(raw.ref)) return;
    const kind = raw.kind === 'video' ? 'video' : 'image';
    const filename = basename(raw.ref);
    if (!filename || filename !== raw.ref) return;
    const key = `${kind}:${filename}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, ref: filename });
  };
  for (const ref of manifest?.assetRefs || []) push(ref);
  // Universe collection payloads are also asset membership. Import from the
  // payload so late-arriving Drive files can be copied and added incrementally
  // even if assetRefs was incomplete in an older manifest.
  for (const item of manifest?.collection?.items || []) push(item);
  return refs;
}

/** Copy bundled assets from the bucket into local data dirs. Runs in parallel. */
async function copyAssetsLocally(bucketPath, assetRefs) {
  await ensureDir(PATHS.images);
  await ensureDir(PATHS.videos);
  const copied = [];
  const available = [];
  const missing = [];
  await Promise.all((assetRefs || []).map(async (ref) => {
    if (!ref || !isStr(ref.ref)) return;
    const filename = basename(ref.ref);
    const isVideo = ref.kind === 'video';
    const sourceDir = join(bucketPath, 'assets', isVideo ? 'videos' : 'images');
    const targetDir = isVideo ? PATHS.videos : PATHS.images;
    const sourcePath = join(sourceDir, filename);
    const targetPath = join(targetDir, filename);
    if (!existsSync(sourcePath)) {
      missing.push({ kind: isVideo ? 'video' : 'image', ref: filename });
      return;
    }
    available.push({ kind: isVideo ? 'video' : 'image', ref: filename });
    if (!existsSync(targetPath)) {
      await copyFile(sourcePath, targetPath);
      copied.push({ kind: isVideo ? 'video' : 'image', ref: filename });
    }
    if (!isVideo) {
      const sidecarBase = filename.replace(/\.(png|jpe?g|webp)$/i, '') + '.metadata.json';
      const sidecarSource = join(sourceDir, sidecarBase);
      if (existsSync(sidecarSource)) {
        const sidecarTarget = join(targetDir, sidecarBase);
        if (!existsSync(sidecarTarget)) await copyFile(sidecarSource, sidecarTarget);
      }
    }
  }));
  return { copied, available, missing };
}

async function processAnnotationManifest(bucket, manifest) {
  const recordId = (manifest.recordIds || [])[0] || manifest.senderInstanceId;
  if (!recordId) return { applied: 0, missing: true, reason: 'no-record-id' };
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
  const inboundSub = manifest.subscription?.recordKind && manifest.subscription?.recordId
    ? { bucketId: bucket.id, recordKind: manifest.subscription.recordKind, recordId: manifest.subscription.recordId }
    : null;
  const inboundRecordsForKind = (recordKind) => {
    if (recordKind === 'series') return records.series;
    if (recordKind === 'universe') return records.universes;
    return [];
  };

  const mergeOne = async ({ kind, record, getFn, insertFn, updateFn, label }) => {
    const existing = await getFn(record.id).catch(() => null);
    if (!existing) {
      await insertFn(record).catch((err) => {
        // Duplicate id is benign — a parallel manifest already inserted it.
        if (err?.code?.endsWith('_DUPLICATE')) return null;
        console.log(`⚠️ sharing.importer: insertWithId(${kind}=${record.id}) failed: ${err.message}`);
      });
      applied++;
      return;
    }
    if (remoteWins(existing.updatedAt, record.updatedAt)) {
      const suppressKind = kind === 'issue' ? 'series' : kind;
      const suppressId = kind === 'issue' ? record.seriesId : record.id;
      await withReexportSuppressed(suppressKind, suppressId, () => updateFn(existing.id, record));
      overridden.push({ kind, id: record.id, label });
      applied++;
    }
  };

  // Universes first — series may reference them via universeId.
  for (const uni of records.universes) {
    await mergeOne({
      kind: 'universe', record: uni, label: uni.name,
      getFn: getUniverse, insertFn: insertUniverseWithId, updateFn: updateUniverse,
    });
  }
  for (const s of records.series) {
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

  // Universe shares can carry a linked media collection payload. Items
  // are unioned into a local "Universe: <name>" collection so peer-
  // generated images appear alongside the universe in the recipient's UI.
  let itemsAdded = 0;
  let itemsDeferred = 0;
  if (manifest.collection) {
    const r = await withReexportSuppressed('universe', manifest.collection.universeId, () =>
      mergeCollectionPayload(manifest.collection, availableAssetKeys));
    itemsAdded = r.itemsAdded;
    itemsDeferred = r.itemsDeferred || 0;
    if (itemsAdded > 0) applied += itemsAdded;
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

  return {
    applied,
    overridden,
    collectionItemsAdded: itemsAdded,
    collectionItemsDeferred: itemsDeferred,
    adoptedSubscription: adoptedSubscription
      ? { id: adoptedSubscription.id, bucketId: adoptedSubscription.bucketId, recordKind: adoptedSubscription.recordKind, recordId: adoptedSubscription.recordId }
      : null,
  };
}

const INBOX_MAX = 1000;

/**
 * Inbox mode: write the manifest + record refs to the bucket's inbox for review.
 *
 * For subscription manifests we replace any prior inbox entry for the same
 * (recordKind, recordId) so a sender's repeated edits don't pile up as N
 * inbox items — the user always sees the latest snapshot. One-shot manifests
 * dedup by manifest id.
 */
async function applyInbox(bucket, manifest, manifestFilename, records) {
  const inbox = await readInbox(bucket.id);
  inbox.items = Array.isArray(inbox.items) ? inbox.items : [];
  const sub = manifest.subscription;
  if (sub?.recordKind && sub?.recordId) {
    inbox.items = inbox.items.filter((it) => !(it.subscription
      && it.subscription.recordKind === sub.recordKind
      && it.subscription.recordId === sub.recordId));
  } else if (inbox.items.some((it) => it.manifestId === manifest.id)) {
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
  if (assetCopy.missing.length > 0 || missingRecords.length > 0) {
    if (assetCopy.missing.length > 0) outcome.pendingAssets = assetCopy.missing;
    if (missingRecords.length > 0) outcome.pendingRecords = missingRecords;
    sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
    console.log(`⏳ sharing: bucket=${bucket.name} manifest=${manifest.id} kind=${manifest.kind} mode=${bucket.mode} waitingForAssets=${assetCopy.missing.length} waitingForRecords=${missingRecords.length}`);
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
