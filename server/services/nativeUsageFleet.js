import { nativeUsageParticipantKey } from '../lib/nativeUsageContract.js';
import { isPairedPeer } from '../lib/peerPairing.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { loadData } from './instanceIdentity.js';
import { peerAllowsCategoryPull } from './sharing/peerSyncShared.js';
import { readNativeUsagePeerReport, revalidateNativeUsagePeerReport } from './nativeUsagePeer.js';

const MAX_PEERS = 8;
const MAX_INVENTORY = 64;
const CONCURRENCY = 2;

const unavailable = () => ({ reports: [], peerCollection: {
  status: 'unavailable', maxPeers: MAX_PEERS, requested: 0, received: 0, peers: [], findings: ['peer-inventory-unavailable'],
} });

const failureStatus = error => ({
  NATIVE_USAGE_PEER_STALE: 'stale', NATIVE_USAGE_PEER_UNVERIFIED: 'invalid',
  NATIVE_USAGE_PEER_FORBIDDEN: 'forbidden', NATIVE_USAGE_PEER_REPORT_TOO_LARGE: 'too-large',
})[error?.code] ?? 'unavailable';

/** One explicit, direct collection. No saved snapshots, third-party forwarding,
 * retries or probes. Skipped and failed participants remain missing, never zero.
 */
export async function collectNativeUsagePeerReports(localParticipantKey) {
  const peers = (await loadData().catch(() => null))?.peers;
  if (!Array.isArray(peers)) return unavailable();
  const identities = new Map();
  for (const peer of peers) {
    const key = nativeUsageParticipantKey(peer?.instanceId);
    if (key) identities.set(key, (identities.get(key) ?? 0) + 1);
  }
  const reports = [];
  const rows = [];
  const requests = [];
  const findings = peers.length > MAX_INVENTORY ? ['peer-inventory-truncated'] : [];
  for (const peer of peers.slice(0, MAX_INVENTORY)) {
    const participantKey = nativeUsageParticipantKey(peer?.instanceId);
    const row = { participantKey, status: 'pending', capturedAt: null };
    rows.push(row);
    if (!participantKey) row.status = 'identity-unknown';
    else if (identities.get(participantKey) > 1 || participantKey === localParticipantKey) row.status = 'duplicate-identity';
    else if (peer.enabled === false) row.status = 'disabled';
    else if (!peerAllowsCategoryPull(peer, 'usage')) row.status = 'usage-disabled';
    else if (!isPairedPeer(peer)) row.status = 'unpaired';
    else if (requests.length >= MAX_PEERS) row.status = 'peer-limit';
    else requests.push({ instanceId: peer.instanceId, row });
  }
  await mapWithConcurrency(requests, CONCURRENCY, async ({ instanceId, row }) => {
    const report = await readNativeUsagePeerReport(instanceId).catch(error => {
      row.status = failureStatus(error);
      return null;
    });
    if (report) {
      reports.push(report);
      row.status = 'available';
      row.capturedAt = report.capturedAt;
    }
  });
  rows.sort((a, b) => (a.participantKey ?? '').localeCompare(b.participantKey ?? '') || a.status.localeCompare(b.status));
  reports.sort((a, b) => a.participantKey.localeCompare(b.participantKey));
  return { reports, peerCollection: {
    status: rows.every(row => row.status === 'available') && !findings.length ? 'complete' : 'partial',
    maxPeers: MAX_PEERS, requested: requests.length, received: reports.length, peers: rows, findings,
  } };
}

/** Finalize only after local capture and selection reads have also settled.
 * A peer may be revoked while any other part of the matrix request is pending.
 */
export async function revalidateNativeUsagePeerCollection(collection) {
  const verified = await mapWithConcurrency(collection.reports, CONCURRENCY, async report => {
    const valid = await revalidateNativeUsagePeerReport(report).then(() => true, error => {
      const row = collection.peerCollection.peers.find(peer => peer.participantKey === report.participantKey);
      row.status = failureStatus(error);
      row.capturedAt = null;
      return false;
    });
    return valid ? report : null;
  });
  collection.reports = verified.filter(Boolean);
  collection.peerCollection.received = collection.reports.length;
  if (collection.peerCollection.peers.some(peer => peer.status !== 'available') && collection.peerCollection.status === 'complete') {
    collection.peerCollection.status = 'partial';
  }
}
