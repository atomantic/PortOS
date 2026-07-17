/**
 * Tombstone garbage collection for federated peer sync.
 *
 * The Stage 1 soft-delete refactor turned deletes into tombstone records
 * (`{ deleted: true, deletedAt }`) so the LWW merge can keep them from
 * being resurrected by out-of-date peers. Tombstones cannot be pruned
 * blindly — if peer-A deletes record X and peer-B comes online later,
 * peer-B's snapshot must still see the tombstone so its older "live" copy
 * loses the merge.
 *
 * This sweep prunes a tombstone only when BOTH conditions hold:
 *   1. Every peer currently subscribed to the record's kind has acked a
 *      deletedAt at least as recent as the tombstone (so we know every
 *      subscriber has received and applied this specific deletion).
 *   2. At least `graceMs` has elapsed since the tombstone was created — a
 *      buffer for transient replay / disconnect cases that haven't shown
 *      up in the ack water-mark yet. The orchestrator path uses the 24h
 *      default; the manual-trigger UI / CLI passes `graceMs: 0`.
 *
 * When a record's kind has NO subscribed peers, condition (1) is trivially
 * satisfied (`getMinAckAcrossPeers([])` returns Infinity), so the sweep
 * falls back to a simple "older than grace" check.
 *
 * Issues piggyback on the series subscription model — an issue tombstone
 * is only pushed alongside its parent series's push, so the relevant ack
 * cohort for issue tombstones is "peers subscribed to series".
 *
 * Tracks have a similar piggyback case (#1922): a musicVideoProject push
 * bundles its linked track record (#1858) so a peer subscribed to
 * musicVideoProjects only — no independent `track` subscription — can still
 * resolve and render it. Such a peer is invisible to a `track`-subscription-
 * only ack cohort, so the `track` cutoff also folds in peers subscribed to
 * `musicVideoProject`, reading their confirmed-delivery floor off the
 * bundle-specific `lastConfirmedTrackBundleAtMs` (not the generic
 * `lastConfirmedPushedAt`, which advances even when the bundled track merge
 * failed). See `TRACK_COHORT_KINDS` / `confirmedFloorForSub` below.
 */

import { pruneTombstonedUniverses, listUniverses } from '../universeBuilder.js';
import { pruneTombstonedSeries, listSeries } from '../pipeline/series.js';
import { pruneTombstonedIssues, listIssueIds } from '../pipeline/issues.js';
import { pruneTombstonedCollections, listCollections } from '../mediaCollections.js';
import { pruneTombstonedAuthors, listAuthorIds } from '../authors/index.js';
import { pruneTombstonedArtists, listArtistIds } from '../artists/index.js';
import { pruneTombstonedAlbums, listAlbumIds } from '../albums/index.js';
import { pruneTombstonedTracks, listTrackIds } from '../tracks/index.js';
import { pruneTombstonedProjects, listProjectIds } from '../creativeDirector/local.js';
import {
  pruneTombstonedProjects as pruneTombstonedMusicVideoProjects,
  listProjectIds as listMusicVideoProjectIds,
} from '../musicVideo/projects.js';
import { pruneTombstonedBoards, listBoardIds } from '../moodBoard/index.js';
import {
  pruneTombstonedWorks, listWorkIdsForSync,
  pruneTombstonedFolders, listFolderIdsForSync,
  pruneTombstonedExercises, listExerciseIdsForSync,
} from '../writersRoom/sync.js';
import {
  pruneTombstonedCommissionFeedback, listCommissionFeedbackIdsForSync,
} from '../creativeCommissions/feedbackStore.js';
import { pruneOrphanedBaseHashes } from '../../lib/conflictJournal.js';
import { listPeerSubscriptions, pruneOrphanedPeerSubscriptions } from './peerSync.js';
import { getMinAckAcrossPeers } from './peerTombstoneCursors.js';
import { getPeers } from '../instances.js';

// Each kind's UNCAPPED live-id source (default args exclude tombstoned/deleted).
// Used to build the orphan-sweep resolver's per-kind id-sets. A kind absent
// from this map is unknown → the resolver keeps its keys (never strips).
// `listIssueIds` (not `listIssues`) because the latter caps at 1000 — a capped
// source would report a live record beyond the cap as missing and the sweep
// would strip its base hash, silently disabling conflict detection for it.
const LIVE_ID_LISTERS = Object.freeze({
  universe: async () => (await listUniverses()).map((r) => r.id),
  series: async () => (await listSeries()).map((r) => r.id),
  issue: () => listIssueIds(),
  mediaCollection: async () => (await listCollections()).map((r) => r.id),
  author: () => listAuthorIds(),
  artist: () => listArtistIds(),
  album: () => listAlbumIds(),
  track: () => listTrackIds(),
  creativeDirectorProject: () => listProjectIds(),
  musicVideoProject: () => listMusicVideoProjectIds(),
  moodBoard: () => listBoardIds(),
  writersRoomWork: () => listWorkIdsForSync(),
  writersRoomFolder: () => listFolderIdsForSync(),
  writersRoomExercise: () => listExerciseIdsForSync(),
  commissionFeedback: () => listCommissionFeedbackIdsForSync(),
});

// Each peer-subscribable kind's UNCAPPED id source INCLUDING tombstones —
// used by the orphan peer-subscription sweep. A tombstoned record still owns
// its subscription (the sub pushes the delete to peers), so the sweep must
// treat a tombstone as "still resolves" and strip a sub only once the record
// directory is actually gone (hard-deleted by the tombstone prune above).
// Issues are absent — they're never directly subscribed (issue tombstones
// ride their parent series's push, so PEER_SUBSCRIBABLE_KINDS has no 'issue').
const ALL_ID_LISTERS = Object.freeze({
  universe: async () => (await listUniverses({ includeDeleted: true })).map((r) => r.id),
  series: async () => (await listSeries({ includeDeleted: true })).map((r) => r.id),
  mediaCollection: async () => (await listCollections({ includeDeleted: true })).map((r) => r.id),
  author: () => listAuthorIds({ includeDeleted: true }),
  artist: () => listArtistIds({ includeDeleted: true }),
  album: () => listAlbumIds({ includeDeleted: true }),
  track: () => listTrackIds({ includeDeleted: true }),
  creativeDirectorProject: () => listProjectIds({ includeDeleted: true }),
  musicVideoProject: () => listMusicVideoProjectIds({ includeDeleted: true }),
  moodBoard: () => listBoardIds({ includeDeleted: true }),
  writersRoomWork: () => listWorkIdsForSync({ includeDeleted: true }),
  writersRoomFolder: () => listFolderIdsForSync({ includeDeleted: true }),
  writersRoomExercise: () => listExerciseIdsForSync({ includeDeleted: true }),
  commissionFeedback: () => listCommissionFeedbackIdsForSync({ includeDeleted: true }),
});

// Build a kind-aware id-membership resolver for ONE sweep: lazily list each
// kind's id Set on first use (a sweep that never probes a kind never lists it)
// and check membership in memory — at most one listing per kind per sweep,
// collapsing what would otherwise be one record read per probed key. Unknown
// kinds resolve to `true` so a sweep can never strip something it can't
// authoritatively check (a key for a future kind, or a shape this version
// doesn't recognize); a listing that throws also keeps the kind (both
// `pruneOrphanedBaseHashes` and `pruneOrphanedPeerSubscriptions` treat a
// resolver rejection as "still resolves"). The base-hash sweep passes
// LIVE_ID_LISTERS (a record stops protecting its base hash once tombstoned);
// the subscription sweep passes ALL_ID_LISTERS (a tombstone still owns its
// sub until the record dir is hard-deleted).
function makeRecordIdResolver(listers) {
  const idSets = new Map(); // kind → Set<id>
  return async (kind, id) => {
    const lister = listers[kind];
    if (!lister) return true; // unknown kind → never strip
    if (!idSets.has(kind)) {
      idSets.set(kind, new Set(await lister()));
    }
    return idSets.get(kind).has(id);
  };
}

const GRACE_MS = 24 * 60 * 60 * 1000;

// `peer_subscriptions.json` rows outlive peer removal (no cleanup hook on
// instance delete), and disabled / globally-silenced peers never advance
// their ack cursor. Filtering against this set keeps a stale sub from
// freezing the GC water-mark at peer-removal time.
function eligiblePeerIdSet(peers) {
  return new Set(
    peers
      .filter((p) => p?.enabled && p.syncEnabled !== false)
      .map((p) => p.instanceId)
      .filter(Boolean),
  );
}

// #1922: a musicVideoProject subscription is also a delivery vehicle for its
// linked track's tombstone (#1858 bundles `linkedTrack` on the project push).
// A peer subscribed to musicVideoProjects only (no `track` subscription of
// its own) is otherwise INVISIBLE to the `track` cutoff cohort below — so
// without this, track-tombstone GC never waited on such a peer at all, and
// could prune the tombstone before a transient bundled-delivery retry landed.
// Fold musicVideoProject subscribers into the `track` cohort; the precise
// per-record floor for THEIR rows comes from `lastConfirmedTrackBundleAtMs`
// (see `confirmedFloorForSub` below), not the generic `lastConfirmedPushedAt`.
const TRACK_COHORT_KINDS = Object.freeze(['track', 'musicVideoProject']);

function cohortKindsFor(recordKind) {
  return recordKind === 'track' ? TRACK_COHORT_KINDS : [recordKind];
}

function peerIdsSubscribedToKind(subs, peers, recordKind) {
  const cohortKinds = cohortKindsFor(recordKind);
  const eligible = eligiblePeerIdSet(peers);
  return [...new Set(
    subs
      .filter((s) => cohortKinds.includes(s.recordKind))
      .map((s) => s.peerId)
      .filter((id) => id && eligible.has(id)),
  )];
}

// Lowest per-(peer,record) confirmed-delivery water-mark across this kind's
// eligible subscription rows (ms epoch). This closes the per-peer-cursor gap:
// the per-peer tombstone ack cursor advances to the MAX deletedAt acked across
// ALL of a peer's pushes, so a later record-B success can drag it past a
// record-A whose push never landed — and GC would then prune A's tombstone
// even though A was never confirmed delivered. Clamping the prune cutoff to
// the MIN `lastConfirmedPushedAt` across the kind's rows holds the line: any
// record whose push is unconfirmed (field still `null`, or stuck at a
// pre-delete success time) pins the cutoff below its own `deletedAt`, so its
// tombstone survives until that record's (delete-)push is actually confirmed.
//
// A row with no `lastConfirmedPushedAt` yet (never had a confirmed push) floors
// to its `createdAt` rather than 0: a brand-new subscription should protect
// tombstones created AFTER it subscribed (those it still owes the peer) without
// freezing GC of tombstones that predate the subscription entirely — those
// older tombstones are already gated by the cursor's `subscribedSince` horizon
// (peerTombstoneCursors.js) and were never going to ride this row's pushes.
// An unparseable `createdAt` (hand-edited / legacy row) floors to 0 — fully
// conservative, never a false prune.
//
// #1922: which field on a subscription row holds its confirmed-delivery
// water-mark FOR `targetKind`. Only a musicVideoProject row standing in for
// the `track` cutoff (i.e. `targetKind === 'track'`) reads the bundle-specific
// `lastConfirmedTrackBundleAtMs` — its generic `lastConfirmedPushedAt`
// advances on every successful project push REGARDLESS of whether the
// bundled track merge succeeded (`trackSyncPending`), so reusing it here
// would let GC treat an unconfirmed bundled tombstone as delivered. The SAME
// row's protection of its OWN `musicVideoProject` tombstone (when
// `targetKind === 'musicVideoProject'`) still reads `lastConfirmedPushedAt`,
// unchanged. Every other recordKind/targetKind pairing also keeps using
// `lastConfirmedPushedAt` as before.
//
// Upgrade compat: an existing musicVideoProject subscription row created
// BEFORE this field existed has no `lastConfirmedTrackBundleAtMs` at all —
// and if its project content hasn't changed since, `pushRecordToPeer`'s
// `unchanged`-hash short-circuit means it may NEVER take another real push
// that would stamp the field, pinning the `track` floor at that row's old
// `createdAt` indefinitely. A non-null `lastPushedHash` on the row is a safe
// historical proxy: `persistPushSuccess` has ALWAYS withheld the hash when
// `trackSyncPending` was true (#1858, predating this field), so a saved hash
// means that row's most recent successful push already had its bundled track
// merge confirmed — `lastConfirmedPushedAt` is a sound backfilled stand-in.
// A row with neither field set (no hash yet, or hash withheld) still floors
// conservatively to `createdAt`.
function confirmedFloorForSub(sub, targetKind) {
  if (targetKind === 'track' && sub.recordKind === 'musicVideoProject') {
    if (Number.isFinite(sub.lastConfirmedTrackBundleAtMs)) return sub.lastConfirmedTrackBundleAtMs;
    if (typeof sub.lastPushedHash === 'string' && Number.isFinite(sub.lastConfirmedPushedAt)) {
      return sub.lastConfirmedPushedAt;
    }
    const createdMs = Date.parse(sub.createdAt || '');
    return Number.isFinite(createdMs) ? createdMs : 0;
  }
  let confirmed = sub.lastConfirmedPushedAt;
  if (!Number.isFinite(confirmed)) {
    // Never confirmed → floor to createdAt (0 if unparseable). See header.
    const createdMs = Date.parse(sub.createdAt || '');
    confirmed = Number.isFinite(createdMs) ? createdMs : 0;
  }
  return confirmed;
}

// Returns Infinity when there are no eligible rows for the kind (no per-record
// constraint → the snapshot-coverage + per-peer-ack checks alone govern).
//
// #1922: every eligible row of the cohort's kinds contributes its floor,
// INCLUDING a peer's musicVideoProject rows even when that same peer also
// holds a direct `track` subscription. This is deliberately conservative: the
// `track` cutoff is one global value applied to every track tombstone (this
// file has no per-record cutoff mechanism — see the module docstring), and a
// peer can directly subscribe to track A while relying on an UNRELATED
// project's bundle as the only delivery path for track B. Excluding that
// peer's musicVideoProject rows just because it also has SOME direct track
// subscription would let GC prune track B's tombstone before the bundle ever
// confirmed. The accepted tradeoff — an unrelated/stale musicVideoProject
// subscription can hold back pruning for every track tombstone, not just the
// one it bundles — matches this module's "correctness over GC aggressiveness"
// posture for every other kind's clamp (see `minConfirmedPushedAtForKind`'s
// header above).
function minConfirmedPushedAtForKind(subs, peers, recordKind) {
  const cohortKinds = cohortKindsFor(recordKind);
  const eligible = eligiblePeerIdSet(peers);
  let min = Infinity;
  for (const s of subs) {
    if (!cohortKinds.includes(s.recordKind)) continue;
    if (!s.peerId || !eligible.has(s.peerId)) continue;
    const confirmed = confirmedFloorForSub(s, recordKind);
    if (confirmed < min) min = confirmed;
  }
  return min;
}

function snapshotCategoryForKind(recordKind) {
  if (recordKind === 'universe') return 'universe';
  if (recordKind === 'series' || recordKind === 'issue') return 'pipeline';
  if (recordKind === 'mediaCollection') return 'mediaCollections';
  return null;
}

// Peers that can resurrect a pruned tombstone via the 60s snapshot loop.
// The snapshot path has no per-peer ack water-mark, so any peer in this set
// that's NOT also covered by a per-record subscription makes pruning unsafe.
// Legacy peers without `syncCategories` fall back to brain+memory only
// (syncOrchestrator.getEffectiveCategories), so they're excluded.
function snapshotPeerIdsForKind(peers, recordKind) {
  const category = snapshotCategoryForKind(recordKind);
  if (!category) return [];
  return peers
    .filter((p) => {
      if (!p?.enabled) return false;
      if (p.syncEnabled === false) return false;
      // A full-sync peer mirrors every category, so it can resurrect a pruned
      // tombstone for ANY kind via its snapshot loop — it must count here even
      // when its stored syncCategories map doesn't list this category.
      if (p.fullSync === true) return true;
      const cats = p.syncCategories;
      return !!cats && typeof cats === 'object' && cats[category] === true;
    })
    .map((p) => p.instanceId)
    .filter(Boolean);
}

// Returns null when ANY snapshot-mode peer for this kind isn't covered by
// a per-record subscription — without an ack horizon, an offline peer could
// resurrect a pruned tombstone via its next snapshot push. Otherwise the
// cutoff is `min(now, minAck, minConfirmedPush) - graceMs + 1`. The `+1`
// compensates for the strict-less-than comparison the prune helpers use
// (`deletedAt < beforeMs`); without it, a tombstone deleted at the same
// millisecond as the clamp survives forever under `graceMs:0` (the manual-
// trigger path). At graceMs=24h the 1ms shift is invisible, so the
// orchestrator path is unchanged in practice.
//
// `minConfirmedPush` is the per-(peer,record) clamp (see
// minConfirmedPushedAtForKind): the per-peer `minAck` cursor alone can drift
// past a record whose push never landed, so we additionally hold the cutoff
// at/below the lowest confirmed per-record delivery point. Issue tombstones
// ride their parent series's push, so the caller reuses the `series` cutoff
// for issues — the series rows' confirmed-push marks cover issues too.
async function cutoffForKind(recordKind, { peers, subs, now, graceMs }) {
  const peerIds = peerIdsSubscribedToKind(subs, peers, recordKind);
  const snapshotPeerIds = snapshotPeerIdsForKind(peers, recordKind);
  const subbed = new Set(peerIds);
  if (snapshotPeerIds.some((id) => !subbed.has(id))) return null;
  const minAck = await getMinAckAcrossPeers(peerIds);
  const minConfirmedPush = minConfirmedPushedAtForKind(subs, peers, recordKind);
  return Math.min(minAck, minConfirmedPush, now) - graceMs + 1;
}

// Single point of disk I/O for peer registry + subscription rows. Both
// `sweepTombstones` and `getSweepStatus` read these once and thread them
// through the pure helpers, so the orchestrator's 60s loop hits the file
// system twice per cycle instead of six times.
async function loadState() {
  const [peers, subs] = await Promise.all([
    getPeers().catch(() => []),
    listPeerSubscriptions(),
  ]);
  return { peers, subs };
}

function refusedFromCutoffs(cutoffs) {
  const refused = [];
  const {
    universeCutoff,
    seriesCutoff,
    collectionCutoff,
    authorCutoff,
    artistCutoff,
    albumCutoff,
    trackCutoff,
    projectCutoff,
    musicVideoProjectCutoff,
    boardCutoff,
    workCutoff,
    folderCutoff,
    exerciseCutoff,
    commissionFeedbackCutoff,
  } = cutoffs;
  if (universeCutoff === null) refused.push('universe');
  // Issue tombstones ride series pushes — refused exactly when series is.
  if (seriesCutoff === null) {
    refused.push('series');
    refused.push('issue');
  }
  if (collectionCutoff === null) refused.push('mediaCollection');
  // Authors have no snapshot category (snapshotCategoryForKind → null), so the
  // cutoff never refuses on snapshot-coverage grounds — but the per-record
  // confirmed-push clamp can still hold it; surface it for symmetry.
  if (authorCutoff === null) refused.push('author');
  if (artistCutoff === null) refused.push('artist');
  if (albumCutoff === null) refused.push('album');
  if (trackCutoff === null) refused.push('track');
  if (projectCutoff === null) refused.push('creativeDirectorProject');
  if (musicVideoProjectCutoff === null) refused.push('musicVideoProject');
  if (boardCutoff === null) refused.push('moodBoard');
  if (workCutoff === null) refused.push('writersRoomWork');
  if (folderCutoff === null) refused.push('writersRoomFolder');
  if (exerciseCutoff === null) refused.push('writersRoomExercise');
  if (commissionFeedbackCutoff === null) refused.push('commissionFeedback');
  return refused;
}

/**
 * One sweep cycle. Returns `{ universes, series, issues, collections,
 * orphanBaseHashes, orphanSubscriptions, refused }` — the four per-kind
 * tombstone-prune counts, the two post-prune orphan-sweep counts, and the
 * list of kinds whose cutoff was refused.
 *
 * `graceMs` defaults to 24h so the orchestrator path is unchanged; the
 * manual-trigger UI / CLI passes 0 to skip the post-delete buffer. The
 * per-kind null-cutoff refusal (snapshot-mode peer with no per-record sub)
 * fires independently of graceMs — `refused` lists kinds we couldn't touch.
 */
export async function sweepTombstones({ now = Date.now(), graceMs = GRACE_MS } = {}) {
  const { peers, subs } = await loadState();
  const [
    universeCutoff,
    seriesCutoff,
    collectionCutoff,
    authorCutoff,
    artistCutoff,
    albumCutoff,
    trackCutoff,
    projectCutoff,
    musicVideoProjectCutoff,
    boardCutoff,
    workCutoff,
    folderCutoff,
    exerciseCutoff,
    commissionFeedbackCutoff,
  ] = await Promise.all([
    cutoffForKind('universe', { peers, subs, now, graceMs }),
    cutoffForKind('series', { peers, subs, now, graceMs }),
    cutoffForKind('mediaCollection', { peers, subs, now, graceMs }),
    cutoffForKind('author', { peers, subs, now, graceMs }),
    cutoffForKind('artist', { peers, subs, now, graceMs }),
    cutoffForKind('album', { peers, subs, now, graceMs }),
    cutoffForKind('track', { peers, subs, now, graceMs }),
    cutoffForKind('creativeDirectorProject', { peers, subs, now, graceMs }),
    cutoffForKind('musicVideoProject', { peers, subs, now, graceMs }),
    cutoffForKind('moodBoard', { peers, subs, now, graceMs }),
    cutoffForKind('writersRoomWork', { peers, subs, now, graceMs }),
    cutoffForKind('writersRoomFolder', { peers, subs, now, graceMs }),
    cutoffForKind('writersRoomExercise', { peers, subs, now, graceMs }),
    cutoffForKind('commissionFeedback', { peers, subs, now, graceMs }),
  ]);
  const issueCutoff = seriesCutoff;
  const [u, s, i, c, a, ar, al, t, cd, mv, mb, wr, wrf, wre, cfb] = await Promise.all([
    universeCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedUniverses(universeCutoff),
    seriesCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedSeries(seriesCutoff),
    issueCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedIssues(issueCutoff),
    collectionCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedCollections(collectionCutoff),
    authorCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedAuthors(authorCutoff),
    artistCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedArtists(artistCutoff),
    albumCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedAlbums(albumCutoff),
    trackCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedTracks(trackCutoff),
    projectCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedProjects(projectCutoff),
    musicVideoProjectCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedMusicVideoProjects(musicVideoProjectCutoff),
    boardCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedBoards(boardCutoff),
    workCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedWorks(workCutoff),
    folderCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedFolders(folderCutoff),
    exerciseCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedExercises(exerciseCutoff),
    commissionFeedbackCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedCommissionFeedback(commissionFeedbackCutoff),
  ]);
  // Backstop AFTER the tombstone prunes: the prune paths already evict a freshly
  // hard-deleted record's base hash, so this sweep mops up only keys that
  // escaped (records deleted outside the prune path, pre-existing accumulation
  // on long-lived installs, or a future kind without per-record eviction). Runs
  // every kind regardless of which were refused — orphan keys aren't gated on
  // snapshot coverage.
  const orphan = await pruneOrphanedBaseHashes(makeRecordIdResolver(LIVE_ID_LISTERS));
  // Orphan peer-subscription sweep — same backstop logic as the base-hash
  // sweep, AFTER the tombstone prunes so a record whose dir was just rm'd
  // (no longer resolves even with includeDeleted) gets its dead subscription
  // rows dropped. Runs every kind regardless of refusals: an orphaned sub
  // points at a record that no longer exists, so it's safe to strip no matter
  // what the snapshot-coverage gate decided for live tombstones.
  const orphanSubs = await pruneOrphanedPeerSubscriptions(makeRecordIdResolver(ALL_ID_LISTERS));
  return {
    universes: u.pruned,
    series: s.pruned,
    issues: i.pruned,
    collections: c.pruned,
    authors: a.pruned,
    artists: ar.pruned,
    albums: al.pruned,
    tracks: t.pruned,
    creativeDirectorProjects: cd.pruned,
    musicVideoProjects: mv.pruned,
    moodBoards: mb.pruned,
    writersRoomWorks: wr.pruned,
    writersRoomFolders: wrf.pruned,
    writersRoomExercises: wre.pruned,
    commissionFeedback: cfb.pruned,
    orphanBaseHashes: orphan.pruned,
    orphanSubscriptions: orphanSubs.pruned,
    refused: refusedFromCutoffs({ universeCutoff, seriesCutoff, collectionCutoff, authorCutoff, artistCutoff, albumCutoff, trackCutoff, projectCutoff, musicVideoProjectCutoff, boardCutoff, workCutoff, folderCutoff, exerciseCutoff, commissionFeedbackCutoff }),
  };
}

// Dry-run companion to `sweepTombstones` — returns the refused kinds
// without pruning. Refusal is independent of graceMs (only snapshot
// coverage matters), so this hardcodes graceMs:0 internally.
export async function getSweepStatus({ now = Date.now() } = {}) {
  const { peers, subs } = await loadState();
  const [universeCutoff, seriesCutoff, collectionCutoff, authorCutoff, artistCutoff, albumCutoff, trackCutoff, projectCutoff, musicVideoProjectCutoff, boardCutoff, workCutoff, folderCutoff, exerciseCutoff, commissionFeedbackCutoff] = await Promise.all([
    cutoffForKind('universe', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('series', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('mediaCollection', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('author', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('artist', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('album', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('track', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('creativeDirectorProject', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('musicVideoProject', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('moodBoard', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('writersRoomWork', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('writersRoomFolder', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('writersRoomExercise', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('commissionFeedback', { peers, subs, now, graceMs: 0 }),
  ]);
  return { refused: refusedFromCutoffs({ universeCutoff, seriesCutoff, collectionCutoff, authorCutoff, artistCutoff, albumCutoff, trackCutoff, projectCutoff, musicVideoProjectCutoff, boardCutoff, workCutoff, folderCutoff, exerciseCutoff, commissionFeedbackCutoff }) };
}

export const TOMBSTONE_GRACE_MS = GRACE_MS;
