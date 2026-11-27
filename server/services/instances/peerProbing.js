/** Probe registered peers, handle announcements and wake peers in backoff. */
import net from 'net';
import dns from 'dns/promises';
import crypto from 'crypto';
import { NEW_PEER_MEDIA_SYNC_MODE, PROBE_TIMEOUT_MS, peerLogLabel, validHost, validName } from './peerRecord.js';
import { connectToPeer, disconnectFromPeer } from '../peerSocketRelay.js';
import { UNKNOWN_INSTANCE_ID, getInstanceId, loadData, withData } from '../instanceIdentity.js';
import { instanceEvents } from '../instanceEvents.js';
import { normalizePeerMediaProviderConfig, probeFederatedMediaProvider } from '../federatedMediaConsumer.js';
import { isBlockedIngestHost } from '../../lib/safeUrlFetch.js';
import { DEFAULT_PEER_PORT } from '../../lib/ports.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { getSelfHost } from '../../lib/peerSelfHost.js';
import { buildLastProbeRecord, classifyPeerProbeFailure, formatProbeDiagnosticLog } from '../../lib/peerProbeDiagnostics.js';
import { peerFetch, readPeerBody } from '../../lib/peerHttpClient.js';
import { DEFAULT_SYNC_CATEGORIES } from '../../lib/instanceSyncCategories.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';

// Streamed-size cap for probe bodies: plain-HTTP peers ignore peerFetch's `maxBytes`, so an
// unbounded `res.json()` would buffer whatever a stalled or hostile peer streams.
const PEER_PROBE_BODY_MAX_BYTES = 8 * 1024 * 1024;

// Backoff tiers for consecutive probe failures (in ms)
// 30s → 1m → 5m → 15m → 1h (max)
export const BACKOFF_TIERS_MS = [
  30_000,      // tier 0: normal (1 failure)
  60_000,      // tier 1: 1 minute
  300_000,     // tier 2: 5 minutes
  900_000,     // tier 3: 15 minutes
  3_600_000    // tier 4: 1 hour (max)
];

export const PEER_WAKE_RATE_LIMIT_MS = 30_000;
const lastWakeAtByPeerId = new Map();

function shouldWakePeer(peerId, now = Date.now()) {
  if (!peerId) return false;
  const lastWake = lastWakeAtByPeerId.get(peerId) || 0;
  if (now - lastWake < PEER_WAKE_RATE_LIMIT_MS) return false;
  lastWakeAtByPeerId.set(peerId, now);
  return true;
}

export function __resetPeerWakesForTests() {
  lastWakeAtByPeerId.clear();
}

export function wakePeerProbe(peer) {
  if (!peer?.id || peer.enabled === false) return false;
  if (peer.status !== 'offline' && !peer.nextProbeAt) return false;
  if (!shouldWakePeer(peer.id)) return false;

  withData(async (data) => {
    const entry = data.peers.find((p) => p.id === peer.id);
    if (entry && entry.nextProbeAt) {
      entry.nextProbeAt = null;
    }
  }).catch((err) => {
    console.error(`❌ Failed to clear nextProbeAt on peer wake: ${err.message}`);
  });

  probePeer(peer).catch((err) => {
    console.log(`⚠️ Wake probe failed for ${peerLogLabel()}: ${err.message}`);
  });

  return true;
}

function classifyProbeError(err, peer, tunnelError = null) {
  const classified = classifyPeerProbeFailure(err, {
    peer,
    tunnelError,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
  });
  // Keep emoji prefixes for classic log grepping; structured class is on lastProbe.
  if (classified.class === 'dns') return `🌐 ❌ ${classified.message}`;
  if (classified.class === 'local_refused') return `🌐 ❌ ${classified.message}`;
  if (classified.class === 'host_unreachable') return `🌐 ❌ ${classified.message}`;
  if (classified.class === 'probe_timeout') return `🌐 ⏱️ ${classified.message}`;
  if (classified.class === 'tunnel_dial') return `🐈 ❌ ${classified.message}`;
  if (classified.class === 'auth_required') return `🔒 ${classified.message}`;
  if (classified.class === 'probe_http') return `🌐 ❌ ${classified.message}`;
  return classified.message;
}

/** Best-effort live forward hint for a tailcat peer (dynamic import avoids a cycle). */
async function lookupTailcatForwardHint(peer) {
  if (peer?.transport !== 'tailcat') return null;
  try {
    const { listTailcatForwards } = await import('../tailcatPeer.js');
    const forwards = await listTailcatForwards();
    return forwards.find((f) => f.peerId === peer.id) || null;
  } catch {
    return null;
  }
}

function isIPAddress(str) {
  return net.isIP(str) !== 0;
}

// An announce is unauthenticated, so unlike an operator-entered host it must not
// name this machine or a link-local/metadata service (probePeer would GET it).
function announcedHost(str) {
  const host = validHost(str);
  return host && !isBlockedIngestHost(host) ? host : undefined;
}

// A DNS host that answers loopback/link-local would turn the fixed-path probe
// and relay into an SSRF read. LAN and tailnet answers stay allowed; a lookup
// failure is left to the fetch itself to report as unreachable.
async function assertPeerHostNotLocal(peer) {
  if (peer.transport === 'tailcat') return;
  if (peer.address && isBlockedIngestHost(peer.address)) {
    throw new Error(`peer address ${peer.address} is a loopback, unspecified or link-local address`);
  }
  if (!peer.host || net.isIP(peer.host)) return;
  const answers = await dns.lookup(peer.host, { all: true }).catch(() => []);
  if (answers.some(({ address }) => isBlockedIngestHost(address))) {
    throw new Error(`peer host resolves to a loopback or link-local address`);
  }
}

// --- Probing ---

// Peers observed online in THIS process. The persisted `status` survives a
// restart, so a peer that was online before the restart would never produce a
// status transition and `peer:online` listeners (push retry, sync) would not
// run for edits stranded by the restart (#11750). The first online sighting
// per process emits regardless of the persisted status; later sightings keep
// the transition-only rule.
const peersSeenOnlineThisProcess = new Set();

/** Test-only: forget which peers were seen online so a test can simulate a fresh boot. */
export function __resetPeersSeenOnlineForTests() {
  peersSeenOnlineThisProcess.clear();
}

function isFirstOnlineSighting(peerId) {
  if (peersSeenOnlineThisProcess.has(peerId)) return false;
  peersSeenOnlineThisProcess.add(peerId);
  return true;
}

export async function probePeer(peer) {
  const baseUrl = peerBaseUrl(peer);

  const previousStatus = peer.status;
  let status, lastHealth, lastSeen, remoteInstanceId, remoteVersion, remoteApps, remoteSyncSeqs;
  let remoteMediaProviderStatus = null;
  // Latches when the peer answers 401/403 — a reachable-but-auth-gated peer, as
  // opposed to an unreachable one. The Instances UI reads this to prompt for a
  // credential instead of showing a generic offline state.
  let authRequired = false;
  let probeFailure = null;
  const probeStartedAt = Date.now();
  // For tailcat peers, read the live forward's tunnelError up front so a probe
  // that times out / resets can be classified as tunnel dial vs local refuse vs
  // PortOS health/details failure — the three operator-visible cases.
  const forwardHint = await lookupTailcatForwardHint(peer);
  const tunnelError = forwardHint?.tunnelError || null;
  // One shared abort signal spans the instanceId read, all three parallel
  // fetches, AND their body reads, so a single PROBE_TIMEOUT_MS bounds the whole
  // probe (the instanceId read is inside the budget, as it was before).
  await withAbortTimeout(PROBE_TIMEOUT_MS, async (signal) => {
    await assertPeerHostNotLocal(peer);
    // Pass our own instanceId as `forPeer` so the peer also returns ITS cursor
    // into our data (`cursorForYou`) — our push-frontier toward it. Best-effort:
    // an unresolved/unknown id just omits the param and we get the inbound-only
    // shape (push count renders "unknown" client-side, never a misleading 0).
    const ourInstanceId = await getInstanceId().catch(() => null);
    const forPeerQs = typeof ourInstanceId === 'string' && ourInstanceId && ourInstanceId !== UNKNOWN_INSTANCE_ID
      ? `?forPeer=${encodeURIComponent(ourInstanceId)}`
      : '';
    // Fetch health details, the PM2-backed app probe projection, sync status, and opted-in media capacity in
    // parallel under the same bounded probe budget. The first three paths are
    // the frozen peer-probe contract documented in docs/API.md: deployed peers
    // call them across independently upgraded installs, so remove/rename or
    // incompatible response changes require a versioned replacement rather
    // than a silent change here. Older/unconfigured peers incur no fourth
    // request.
    const [healthRes, appsRes, syncRes, mediaProviderStatus] = await Promise.all([
      peerFetch(`${baseUrl}/api/system/health/details`, { signal }, peer),
      peerFetch(`${baseUrl}/api/apps?view=probe`, { signal }, peer).catch(() => null),
      peerFetch(`${baseUrl}/api/instances/sync-status${forPeerQs}`, { signal }, peer).catch(() => null),
      normalizePeerMediaProviderConfig(peer).enabled
        ? probeFederatedMediaProvider(peer, { signal })
        : Promise.resolve(null),
    ]);
    remoteMediaProviderStatus = mediaProviderStatus;
    if (!healthRes.ok) {
      const err = new Error(`HTTP ${healthRes.status}`);
      err.httpStatus = healthRes.status;
      throw err;
    }
    const json = await readPeerBody(healthRes, 'json', { maxBytes: PEER_PROBE_BODY_MAX_BYTES });
    status = 'online';
    lastHealth = json;
    lastSeen = new Date().toISOString();
    remoteInstanceId = json.instanceId ?? null;
    remoteVersion = json.version ?? null;

    if (appsRes?.ok) {
      const appsJson = await readPeerBody(appsRes, 'json', { maxBytes: PEER_PROBE_BODY_MAX_BYTES }).catch(() => null);
      const appsList = Array.isArray(appsJson) ? appsJson : appsJson?.apps;
      remoteApps = appsList?.map(a => ({
        id: a.id, name: a.name, icon: a.icon,
        overallStatus: a.overallStatus, uiPort: a.uiPort, apiPort: a.apiPort, type: a.type
      })) ?? null;
    }
    if (syncRes?.ok) {
      remoteSyncSeqs = await readPeerBody(syncRes, 'json', { maxBytes: PEER_PROBE_BODY_MAX_BYTES }).catch(() => null);
    }
  }).catch((err) => {
    probeFailure = err;
    status = 'offline';
    authRequired = err?.httpStatus === 401 || err?.httpStatus === 403;
    lastHealth = peer.lastHealth; // preserve last known
    lastSeen = peer.lastSeen;
    if (normalizePeerMediaProviderConfig(peer).enabled && !remoteMediaProviderStatus) {
      remoteMediaProviderStatus = {
        checkedAt: new Date().toISOString(),
        state: 'unreachable',
        reason: 'peer-offline',
        freshUntil: null,
        snapshot: null,
      };
    }
  });

  const latencyMs = Date.now() - probeStartedAt;
  const probedAt = new Date().toISOString();
  const classification = probeFailure
    ? classifyPeerProbeFailure(probeFailure, {
      peer,
      tunnelError,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
    })
    : { class: 'ok', message: null, httpStatus: 200 };
  const lastProbe = buildLastProbeRecord({
    ok: status === 'online',
    classification,
    latencyMs,
    at: probedAt,
  });
  if (status !== 'online') {
    console.log(`⚠️ Probe failed for ${peerLogLabel()}: ${classifyProbeError(probeFailure, peer, tunnelError)} ${formatProbeDiagnosticLog(lastProbe)}`);
  }

  const stored = await withData(async (data) => {
    const entry = data.peers.find(p => p.id === peer.id);
    if (!entry) return null;
    entry.status = status;
    entry.lastSeen = lastSeen;
    entry.lastHealth = lastHealth;
    entry.lastProbe = lastProbe;
    // Surface "reachable but needs a credential" distinctly from plain offline.
    // Cleared on any successful probe (including after the user adds the password).
    entry.authRequired = authRequired;
    // Peer credential handshake (#8356). Latch on the receiver's confirmation
    // that this probe's pair token verified; after that peerFetch stops sending
    // the stored Basic password. A 401/403 unlatches, so a receiver that loses
    // its side of the pairing (or is downgraded) gets Basic again next probe.
    // Other failures (timeouts, offline) keep the last answer.
    if (status === 'online') entry.peerAuthAccepted = lastHealth?.peerAuth?.accepted === true;
    else if (authRequired) entry.peerAuthAccepted = false;
    entry.lastApps = remoteApps ?? entry.lastApps ?? null;
    entry.remoteSyncSeqs = remoteSyncSeqs ?? entry.remoteSyncSeqs ?? null;
    if (normalizePeerMediaProviderConfig(entry).enabled) {
      if (remoteMediaProviderStatus) entry.mediaProviderStatus = remoteMediaProviderStatus;
    } else {
      delete entry.mediaProviderStatus;
    }
    if (remoteInstanceId && (!entry.syncSecret || !entry.instanceId)) entry.instanceId = remoteInstanceId;
    if (status === 'online') entry.version = remoteVersion;
    // Auto-update name from hostname if current name is just an IP address
    const remoteHostname = validName(lastHealth?.hostname, null);
    if (remoteHostname && isIPAddress(entry.name)) {
      entry.name = remoteHostname;
    }

    // Backoff tracking for failed probes
    if (status === 'online') {
      if (entry.consecutiveFailures > 0) {
        console.log(`🌐 ${peerLogLabel()} recovered after ${entry.consecutiveFailures} consecutive failures`);
      }
      entry.consecutiveFailures = 0;
      entry.nextProbeAt = null;
    } else {
      entry.consecutiveFailures = (entry.consecutiveFailures ?? 0) + 1;
      const tier = Math.min(entry.consecutiveFailures - 1, BACKOFF_TIERS_MS.length - 1);
      const backoffMs = BACKOFF_TIERS_MS[tier];
      entry.nextProbeAt = new Date(Date.now() + backoffMs).toISOString();
      console.log(`⏳ ${peerLogLabel()} backoff tier ${tier} (${backoffMs / 1000}s), failures: ${entry.consecutiveFailures}`);
    }

    return entry;
  });

  // Manage peer socket relay based on status
  if (status === 'online') {
    connectToPeer(peer);
  } else {
    disconnectFromPeer(peer.id);
  }

  // Announce ourselves only when peer transitions to online (not every poll cycle)
  if (status === 'online') {
    const firstSighting = isFirstOnlineSighting(peer.id);
    const transitioned = previousStatus !== 'online';
    if (stored) {
      if (transitioned) void announceSelf(stored);
      if (transitioned || firstSighting) instanceEvents.emit('peer:online', stored);
    }
  }

  return stored;
}

export async function probeAllPeers() {
  const data = await loadData();
  const now = Date.now();
  const enabled = data.peers.filter(p => {
    if (!p.enabled) return false;
    // Respect backoff: skip peers whose next probe time hasn't arrived
    if (p.nextProbeAt && new Date(p.nextProbeAt).getTime() > now) return false;
    return true;
  });
  if (enabled.length === 0) return;

  await Promise.allSettled(enabled.map(p => probePeer(p)));

  // Re-read to get updated state and emit
  const updated = await loadData();
  instanceEvents.emit('peers:updated', updated.peers);
}

// --- Announce (Bidirectional Registration) ---

// `viaRemoteIngress`: the request is remote Tailcat traffic that arrived over
// loopback, so `address` (127.0.0.1) is the ingress hop, never a dialable
// caller. Such an announce may only refresh an existing tailcat peer by
// instanceId; it can never create, address-match or probe a loopback peer.
export async function handleAnnounce({ address, port, instanceId, name, host, viaRemoteIngress = false }) {
  // Set only when this announce marked the peer online (not the forged-address
  // branch, which records a sighting without trusting it).
  let markedOnlinePeer = null;
  let peerToWake = null;
  const result = await withData(async (data, afterCommit) => {
    // Check for existing peer by instanceId
    let existing = data.peers.find(p => p.instanceId === instanceId);
    // instanceId is public (GET /api/system/health returns it unauthenticated),
    // so a match on instanceId alone does not prove the caller IS that peer —
    // only that it knows a public value. Track whether the match instead came
    // through the address+port fallback below, where the caller's address is
    // already part of the match.
    let matchedByAddress = false;
    // Fallback: check by address + port
    // Tailcat peers sit on local forward coordinates (127.0.0.1:15555+), so an
    // address+port match would let any caller on that hop hijack them.
    if (!existing && !viaRemoteIngress) {
      existing = data.peers.find(p => p.transport !== 'tailcat' && p.address === address && p.port === port);
      matchedByAddress = true;
    }
    if (viaRemoteIngress && existing?.transport !== 'tailcat') existing = undefined;
    if (!existing && (viaRemoteIngress || isBlockedIngestHost(address))) {
      throw new ServerError('Announce refused: caller address is not a dialable peer address', { status: 400 });
    }

    const instanceIdMatches = !existing || !existing.instanceId || existing.instanceId === instanceId;
    if (existing && existing.enabled !== false && instanceIdMatches) {
      if (shouldWakePeer(existing.id)) {
        if (existing.nextProbeAt) existing.nextProbeAt = null;
        peerToWake = existing;
      }
    }

    const normalizedHost = announcedHost(host);

    if (existing?.syncSecret) return { created: false, peer: { instanceId: existing.instanceId } };

    // A forged announce: instanceId matches a stored peer, but the caller's
    // source address does not match the stored one. Record the sighting only
    // — never let it teach host/port/name/status, or an attacker who merely
    // reads a peer's public instanceId could redirect our future requests
    // (and the peer's Basic credential) to a host they control.
    // Exempt tailcat: its stored `address` is intentionally the LOCAL forward's
    // loopback address, never the remote caller's — a mismatch there is the
    // normal case, not a forgery signal, and its host/port are already pinned
    // to the local forward by the `transport !== 'tailcat'` guards below.
    if (existing && !matchedByAddress && existing.transport !== 'tailcat' && existing.address !== address) {
      console.warn(`⚠️ Peer announce instanceId matched but address mismatched — ignoring host/port/name update`);
      existing.lastSeen = new Date().toISOString();
      afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
      return { created: false, peer: { instanceId: existing.instanceId } };
    }

    if (existing) {
      existing.lastSeen = new Date().toISOString();
      existing.status = 'online';
      existing.nextProbeAt = null;
      existing.consecutiveFailures = 0;
      markedOnlinePeer = existing;
      existing.instanceId = instanceId;
      // A managed forward uses local coordinates, not the remote listen port.
      if (existing.transport !== 'tailcat') existing.port = port;
      // Only auto-update name if still an IP address (preserve user-set names)
      const sanitized = validName(name, null);
      if (sanitized && isIPAddress(existing.name)) {
        existing.name = sanitized;
      }
      // Adopt host from inbound announce only when we don't already have one
      // AND the user hasn't manually intervened. The hostManual flag covers
      // the "user explicitly cleared this — stay on IP" case that the
      // existing.host check alone can't distinguish from "never set".
      if (existing.transport !== 'tailcat' && normalizedHost && !existing.host && !existing.hostManual) {
        existing.host = normalizedHost;
        console.log(`🌐 Peer host learned via announce: ${peerLogLabel()}`);
      }
      // Mark that this peer has announced to us (inbound connection)
      existing.directions = existing.directions || [];
      if (!existing.directions.includes('inbound')) existing.directions.push('inbound');
      console.log(`🌐 Peer announced (existing): ${peerLogLabel()}`);
      afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
      return { created: false, peer: existing };
    }

    // Create new peer entry from remote announcement
    const peer = {
      id: crypto.randomUUID(),
      address,
      host: normalizedHost || null,
      // A credential can only be entered locally, never learned from an
      // announce — start null. If this peer needs auth, our probe to it will
      // 401 and the user sets the password from the Instances UI.
      auth: null,
      // The host came from the peer's announce, not from a user — leave
      // hostManual false so subsequent updates from the peer can still refine.
      hostManual: false,
      port,
      name: validName(name, normalizedHost || address),
      instanceId,
      addedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      lastHealth: null,
      status: 'online',
      enabled: true,
      syncEnabled: false,
      syncCategories: { ...DEFAULT_SYNC_CATEGORIES },
      mediaSyncMode: NEW_PEER_MEDIA_SYNC_MODE,
      consecutiveFailures: 0,
      nextProbeAt: null,
      directions: ['inbound']
    };
    data.peers.push(peer);
    console.log(`🌐 Peer announced (new): ${peerLogLabel()}`);
    afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    return { created: true, peer };
  });

  // The announce path sets status = 'online' without a probe, so it needs the
  // same once-per-process convergence trigger as probePeer.
  if (markedOnlinePeer && isFirstOnlineSighting(markedOnlinePeer.id)) {
    instanceEvents.emit('peer:online', markedOnlinePeer);
  }

  // Immediately probe newly announced peers to populate health data
  if (result.created) {
    probePeer(result.peer).catch(err => {
      console.log(`⚠️ Initial probe failed for announced ${peerLogLabel()}: ${err.message}`);
    });
  } else if (peerToWake) {
    probePeer(peerToWake).catch(err => {
      console.log(`⚠️ Wake probe failed for ${peerLogLabel()}: ${err.message}`);
    });
  }

  return result;
}

// Owns every rejection: callers in addPeer/probePeer fire it without awaiting.
export async function announceSelf(peer) {
  let data;
  try {
    data = await loadData();
  } catch (err) {
    console.log(`🌐 Announce skipped: instances data unreadable: ${err.message}`);
    return;
  }
  if (!data.self) return;

  const selfPort = parseInt(process.env.PORT, 10) || DEFAULT_PEER_PORT;
  const selfHost = getSelfHost();
  const url = `${peerBaseUrl(peer)}/api/instances/peers/announce`;

  await withAbortTimeout(PROBE_TIMEOUT_MS, async (signal) => {
    const res = await peerFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: selfPort,
        instanceId: data.self.instanceId,
        name: data.self.name,
        host: selfHost
      }),
      signal
    }, peer);
    if (res.ok) {
      console.log(`🌐 Announced self to ${peerLogLabel()}`);
      await markDirection(peer.id, 'outbound');
    } else {
      console.log(`🌐 Announce to ${peerLogLabel()} failed: HTTP ${res.status}`);
    }
  }).catch((err) => {
    console.log(`🌐 Announce to ${peerLogLabel()} unreachable: ${err.message}`);
  });
}

export async function connectPeer(id) {
  const data = await loadData();
  const peer = data.peers.find(p => p.id === id);
  if (!peer) return null;
  await announceSelf(peer);
  const probed = await probePeer(peer);
  return probed;
}

async function markDirection(peerId, direction) {
  await withData(async (data, afterCommit) => {
    const peer = data.peers.find(p => p.id === peerId);
    if (!peer) return;
    peer.directions = peer.directions || [];
    if (!peer.directions.includes(direction)) {
      peer.directions.push(direction);
      afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    }
  });
}
