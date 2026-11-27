/** Serialize shared-inbox changes and promote verified manifests into live state. */

import { UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';
import { EventEmitter } from 'events';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile, atomicWrite } from '../../lib/fileUtils.js';
import { existsSync } from 'fs';
import { readManifest, readCursor, forgetProcessed } from './manifest.js';
import { getBucket } from './buckets.js';
import {
  readReferencedRecords, missingDeclaredReviews, missingDeclaredOutlines, mergeMediaJobRecords,
} from './importerRecords.js';
import { copyAssetsLocally, manifestAssetRefs } from './importerAssets.js';
import { applyAutoMerge } from './importerAutoMerge.js';

export function isSelfAuthored(senderInstanceId, localInstanceId) {
  return !!localInstanceId
    && !!senderInstanceId
    && senderInstanceId !== UNKNOWN_INSTANCE_ID
    && senderInstanceId === localInstanceId;
}

export const sharingEvents = new EventEmitter();

const queueInboxWrite = createKeyCachedQueue();

const inboxPath = (bucketId) => join(PATHS.data, 'sharing', 'inbox', `${bucketId}.json`);

async function readInbox(bucketId) {
  await ensureDir(join(PATHS.data, 'sharing', 'inbox'));
  return readJSONFile(inboxPath(bucketId), { items: [] }, { logError: false, strict: true });
}

async function writeInbox(bucketId, inbox) {
  await ensureDir(join(PATHS.data, 'sharing', 'inbox'));
  await atomicWrite(inboxPath(bucketId), inbox);
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
export async function applyInbox(bucket, manifest, manifestFilename, records) {
  return queueInboxWrite(bucket.id, async () => {
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
  });
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
 * Drop inbox items that are no longer importable:
 *   - Self-authored: this instance produced the manifest (pre-fix releases
 *     surfaced these as pending imports). Items predating the
 *     `senderInstanceId` field are backfilled by reading the underlying
 *     manifest.
 *   - Orphan: the manifest file is gone from the bucket. `promoteInboxItem`
 *     would fail anyway; clearing them lets the UI advance instead of
 *     stranding zombie rows the user must hand-dismiss.
 */
export async function pruneSelfAuthoredInbox(bucket, localInstanceId) {
  return queueInboxWrite(bucket.id, async () => {
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
  });
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
  // Same out-of-order delivery guard as the auto-merge path: a declared review
  // file that hasn't landed (or is present-but-unparseable) must block the
  // promote, or applyAutoMerge would read null and silently drop the review.
  const missingReviews = await missingDeclaredReviews(bucket.path, manifest);
  if (missingReviews.length > 0) {
    throw Object.assign(new Error(`Manifest reviews are still syncing (${missingReviews.length} missing)`), {
      code: 'SHARING_REVIEWS_PENDING',
      missingReviews,
    });
  }
  // Same out-of-order delivery guard for the reverse-outline sibling doc (#1348).
  const missingOutlines = await missingDeclaredOutlines(bucket.path, manifest);
  if (missingOutlines.length > 0) {
    throw Object.assign(new Error(`Manifest outlines are still syncing (${missingOutlines.length} missing)`), {
      code: 'SHARING_OUTLINES_PENDING',
      missingOutlines,
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
  // A transient manuscript-review merge failure must also keep the inbox row —
  // otherwise the manual promote consumes it while the bundled review silently
  // never lands (the review has no independent reconciliation cycle).
  if (outcome.reviewMergeFailures) {
    throw Object.assign(new Error(`Manuscript-review merge failed for ${outcome.reviewMergeFailures.join(', ')} — retry after resolving the underlying error`), {
      code: 'SHARING_REVIEW_MERGE_FAILED',
      reviewMergeFailures: outcome.reviewMergeFailures,
    });
  }
  // Same for a transient reverse-outline merge failure (#1348) — the outline has
  // no independent reconciliation cycle either, so keep the inbox row for retry.
  if (outcome.outlineMergeFailures) {
    throw Object.assign(new Error(`Reverse-outline merge failed for ${outcome.outlineMergeFailures.join(', ')} — retry after resolving the underlying error`), {
      code: 'SHARING_OUTLINE_MERGE_FAILED',
      outlineMergeFailures: outcome.outlineMergeFailures,
    });
  }
  // Drop from inbox.
  await queueInboxWrite(bucketId, async () => {
    const live = await readInbox(bucketId);
    const liveIdx = (live.items || []).findIndex((it) => it.manifestId === manifestId);
    if (liveIdx < 0) return;
    live.items.splice(liveIdx, 1);
    await writeInbox(bucketId, live);
  });
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
    || manifestFilename in (cursor.refusedById || {})
    || (Array.isArray(cursor.processed) && cursor.processed.includes(manifestFilename));
  const inboxHit = await queueInboxWrite(bucketId, async () => {
    const inbox = await readInbox(bucketId);
    const hit = (inbox.items || []).some((it) => it.manifestFilename === manifestFilename);
    if (hit) {
      inbox.items = inbox.items.filter((it) => it.manifestFilename !== manifestFilename);
      await writeInbox(bucketId, inbox);
    }
    return hit;
  });
  // Ignore unlink noise for files we have never imported or queued.
  if (!wasTracked && !inboxHit) return { handled: true, wasTracked: false };
  await forgetProcessed(bucketId, manifestFilename);
  sharingEvents.emit('unshared', { bucketId, manifestFilename });
  console.log(`📤 sharing: bucket=${bucketId} manifest=${manifestFilename} unshared by peer`);
  return { handled: true, wasTracked };
}

export async function dismissInboxItem(bucketId, manifestId) {
  return queueInboxWrite(bucketId, async () => {
    const inbox = await readInbox(bucketId);
    const before = (inbox.items || []).length;
    inbox.items = (inbox.items || []).filter((it) => it.manifestId !== manifestId);
    if (inbox.items.length === before) throw Object.assign(new Error(`Inbox item not found: ${manifestId}`), { code: 'SHARING_INBOX_NOT_FOUND' });
    await writeInbox(bucketId, inbox);
    sharingEvents.emit('inbox-updated', { bucketId });
    return { dismissed: true };
  });
}

export async function listInbox(bucketId) {
  const inbox = await readInbox(bucketId);
  return Array.isArray(inbox.items) ? inbox.items : [];
}
