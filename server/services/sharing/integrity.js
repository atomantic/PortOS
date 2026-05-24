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

import { computeRecordIntegrity } from '../../lib/syncIntegrity.js';
import { listCollections } from '../mediaCollections.js';
import { listUniverses } from '../universeBuilder.js';
import { listSeries } from '../pipeline/series.js';
import { getPeers } from '../instances.js';
import { assetShaListForRecord } from './peerSync.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';

async function recordsForKind(kind) {
  if (kind === 'mediaCollection') return listCollections({ includeDeleted: true });
  if (kind === 'universe') return listUniverses({ includeDeleted: true });
  if (kind === 'series') return listSeries({ includeDeleted: true });
  return [];
}

/**
 * Build a local manifest for the given kind.
 * One row per record: `{ id, name, updatedAt, deleted, assetHashes }`.
 * Includes tombstoned records so deletes surface correctly in the diff.
 *
 * @param {'universe'|'series'|'mediaCollection'} kind
 * @returns {Promise<Array>}
 */
export async function buildLocalManifest(kind) {
  const records = await recordsForKind(kind);
  return Promise.all(records.map(async (r) => ({
    id: r.id,
    name: r.name,
    updatedAt: r.updatedAt,
    deleted: r.deleted === true,
    assetHashes: await assetShaListForRecord(kind, r),
  })));
}

/**
 * Fetch the peer's manifest for `kind`, run the local-vs-remote diff, and
 * return the classified record list.
 *
 * @param {{ peerId: string, kind: string }} opts
 * @returns {Promise<{ available: boolean, reason?: string, records: Array }>}
 */
export async function getPeerIntegrity({ peerId, kind }) {
  const peers = await getPeers().catch(() => []);
  const peer = peers.find((p) => p.instanceId === peerId) || null;

  if (!peer) return { available: false, reason: 'peer-not-found', records: [] };

  const res = await peerFetch(
    `${peerBaseUrl(peer)}/api/peer-sync/manifest?kind=${encodeURIComponent(kind)}`,
  ).catch(() => null);

  if (!res || res.status === 404) return { available: false, reason: 'peer-too-old', records: [] };
  if (!res.ok) return { available: false, reason: 'fetch-failed', records: [] };

  const body = await res.json().catch(() => null);
  const remote = Array.isArray(body?.records) ? body.records : [];

  const local = await buildLocalManifest(kind);
  return { available: true, records: computeRecordIntegrity(local, remote) };
}
