/** Merge shared records and linked media collections into the local domain stores. */

import { getUniverse, preserveLegacyUniverseFields, insertUniverseWithId, updateUniverse } from '../universeBuilder.js';
import {
  findOrCreateUniverseCollection, findOrCreateSeriesCollection, addItem as addCollectionItem,
  ERR_DUPLICATE as COLLECTION_ERR_DUPLICATE,
} from '../mediaCollections.js';
import { logFailureWithStack } from '../../lib/failureLogging.js';
import { getSeries, insertSeriesWithId, updateSeries } from '../pipeline/series.js';
import { basename } from 'path';
import { withReexportSuppressed, adoptImportedSubscription } from './subscriptions.js';
import {
  setSyncBaseHash, contentHashForRecord, maybeJournalBeforeOverwrite, flushBaseHashes,
} from '../../lib/conflictJournal.js';
import { applyLegacySeriesCanonToUniverse } from '../pipeline/migrateSeriesCanon.js';
import { getIssue, insertIssueWithId, updateIssue } from '../pipeline/issues.js';
import { isSafeRecordId } from '../../lib/zodCompat.js';
import { readJSONFile } from '../../lib/fileUtils.js';
import { bucketRecordPath } from './buckets.js';
import { mergeReviewFromSync } from '../pipeline/manuscriptReview.js';
import { mergeOutlineFromSync } from '../pipeline/reverseOutline.js';
import { isPlainObject } from '../../lib/objects.js';

// Record kinds that participate in the non-blocking conflict journal. Universe,
// series, AND issue all seed a base hash on first import and archive a losing
// local version before an LWW overwrite. (Media collections are journaled
// separately via their own merge path; see mediaCollections.js.)
const JOURNALED_KINDS = new Set(['universe', 'series', 'issue']);

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
  let collectionPromise;
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
    collectionPromise = findOrCreateUniverseCollection({
      universeId: payload.universeId,
      universeName,
      description: payload.description || '',
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
      collectionPromise = findOrCreateUniverseCollection({
        universeId: localUniverse.id,
        universeName: localUniverse.name,
        description: payload.description || '',
      });
    } else {
      const fallbackRaw = typeof payload.name === 'string' ? payload.name : '';
      const fallbackName = fallbackRaw.replace(/^Series:\s*/i, '').trim() || payload.seriesId;
      const seriesName = typeof localSeries.name === 'string' && localSeries.name.trim()
        ? localSeries.name
        : fallbackName;
      collectionPromise = findOrCreateSeriesCollection({
        seriesId: payload.seriesId,
        seriesName,
        description: payload.description || '',
      });
    }
  }
  const owner = payload.universeId ? `universe:${payload.universeId}` : `series:${payload.seriesId}`;
  const collection = await collectionPromise.catch((err) => {
    logFailureWithStack(`⚠️ sharing.importer: find or create collection for ${owner} failed`, err);
    return null;
  });
  if (!collection) return { itemsAdded: 0, failures: [owner] };
  let added = 0;
  let deferred = 0;
  const failures = [];
  for (const item of payload.items) {
    if (!item?.kind || !item?.ref) continue;
    if (availableAssetKeys && !availableAssetKeys.has(`${item.kind}:${basename(item.ref)}`)) {
      deferred += 1;
      continue;
    }
    const result = await addCollectionItem(collection.id, item).catch((err) => {
      if (err?.code === COLLECTION_ERR_DUPLICATE) return null;
      logFailureWithStack(`⚠️ sharing.importer: addCollectionItem failed for ${item.ref}`, err);
      failures.push(`${item.kind}:${item.ref}`);
      return null;
    });
    if (result) added += 1;
  }
  return { itemsAdded: added, itemsDeferred: deferred, failures };
}

function createRecordMerger(bucket, manifest) {
  const outcome = { applied: 0, overridden: [], failedInserts: [] };
  const senderCannotRepresentClimax = (Number(manifest?.portosSchemaVersions?.pipelineIssues) || 0) < 3;
  const senderUniversesVersion = Number(manifest?.portosSchemaVersions?.universes) || 0;
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
          logFailureWithStack(`⚠️ sharing.importer: insertWithId(${kind}=${record.id}) failed`, err);
          outcome.failedInserts.push(`${kind}:${record.id}`);
          return false;
        });
      if (insertOk) {
        outcome.applied++;
        // Seed the conflict-journal base hash for a freshly-imported record so
        // its FIRST cross-install divergence is journaled (the sync merge paths
        // seed on their insert branch too; without this a bucket-imported
        // record has base==null and the first conflict would be missed). Hash
        // the STORED record so the base matches a future `local` hash exactly.
        if (JOURNALED_KINDS.has(kind)) {
          const stored = await getFn(record.id).catch(() => null);
          if (stored) await setSyncBaseHash(kind, record.id, contentHashForRecord(kind, stored));
        }
      }
      return;
    }
    // Cheap out-of-queue early-out: a local copy already at or past the remote
    // clock can only move further ahead, so there is nothing to apply. The
    // authoritative comparison re-runs below INSIDE the owning write queue.
    if (!remoteWins(existing.updatedAt, record.updatedAt)) return;
    // Re-read, compare, journal, and persist inside the domain write queue so a
    // local edit that lands after the read above can't be clobbered by this
    // older snapshot (#10761). `updatedAt: record.updatedAt` keeps the winning
    // SOURCE clock — a receipt-time stamp would out-rank the next delayed source
    // revision and silently drop it once its manifest is marked processed.
    let wrote = false;
    await withReexportSuppressed(suppressKind, suppressId, () => updateFn(existing.id, async (latest) => {
      if (!remoteWins(latest.updatedAt, record.updatedAt)) return null;
      let incoming = record;
      // A remote series that arrived without a universe link (an orphan on the
      // sender — older peer, or a record whose link was cleared before the
      // hierarchy rule shipped) must NOT clear the local link: updateSeries
      // refuses to unlink a linked series and would throw, aborting the whole
      // manifest. Preserve the existing link (a *move* to a different non-empty
      // universe still applies). Mirrors the legacy-canon re-stamp below, but
      // for every series — not just ones carrying legacy canon arrays.
      if (kind === 'series' && !incoming.universeId && latest.universeId) {
        incoming = { ...incoming, universeId: latest.universeId };
      }
      if (kind === 'issue' && senderCannotRepresentClimax
        && latest.arcRole === 'climax' && incoming.arcRole !== 'climax') {
        incoming = { ...incoming, arcRole: 'climax' };
      }
      if (kind === 'universe') {
        incoming = preserveLegacyUniverseFields(incoming, latest, senderUniversesVersion);
      }
      // Non-blocking conflict journal for every synced record kind — a
      // share-bucket import that LWW-overwrites a locally-diverged record
      // archives the losing local version first.
      if (JOURNALED_KINDS.has(kind)) {
        await maybeJournalBeforeOverwrite({
          kind, id: incoming.id, local: latest, remote: incoming,
          source: { via: 'share-bucket', bucketId: bucket.id, peerId: manifest.senderInstanceId ?? null },
        });
      }
      wrote = true;
      return incoming;
    }, { updatedAt: record.updatedAt }));
    // Count only a write the queue actually performed — a newer local edit that
    // landed first turns this merge into a no-op.
    if (wrote) {
      outcome.overridden.push({ kind, id: record.id, label });
      outcome.applied++;
    }
  };
  return { mergeOne, outcome };
}

async function mergeUniverses(universes, mergeOne) {
  // Universes first — series may reference them via universeId.
  // updateUniverse's mutator form (which mergeOne always uses) also skips the
  // service-side `referenceSheetImageRef` preservation guard (gated on
  // `!isMutator`): sync's intent is that the remote's newer record wins LWW,
  // including server-owned operational pointers like the rendered sheet
  // filename. A literal-patch call would let the local stale pointer
  // overwrite the remote's freshly-rendered one.
  for (const uni of universes) {
    await mergeOne({
      kind: 'universe', record: uni, label: uni.name,
      getFn: getUniverse, insertFn: insertUniverseWithId, updateFn: updateUniverse,
    });
  }
}

async function mergeSeries(series, mergeOne) {
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
  for (const s of series) {
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
      logFailureWithStack(`⚠️ sharing.importer: legacy series canon migration for ${s.id} failed`, err);
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
      console.error(`⚠️ sharing.importer: skipping series ${s.id} merge — missing universe ${r.universeId}`);
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

  for (const s of series) {
    if (skipSeriesMerge.has(s.id)) continue;
    await mergeOne({
      kind: 'series', record: s, label: s.name,
      getFn: getSeries, insertFn: insertSeriesWithId, updateFn: updateSeries,
    });
  }
  return { skipSeriesMerge, legacyCanonPendingUniverses, legacyCanonPendingFailures };
}

async function mergeIssues(issues, mergeOne) {
  for (const iss of issues) {
    await mergeOne({
      kind: 'issue', record: iss, label: iss.title,
      getFn: getIssue, insertFn: insertIssueWithId, updateFn: updateIssue,
    });
  }
}

// Only merge sibling documents declared by this manifest. A previous export may
// have left a stale file behind. Failed writes must keep the manifest retryable.
async function mergeSeriesDocuments(bucketPath, series, skipped, refs, directory, label, merge) {
  const declared = new Set((Array.isArray(refs) ? refs : []).filter(isSafeRecordId));
  const failures = [];
  for (const { id } of series) {
    if (skipped.has(id) || !declared.has(id)) continue;
    // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
    const doc = await readJSONFile(bucketRecordPath(bucketPath, directory, id), null, { logError: false });
    if (doc) {
      await merge(id, doc).catch((err) => {
        logFailureWithStack(`⚠️ sharing.importer: ${label} merge for ${id} failed`, err);
        failures.push(id);
      });
    }
  }
  return failures;
}

async function mergeLinkedCollection(manifest, availableAssetKeys) {
  // Universe and series shares can both carry a linked media collection
  // payload. Items are unioned into a local "Universe: <name>" or
  // "Series: <name>" collection so peer-generated images appear alongside
  // the owner record in the recipient's UI.
  let itemsAdded = 0;
  let itemsDeferred = 0;
  let collectionPendingUniverse = null;
  let collectionPendingSeries = null;
  let collectionTombstonedUniverse = null;
  let collectionMergeFailures = null;
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
    // `mergeCollectionPayload` defers when the referenced owner record
    // hasn't been imported locally yet. Propagate that as a pending
    // condition so processManifest leaves the cursor un-advanced and the
    // watcher retries — otherwise the manifest is marked processed and
    // the deferred items never land if the owner record arrives in a
    // later (independent) sync.
    if (r.missingUniverse) collectionPendingUniverse = manifest.collection.universeId;
    if (r.missingSeries) collectionPendingSeries = manifest.collection.seriesId;
    if (r.tombstonedUniverse) collectionTombstonedUniverse = r.tombstonedUniverse;
    if (r.failures?.length) collectionMergeFailures = r.failures;
  }
  return { itemsAdded, itemsDeferred, collectionPendingUniverse, collectionPendingSeries, collectionTombstonedUniverse, collectionMergeFailures };
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
export async function applyAutoMerge(bucket, manifest, records, { availableAssetKeys = null } = {}) {
  const { mergeOne, outcome } = createRecordMerger(bucket, manifest);
  const inboundSub = manifest.subscription?.recordKind && manifest.subscription?.recordId
    ? { bucketId: bucket.id, recordKind: manifest.subscription.recordKind, recordId: manifest.subscription.recordId }
    : null;
  const inboundRecordsForKind = (recordKind) => {
    if (recordKind === 'series') return records.series;
    if (recordKind === 'universe') return records.universes;
    return [];
  };

  await mergeUniverses(records.universes, mergeOne);
  const { skipSeriesMerge, legacyCanonPendingUniverses, legacyCanonPendingFailures } = await mergeSeries(records.series, mergeOne);
  await mergeIssues(records.issues, mergeOne);
  const reviewMergeFailures = await mergeSeriesDocuments(bucket.path, records.series, skipSeriesMerge,
    manifest.reviewRefs, 'reviews', 'manuscript-review', mergeReviewFromSync);
  const outlineMergeFailures = await mergeSeriesDocuments(bucket.path, records.series, skipSeriesMerge,
    manifest.outlineRefs, 'outlines', 'reverse-outline', mergeOutlineFromSync);
  const {
    itemsAdded, itemsDeferred, collectionPendingUniverse, collectionPendingSeries, collectionTombstonedUniverse, collectionMergeFailures,
  } = await mergeLinkedCollection(manifest, availableAssetKeys);

  let adoptedSubscription = null;
  if (inboundSub && inboundRecordsForKind(inboundSub.recordKind).some((record) => record.id === inboundSub.recordId)) {
    adoptedSubscription = await adoptImportedSubscription({
      ...inboundSub,
      lastManifestId: manifest.id,
    }).catch((err) => {
      logFailureWithStack(`⚠️ sharing.importer: adopt subscription failed for ${inboundSub.recordKind}/${inboundSub.recordId}`, err);
      return null;
    });
  }

  // Persist the batched conflict-journal base-hash updates accumulated above.
  await flushBaseHashes();

  return {
    applied: outcome.applied + itemsAdded,
    overridden: outcome.overridden,
    collectionItemsAdded: itemsAdded,
    collectionItemsDeferred: itemsDeferred,
    collectionPendingUniverse,
    collectionPendingSeries,
    collectionTombstonedUniverse,
    collectionMergeFailures,
    legacyCanonPendingUniverses: legacyCanonPendingUniverses.length > 0 ? legacyCanonPendingUniverses : null,
    legacyCanonPendingFailures: legacyCanonPendingFailures.length > 0 ? legacyCanonPendingFailures : null,
    recordImportFailures: outcome.failedInserts.length > 0 ? outcome.failedInserts : null,
    reviewMergeFailures: reviewMergeFailures.length > 0 ? reviewMergeFailures : null,
    outlineMergeFailures: outlineMergeFailures.length > 0 ? outlineMergeFailures : null,
    adoptedSubscription: adoptedSubscription
      ? { id: adoptedSubscription.id, bucketId: adoptedSubscription.bucketId, recordKind: adoptedSubscription.recordKind, recordId: adoptedSubscription.recordId }
      : null,
  };
}
