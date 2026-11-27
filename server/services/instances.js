/**
 * Instances Service
 *
 * Manages PortOS peer orchestration — peer registration, health probing,
 * query proxying, and reciprocal sync. This install's own federation identity
 * (instanceId/name) and the data/instances.json file I/O + mutex live in
 * services/instanceIdentity.js; the registry modules share that persistence boundary.
 * Data persists to data/instances.json.
 *
 * Storage: `file-primary` — machine-local peer registry. Per-peer `mediaDeleteAllowed`
 * (default true; only an explicit false refuses, via `peerMayDeleteMedia`) is machine-local.
 */

export { DEFAULT_SYNC_CATEGORIES, resolveEffectiveCategories } from '../lib/instanceSyncCategories.js';
export {
  DEFAULT_MEDIA_SYNC_MODE, MEDIA_SYNC_MODES, NEW_PEER_MEDIA_SYNC_MODE, peerLogLabel,
  peerMayDeleteMedia, peerMediaSyncMode, redactPeerForWire, sanitizePeerForClient, validHost,
} from './instances/peerRecord.js';
export {
  addPeer, getAssignableInstances, getPeers, removePeer, setPeerSchemaGap, setTailcatPeerPort, updatePeer,
} from './instances/peerCrud.js';
export { acceptPeerSyncSecretFromPeer, pairPeerSyncSecret } from './instances/peerPairing.js';
export {
  BACKOFF_TIERS_MS, PEER_WAKE_RATE_LIMIT_MS, __resetPeersSeenOnlineForTests, __resetPeerWakesForTests,
  connectPeer, handleAnnounce, probeAllPeers, probePeer, wakePeerProbe,
} from './instances/peerProbing.js';
export { queryPeer } from './instances/peerQuery.js';
export { startPolling, stopPolling } from './instances/peerPolling.js';
export { applyReciprocalSync, enqueueReciprocalSync, requestReciprocalSync } from './instances/peerReciprocalSync.js';
