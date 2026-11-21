/**
 * Per-category sync integrity: build a local manifest and compare it against
 * a remote peer's manifest to surface records that are out-of-parity.
 *
 * `buildLocalManifest(kind)` — returns one row per record with id, name,
 *   updatedAt, deleted, and sorted sha256 asset hashes. Tombstones are
 *   included so that deletes diff correctly against the peer.
 *
 * `getPeerIntegrity({ peerId, kind })` — fetches the peer's manifest via
 *   GET /api/peer-sync/manifest, then runs the pure diff. Returns
 *   `{ available: bool, reason?, records: [...] }`.
 */

import { computeRecordIntegrity, INTEGRITY_STATUS } from '../../lib/syncIntegrity.js';
import { peerCollectionIntegrityPayloadSchema } from '../../lib/peerSyncValidation.js';
import { listCollections } from '../mediaCollections.js';
import { listUniverses } from '../universeBuilder.js';
import { listSeries } from '../pipeline/series.js';
import { listLooms } from '../fableLoom/records.js';
import { listAuthors } from '../authors/index.js';
import { listArtists } from '../artists/index.js';
import { listAlbums } from '../albums/index.js';
import { listTracks } from '../tracks/index.js';
import { listProjects as listCreativeDirectorProjects } from '../creativeDirector/local.js';
import { listBoards } from '../moodBoard/index.js';
import { listProjects as listMusicVideoProjects } from '../musicVideo/projects.js';
import {
  listWorksForIntegrity, listFoldersForIntegrity, listExercisesForIntegrity, buildWorkBodyManifest,
} from '../writersRoom/sync.js';
import { listCommissionFeedbackForIntegrity } from '../creativeCommissions/feedbackStore.js';
import { listCommissionsForIntegrity } from '../creativeCommissions/store.js';
import { listDecksForIntegrity } from '../decks.js';
import { listStoryboardsForIntegrity } from '../storyboards/sync.js';
import { getPeers } from '../instances.js';
import { assetIntegrityForRecord, getRecordPayloadForPeer } from './peerSync.js';
import { referenceCollectionAssetManifest } from './peerSyncAssets.js';
import { sanitizeAssetFilename } from './buckets.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch, readPeerBody } from '../../lib/peerHttpClient.js';

const PEER_INTEGRITY_TIMEOUT_MS = 15_000;
const PEER_INTEGRITY_MAX_BYTES = 16 * 1024 * 1024;
// Older peers accepted every kind but only built inventories for these four.
const LEGACY_MANIFEST_KINDS = new Set(['mediaCollection', 'universe', 'series', 'fableLoom']);
export const PEER_MANIFEST_VERSION = 1;
export const isLegacyManifestKind = (kind) => LEGACY_MANIFEST_KINDS.has(kind);

async function recordsForKind(kind) {
  if (kind === 'mediaCollection') return listCollections({ includeDeleted: true });
  if (kind === 'universe') return listUniverses({ includeDeleted: true });
  if (kind === 'series') return listSeries({ includeDeleted: true });
  if (kind === 'fableLoom') return listLooms({ includeDeleted: true });
  if (kind === 'author') return listAuthors({ includeDeleted: true });
  if (kind === 'artist') return listArtists({ includeDeleted: true });
  if (kind === 'album') return listAlbums({ includeDeleted: true });
  if (kind === 'track') return listTracks({ includeDeleted: true });
  if (kind === 'creativeDirectorProject') return listCreativeDirectorProjects({ includeDeleted: true });
  if (kind === 'moodBoard') return listBoards({ includeDeleted: true });
  if (kind === 'musicVideoProject') return listMusicVideoProjects({ includeDeleted: true });
  if (kind === 'writersRoomWork') return listWorksForIntegrity();
  if (kind === 'writersRoomFolder') return listFoldersForIntegrity();
  if (kind === 'writersRoomExercise') return listExercisesForIntegrity();
  if (kind === 'commissionFeedback') return listCommissionFeedbackForIntegrity();
  if (kind === 'creativeCommission') return listCommissionsForIntegrity();
  if (kind === 'deck') return listDecksForIntegrity();
  if (kind === 'storyboard') return listStoryboardsForIntegrity();
  return [];
}

/**
 * Build a local manifest for the given kind.
 * One row per record: `{ id, name, updatedAt, deleted, assetHashes }`.
 * Includes tombstoned records so deletes surface correctly in the diff.
 *
 * @param {string} kind a subscribable record kind
 * @returns {Promise<Array>}
 */
export async function buildLocalManifest(kind) {
  const records = await recordsForKind(kind);
  // Hash records SEQUENTIALLY (for...of, not Promise.all(map)) so a large
  // library can't fan out an unbounded number of concurrent file-hash reads and
  // spike CPU/disk. Each assetShaListForRecord already reads many files; doing
  // every record's pass at once would multiply that.
  const out = [];
  for (const r of records) {
    const deleted = r.deleted === true;
    // Live ephemeral records are local-only; their tombstones still propagate.
    if (r.ephemeral === true && !deleted) continue;
    const assetIntegrity = deleted || kind === 'writersRoomWork'
      ? { assetHashes: [], metadataMissing: false }
      : await assetIntegrityForRecord(kind, r);
    let workAssets = [];
    if (!deleted && kind === 'writersRoomWork') {
      const { buildWorkBibleManifest } = await import('../writersRoom/bibleSync.js');
      workAssets = [...await buildWorkBodyManifest(r), ...await buildWorkBibleManifest(r)];
    }
    out.push({
      id: r.id,
      name: r.name ?? r.title,
      updatedAt: r.updatedAt,
      deleted,
      // Tombstones never need asset hashes: computeRecordIntegrity only
      // compares assetHashes when BOTH sides are live (and drops
      // deleted-vs-deleted pairs entirely). Hashing a deleted record's
      // still-on-disk assets is pure wasted file I/O.
      assetHashes: [...assetIntegrity.assetHashes, ...workAssets.map((asset) => asset.sha256)].sort(),
      metadataMissing: assetIntegrity.metadataMissing,
    });
  }
  return out;
}

const assetKey = ({ kind, filename }) => `${kind}:${filename}`;

function collectionInventory({ record, assetManifest, videoFilenames }) {
  const filenames = new Map(Object.entries(videoFilenames ?? {}));
  const manifest = new Map(assetManifest.filter((asset) => asset.sha256).map((asset) => [assetKey(asset), asset]));
  const files = new Map();
  const matched = new Set();
  for (const ref of referenceCollectionAssetManifest(record)) {
    const alias = ref.kind === 'video' ? sanitizeAssetFilename(filenames.get(ref.filename)) : null;
    const file = alias ? { ...ref, filename: alias } : ref;
    const copy = manifest.get(assetKey(file));
    files.set(assetKey(ref), { ...file, sha256: copy?.sha256, alias });
    if (copy) matched.add(copy);
  }
  const assets = [...matched];
  return {
    ...record,
    files,
    assetHashes: assets.map((asset) => asset.sha256),
    metadataMissing: assets.some((asset) => asset.kind === 'image' && !asset.sidecarSha256),
  };
}

function compareCollections(localPayload, peerPayload) {
  const local = localPayload ? collectionInventory(localPayload) : null;
  const peer = collectionInventory(peerPayload);
  const records = computeRecordIntegrity(local ? [local] : [], [peer]);
  if (!local || local.deleted === true || peer.deleted === true) return records;

  const differences = new Map();
  for (const [key, ref] of new Map([...local.files, ...peer.files])) {
    const here = local.files.get(key);
    const there = peer.files.get(key);
    const localSha = here?.sha256;
    const peerSha = there?.sha256;
    if (localSha && localSha === peerSha) continue;
    const availability = localSha ? (peerSha ? 'different' : 'local') : (peerSha ? 'peer' : 'neither');
    const filename = (localSha ? here.filename : peerSha ? there.filename : here?.alias ?? there?.alias) ?? ref.filename;
    const asset = { kind: ref.kind, filename, availability };
    differences.set(`${availability}:${assetKey(asset)}`, asset);
  }
  const comparison = records[0];
  // Equal hash lists can hide missing files on both sides or the same bytes
  // stored under different filenames. Keep timestamp divergence actionable.
  if (differences.size && comparison.status !== INTEGRITY_STATUS.DIVERGED) {
    comparison.status = INTEGRITY_STATUS.ASSETS_MISSING;
  }
  return [{ ...comparison, assetDifferences: [...differences.values()] }];
}

/**
 * Fetch the peer's manifest for `kind`, run the local-vs-remote diff, and
 * return the classified record list.
 *
 * @param {{ peerId: string, kind: string, recordId?: string }} opts
 * @returns {Promise<{ available: boolean, reason?: string, records: Array }>}
 */
export async function getPeerIntegrity({ peerId, kind, recordId }) {
  const peers = await getPeers().catch(() => []);
  const peer = peers.find((p) => p.instanceId === peerId) || null;

  if (!peer) return { available: false, reason: 'peer-not-found', records: [] };

  const collectionDetail = kind === 'mediaCollection' && !!recordId;
  const query = new URLSearchParams({ kind });
  if (collectionDetail) {
    query.set('id', recordId);
    query.set('collectionIntegrity', '1');
  }
  const path = collectionDetail ? '/api/peer-sync/record' : '/api/peer-sync/manifest';
  const res = await peerFetch(
    `${peerBaseUrl(peer)}${path}?${query}`,
    { signal: AbortSignal.timeout(PEER_INTEGRITY_TIMEOUT_MS), maxBytes: PEER_INTEGRITY_MAX_BYTES },
    peer,
  ).catch(() => null);

  // Distinguish a network failure (peerFetch threw / returned null) from a 404.
  // A null result means the peer is offline/unreachable — NOT that it's running
  // an older PortOS without the /manifest route. Lumping them together would
  // tell the user "peer too old, upgrade it" when the peer is simply down.
  if (!res) return { available: false, reason: 'peer-unreachable', records: [] };
  if (res.status === 404) {
    if (!collectionDetail) return { available: false, reason: 'peer-too-old', records: [] };
    // A 404 can mean either a missing collection or an older peer. The
    // category manifest can distinguish a local-only row from an unknown one.
    const fallback = await getPeerIntegrity({ peerId, kind });
    return { ...fallback, records: fallback.records.filter((entry) => entry.id === recordId) };
  }
  if (!res.ok) return { available: false, reason: 'fetch-failed', records: [] };

  const body = await readPeerBody(res, 'json', {
    idleTimeoutMs: PEER_INTEGRITY_TIMEOUT_MS,
    maxBytes: PEER_INTEGRITY_MAX_BYTES,
  }).catch(() => null);
  if (!body) return { available: false, reason: 'fetch-failed', records: [] };
  if (collectionDetail) {
    const parsed = peerCollectionIntegrityPayloadSchema.safeParse(body);
    if (!parsed.success || parsed.data.sourceInstanceId !== peerId || parsed.data.record.id !== recordId ||
        (parsed.data.record.deleted !== true && !Array.isArray(parsed.data.record.items))) {
      return { available: false, reason: 'fetch-failed', records: [] };
    }
    const localPayload = await getRecordPayloadForPeer(kind, recordId, { collectionIntegrity: true });
    return { available: true, records: compareCollections(localPayload, parsed.data) };
  }
  if (!Array.isArray(body.records)) return { available: false, reason: 'fetch-failed', records: [] };
  if (!isLegacyManifestKind(kind) &&
      (typeof body.manifestVersion !== 'number' || body.manifestVersion < PEER_MANIFEST_VERSION)) {
    return { available: false, reason: 'peer-too-old', records: [] };
  }
  // The peer response is untrusted — computeRecordIntegrity assumes every entry
  // is a non-null object with a string `id` (it reads `r.id` and keys a Map on
  // it). A hostile/malformed manifest (nulls, scalars, id-less objects) would
  // otherwise throw and 500 this endpoint, so filter to well-formed rows first.
  const remote = body.records.filter(
    (r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id,
  );

  const local = await buildLocalManifest(kind);
  return { available: true, records: computeRecordIntegrity(local, remote) };
}
