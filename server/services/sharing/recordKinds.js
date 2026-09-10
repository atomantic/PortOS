/**
 * Federated peer-sync — per-kind record descriptor table.
 *
 * The 16 subscribable record kinds (`PEER_SUBSCRIBABLE_KINDS`,
 * `peerSyncShared.js`) each need the same four facts — how to load one by
 * id, how to merge an incoming batch, how to build its asset manifest, and
 * whether the kind has a local-only "ephemeral" opt-out flag. Before #6843
 * those facts were spelled out as six parallel `kind === '…'` ladders across
 * `peerSyncPush.js`, `peerSyncReceive.js`, `peerSyncAssets.js` and
 * `tombstoneGc.js`; a kind added to some ladders and missed in others failed
 * silently (a missing `classifyLocalRecord` arm never auto-creates a reverse
 * subscription; a missing `buildPushPayload` arm never pushes at all). This
 * table is the single per-kind source of truth those call sites now dispatch
 * through — same shape as the `RECORD_KIND_LISTERS` table in `peerSync.js`
 * and `LIVE_ID_LISTERS`/`ALL_ID_LISTERS` in `tombstoneGc.js`.
 *
 * Imports only the store getters/mergers `peerSyncPush.js` and
 * `peerSyncReceive.js` already imported directly (same files, so no new
 * static-import-closure edge — see `server/lib/importScoping.test.js`), plus
 * the per-kind asset-manifest builders from `peerSyncAssets.js`. This module
 * imports peerSyncAssets.js; peerSyncAssets.js never imports this module
 * back (recordKinds.js -> peerSyncAssets.js is the only allowed direction).
 *
 * `universe` and `series` carry `buildAssetManifest: null` — their asset
 * manifests need a bundled linked-collection/child-issues argument the
 * generic one-record builders don't take, so `buildPushPayload` keeps their
 * bundle-aware construction as explicit hooks instead of routing it through
 * this table. `writersRoomWork`, `writersRoomFolder`, `writersRoomExercise`,
 * `commissionFeedback` and `creativeCommission` also carry
 * `buildAssetManifest: null` — they ship no generic asset manifest at all
 * (writersRoomWork's prose rides the separate `draftBodyManifest`; the other
 * four are body-less LWW records).
 *
 * `merge` is called uniformly as `desc.merge(records, { source,
 * senderSchemaVersions })` — every merger destructures at least `{ source }`;
 * the dozen that don't also use `senderSchemaVersions` simply ignore the
 * extra key (only `mergeUniversesFromSync` and `mergeLoomsFromSync` read it).
 */
import { getUniverse, mergeUniversesFromSync } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync } from '../pipeline/series.js';
import { listIssuesForSeries } from '../pipeline/issues.js';
import { getCollection, findCollectionBySeriesId, mergeMediaCollectionsFromSync } from '../mediaCollections.js';
import { getAuthor, mergeAuthorsFromSync } from '../authors/index.js';
import { getArtist, mergeArtistsFromSync } from '../artists/index.js';
import { getAlbum, mergeAlbumsFromSync } from '../albums/index.js';
import { getTrack, mergeTracksFromSync } from '../tracks/index.js';
import { getProject, mergeProjectsFromSync } from '../creativeDirector/local.js';
import { getProject as getMusicVideoProject, mergeProjectsFromSync as mergeMusicVideoProjectsFromSync } from '../musicVideo/projects.js';
import { getBoard, mergeBoardsFromSync } from '../moodBoard/index.js';
import { getLoom, mergeLoomsFromSync } from '../fableLoom/index.js';
import {
  getWorkForSync, mergeWorksFromSync,
  getFolderForSync, mergeFoldersFromSync,
  getExerciseForSync, mergeExercisesFromSync,
} from '../writersRoom/sync.js';
import { getCommissionFeedbackForSync, mergeCommissionFeedbackFromSync } from '../creativeCommissions/feedbackStore.js';
import { getCommissionForSync, mergeCommissionsFromSync } from '../creativeCommissions/store.js';
import {
  buildAssetManifest,
  buildAssetManifestForSeries,
  buildCollectionAssetManifest,
  buildAuthorAssetManifest,
  buildArtistAssetManifest,
  buildAlbumAssetManifest,
  buildTrackAssetManifest,
  buildProjectAssetManifest,
  buildMusicVideoAssetManifest,
  buildBoardAssetManifest,
  buildFableLoomAssetManifest,
} from './peerSyncAssets.js';
import { isNonBlankStr } from '../../lib/textUtils.js';

export const RECORD_KINDS = Object.freeze({
  __proto__: null, // same reason as RECORD_KIND_LISTERS: a lookup can only hit a declared kind
  universe: {
    load: (id) => getUniverse(id, { includeDeleted: true }),
    merge: mergeUniversesFromSync,
    buildAssetManifest: null, // bundle-aware builder lives in buildPushPayload's universe hook
    hasEphemeral: true,
  },
  series: {
    load: (id) => getSeries(id, { includeDeleted: true }),
    merge: mergeSeriesFromSync,
    buildAssetManifest: null, // bundle-aware builder lives in buildPushPayload's series hook
    hasEphemeral: true,
  },
  mediaCollection: {
    load: (id) => getCollection(id, { includeDeleted: true }),
    merge: mergeMediaCollectionsFromSync,
    buildAssetManifest: buildCollectionAssetManifest,
    hasEphemeral: false,
  },
  author: {
    load: (id) => getAuthor(id, { includeDeleted: true }),
    merge: mergeAuthorsFromSync,
    buildAssetManifest: buildAuthorAssetManifest,
    hasEphemeral: false,
  },
  artist: {
    load: (id) => getArtist(id, { includeDeleted: true }),
    merge: mergeArtistsFromSync,
    buildAssetManifest: buildArtistAssetManifest,
    hasEphemeral: false,
  },
  album: {
    load: (id) => getAlbum(id, { includeDeleted: true }),
    merge: mergeAlbumsFromSync,
    buildAssetManifest: buildAlbumAssetManifest,
    hasEphemeral: false,
  },
  track: {
    load: (id) => getTrack(id, { includeDeleted: true }),
    merge: mergeTracksFromSync,
    buildAssetManifest: buildTrackAssetManifest,
    hasEphemeral: false,
  },
  creativeDirectorProject: {
    load: (id) => getProject(id, { includeDeleted: true }),
    merge: mergeProjectsFromSync,
    buildAssetManifest: buildProjectAssetManifest,
    hasEphemeral: false,
  },
  moodBoard: {
    load: (id) => getBoard(id, { includeDeleted: true }),
    merge: mergeBoardsFromSync,
    buildAssetManifest: buildBoardAssetManifest,
    hasEphemeral: false,
  },
  fableLoom: {
    load: (id) => getLoom(id, { includeDeleted: true }),
    merge: mergeLoomsFromSync,
    buildAssetManifest: buildFableLoomAssetManifest,
    // No ephemeral concept (syncWire.js's fableLoom wire case: "always
    // wire-syncable when present"). `classifyLocalRecord` had NO arm for this
    // kind before this table — a found loom always fell through to the
    // ladder's final `return 'missing'`, so an inbound fableLoom push never
    // auto-created a reverse subscription. Same bug class as the
    // mediaCollection gap `peerSync.test.js` documents ("Regression (Bug 1):
    // classifyLocalRecord had no mediaCollection branch"); the registry-
    // completeness guard in recordKinds.test.js makes the omission
    // structurally impossible going forward.
    hasEphemeral: false,
  },
  writersRoomWork: {
    load: (id) => getWorkForSync(id),
    merge: mergeWorksFromSync,
    buildAssetManifest: null, // prose rides the separate draftBodyManifest, not assetManifest
    hasEphemeral: false,
  },
  writersRoomFolder: {
    load: (id) => getFolderForSync(id),
    merge: mergeFoldersFromSync,
    buildAssetManifest: null, // body-less (#1645)
    hasEphemeral: false,
  },
  writersRoomExercise: {
    load: (id) => getExerciseForSync(id),
    merge: mergeExercisesFromSync,
    buildAssetManifest: null, // body-less (#1645)
    hasEphemeral: false,
  },
  musicVideoProject: {
    load: (id) => getMusicVideoProject(id, { includeDeleted: true }),
    merge: mergeMusicVideoProjectsFromSync,
    buildAssetManifest: buildMusicVideoAssetManifest,
    // Documented drift (pre-#6843): applyIncomingPush's local-ephemeral lookup
    // special-cased this kind (`local?.ephemeral === true`, added by #1858),
    // but the store carries no ephemeral flag at all
    // (`musicVideo/projectsLogic.js`: "no ephemeral flag") and
    // classifyLocalRecord already documented that. `hasEphemeral: false` is
    // the behavior-identical replacement — the old check always evaluated to
    // false, it just cost a disk read to get there.
    hasEphemeral: false,
  },
  commissionFeedback: {
    load: (id) => getCommissionFeedbackForSync(id),
    merge: mergeCommissionFeedbackFromSync,
    buildAssetManifest: null, // body-less (#2686)
    hasEphemeral: false,
  },
  creativeCommission: {
    load: (id) => getCommissionForSync(id),
    merge: mergeCommissionsFromSync,
    buildAssetManifest: null, // body-less brief (#2686)
    hasEphemeral: false,
  },
});

// --- Asset-integrity manifest (moved from peerSyncAssets.js, #6843) -------
//
// Kept here rather than in peerSyncAssets.js because its dispatch reads
// RECORD_KINDS; peerSyncAssets.js must never import this module (the
// allowed direction is recordKinds.js -> peerSyncAssets.js only, so the
// asset-builder leaf never has to know this table exists).

function summarizeAssetManifest(manifest) {
  const entries = Array.isArray(manifest) ? manifest : [];
  return {
    assetHashes: entries.map((e) => e.sha256).filter(Boolean).sort(),
    metadataMissing: entries.some((e) => e?.kind === 'image' && !isNonBlankStr(e.sidecarSha256)),
  };
}

async function buildIntegrityAssetManifest(kind, record) {
  if (kind === 'series') {
    // Mirrors the push manifest path (buildPushPayload's series hook) so
    // child issue assets participate in integrity the same way they ride a
    // series push.
    const childIssues = await listIssuesForSeries(record?.id, { includeDeleted: true }).catch(() => []);
    const manifestIssues = childIssues.filter((i) => i?.deleted !== true && i?.ephemeral !== true);
    const linkedCollection = await findCollectionBySeriesId(record?.id).catch(() => null);
    return buildAssetManifestForSeries(record, manifestIssues, linkedCollection);
  }
  const desc = RECORD_KINDS[kind];
  if (desc?.buildAssetManifest) return desc.buildAssetManifest(record);
  // universe (bundle-aware builder needs a linkedCollection arg this
  // integrity check doesn't have) and every body-less/draft-body kind fall
  // back to the generic direct-image-reference scan — same as before this
  // table existed, when the ladder's final line was `return
  // buildAssetManifest(record);` for any kind without its own arm.
  return buildAssetManifest(record);
}

/**
 * Returns the integrity-facing asset summary for a record: sorted file hashes
 * plus whether any hashed image lacks a gen-params sidecar. `series` mirrors
 * the push manifest path so child issue assets participate in integrity.
 *
 * @param {string} kind one of PEER_SUBSCRIBABLE_KINDS
 * @param {object} record
 * @returns {Promise<{assetHashes:string[], metadataMissing:boolean}>}
 */
export async function assetIntegrityForRecord(kind, record) {
  const manifest = await buildIntegrityAssetManifest(kind, record);
  return summarizeAssetManifest(manifest);
}

/**
 * Back-compat helper for callers/tests that only need hashes.
 *
 * @param {string} kind one of PEER_SUBSCRIBABLE_KINDS
 * @param {object} record
 * @returns {Promise<string[]>} sorted sha256 strings (falsy hashes omitted)
 */
export async function assetShaListForRecord(kind, record) {
  const { assetHashes } = await assetIntegrityForRecord(kind, record);
  return assetHashes;
}
