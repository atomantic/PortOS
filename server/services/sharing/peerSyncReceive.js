/**
 * Federated peer-sync — receiver-side push handler.
 *
 * `applyIncomingPush` merges an inbound record via the existing
 * `merge*FromSync` LWW paths, computes the missing-asset / missing-body diff
 * the sender must satisfy, kicks off the background asset pull, advances
 * tombstone cursors, and (best-effort) creates a reverse subscription back to
 * the sender. Asset diffing + pulling live in `peerSyncAssets.js`.
 *
 * Split out of the former 4,004-line peerSync.js (#1830).
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/storyBible.js';
import { isPlainObject } from '../../lib/objects.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { getOrComputeImageSha256 } from '../../lib/assetHash.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { pullSidecarForImage } from './sidecarSync.js';
import { sanitizeAssetFilename } from './buckets.js';
import {
  PORTOS_SCHEMA_VERSIONS,
  RECORD_KIND_SCHEMA_CATEGORIES,
  compareSchemaVersions,
  scopeVersionDiff,
  formatVersionGap,
  getPortosVersion,
} from '../../lib/schemaVersions.js';
import { UNKNOWN_INSTANCE_ID } from '../instances.js';
import { getUniverse, mergeUniversesFromSync } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync } from '../pipeline/series.js';
import { mergeIssuesFromSync } from '../pipeline/issues.js';
import { getCollection, mergeMediaCollectionsFromSync } from '../mediaCollections.js';
import { getAuthor, mergeAuthorsFromSync } from '../authors/index.js';
import { getArtist, mergeArtistsFromSync } from '../artists/index.js';
import { getAlbum, mergeAlbumsFromSync } from '../albums/index.js';
import { getTrack, mergeTracksFromSync } from '../tracks/index.js';
import { getProject, mergeProjectsFromSync } from '../creativeDirector/local.js';
import { getProject as getMusicVideoProject, mergeProjectsFromSync as mergeMusicVideoProjectsFromSync } from '../musicVideo/projects.js';
import { getBoard, mergeBoardsFromSync } from '../moodBoard/index.js';
import {
  getWorkForSync,
  mergeWorksFromSync,
  diffWorkBodyManifest,
  getFolderForSync,
  mergeFoldersFromSync,
  getExerciseForSync,
  mergeExercisesFromSync,
} from '../writersRoom/sync.js';
import { WRITERS_ROOM_DRAFT_ASSET_KIND } from '../writersRoom/syncLogic.js';
import { WORK_ID_RE, DRAFT_ID_RE, wrWorkDir, wrDraftPath } from '../writersRoom/_shared.js';
import {
  initCursor,
  ackDeletesUpTo,
} from './peerTombstoneCursors.js';
import {
  diffAssetManifestAgainstLocal,
  directoryForAssetKind,
  pullMissingAssetsFromPeer,
  pullMissingWorkBodies,
} from './peerSyncAssets.js';
import { findPeerSubscription, subscribePeer } from './peerSync.js';
import {
  makeErr,
  isNonEmptyStr,
  findPeerById,
  peerSyncEvents,
  ERR_VALIDATION,
  ERR_SCHEMA_VERSION_AHEAD,
  PEER_SUBSCRIBABLE_KINDS,
} from './peerSyncShared.js';


/**
 * Apply a received catalog bundle on the receiver. Reuses
 * `catalogSync.applyRemoteChanges` so the bundle goes through the exact same
 * per-row LWW upsert + schema gate + try/catch isolation as direct catalog
 * sync — we forward `portosMeta` so applyRemoteChanges runs the gate itself
 * (defense in depth; the push-level gate already ran). Postgres-only; the
 * applyIncomingPush caller already null-checks `catalogBundle`, but we re-gate
 * the backend here so a stray call on a non-Postgres install is a clean no-op.
 */
async function applyCatalogBundle(catalogBundle, portosMeta) {
  const { getBackendName } = await import('../memoryBackend.js');
  if (getBackendName() !== 'postgres') return;
  const { applyRemoteChanges } = await import('../catalogSync.js');
  await applyRemoteChanges({
    ingredients: Array.isArray(catalogBundle.ingredients) ? catalogBundle.ingredients : [],
    refs: Array.isArray(catalogBundle.refs) ? catalogBundle.refs : [],
    portosMeta,
  });
}

// --- Receiver-side push handler -----------------------------------------

/**
 * Apply an incoming push to local state. Wraps the existing `merge*FromSync`
 * dispatch + computes the asset-diff response + (best-effort) creates a
 * reverse subscription back to the sender so subsequent edits flow both
 * ways without manual re-configuration.
 *
 * The HTTP route in Stage 3 will be a thin wrapper around this — validate
 * the body shape, call this function, return the response.
 */
export async function applyIncomingPush(payload) {
  if (!isPlainObject(payload)) {
    throw makeErr('payload must be an object', ERR_VALIDATION);
  }
  const { kind, record, issues, linkedCollection, linkedTrack, catalogBundle, manuscriptReview, reverseOutline, assetManifest, draftBodyManifest, sourceInstanceId, portosMeta } = payload;
  if (!PEER_SUBSCRIBABLE_KINDS.includes(kind)) {
    throw makeErr(`unknown kind: ${kind}`, ERR_VALIDATION);
  }
  // Identity + record-shape checks happen BEFORE the schema-version gate.
  // The gate's 409 body includes `receiverSchemaVersions: PORTOS_SCHEMA_VERSIONS`
  // — a (mild) version-fingerprint disclosure — and we don't want to surface
  // it to callers that haven't even identified themselves correctly. Move
  // the cheap shape validation first so unidentified or malformed requests
  // get a clean 400 with no version information.
  if (!isNonEmptyStr(sourceInstanceId) || sourceInstanceId === UNKNOWN_INSTANCE_ID) {
    throw makeErr('sourceInstanceId required (and not "unknown")', ERR_VALIDATION);
  }
  if (!isPlainObject(record) || !isNonEmptyStr(record.id)) {
    throw makeErr('record must be an object with a string id', ERR_VALIDATION);
  }

  // SCHEMA-VERSION GATE — runs BEFORE any merge so a sender on a newer
  // storage layout can't corrupt local state. Legacy senders without
  // `portosMeta` pass through (comparator treats absent as zero/no-contract;
  // their record went through the same v0 → vN sanitizer chain we already
  // run). When the sender is AHEAD on any category, we reject with a
  // structured error the route layer maps to HTTP 409 + body so the sender
  // can persist the gap on the subscription and surface it in the UI.
  //
  // We do NOT reject on "sender behind" here — the sanitizer's existing
  // backfill chain handles older inputs in-place. A future forward-only
  // contract (e.g. a required field that the sanitizer can't synthesize)
  // can opt into a behind-gate; the comparator already surfaces both
  // directions for that purpose.
  const senderSchemaVersions = isPlainObject(portosMeta?.schemaVersions) ? portosMeta.schemaVersions : {};
  const senderPortosVersion = typeof portosMeta?.portosVersion === 'string' ? portosMeta.portosVersion : null;
  // Per-category gate, scoped to the categories THIS push actually writes a
  // LIVE (non-tombstone) record into. A sender ahead on an unrelated category
  // no longer rejects this push; the full union diff stays for diagnostics.
  //
  // Tombstones are folded INTO the per-category scoping rather than exempted
  // wholesale. A tombstone payload carries only id+deleted+deletedAt+updatedAt
  // — fields that exist at EVERY schema version and can't corrupt local state
  // — so its category needn't gate, and exempting it keeps federated deletes
  // converging even when one peer upgrades ahead (otherwise blockedBySchema →
  // edit-push cooldown → the delete never lands). BUT a deleted `series` push
  // still bundles its LIVE child issues (deleteSeries does not cascade-
  // tombstone them; buildPushPayload ships every child so the receiver can
  // finish its cascade), and those live, full-shape issue records WOULD
  // corrupt an older receiver. So gate a category only when it carries at
  // least one live record:
  const relevantCategories = new Set();
  if (record.deleted !== true) {
    for (const c of (RECORD_KIND_SCHEMA_CATEGORIES[kind] || [])) relevantCategories.add(c);
  }
  if (kind === 'series' && Array.isArray(issues) && issues.some((i) => i?.deleted !== true)) {
    for (const c of RECORD_KIND_SCHEMA_CATEGORIES.issue) relevantCategories.add(c);
  }
  // A linked collection only rides a non-deleted push (buildPushPayload drops
  // it for tombstones) and is itself a live record when present. This gate
  // mirrors the merge predicate's OWNER-tombstone check (the merge refuses the
  // collection when the owner record is a tombstone) — so the gate never
  // blocks `mediaCollections` over a collection the merge would ignore. It is
  // intentionally MORE permissive on the collection itself: the extra
  // `linkedCollection.deleted !== true` check here is defensive (today's
  // exporter never bundles a deleted collection), and a tombstone collection
  // is schema-version-safe at any version anyway, so it needn't gate.
  if (record.deleted !== true && isPlainObject(linkedCollection) && linkedCollection.deleted !== true) {
    for (const c of RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection) relevantCategories.add(c);
  }
  // A catalog bundle ships catalog-schema-shaped ingredient rows. Gate the
  // `catalog` category whenever the bundle carries at least one LIVE ingredient
  // — a sender ahead on `catalog` would push forward-shaped payload an older
  // receiver can't interpret. Tombstone-only bundles (all ingredients deleted)
  // are id+deleted+deletedAt+updatedAt — safe at every version, so they needn't
  // gate (same reasoning as the tombstone-record exemption above).
  if (record.deleted !== true && isPlainObject(catalogBundle) &&
      Array.isArray(catalogBundle.ingredients) &&
      catalogBundle.ingredients.some((i) => i?.deleted !== true)) {
    for (const c of (RECORD_KIND_SCHEMA_CATEGORIES['cat-ingredient'] || ['catalog'])) relevantCategories.add(c);
  }
  const fullDiff = compareSchemaVersions(senderSchemaVersions, PORTOS_SCHEMA_VERSIONS);
  const versionDiff = scopeVersionDiff(fullDiff, [...relevantCategories]);
  if (versionDiff.ahead.length > 0) {
    console.warn(
      `⚠️ peerSync: rejecting push from ${sourceInstanceId} — ${formatVersionGap(versionDiff)} (sender PortOS ${senderPortosVersion || 'unknown'})`,
    );
    // Surface the receiver's PortOS version so the sender can show the user
    // *which* version their peer is on (the label the user thinks of as "the
    // peer's PortOS version"). Without this field the sender's UI would fall
    // back to its own version, which is misleading.
    const receiverPortosVersion = await getPortosVersion().catch(() => null);
    throw makeErr(
      `sender's schema is ahead — receiver cannot apply (${formatVersionGap(versionDiff)})`,
      ERR_SCHEMA_VERSION_AHEAD,
      {
        ahead: versionDiff.ahead,
        behind: versionDiff.behind,
        senderPortosVersion,
        receiverPortosVersion,
        receiverSchemaVersions: PORTOS_SCHEMA_VERSIONS,
      },
    );
  }

  // Look up the LOCAL record state BEFORE merging so we can detect the
  // "local user marked this record ephemeral" case. The merge functions
  // already silently drop ephemeral records, but the side effects below
  // (linkedCollection merge, asset pull, reverse subscription) ran
  // unconditionally — meaning a stale peer subscription could still
  // mutate a local collection, download bytes the user opted out of, and
  // auto-create a reverse sub the user explicitly torn down. Computing
  // `localEphemeral` here is one extra read but closes the gap.
  let localEphemeral = false;
  if (kind === 'universe') {
    const local = await getUniverse(record.id, { includeDeleted: true }).catch(() => null);
    localEphemeral = local?.ephemeral === true;
  } else if (kind === 'series') {
    const local = await getSeries(record.id, { includeDeleted: true }).catch(() => null);
    localEphemeral = local?.ephemeral === true;
  } else if (kind === 'musicVideoProject') {
    // #1858: the music-video push now carries a secondary `linkedTrack` bundle,
    // so it needs the same opt-out gate — a stale peer push must not plant a
    // track record for a project the user marked ephemeral.
    const local = await getMusicVideoProject(record.id, { includeDeleted: true }).catch(() => null);
    localEphemeral = local?.ephemeral === true;
  }

  // Merge into local state via the existing LWW path. The merge functions
  // honor `deleted: true` + bump `updatedAt`, so this is the single
  // tombstone-aware reconciliation point. Attribute any conflict journaled by
  // the merge to THIS push's origin peer so the Conflicts tab can show which
  // peer collided (without `source`, the merge fns fall back to
  // `{ via:'sync', peerId:null }` and the attribution is lost).
  const source = { via: 'peer-push', peerId: sourceInstanceId };
  // Set true when a bundled manuscript-review merge throws — returned to the
  // sender so it withholds lastPushedHash and retries (the review has no other
  // reconciliation path; see the merge block below).
  let reviewSyncPending = false;
  // Same contract as reviewSyncPending, for the bundled reverse-outline doc.
  let outlineSyncPending = false;
  // Set true when a writersRoomWork merge accepted the remote (insert/remote-won)
  // — gates whether a present-but-different local draft body may be overwritten.
  let workMergeApplied = false;
  if (kind === 'universe') {
    await mergeUniversesFromSync([record], { source });
  } else if (kind === 'series') {
    await mergeSeriesFromSync([record], { source });
    // Bundled issues: skip the entire batch if the LOCAL series is
    // ephemeral. mergeSeriesFromSync already refused the parent record on
    // its own, but child issue merges are a separate code path —
    // `updateSeries` doesn't auto-flip child issues' `ephemeral` flag when
    // the parent is marked ephemeral, so without this gate a stale reverse
    // subscription could overwrite the private fork's issue stages.
    if (!localEphemeral && Array.isArray(issues) && issues.length > 0) {
      await mergeIssuesFromSync(issues, { source });
    }
    // Merge the bundled manuscript-review sibling doc, LWW-per-comment. Same
    // guards as the issue batch + linkedCollection below: skip for local-
    // ephemeral records (the user opted this series out of sync) and tombstone
    // pushes (a deleted series carries no live review). A merge failure must
    // NOT fail the push (the series/issues already merged) — but unlike the
    // linkedCollection bundle, the review has NO independent reconciliation
    // cycle, so a swallowed failure could never resend once the sender saves
    // lastPushedHash. Signal `reviewSyncPending` so the sender withholds the
    // hash (mirrors the missing-assets guard) and retries next cycle.
    // Dynamic import keeps the arcPlanner graph off peerSync's load path.
    if (!localEphemeral && record.deleted !== true && isPlainObject(manuscriptReview)) {
      const { mergeReviewFromSync } = await import('../pipeline/manuscriptReview.js');
      await mergeReviewFromSync(record.id, manuscriptReview).catch((err) => {
        console.log(`⚠️ peerSync: manuscriptReview merge failed: ${err.message}`);
        reviewSyncPending = true;
      });
    }
    // Merge the bundled reverse-outline sibling doc, whole-doc LWW on
    // generatedAt. Same ephemeral/tombstone guards + pending-signal contract as
    // the review above: a merge failure must withhold the sender's hash so the
    // outline (which has no independent reconciliation cycle) re-sends next
    // cycle. Dynamic import keeps the arcPlanner graph off peerSync's load path.
    if (!localEphemeral && record.deleted !== true && isPlainObject(reverseOutline)) {
      const { mergeOutlineFromSync } = await import('../pipeline/reverseOutline.js');
      await mergeOutlineFromSync(record.id, reverseOutline).catch((err) => {
        console.log(`⚠️ peerSync: reverseOutline merge failed: ${err.message}`);
        outlineSyncPending = true;
      });
    }
  } else if (kind === 'mediaCollection') {
    await mergeMediaCollectionsFromSync([record], { source });
  } else if (kind === 'author') {
    await mergeAuthorsFromSync([record], { source });
  } else if (kind === 'artist') {
    await mergeArtistsFromSync([record], { source });
  } else if (kind === 'album') {
    await mergeAlbumsFromSync([record], { source });
  } else if (kind === 'track') {
    await mergeTracksFromSync([record], { source });
  } else if (kind === 'creativeDirectorProject') {
    await mergeProjectsFromSync([record], { source });
  } else if (kind === 'moodBoard') {
    await mergeBoardsFromSync([record], { source });
  } else if (kind === 'writersRoomWork') {
    const mergeResult = await mergeWorksFromSync([record], { source });
    // Did the receiver accept the remote work (insert / remote-won LWW)? This
    // gates whether a PRESENT-but-different local draft body may be overwritten —
    // a stale push that lost the LWW must NOT clobber newer local prose.
    workMergeApplied = mergeResult?.applied === true;
  } else if (kind === 'writersRoomFolder') {
    await mergeFoldersFromSync([record], { source });
  } else if (kind === 'writersRoomExercise') {
    await mergeExercisesFromSync([record], { source });
  } else if (kind === 'musicVideoProject') {
    await mergeMusicVideoProjectsFromSync([record], { source });
    // #1858: merge the bundled linked track record so a receiver WITHOUT the
    // Tracks category can still resolve `project.trackId` (getTrack) at render
    // time. The audio bytes already pulled via assetManifest. Non-fatal: the
    // project itself is merged; skip on a tombstone push, a local-ephemeral
    // (opted-out) project, or a missing bundle — same contract as linkedCollection.
    if (!localEphemeral && record.deleted !== true && isPlainObject(linkedTrack)) {
      await mergeTracksFromSync([linkedTrack], { source }).catch((err) => {
        console.log(`⚠️ peerSync: linkedTrack merge failed: ${err.message}`);
      });
    }
  }

  // Apply the bundled collection (if any) — same LWW + union-of-items
  // semantics as the snapshot-sync mediaCollections category. Failures here
  // don't fail the push: the record itself is already merged and the next
  // snapshot-sync cycle will reconcile the collection if it diverged. The
  // sanitizer in mediaCollections drops a peer-supplied `id` that isn't a
  // valid path-segment (the store's id allowlist), so a bogus payload can't
  // plant a malformed row or abort the batch.
  //
  // Defense in depth on the peer-supplied envelope:
  //   - plain-object check (arrays would get wrapped and the sanitizer
  //     would drop them, but skipping early avoids the wasted call)
  //   - refuse to merge when the record is a tombstone (`deleted === true`)
  //     — the sender already skips bundling for tombstones, so a present
  //     `linkedCollection` on a tombstone push is either a bug or a
  //     malicious peer trying to resurrect a collection during delete
  //     propagation.
  //   - refuse to merge when the LOCAL record is ephemeral — the user
  //     explicitly opted out of sync for this record, so peer-pushed
  //     collection mutations must not land.
  if (!localEphemeral && record.deleted !== true && isPlainObject(linkedCollection)) {
    await mergeMediaCollectionsFromSync([linkedCollection], { source }).catch((err) => {
      console.log(`⚠️ peerSync: linkedCollection merge failed: ${err.message}`);
    });
  }

  // Apply the bundled catalog rows (ingredients + universe→ingredient refs)
  // through the same LWW upsert path as direct catalog sync. Same guards as the
  // linkedCollection merge: skip for local-ephemeral records and tombstone
  // pushes (a deleted universe's catalog refs tombstone locally on the next
  // catalog-sync cycle; resurrecting them here would be wrong). Postgres-only
  // and best-effort — a failure doesn't fail the push (the universe record is
  // already merged; the receiver's backfill still derives a lossy view, and
  // the next catalog-sync cycle reconciles the enriched rows).
  if (!localEphemeral && record.deleted !== true && isPlainObject(catalogBundle)) {
    await applyCatalogBundle(catalogBundle, portosMeta).catch((err) => {
      console.log(`⚠️ peerSync: catalog bundle apply failed: ${err.message}`);
    });
  }

  // Diff incoming asset manifest against local disk. We (the receiver) are
  // the ones that will background-pull `missingAssets` from the sender's
  // `/data/{images,image-refs,videos}/<filename>` static mount in Stage 3
  // — the sender just needs to keep those files served, no action required
  // from it here. We return the list to the sender in the response so it
  // can surface progress in its UI ("N/M assets still syncing to peer X").
  // For local-ephemeral records, skip the diff entirely so we don't even
  // report a non-empty missingAssets back to the sender (which would
  // surface a "still syncing" UI for a record we silently refused).
  const missingAssets = localEphemeral ? [] : await diffAssetManifestAgainstLocal(assetManifest);

  // Compute the deletedAt water-mark we can ack. Use the maximum across the
  // record + its issues (a single push can carry multiple tombstones).
  // We return this to the sender so THEY can advance THEIR cursor (which
  // tracks what we — the receiver — have acked of THEIR pushes). We do
  // NOT call ackDeletesUpTo here: that would write
  // `localCursors[sourceInstanceId] = ackedDeletesUpTo`, which is
  // mis-directional. Our cursors track "what peer X has acked of OUR
  // local deletions" so tombstoneGc can prune our local tombstones once
  // every subscribed peer has confirmed receipt. The receive-side ack
  // here would let GC prune OUR older local tombstones as if peer-A had
  // seen them — even though peer-A is just telling us about ITS own
  // tombstones. In bidirectional sync, that lets peer-A's stale live
  // records resurrect after GC drops our tombstones.
  const ackedDeletesUpTo = computeAckedDeletesFromPayload(record, issues);

  // Best-effort reverse subscription. Failures don't fail the push — the
  // record is already merged and the response will tell the sender what
  // assets to push next. The reverse subscription only affects whether
  // future edits flow BACK; the user can also create one manually.
  // Skip for local-ephemeral: the user said "don't sync this record"; we
  // shouldn't auto-create a sub the next edit would push out to a peer.
  const reverseSubscriptionCreated = localEphemeral ? false : await maybeCreateReverseSubscription({
    peerId: sourceInstanceId,
    recordKind: kind,
    recordId: record.id,
  }).catch(() => false);

  // Schedule background pulls for every asset we're missing. The sender just
  // told us they have these files — fetch them via their `/data/{kind-dir}/`
  // static mount (acceptRanges enabled so resumes work over flaky Tailnet).
  // Fire-and-forget so the push response isn't blocked on a slow pull; the
  // worker emits a socket event when each asset lands so the UI can swap
  // the MediaImage placeholder for the real bytes.
  // (missingAssets is already [] for localEphemeral above, so the worker
  // can never schedule pulls for opted-out records.)
  if (missingAssets.length > 0) {
    pullMissingAssetsFromPeer(sourceInstanceId, missingAssets).catch((err) => {
      console.log(`⚠️ peerSync: asset pull from ${sourceInstanceId} failed: ${err.message}`);
    });
  }

  // Writers Room: the file-primary draft `.md` bodies ride their own manifest
  // (the generic asset pipeline keys on a flat basename + single dir per kind;
  // bodies live at works/<workId>/drafts/<draftId>.md). Diff against local disk
  // and background-pull the missing ones from the sender's /data/writers-room
  // static mount. `includeMismatched: workMergeApplied` is the data-safety gate —
  // a present-but-different local body is only replaced when the receiver also
  // accepted the remote record (so a stale push can't clobber newer local prose);
  // an absent body is always pulled (fills inserts + retries a failed pull).
  // Same guards as the asset path: skip for local-ephemeral and tombstone pushes.
  let missingDraftBodies = [];
  if (kind === 'writersRoomWork' && !localEphemeral && record.deleted !== true) {
    // Scope the manifest to THIS work: a body entry's path is works/<workId>/...,
    // so an entry whose workId != the pushed record's id would write bytes into a
    // DIFFERENT local work's draft (clobbering unrelated prose when the merge
    // accepted the remote). A peer may only replicate the bodies of the work it
    // actually pushed.
    const ownBodies = Array.isArray(draftBodyManifest)
      ? draftBodyManifest.filter((e) => e && e.workId === record.id)
      : [];
    missingDraftBodies = await diffWorkBodyManifest(ownBodies, { includeMismatched: workMergeApplied });
    if (missingDraftBodies.length > 0) {
      pullMissingWorkBodies(sourceInstanceId, missingDraftBodies).catch((err) => {
        console.log(`⚠️ peerSync: draft-body pull from ${sourceInstanceId} failed: ${err.message}`);
      });
    }
  }

  return {
    missingAssets,
    // Surfaced like missingAssets so the sender withholds lastPushedHash while
    // bodies are still pending and keeps re-pushing until the pulls land.
    ...(missingDraftBodies.length > 0 ? { missingDraftBodies } : {}),
    reverseSubscriptionCreated,
    ackedDeletesUpTo,
    ...(reviewSyncPending ? { reviewSyncPending: true } : {}),
    ...(outlineSyncPending ? { outlineSyncPending: true } : {}),
  };
}

function computeAckedDeletesFromPayload(record, issues) {
  let max = 0;
  const consider = (rec) => {
    if (!rec?.deleted || !isStr(rec.deletedAt)) return;
    const ms = Date.parse(rec.deletedAt);
    if (Number.isFinite(ms) && ms > max) max = ms;
  };
  consider(record);
  if (Array.isArray(issues)) for (const i of issues) consider(i);
  return max;
}

async function maybeCreateReverseSubscription({ peerId, recordKind, recordId }) {
  // Skip if a subscription back to the sender already exists.
  const existing = await findPeerSubscription(peerId, recordKind, recordId);
  if (existing) return false;

  // Cheap in-memory checks FIRST. Honor the per-peer `directions` flag — a
  // peer marked inbound-only is one we accept pushes FROM but never push
  // back TO — auto-creating a reverse subscription would break that
  // explicit configuration. Doing this BEFORE the ephemeral-record disk
  // read means inbound-only / unknown peers don't trigger an extra
  // getUniverse / getSeries on every incoming push.
  const peer = await findPeerById(peerId);
  if (!peer) return false;
  const directions = Array.isArray(peer.directions) ? peer.directions : [];
  if (directions.length > 0 && !directions.includes('outbound')) return false;

  // Now the disk read: only reverse-subscribe when the local record exists
  // AND is non-ephemeral. Three reasons to hard-stop on missing/read-failed:
  //
  // 1. Ephemeral: auto-creating a reverse sub for a local-only record
  //    would accumulate orphan rows in peer_subscriptions.json. Every
  //    future edit on the local side fires recordEvents.updated →
  //    triggerPushForRecord → pushRecordToPeer → buildPushPayload →
  //    sanitizeRecordForWire returns null (ephemeral filter) → push
  //    aborts with "record-not-found". The sub burns an asset-manifest
  //    sha-pass on every edit and never sends bytes. The merge path
  //    upstream already refused the inbound edit (local-ephemeral →
  //    continue), so the sender's record state isn't reflected locally
  //    anyway — there's nothing meaningful to push back.
  //
  // 2. Record-missing: the sender pushed a record that passed Zod but was
  //    dropped by the service sanitizer (missing name, etc.). The merge
  //    never created the local copy, so a reverse sub would point at a
  //    nonexistent record and every push would resolve to null. Same
  //    orphan-row dynamic as ephemeral, but worse because there's never
  //    going to be a record to clear it via the ephemeral lifecycle
  //    transition.
  //
  // 3. Read-failed: a transient IO error reading the record file —
  //    treating it as "non-ephemeral, go ahead and subscribe" can create
  //    a sub for a record that turns out to be ephemeral once the IO
  //    settles. Conservative default: don't subscribe.
  const localState = await classifyLocalRecord(recordKind, recordId);
  if (localState !== 'syncable') return false;

  const sub = await subscribePeer({ peerId, recordKind, recordId }, { adoptedFromReverse: true });
  // subscribePeer is idempotent — only announce when a row was genuinely
  // inserted (created=true). The existing-sub short-circuit at the top of
  // this function already returns early, but guarding on `created` keeps the
  // event honest if a race ever lands an identical row between the
  // findPeerSubscription check and the insert. `sharing/index.js` wires this
  // to the `peerSync:subscription:created` socket event so the Instances page
  // re-fetches that peer's subs without a manual reload.
  if (sub?.created) {
    peerSyncEvents.emit('subscription-created', {
      peerId,
      recordKind,
      recordId,
      subId: sub.id,
    });
  }
  return true;
}

/**
 * Look up the local record (live or tombstoned) and tri-state-classify it
 * for the reverse-subscribe gate. Returns one of:
 *
 *   'syncable'   — record exists, is non-ephemeral; safe to reverse-subscribe.
 *   'ephemeral'  — record exists but is local-only; reverse-subscribe would
 *                  accumulate an orphan sub that never sends bytes.
 *   'missing'    — record is not on disk OR a read error occurred; can't
 *                  classify, so the conservative default is to skip the
 *                  reverse-subscribe (callers treat anything other than
 *                  'syncable' as a no-go).
 *
 * Includes deleted records on the lookup so a tombstone-as-state record
 * still gets classified as 'syncable' (we WANT peer pushes to converge
 * a deleted record's tombstone if they're targeting it).
 */
async function classifyLocalRecord(recordKind, recordId) {
  if (recordKind === 'universe') {
    const u = await getUniverse(recordId, { includeDeleted: true }).catch(() => undefined);
    if (!u) return 'missing';
    return u.ephemeral === true ? 'ephemeral' : 'syncable';
  }
  if (recordKind === 'series') {
    const s = await getSeries(recordId, { includeDeleted: true }).catch(() => undefined);
    if (!s) return 'missing';
    return s.ephemeral === true ? 'ephemeral' : 'syncable';
  }
  if (recordKind === 'mediaCollection') {
    // Collections have no `ephemeral` concept, so a found record is always
    // 'syncable'. Without this branch, maybeCreateReverseSubscription's
    // `localState !== 'syncable'` guard would never bootstrap bidirectional
    // collection sync from an inbound push. No ping-pong risk — the
    // lastPushedHash short-circuit + LWW same-`updatedAt` no-op merge prevent
    // it, same as universe/series.
    const c = await getCollection(recordId, { includeDeleted: true }).catch(() => null);
    return c ? 'syncable' : 'missing';
  }
  if (recordKind === 'author') {
    // Authors have no `ephemeral` concept (like mediaCollection) — a found
    // record (live or tombstoned) is always 'syncable'. Lets an inbound author
    // push bootstrap bidirectional sync. No ping-pong risk: lastPushedHash +
    // LWW same-`updatedAt` no-op merge prevent it, same as the others.
    const a = await getAuthor(recordId, { includeDeleted: true }).catch(() => null);
    return a ? 'syncable' : 'missing';
  }
  if (recordKind === 'artist') {
    const a = await getArtist(recordId, { includeDeleted: true }).catch(() => null);
    return a ? 'syncable' : 'missing';
  }
  if (recordKind === 'album') {
    const a = await getAlbum(recordId, { includeDeleted: true }).catch(() => null);
    return a ? 'syncable' : 'missing';
  }
  if (recordKind === 'track') {
    const t = await getTrack(recordId, { includeDeleted: true }).catch(() => null);
    return t ? 'syncable' : 'missing';
  }
  if (recordKind === 'creativeDirectorProject') {
    // CD projects have no `ephemeral` concept (like the persona/music kinds) — a
    // found record (live or tombstoned) is always 'syncable'. No ping-pong risk:
    // lastPushedHash + LWW same-`updatedAt` no-op merge prevent it.
    const p = await getProject(recordId, { includeDeleted: true }).catch(() => null);
    return p ? 'syncable' : 'missing';
  }
  if (recordKind === 'moodBoard') {
    // Mood boards have no `ephemeral` concept (like the persona/music/CD kinds) —
    // a found record (live or tombstoned) is always 'syncable'. No ping-pong risk:
    // lastPushedHash + LWW same-`updatedAt` no-op merge prevent it.
    const b = await getBoard(recordId, { includeDeleted: true }).catch(() => null);
    return b ? 'syncable' : 'missing';
  }
  if (recordKind === 'writersRoomWork') {
    // Works have no `ephemeral` concept (like the persona/music/CD/board kinds) —
    // a found work (live or tombstoned) is always 'syncable', so an inbound work
    // push bootstraps bidirectional sync. No ping-pong risk: lastPushedHash + LWW
    // same-`updatedAt` no-op merge prevent it.
    const w = await getWorkForSync(recordId).catch(() => null);
    return w ? 'syncable' : 'missing';
  }
  if (recordKind === 'writersRoomFolder') {
    // Body-less, no `ephemeral` concept (#1645) — a found folder (live or
    // tombstoned) is always 'syncable'. Same no-ping-pong guards as works.
    const f = await getFolderForSync(recordId).catch(() => null);
    return f ? 'syncable' : 'missing';
  }
  if (recordKind === 'writersRoomExercise') {
    const e = await getExerciseForSync(recordId).catch(() => null);
    return e ? 'syncable' : 'missing';
  }
  if (recordKind === 'musicVideoProject') {
    // Music Video projects have no `ephemeral` concept (like the persona/music/CD/
    // board kinds) — a found project (live or tombstoned) is always 'syncable'.
    // No ping-pong risk: lastPushedHash + LWW same-`updatedAt` no-op merge prevent it.
    const p = await getMusicVideoProject(recordId, { includeDeleted: true }).catch(() => null);
    return p ? 'syncable' : 'missing';
  }
  return 'missing';
}