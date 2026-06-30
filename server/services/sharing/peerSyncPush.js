/**
 * Federated peer-sync — outbound push pipeline.
 *
 * `pushRecordToPeer` (the per-subscription push), the payload builder that
 * sanitizes a record + bundles its child issues / linked collection / catalog
 * rows / manuscript-review docs, the schema-version-gate bookkeeping, and the
 * push success/blocked persistence. Asset manifests are built in
 * `peerSyncAssets.js`.
 *
 * Split out of the former 4,004-line peerSync.js (#1830).
 */
import { join } from 'path';
import { PATHS, readJSONFile } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/storyBible.js';
import { isPlainObject } from '../../lib/objects.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { sanitizeRecordForWire } from '../../lib/syncWire.js';
import { setSyncBaseHash, contentHashForRecord, flushBaseHashes } from '../../lib/conflictJournal.js';
import { sanitizeAssetFilename } from './buckets.js';
import {
  buildPortosMeta,
  formatVersionGap,
} from '../../lib/schemaVersions.js';
import { getInstanceId, getPeers, UNKNOWN_INSTANCE_ID } from '../instances.js';
import { getUniverse } from '../universeBuilder.js';
import { getSeries } from '../pipeline/series.js';
import { listIssues } from '../pipeline/issues.js';
import {
  getCollection,
  findCollectionByUniverseId,
  findCollectionBySeriesId,
} from '../mediaCollections.js';
import { getAuthor } from '../authors/index.js';
import { getArtist } from '../artists/index.js';
import { getAlbum } from '../albums/index.js';
import { getTrack } from '../tracks/index.js';
import { getProject } from '../creativeDirector/local.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getBoard } from '../moodBoard/index.js';
import {
  getWorkForSync,
  buildWorkBodyManifest,
  getFolderForSync,
  getExerciseForSync,
} from '../writersRoom/sync.js';
import { ackDeletesUpTo } from './peerTombstoneCursors.js';
import {
  buildAssetManifestWithCollection,
  buildAssetManifestForSeries,
  buildCollectionAssetManifest,
  buildAuthorAssetManifest,
  buildArtistAssetManifest,
  buildAlbumAssetManifest,
  buildTrackAssetManifest,
  buildProjectAssetManifest,
  buildBoardAssetManifest,
  buildMusicVideoAssetManifest,
} from './peerSyncAssets.js';
import {
  isNonEmptyStr,
  peerAllowsOutbound,
  peerHasCategory,
  findPeerById,
  readState,
  writeState,
  withStateLock,
  peerSyncEvents,
  PUSH_TIMEOUT_MS,
  ERR_SCHEMA_VERSION_AHEAD,
  PEER_SUBSCRIBABLE_KINDS,
} from './peerSyncShared.js';


// --- Push pipeline (sender side) ----------------------------------------

/**
 * Load the live record, sanitize for wire, build the asset manifest, and
 * POST to the peer's `/api/peer-sync/push`. Updates `lastPushedAt` +
 * `lastPushedHash` on success.
 *
 * `lastPushedHash` lets the listener short-circuit no-op edits — if the
 * sanitized record is byte-for-byte identical to what we last pushed, skip
 * the network round-trip. (Useful when the snapshot-sync path and the
 * per-record push path both fire for the same merge.)
 *
 * For series subscriptions, the push payload bundles the child issues in
 * `record.issues` so the receiver applies the series + every issue
 * atomically per merge cycle. Issue records are filtered through
 * `sanitizeRecordForWire('issue', ...)` too.
 */
// Cool-down between re-probes when a peer has rejected our push for schema-
// version reasons. Without it, every local edit would HTTP-roundtrip a 409
// while the peer is on the older PortOS, spamming the network. The retry
// loop on `peer:online` bypasses this — that's the canonical "did the peer
// upgrade?" probe point.
const SCHEMA_BLOCK_RETRY_COOLDOWN_MS = 5 * 60_000;

async function isSubscriptionRecordTombstone(sub) {
  if (sub.recordKind === 'universe') {
    const record = await getUniverse(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'series') {
    const record = await getSeries(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'mediaCollection') {
    const record = await getCollection(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'author') {
    const record = await getAuthor(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'artist') {
    const record = await getArtist(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'album') {
    const record = await getAlbum(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'track') {
    const record = await getTrack(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'creativeDirectorProject') {
    const record = await getProject(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'moodBoard') {
    const record = await getBoard(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'writersRoomWork') {
    const record = await getWorkForSync(sub.recordId).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'writersRoomFolder') {
    const record = await getFolderForSync(sub.recordId).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'writersRoomExercise') {
    const record = await getExerciseForSync(sub.recordId).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'musicVideoProject') {
    const record = await getMusicVideoProject(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  return false;
}

export async function pushRecordToPeer(sub, options = {}) {
  if (
    !isPlainObject(sub)
    || !isNonEmptyStr(sub.peerId)
    || !isNonEmptyStr(sub.recordKind)
    || !isNonEmptyStr(sub.recordId)
  ) {
    return { pushed: false, reason: 'invalid-subscription' };
  }
  // SCHEMA-BLOCK COOLDOWN — if the peer rejected our last push for being
  // schema-ahead, hold off re-probing on every local edit. Re-probes happen
  // on the next `peer:online` (where `retryPendingPushesForPeer` passes
  // `bypassSchemaCooldown: true`) or after the cooldown elapses.
  if (sub.blockedBySchema && !options.bypassSchemaCooldown) {
    const tombstonePush = await isSubscriptionRecordTombstone(sub);
    if (!tombstonePush) {
      const detectedAtMs = Date.parse(sub.blockedBySchema.detectedAt || '');
      const stillCooling = Number.isFinite(detectedAtMs)
        && (Date.now() - detectedAtMs) < SCHEMA_BLOCK_RETRY_COOLDOWN_MS;
      if (stillCooling) {
        return { pushed: false, reason: 'peer-schema-behind-cooldown', blockedBySchema: true };
      }
    }
  }
  const peer = await findPeerById(sub.peerId);
  if (!peer) return { pushed: false, reason: 'peer-not-found' };
  // Re-gate on the same peer flags the auto-subscribe path checks. An
  // existing subscription is NOT a license to keep pushing after the user
  // has globally disabled sync (`syncEnabled: false`), disabled the peer
  // (`enabled: false`), switched the peer to inbound-only (`directions:
  // ['inbound']`), or toggled the matching category off (`syncCategories.*
  // === false`). Without these guards, stale subs would silently outlive
  // the user's intent and leak records on the next edit.
  if (!peerAllowsOutbound(peer)) return { pushed: false, reason: 'peer-disallows-outbound' };
  if (!peerHasCategory(peer, sub.recordKind)) return { pushed: false, reason: 'category-disabled' };

  const ourInstanceId = await getInstanceId().catch(() => null);
  if (!isNonEmptyStr(ourInstanceId) || ourInstanceId === UNKNOWN_INSTANCE_ID) {
    return { pushed: false, reason: 'unknown-local-instance' };
  }

  const payload = await buildPushPayload(sub, ourInstanceId);
  if (!payload) return { pushed: false, reason: 'record-not-found' };

  // No-op short-circuit: don't re-push bytes we already pushed. Hash the
  // FULL logical payload (record + bundled issues + linked collection +
  // asset manifest) — not just the record — so an issue-only edit, an
  // asset-only re-render, a collection-only item add, or a new image
  // landing under the same series still propagates instead of collapsing
  // to "unchanged" because the parent series didn't move.
  // sourceInstanceId is intentionally excluded: it's an envelope field, not
  // a content field, and hashing it would force a re-push every time we
  // bumped instance metadata.
  const hash = simplePayloadHash({
    record: payload.record,
    issues: payload.issues ?? null,
    linkedCollection: payload.linkedCollection ?? null,
    linkedTrack: payload.linkedTrack ?? null,
    manuscriptReview: payload.manuscriptReview ?? null,
    reverseOutline: payload.reverseOutline ?? null,
    assetManifest: payload.assetManifest ?? [],
    draftBodyManifest: payload.draftBodyManifest ?? [],
  });
  if (sub.lastPushedHash && sub.lastPushedHash === hash) {
    return { pushed: false, reason: 'unchanged', hash };
  }

  const url = `${peerBaseUrl(peer)}/api/peer-sync/push`;
  // withAbortTimeout aborts after PUSH_TIMEOUT_MS so a hung peer can't keep the
  // push promise pending forever and block subsequent debounced pushes for the
  // same sub. (The shared `fetchWithTimeout` helper can't be reused — it always
  // calls global fetch with no custom-client hook for the insecure agent.)
  const postPayload = async (body) => {
    return withAbortTimeout(PUSH_TIMEOUT_MS, (signal) => peerFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }, peer)).catch((err) => {
      console.log(`⚠️ peerSync: push to ${peer.name || peer.instanceId} failed: ${err.message}`);
      return null;
    });
  };
  let res = await postPayload(payload);
  // Set when the older-peer retry below strips `manuscriptReview`: the retry
  // succeeds with the review removed, so saving the full-payload hash would
  // make the next push short-circuit as `unchanged` and never deliver the
  // review once that peer upgrades. Withhold the hash (like reviewSyncPending)
  // so the next cycle re-sends.
  let reviewStrippedForLegacyPeer = false;
  // Same as reviewStrippedForLegacyPeer, for the bundled reverse-outline doc —
  // a pre-#1348 peer's strict series schema rejects the `reverseOutline` key, so
  // the retry strips it and we withhold the hash to re-send once it upgrades.
  let outlineStrippedForLegacyPeer = false;
  // Same as the two flags above, for the #1858 bundled linked-track record — a
  // pre-feature peer's strict musicVideoProject push schema rejects the
  // `linkedTrack` key, so the retry strips it and we withhold the hash to
  // re-send once it upgrades (the track has no independent cycle for a
  // musicVideoProjects-only subscriber).
  let trackStrippedForLegacyPeer = false;
  // MIXED-VERSION COMPAT: an older receiver's push schema is still `.strict()`
  // without a `portosMeta` field, so it 400-rejects our envelope at Zod
  // validation BEFORE its schema-version gate code (which doesn't exist on
  // that version anyway) can run. Detect that specific rejection — Zod emits
  // "Unrecognized key(s) in object: 'portosMeta'" — and retry once without
  // the envelope so the push lands on the older peer. The older peer can't
  // see schemaVersions, but until the user upgrades it that's the
  // best-effort behavior we want (vs. permanently stranded pushes). Once
  // they upgrade, the next push round naturally re-includes `portosMeta`.
  // `catalogBundle` (catalog-federation push enrichment) is a second new
  // top-level key an even-newer-than-version-gate-but-pre-catalog peer's strict
  // schema also rejects. `manuscriptReview` (the bundled "Finish the draft"
  // review doc) is a third — a pre-feature peer's series push schema is still
  // `.strict()` without it, so it 400-rejects a review-bearing series push and
  // would strand the series + issues. This retry is exactly what makes the
  // review's "degrades gracefully on older peers" contract hold (see
  // schemaVersions.js): strip the unknown key the older peer can't parse so the
  // record/issues still land; the review reaches it once it upgrades. Strip
  // whichever key(s) the receiver actually named — surgically, so a peer that
  // supports `portosMeta` but not `catalogBundle`/`manuscriptReview` keeps its
  // version-gate handshake. Zod `.strict()` lists all unrecognized keys in one
  // issue, so a single retry covers all of them.
  // A 400 from the receiver is Zod rejecting our envelope BEFORE its schema-version
  // gate (the 409 path below) runs. Parse the body ONCE and route on which part it
  // couldn't accept — two distinct mixed-version cases share this block:
  if (res && res.status === 400) {
    const errBody = await res.clone().json().catch(() => null);
    const isValidationError = errBody?.code === 'VALIDATION_ERROR';
    const details = Array.isArray(errBody?.context?.details) ? errBody.context.details : [];
    const mentions = (key) => details.some((d) => new RegExp(key).test(`${d?.path || ''} ${d?.message || ''}`));
    if (
      isValidationError
      && (payload.portosMeta || payload.catalogBundle || payload.manuscriptReview || payload.reverseOutline || payload.linkedTrack)
      && (mentions('portosMeta') || mentions('catalogBundle') || mentions('manuscriptReview') || mentions('reverseOutline') || mentions('linkedTrack'))
    ) {
      // (1) UNKNOWN ENVELOPE KEY — the peer recognizes the record `kind` but its
      // `.strict()` schema predates a newer top-level key we sent. Strip whichever
      // key(s) it named and retry so the record/issues still land; the stripped
      // feature reaches it once it upgrades (the re-push re-includes the key).
      const legacyPayload = { ...payload };
      const stripped = [];
      if (mentions('portosMeta') && 'portosMeta' in legacyPayload) { delete legacyPayload.portosMeta; stripped.push('portosMeta'); }
      if (mentions('catalogBundle') && 'catalogBundle' in legacyPayload) { delete legacyPayload.catalogBundle; stripped.push('catalogBundle'); }
      if (mentions('manuscriptReview') && 'manuscriptReview' in legacyPayload) { delete legacyPayload.manuscriptReview; stripped.push('manuscriptReview'); reviewStrippedForLegacyPeer = true; }
      if (mentions('reverseOutline') && 'reverseOutline' in legacyPayload) { delete legacyPayload.reverseOutline; stripped.push('reverseOutline'); outlineStrippedForLegacyPeer = true; }
      if (mentions('linkedTrack') && 'linkedTrack' in legacyPayload) { delete legacyPayload.linkedTrack; stripped.push('linkedTrack'); trackStrippedForLegacyPeer = true; }
      console.log(
        `ℹ️ peerSync: ${peer.name || peer.instanceId} rejected newer envelope key(s) ${stripped.join(', ')} — retrying push without them`,
      );
      res = await postPayload(legacyPayload);
    } else if (isValidationError && details.some((d) => d?.path === 'kind' && /discriminator|enum/i.test(d?.message || ''))) {
      // (2) UNKNOWN RECORD KIND → schema-version block (NOT a bare http-400 retry).
      // When we introduce a NEW federated record kind (authors did this;
      // mediaCollection had the same gap when it landed), a peer on an older PortOS
      // whose `peerSyncPushSchema` discriminated union has no arm for that `kind`
      // rejects the push at the discriminator — so unlike case (1) there's no
      // smuggled key to drop: the record KIND itself is what the peer can't parse,
      // and retrying changes nothing. Treat it like the 409: persist an empty-gap
      // `peer-pre-feature` block so the SchemaGapBadge surfaces "peer needs to update
      // PortOS to sync <kind>" and the edit-push cooldown engages, instead of letting
      // the sub churn as a bare `http-400` the UI never explains. The block clears on
      // the next successful push once the peer upgrades (same recovery as the 409
      // path). The signal is a `kind`-path discriminator/enum error — a value WE
      // always send as a valid literal, so the only reason a receiver faults on
      // `kind` is that its schema doesn't know this record kind yet.
      await persistSchemaVersionBlock(sub.id, { reason: 'peer-pre-feature' });
      console.warn(
        `⚠️ peerSync: ${peer.name || peer.instanceId} rejected push — its PortOS doesn't recognize the ` +
        `'${sub.recordKind}' record kind yet. Re-tries pause until they upgrade.`,
      );
      return { pushed: false, reason: 'peer-schema-behind', blockedBySchema: true };
    }
  }
  // 409 with `code: SCHEMA_VERSION_AHEAD` means the receiver is on an OLDER
  // PortOS and can't parse our newer storage layout. Persist the gap on the
  // subscription so the Instances UI can surface "Peer X needs to update
  // PortOS to receive your updates" — and short-circuit retries to that
  // peer for the affected record kind. We don't tear down the subscription;
  // when the peer upgrades and reconnects, `peer:online` will re-fire
  // pushRecordToPeer and the next response either clears the block (success)
  // or refreshes the gap info (still behind).
  if (res && res.status === 409) {
    const body = await res.json().catch(() => null);
    if (body?.code === ERR_SCHEMA_VERSION_AHEAD) {
      // The global error handler nests our `err.details` under `context.details`
      // (see server/routes/peerSync.js `mapAndRethrow`), so reach in two levels
      // to get the original payload from the peerSync service.
      const details = isPlainObject(body.context?.details) ? body.context.details : {};
      // `peerPortosVersion` describes the REJECTING peer's PortOS version
      // (what we want to show in the SchemaGapBadge), so read
      // `receiverPortosVersion` from the receiver-supplied details — NOT
      // `senderPortosVersion`, which is our own version round-tripped from
      // the payload we sent.
      await persistSchemaVersionBlock(sub.id, {
        ahead: Array.isArray(details.ahead) ? details.ahead : [],
        behind: Array.isArray(details.behind) ? details.behind : [],
        peerPortosVersion: typeof details.receiverPortosVersion === 'string' ? details.receiverPortosVersion : null,
        peerSchemaVersions: isPlainObject(details.receiverSchemaVersions) ? details.receiverSchemaVersions : null,
      });
      console.warn(
        `⚠️ peerSync: ${peer.name || peer.instanceId} rejected push — peer is on an older PortOS schema. ` +
        `Re-tries will pause until they upgrade. ${formatVersionGap({ ahead: details.ahead || [], behind: details.behind || [] })}`,
      );
      return { pushed: false, reason: 'peer-schema-behind', blockedBySchema: true };
    }
  }
  if (!res || !res.ok) {
    return { pushed: false, reason: res ? `http-${res.status}` : 'network' };
  }
  const body = await res.json().catch(() => null);

  // Push succeeded — clear any prior schema-version block so the sub goes
  // back to normal. Either the peer upgraded or the gap was transient.
  if (sub.blockedBySchema) {
    await clearSchemaVersionBlock(sub.id);
  }

  // Persist push metadata to peer_subscriptions.json, then advance the
  // tombstone cursor in peer_tombstone_cursors.json if the receiver acked
  // any deletions. These are two separate files; a crash between them
  // leaves the cursor un-advanced for one push cycle, which is safe —
  // `ackDeletesUpTo` is monotonic + idempotent, so the receiver re-acks
  // the same deletedAt on the next push and the cursor catches up.
  //
  // ASSETS-STRANDED GUARD: don't save lastPushedHash when the receiver
  // reported missing assets. The receiver pulls them asynchronously,
  // and any pull failure (transient Tailnet flake, rejected
  // Content-Length, receiver restart mid-pull) would otherwise be
  // permanently masked — the next `peer:online` retry would short-
  // circuit on `unchanged` and never re-POST the manifest, so the
  // receiver never gets a fresh asset list to retry against. The
  // record itself still landed (mergeXxxFromSync ran on the receiver),
  // so we just advance `lastPushedAt` without the hash, and the next
  // push cycle will re-send with the same asset manifest until pulls
  // complete (manifest hash-equal pushes are no-ops on the receiver's
  // merge LWW path; only cost is one redundant POST per push cycle
  // until the receiver finishes pulling).
  // Count BOTH generic assets and Writers Room draft bodies as "stranded" — a
  // body the receiver still has to pull keeps the push un-confirmed for the same
  // reason an asset does (a once-failed pull would otherwise be masked by the
  // next `unchanged` short-circuit and the prose body stranded).
  const missingCount = (Array.isArray(body?.missingAssets) ? body.missingAssets.length : 0)
    + (Array.isArray(body?.missingDraftBodies) ? body.missingDraftBodies.length : 0);
  // REVIEW-STRANDED GUARD: the receiver merged the record/issues (returned 2xx)
  // but its bundled manuscript-review merge threw. Withhold lastPushedHash like
  // the missing-assets case so the next push cycle re-sends the review instead
  // of short-circuiting on `unchanged` — the review has no independent
  // reconciliation path, so a saved hash here would strand the update.
  const reviewSyncPending = body?.reviewSyncPending === true || reviewStrippedForLegacyPeer;
  // OUTLINE-STRANDED GUARD: same as the review above — the receiver merged the
  // record/issues but its bundled reverse-outline merge threw (or we stripped
  // the key for a pre-#1348 peer). The outline has no independent reconciliation
  // path, so withhold lastPushedHash to re-send next cycle.
  const outlineSyncPending = body?.outlineSyncPending === true || outlineStrippedForLegacyPeer;
  // TRACK-STRANDED GUARD: same as the review/outline guards — the receiver merged
  // the project (returned 2xx) but its bundled linked-track merge threw, OR we
  // stripped the key for a pre-#1858 peer. The track has no independent
  // reconciliation path for a musicVideoProjects-only subscriber, so withhold
  // lastPushedHash to re-send next cycle.
  const trackSyncPending = body?.trackSyncPending === true || trackStrippedForLegacyPeer;
  // This push landed (receiver returned 2xx). Stamp the per-record confirmed-
  // delivery water-mark so tombstoneGc won't prune THIS record's tombstone
  // until its delete-push has been confirmed — even if a later push for a
  // DIFFERENT record advances the per-peer ack cursor past it. We stamp on
  // every confirmed push (not just deletes): a successful pre-delete push
  // establishes the floor, and the subsequent delete-push raises it above
  // the tombstone's deletedAt once it lands. The `missingAssets` case still
  // counts as confirmed delivery of the RECORD (merge ran on the receiver);
  // only the asset-stranded hash is withheld, not the confirmation mark.
  //
  // #1922: a musicVideoProject subscription is also a delivery vehicle for
  // its bundled `linkedTrack` (#1858) — the receiver has no independent
  // `track` subscription to ack through. Stamp a SEPARATE floor
  // (`trackBundleConfirmed`) tombstoneGc's `track` cutoff reads off
  // musicVideoProject rows, distinct from `lastConfirmedPushedAt` because the
  // latter advances even when the bundled track merge failed or was stripped
  // for a legacy peer (`trackSyncPending`) — using it here would let GC treat
  // an unconfirmed bundled tombstone as delivered.
  await persistPushSuccess(sub.id, (missingCount > 0 || reviewSyncPending || outlineSyncPending || trackSyncPending) ? null : hash, {
    confirmedAtMs: Date.now(),
    trackBundleConfirmed: sub.recordKind === 'musicVideoProject' && !trackSyncPending,
  });
  if (Number.isFinite(body?.ackedDeletesUpTo) && body.ackedDeletesUpTo > 0) {
    await ackDeletesUpTo(sub.peerId, body.ackedDeletesUpTo).catch(() => {});
  }
  // Conflict-journal base hash: this record's content now lives on the peer too
  // (the record always lands even when assets are still pulling), so stamp the
  // shared-state base for the two journaled kinds. This is the symmetric
  // convergence point to the receiver advancing its base in mergeXxxFromSync —
  // it keeps a peer's echo (reverse-subscription push-back) from later looking
  // like a divergence. Best-effort; never block the push result on a slow DISK
  // — only the filesystem flush runs fire-and-forget. The in-memory stamps ARE
  // awaited: `setSyncBaseHash` just mutates the cached map (no disk I/O), so
  // awaiting it costs nothing once the map is loaded, and it guarantees
  // `_baseDirty` is set before this push returns. That matters under
  // `withBaseHashFlushBatch` — the batch's terminal flush only writes when a
  // stamp landed, so a stamp still pending when the batch closed would be lost
  // until the next flush. The `.catch()` keeps a rejection from escaping.
  if (PEER_SUBSCRIBABLE_KINDS.includes(sub.recordKind) && payload.record) {
    // For mediaCollection, contentHashForRecord hashes only the scalar subset
    // (items are union-merged on the receiver, so the post-push collections are
    // NOT byte-identical — but their scalars converge, which is what the base
    // hash tracks). For universe/series it's the full wire record. Same call
    // either way; the narrowing lives in contentHashForRecord.
    const stamps = [setSyncBaseHash(sub.recordKind, sub.recordId, contentHashForRecord(sub.recordKind, payload.record))];
    // A series push bundles its child issues (`payload.issues`, already in
    // wire form). The receiver seeds each issue's base hash on insert in
    // mergeIssuesFromSync; stamp the SAME base here so the SENDER side also
    // detects the first issue divergence on a later push-back. Issues never
    // carry their own subscription — they ride the series push — so this is
    // the only place the origin can seed an `issue`-keyed base hash. Without
    // it, issue conflict journaling would be one-sided (receiver-only).
    if (sub.recordKind === 'series' && Array.isArray(payload.issues)) {
      for (const issue of payload.issues) {
        if (issue?.id) stamps.push(setSyncBaseHash('issue', issue.id, contentHashForRecord('issue', issue)));
      }
    }
    await Promise.all(stamps).catch((err) => console.log(`⚠️ peerSync: base-hash stamp after push failed: ${err?.message || err}`));
    // Non-blocking disk write. Inside a flush batch this is a no-op (the batch's
    // terminal flush coalesces every record's stamps into one rewrite); outside
    // a batch it fires async exactly as before.
    flushBaseHashes().catch((err) => console.log(`⚠️ peerSync: base-hash flush after push failed: ${err?.message || err}`));
  }
  return {
    pushed: true,
    hash,
    response: body || {},
    missingAssets: Array.isArray(body?.missingAssets) ? body.missingAssets : [],
  };
}

async function persistPushSuccess(subId, hash, { confirmedAtMs = Date.now(), trackBundleConfirmed = false } = {}) {
  await withStateLock(async () => {
    const state = await readState();
    const sub = state.subscriptions.find((s) => s.id === subId);
    if (!sub) return;
    const now = new Date().toISOString();
    sub.lastPushedAt = now;
    sub.lastPushedHash = hash;
    sub.updatedAt = now;
    // Advance the per-record confirmed-delivery water-mark monotonically — an
    // out-of-order retry must not retract it (mirrors ackDeletesUpTo's
    // never-move-backward guarantee). tombstoneGc reads MIN-of-this across a
    // kind's rows, so a regression here would let a stale tombstone prune.
    if (Number.isFinite(confirmedAtMs) && confirmedAtMs > (sub.lastConfirmedPushedAt ?? 0)) {
      sub.lastConfirmedPushedAt = confirmedAtMs;
    }
    // #1922: same monotonic-floor treatment, but scoped to confirmed delivery
    // of a BUNDLED linkedTrack (musicVideoProject subscriptions only — see the
    // call site). tombstoneGc's `track` cutoff reads this instead of
    // `lastConfirmedPushedAt` for musicVideoProject rows.
    if (trackBundleConfirmed && Number.isFinite(confirmedAtMs) && confirmedAtMs > (sub.lastConfirmedTrackBundleAtMs ?? 0)) {
      sub.lastConfirmedTrackBundleAtMs = confirmedAtMs;
    }
    // A successful push (or even a no-asset-stranded push) clears any prior
    // schema-version block — the peer can receive again.
    if (sub.blockedBySchema) delete sub.blockedBySchema;
    await writeState(state);
  });
}

/**
 * Persist a `blockedBySchema` field on the subscription so subsequent pushes
 * short-circuit until the peer upgrades. Stored on the same record as
 * `lastPushedAt` / `lastPushedHash` so the Instances UI can read everything
 * from a single subscription fetch. We capture both directions of the gap
 * (`ahead` = what the PEER needs to gain to receive our pushes; `behind` =
 * what the peer has that we don't — informational) along with the peer's
 * PortOS version string for the user-visible message.
 */
async function persistSchemaVersionBlock(subId, { ahead, behind, peerPortosVersion, peerSchemaVersions, reason = 'schema-version-ahead' }) {
  // Capture peerId inside the lock so the emitted event carries it — lets each
  // Instances PeerCard filter on its own peer instead of every card refetching.
  let blockedPeerId = null;
  await withStateLock(async () => {
    const state = await readState();
    const sub = state.subscriptions.find((s) => s.id === subId);
    if (!sub) return;
    blockedPeerId = sub.peerId || null;
    const now = new Date().toISOString();
    sub.blockedBySchema = {
      detectedAt: now,
      // `schema-version-ahead` = the 409 version-gate path (the peer parsed our
      // envelope but its per-category gate rejected an ahead schema). `peer-pre-feature`
      // = the 400 unknown-kind path below (the peer's push schema has no arm for
      // this record kind at all, so it 400s at Zod before the gate runs). Both
      // surface the same SchemaGapBadge + engage the same cooldown; the marker just
      // distinguishes them in state/logs.
      reason,
      ahead: Array.isArray(ahead) ? ahead : [],
      behind: Array.isArray(behind) ? behind : [],
      peerPortosVersion: peerPortosVersion || null,
      peerSchemaVersions: peerSchemaVersions || null,
    };
    sub.updatedAt = now;
    await writeState(state);
  });
  peerSyncEvents.emit('subscription-blocked', { subId, peerId: blockedPeerId });
}

async function clearSchemaVersionBlock(subId) {
  let clearedPeerId = null;
  await withStateLock(async () => {
    const state = await readState();
    const sub = state.subscriptions.find((s) => s.id === subId);
    if (!sub || !sub.blockedBySchema) return;
    clearedPeerId = sub.peerId || null;
    delete sub.blockedBySchema;
    sub.updatedAt = new Date().toISOString();
    await writeState(state);
  });
  peerSyncEvents.emit('subscription-unblocked', { subId, peerId: clearedPeerId });
}

export async function buildPushPayload(sub, sourceInstanceId) {
  const portosMeta = await buildPortosMeta();
  if (sub.recordKind === 'universe') {
    const record = await getUniverse(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('universe', record);
    if (!sanitized) return null;
    // Look up the linked media collection (auto-managed "Universe: X" bucket)
    // and bundle it in the payload. Without this, collection-only edits (a
    // new image added to the universe's gallery) wouldn't move the universe
    // record itself, so the lastPushedHash short-circuit would treat the
    // push as "unchanged" and the receiver's collection would diverge
    // permanently. Tombstone pushes skip the collection bundle — a deleted
    // universe's collection gets unlinked + orphaned locally, and shipping
    // it would re-create an empty bucket on the receiver.
    const linkedCollection = record.deleted === true
      ? null
      : await findCollectionByUniverseId(sub.recordId).catch(() => null);
    // Tombstone push: deleted records carry no on-disk assets the receiver
    // should pull. Sending an empty manifest avoids triggering
    // pullMissingAssetsFromPeer for a record we're telling the peer to
    // delete — both wasteful (network + disk for bytes the receiver will
    // immediately orphan) and privacy-sensitive (e.g. a record deleted
    // BECAUSE the user wanted the assets off-peer would otherwise still
    // ship them with the tombstone push).
    const assetManifest = record.deleted === true
      ? []
      : await buildAssetManifestWithCollection(record, linkedCollection);
    // Bundle the catalog rows referenced by this universe (ingredients + the
    // universe→ingredient ref links). The embedded canon already replicates
    // via the universe record, but the catalog row's enrichments (tags,
    // embedding, payload.summary) live ONLY in Postgres — without this bundle
    // the receiver re-derives a strictly-lossy view on its first backfill.
    // Skip for tombstone pushes (the universe is being deleted; its ref rows
    // tombstone locally and ride a later catalog-sync cycle if needed).
    const catalogBundle = record.deleted === true
      ? null
      : await buildCatalogBundleForRef('universe', sub.recordId);
    return {
      kind: 'universe',
      record: sanitized,
      assetManifest,
      sourceInstanceId,
      portosMeta,
      ...(linkedCollection ? { linkedCollection } : {}),
      ...(catalogBundle ? { catalogBundle } : {}),
    };
  }
  if (sub.recordKind === 'series') {
    const record = await getSeries(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('series', record);
    if (!sanitized) return null;
    // Bundle child issues — the series + its issues form one unit of edit
    // for downstream consumers (panels, comic pages), so the receiver
    // applies them atomically per merge cycle.
    const childIssues = await listIssues({ seriesId: sub.recordId, includeDeleted: true }).catch(() => []);
    const sanitizedIssues = childIssues
      .map((i) => sanitizeRecordForWire('issue', i))
      .filter(Boolean);
    // Drop ephemeral child issues BEFORE feeding into the asset-manifest
    // builder. sanitizedIssues above already filters them via
    // sanitizeRecordForWire's ephemeral check, but the asset-manifest builder
    // takes the raw `childIssues` array — without the parallel filter here,
    // ephemeral issues' image / video / image-ref filenames would still
    // appear in the manifest the receiver pulls. The user-visible effect:
    // private/scratch image bytes for an issue the user said "don't sync"
    // would land on every peer's disk via pullMissingAssetsFromPeer.
    // ALSO drop deleted child issues from the manifest input — their
    // tombstones still ride along in `sanitizedIssues` (so the receiver
    // can finish its delete cascade), but shipping the deleted issues'
    // asset filenames would trigger needless / privacy-sensitive pulls
    // for bytes that are about to be orphaned on the receiver.
    // Tombstoned ephemeral issues (deleted=true + ephemeral=true) ALSO
    // stay out of the manifest input by this filter.
    const manifestIssues = childIssues.filter(
      (i) => i?.deleted !== true && i?.ephemeral !== true,
    );
    // Same collection-bundle reasoning as the universe branch: a "Series: X"
    // collection's item changes don't move the series record, so without
    // bundling the collection here the per-record push would short-circuit
    // and the receiver's collection would diverge.
    const linkedCollection = record.deleted === true
      ? null
      : await findCollectionBySeriesId(sub.recordId).catch(() => null);
    // Tombstone push at the series level: same reasoning as universe above.
    // When the series itself is deleted, send an empty asset manifest so
    // the receiver doesn't pull bytes for a record it's about to tombstone.
    const assetManifest = record.deleted === true
      ? []
      : await buildAssetManifestForSeries(record, manifestIssues, linkedCollection);
    // Bundle the manuscript-review sibling doc (the "Finish the draft" comment
    // set) so review-only edits — which don't move the series record — still
    // propagate. Same reasoning as the linkedCollection bundle above: the
    // review rides the payload AND the push hash, defeating the lastPushedHash
    // short-circuit. Skip for tombstones (a deleted series ships no review).
    // Dynamic import keeps manuscriptReview's arcPlanner graph off peerSync's
    // boot load path (matches the catalogBundle pattern).
    const manuscriptReview = record.deleted === true
      ? null
      : await import('../pipeline/manuscriptReview.js')
        .then(({ getReview }) => getReview(sub.recordId))
        .catch(() => null);
    // Bundle the reverse-outline sibling doc (the scene-by-scene segmentation)
    // on the same terms as the review above: a regenerate-only change doesn't
    // move the series record, so without bundling it the per-record push would
    // short-circuit and the receiver's outline would diverge. Only a `complete`
    // outline is worth shipping. Skip for tombstones. Dynamic import keeps
    // reverseOutline's arcPlanner graph off peerSync's boot load path.
    const reverseOutline = record.deleted === true
      ? null
      : await import('../pipeline/reverseOutline.js')
        .then(({ getStoredOutline }) => getStoredOutline(sub.recordId))
        .catch(() => null);
    return {
      kind: 'series',
      record: sanitized,
      issues: sanitizedIssues,
      assetManifest,
      sourceInstanceId,
      portosMeta,
      ...(linkedCollection ? { linkedCollection } : {}),
      ...(manuscriptReview && manuscriptReview.comments?.length ? { manuscriptReview } : {}),
      ...(reverseOutline && reverseOutline.status === 'complete' ? { reverseOutline } : {}),
    };
  }
  if (sub.recordKind === 'mediaCollection') {
    const record = await getCollection(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('mediaCollection', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildCollectionAssetManifest(record);
    return { kind: 'mediaCollection', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'author') {
    const record = await getAuthor(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('author', record);
    if (!sanitized) return null;
    // Tombstone push ships no assets — the receiver is about to delete the
    // record, so pulling its headshot would be wasteful + privacy-sensitive
    // (same reasoning as the universe/series branches above).
    const assetManifest = record.deleted === true ? [] : await buildAuthorAssetManifest(record);
    return { kind: 'author', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'artist') {
    const record = await getArtist(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('artist', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildArtistAssetManifest(record);
    return { kind: 'artist', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'album') {
    const record = await getAlbum(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('album', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildAlbumAssetManifest(record);
    return { kind: 'album', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'track') {
    const record = await getTrack(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('track', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildTrackAssetManifest(record);
    return { kind: 'track', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'creativeDirectorProject') {
    const record = await getProject(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('creativeDirectorProject', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildProjectAssetManifest(record);
    return { kind: 'creativeDirectorProject', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'moodBoard') {
    const record = await getBoard(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('moodBoard', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildBoardAssetManifest(record);
    return { kind: 'moodBoard', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'writersRoomWork') {
    const record = await getWorkForSync(sub.recordId).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('writersRoomWork', record);
    if (!sanitized) return null;
    // The work manifest carries draft-version METADATA; the file-primary `.md`
    // prose bodies ride a separate `draftBodyManifest` (SHA256 per draft) the
    // receiver diffs + pulls. A tombstone ships neither asset manifest.
    const draftBodyManifest = record.deleted === true ? [] : await buildWorkBodyManifest(record);
    return { kind: 'writersRoomWork', record: sanitized, assetManifest: [], draftBodyManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'writersRoomFolder') {
    // Body-less (#1645) — no asset/body manifest, just the LWW record envelope.
    const record = await getFolderForSync(sub.recordId).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('writersRoomFolder', record);
    if (!sanitized) return null;
    return { kind: 'writersRoomFolder', record: sanitized, assetManifest: [], sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'writersRoomExercise') {
    const record = await getExerciseForSync(sub.recordId).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('writersRoomExercise', record);
    if (!sanitized) return null;
    return { kind: 'writersRoomExercise', record: sanitized, assetManifest: [], sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'musicVideoProject') {
    // #1770 ships the record (metadata + beat-aligned scenes) as the LWW
    // envelope; #1772 bundles its referenced media. A tombstone ships no bytes.
    const record = await getMusicVideoProject(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('musicVideoProject', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildMusicVideoAssetManifest(record);
    // #1858: bundle the LINKED TRACK RECORD (create-UI projects store `trackId`,
    // not `uploadedAudioFilename`). The audio BYTES ride `assetManifest` above,
    // but the receiver's `resolveMasterAudioPath()` looks the track up by id
    // FIRST and throws "Linked track not found" without the record — so a peer
    // subscribed to `musicVideoProjects` only (no Tracks category) needs the
    // record itself to render. Additive optional key: an older receiver ignores
    // it (same as before), so no schema-version bump (mirrors `linkedCollection`).
    let linkedTrack = null;
    if (record.deleted !== true && isStr(record.trackId)) {
      const track = await getTrack(record.trackId, { includeDeleted: true }).catch(() => null);
      // Ship the linked track whether LIVE or a TOMBSTONE. A track delete fans
      // out to its linked music-video projects (collectSubscriptionsForUpdate),
      // and a musicVideoProjects-only peer needs the tombstone to converge
      // instead of keeping stale audio it can still (wrongly) render. The audio
      // BYTES are dropped for a deleted track (buildMusicVideoAssetManifest reads
      // it without includeDeleted), so only the tombstone record rides.
      if (track) linkedTrack = sanitizeRecordForWire('track', track);
    }
    return {
      kind: 'musicVideoProject', record: sanitized, assetManifest, sourceInstanceId, portosMeta,
      ...(linkedTrack ? { linkedTrack } : {}),
    };
  }
  return null;
}

/**
 * Build the catalog bundle (`{ ingredients, refs }`) that piggy-backs on a
 * universe record push. Catalog data lives in Postgres only — on a non-Postgres
 * install (or when the catalog tables don't exist yet) there's nothing to
 * bundle, so we gate on the backend and swallow any read failure: a missing
 * bundle is non-fatal (the universe record still replicates; the receiver's
 * backfill re-derives a lossy view, exactly as before this bundle existed).
 *
 * Returns `null` (omit the key) when there's nothing to ship — both the
 * non-Postgres case and the genuinely-empty case (a universe with no catalog
 * refs yet). Dynamic import keeps catalogDB's pg module graph off peerSync's
 * load path on installs that never touch Postgres.
 */
async function buildCatalogBundleForRef(refKind, refId) {
  const { getBackendName } = await import('../memoryBackend.js');
  if (getBackendName() !== 'postgres') return null;
  const { getCatalogBundleForRef } = await import('../catalogDB.js');
  const bundle = await getCatalogBundleForRef(refKind, refId).catch((err) => {
    console.log(`⚠️ peerSync: catalog bundle for ${refKind}/${refId} failed: ${err.message}`);
    return null;
  });
  if (!bundle) return null;
  const ingredients = Array.isArray(bundle.ingredients) ? bundle.ingredients : [];
  const refs = Array.isArray(bundle.refs) ? bundle.refs : [];
  if (ingredients.length === 0 && refs.length === 0) return null;
  return { ingredients, refs };
}

// Tiny stable-string hash for the push short-circuit. NOT a cryptographic
// hash — we just need "is this the same record we last pushed". Collisions
// at this size mean we MIGHT skip a real edit, but the snapshot sync would
// catch it within 60s, so the cost is bounded.
function simplePayloadHash(record) {
  // JSON.stringify is key-order sensitive, and sanitizeRecordForWire
  // guarantees a canonical key order — so two identical logical records
  // produce identical hashes here.
  const json = JSON.stringify(record);
  let h = 0;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) - h + json.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}