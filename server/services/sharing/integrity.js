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
  // Hash records SEQUENTIALLY (for...of, not Promise.all(map)) so a large
  // library can't fan out an unbounded number of concurrent file-hash reads and
  // spike CPU/disk. Each assetShaListForRecord already reads many files; doing
  // every record's pass at once would multiply that.
  const out = [];
  for (const r of records) {
    const deleted = r.deleted === true;
    out.push({
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt,
      deleted,
      // Tombstones never need asset hashes: computeRecordIntegrity only
      // compares assetHashes when BOTH sides are live (and drops
      // deleted-vs-deleted pairs entirely). Hashing a deleted record's
      // still-on-disk assets is pure wasted file I/O.
      assetHashes: deleted ? [] : await assetShaListForRecord(kind, r),
    });
  }
  return out;
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

  // Distinguish a network failure (peerFetch threw / returned null) from a 404.
  // A null result means the peer is offline/unreachable — NOT that it's running
  // an older PortOS without the /manifest route. Lumping them together would
  // tell the user "peer too old, upgrade it" when the peer is simply down.
  if (!res) return { available: false, reason: 'peer-unreachable', records: [] };
  if (res.status === 404) return { available: false, reason: 'peer-too-old', records: [] };
  if (!res.ok) return { available: false, reason: 'fetch-failed', records: [] };

  const body = await res.json().catch(() => null);
  // The peer response is untrusted — computeRecordIntegrity assumes every entry
  // is a non-null object with a string `id` (it reads `r.id` and keys a Map on
  // it). A hostile/malformed manifest (nulls, scalars, id-less objects) would
  // otherwise throw and 500 this endpoint, so filter to well-formed rows first.
  const remote = (Array.isArray(body?.records) ? body.records : []).filter(
    (r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id,
  );

  const local = await buildLocalManifest(kind);
  return { available: true, records: computeRecordIntegrity(local, remote) };
}
