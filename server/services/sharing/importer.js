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
 * in `records/media/` are handed to the media queue (which owns
 * `data/media-jobs.json`) so re-render workflows have the prompt + params.
 */

import { createHash } from 'crypto';
import { SHARING_SCHEMA_VERSION, isManifestCompatible } from './version.js';
import {
  PORTOS_SCHEMA_VERSIONS, RECORD_KIND_SCHEMA_CATEGORIES, compareSchemaVersions, scopeVersionDiff,
  formatVersionGap,
} from '../../lib/schemaVersions.js';
import { isSafeRecordId } from '../../lib/zodCompat.js';
import { bucketRecordPath, getBucket } from './buckets.js';
import { readJSONFile } from '../../lib/fileUtils.js';
import { mergePeerAnnotations } from '../mediaAnnotations.js';
import { sharingEvents, isSelfAuthored, applyInbox, pruneSelfAuthoredInbox } from './importerInbox.js';
import { isPlainObject } from '../../lib/objects.js';
import { readManifest, readCursor, hasBeenProcessed, isRefusalCurrent, markProcessed, markRefused } from './manifest.js';
import { getInstanceId } from '../instanceIdentity.js';
import {
  readReferencedRecords, missingDeclaredReviews, missingDeclaredOutlines, mergeMediaJobRecords,
} from './importerRecords.js';
import { copyAssetsLocally, manifestAssetRefs } from './importerAssets.js';
import { applyAutoMerge } from './importerAutoMerge.js';
import { logFailureWithStack } from '../../lib/failureLogging.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';

export {
  dismissInboxItem, handleUnshare, listInbox, promoteInboxItem, sharingEvents,
} from './importerInbox.js';

// Everything on the receiving side that the two compatibility gates in
// `processManifest` read. A refusal recorded under this fingerprint stays quiet
// until an upgrade changes one of them.
const LOCAL_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify({
    sharing: SHARING_SCHEMA_VERSION,
    portos: PORTOS_SCHEMA_VERSIONS,
    categories: RECORD_KIND_SCHEMA_CATEGORIES,
  }))
  .digest('hex')
  .slice(0, 16);

async function processAnnotationManifest(bucket, manifest) {
  const recordId = (manifest.recordIds || [])[0] || manifest.senderInstanceId;
  if (!recordId) return { applied: 0, missing: true, reason: 'no-record-id' };
  if (!isSafeRecordId(recordId)) return { applied: 0, missing: true, reason: 'bad-record-id' };
  const recordPath = bucketRecordPath(bucket.path, 'media-annotations', recordId);
  // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
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
  if (isRefusalCurrent(cursor, manifestFilename, manifest.id, LOCAL_SCHEMA_FINGERPRINT)) {
    return { skipped: true, reason: 'already-refused' };
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
    // Record the refusal so the watcher doesn't replay it on every file event,
    // and emit a clear signal so the user knows a peer is on a newer protocol.
    // The refusal lapses when an upgrade changes this install's schema, so
    // the share imports on the next backlog walk.
    await markRefused(bucketId, manifestFilename, manifest.id, LOCAL_SCHEMA_FINGERPRINT);
    sharingEvents.emit('incompatible-manifest', {
      bucketId, manifestId: manifest.id, manifestFilename,
      remoteVersion, localVersion: SHARING_SCHEMA_VERSION,
      producedByVersion: manifest.producedByVersion || 'unknown',
      source: manifest.source || 'unknown',
    });
    console.error(`⚠️ sharing: bucket=${bucket.name} manifest=${manifest.id} schemaVersion=${remoteVersion} > local=${SHARING_SCHEMA_VERSION} — refusing import (peer producedBy=${manifest.producedByVersion || 'unknown'})`);
    return { skipped: true, reason: 'incompatible-version', remoteVersion, localVersion: SHARING_SCHEMA_VERSION };
  }
  // PORTOS SCHEMA-VERSION GATE — even when the share-protocol schemaVersion
  // is compatible, the manifest's per-category storage layout versions
  // (`portosSchemaVersions`, e.g. `{ universes: 5 }`) may exceed what this
  // PortOS can apply. We refuse the import and record the refusal against
  // this install's schema (see the dedup rationale in the branch below), so
  // the first backlog walk after an upgrade retries it. Emits a
  // `portos-schema-ahead` event; `shareRefusalNotifier.js` turns it into a
  // persistent "Update PortOS to import this share" bell card.
  const senderSchemaVersions = isPlainObject(manifest.portosSchemaVersions)
    ? manifest.portosSchemaVersions
    : {};
  // Scope the gate to the categories this manifest actually carries, so an
  // ahead-mismatch on a category the manifest doesn't touch can't refuse the
  // import. Full union diff stays available for diagnostics.
  const portosFullDiff = compareSchemaVersions(senderSchemaVersions, PORTOS_SCHEMA_VERSIONS);
  const portosDiff = scopeVersionDiff(portosFullDiff, relevantSchemaCategoriesForManifest(manifest));
  if (portosDiff.ahead.length > 0) {
    // Record the refusal so subsequent watcher fan-outs (every asset/record
    // file landing under the bucket triggers a backlog scan that re-walks
    // every manifest) don't re-fire this event 100× per bundle. Mirrors
    // the sibling `incompatible-version` branch above. The record is bound to
    // this install's schema fingerprint, so an upgrade lifts it and the
    // boot backlog walk imports the share without cursor surgery.
    await markRefused(bucketId, manifestFilename, manifest.id, LOCAL_SCHEMA_FINGERPRINT);
    sharingEvents.emit('portos-schema-ahead', {
      bucketId, manifestId: manifest.id, manifestFilename,
      ahead: portosDiff.ahead,
      behind: portosDiff.behind,
      producedByVersion: manifest.producedByVersion || 'unknown',
      source: manifest.source || 'unknown',
    });
    console.log(
      `⚠️ sharing: bucket=${bucket.name} manifest=${manifest.id} — ${formatVersionGap(portosDiff)} ` +
      `(producedBy=${manifest.producedByVersion || 'unknown'}). Update PortOS to import — it retries after the upgrade.`,
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

  // Declared manuscript-review files (records/reviews/<seriesId>.json) that the
  // manifest says are bundled but haven't landed on disk yet. Cloud-relayed
  // buckets (Drive/Dropbox) deliver files out of order, so the manifest can be
  // processed before its review file syncs; without this wait the importer
  // would read null, treat it as "no review", and markProcessed — permanently
  // dropping the review. Mirror the missingRecords pending gate. Legacy
  // manifests have no `reviewRefs` → empty → no wait (back-compat).
  const missingReviews = await missingDeclaredReviews(bucket.path, manifest);
  // Declared reverse-outline files not yet on disk (#1348) — same out-of-order
  // cloud-delivery wait as missingReviews. Legacy manifests → empty → no wait.
  const missingOutlines = await missingDeclaredOutlines(bucket.path, manifest);

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
  const collectionTombstonedUniverse = outcome?.collectionTombstonedUniverse || null;
  // Tombstoned universe: the collection owner IS on disk but locally deleted.
  // Unlike the truly-missing case this will never self-resolve via sync, so we
  // advance the cursor (no infinite pending loop) and emit a clear signal. The
  // user must restore the deleted universe to import the N deferred items.
  if (collectionTombstonedUniverse) {
    await markProcessed(bucketId, manifestFilename, manifest.id);
    sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
    console.error(`⚠️ sharing: bucket=${bucket.name} manifest=${manifest.id} kind=${manifest.kind} collectionUniverse=${collectionTombstonedUniverse} is deleted locally — ${outcome.collectionItemsDeferred ?? 0} item(s) skipped; restore universe to import`);
    return { processed: true, manifest, outcome };
  }
  // Each row is checked once for "is this still pending?", assigned onto
  // `outcome.<key>` once, and formatted into the `⏳ sharing:` log line once —
  // rather than the same eleven conditions repeated across a trigger check,
  // an assignment block, and a log-suffix template (#6845).
  const PENDING_SIGNALS = [
    { key: 'pendingAssets', value: assetCopy.missing, label: 'waitingForAssets', format: 'count', alwaysLog: true },
    { key: 'pendingRecords', value: missingRecords, label: 'waitingForRecords', format: 'count', alwaysLog: true },
    { key: 'pendingReviews', value: missingReviews, label: 'waitingForReviews', format: 'count' },
    { key: 'pendingOutlines', value: missingOutlines, label: 'waitingForOutlines', format: 'count' },
    { key: 'pendingCollectionUniverse', value: outcome?.collectionPendingUniverse || null, label: 'waitingForUniverse', format: 'value' },
    { key: 'pendingCollectionSeries', value: outcome?.collectionPendingSeries || null, label: 'waitingForSeries', format: 'value' },
    { key: 'pendingLegacyCanonUniverses', value: outcome?.legacyCanonPendingUniverses || null, label: 'waitingForLegacyCanonUniverses', format: 'list' },
    { key: 'pendingLegacyCanonFailures', value: outcome?.legacyCanonPendingFailures || null, label: 'legacyCanonFailures', format: 'list' },
    { key: 'pendingRecordImportFailures', value: outcome?.recordImportFailures || null, label: 'recordImportFailures', format: 'list' },
    { key: 'pendingReviewMergeFailures', value: outcome?.reviewMergeFailures || null, label: 'reviewMergeFailures', format: 'list' },
    { key: 'pendingOutlineMergeFailures', value: outcome?.outlineMergeFailures || null, label: 'outlineMergeFailures', format: 'list' },
  ];
  const isPendingSignalSet = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));
  const activePendingSignals = PENDING_SIGNALS.filter((signal) => isPendingSignalSet(signal.value));
  if (activePendingSignals.length > 0) {
    for (const { key, value } of activePendingSignals) outcome[key] = value;
    const suffix = PENDING_SIGNALS
      .filter((signal) => signal.alwaysLog || isPendingSignalSet(signal.value))
      .map(({ value, label, format }) => ` ${label}=${format === 'count' ? value.length : format === 'list' ? value.join(',') : value}`)
      .join('');
    sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
    console.log(`⏳ sharing: bucket=${bucket.name} manifest=${manifest.id} kind=${manifest.kind} mode=${bucket.mode}${suffix}`);
    return { processed: true, pending: true, manifest, outcome };
  }
  await markProcessed(bucketId, manifestFilename, manifest.id);

  sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
  console.log(`📥 sharing: bucket=${bucket.name} manifest=${manifest.id} kind=${manifest.kind} mode=${bucket.mode} ${outcome.applied !== undefined ? `applied=${outcome.applied}` : `queued=${outcome.queued}`}`);
  return { processed: true, manifest, outcome };
}

/** On startup or registration, scan the manifests dir for unprocessed entries. */
export async function processBacklog(bucketId) {
  const bucket = await getBucket(bucketId);
  const localInstanceId = await getInstanceId().catch(() => null);
  await pruneSelfAuthoredInbox(bucket, localInstanceId).catch((err) => {
    logFailureWithStack('⚠️ sharing.importer: pruneSelfAuthoredInbox failed', err);
  });
  const manifestsDir = join(bucket.path, 'manifests');
  if (!existsSync(manifestsDir)) return { processed: 0 };
  const filenames = (await readdir(manifestsDir).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .sort();
  let processed = 0;
  for (const f of filenames) {
    const res = await processManifest(bucketId, f).catch((err) => {
      logFailureWithStack(`⚠️ sharing.importer: processManifest failed for ${f}`, err);
      return null;
    });
    if (res?.processed) processed++;
  }
  return { processed };
}
