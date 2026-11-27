/** Register, update and retire local peer records. */
import crypto from 'crypto';
import { MEDIA_SYNC_MODES, NEW_PEER_MEDIA_SYNC_MODE, peerLogLabel, validHost, validName } from './peerRecord.js';
import { enqueueReciprocalSync } from './peerReciprocalSync.js';
import { announceSelf, probePeer } from './peerProbing.js';
import { autoSubscribePeerToAllRecords } from '../sharing/recordEvents.js';
import { disconnectFromPeer } from '../peerSocketRelay.js';
import { loadData, withData } from '../instanceIdentity.js';
import { instanceEvents } from '../instanceEvents.js';
import { mergePeerMediaProviderConfig } from '../federatedMediaConsumer.js';
import { DEFAULT_PEER_PORT } from '../../lib/ports.js';
import { PAIR_SECRET_MIN_LENGTH } from '../../lib/peerPairing.js';
import { canonicalStringify } from '../../lib/objects.js';
import { DEFAULT_SYNC_CATEGORIES, PER_RECORD_CATEGORY_KINDS, hasOptedInCategory } from '../../lib/instanceSyncCategories.js';

// Normalize a credential object off a peer add/update payload. Returns:
//   - `undefined` for absent / malformed input, or a username-only payload
//     (caller leaves the field as-is — see below)
//   - `null` for an explicit clear (both fields blank)
//   - `{ username, password }` for a credential to store
// The password is the secret that defines the credential; username defaults to
// '' so a password-only credential is valid Basic auth. A payload with a
// username but no password is treated as "ignore", NOT a blank-password store:
// the client only ever receives a redacted peer (`{ username, hasPassword }`),
// so round-tripping that shape back into a PATCH must not silently wipe a
// working password. An explicit clear always goes through `auth: null`.
function sanitizePeerAuth(auth) {
  if (auth === null) return null;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return undefined;
  const username = typeof auth.username === 'string' ? auth.username.trim() : '';
  const password = typeof auth.password === 'string' ? auth.password : '';
  if (!password) return username ? undefined : null;
  return { username, password };
}

// True when two credential values (null or { username, password }) are
// equivalent — used to skip a needless socket-relay reconnect on a no-op
// credential write.
function sameAuth(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.username === b.username && a.password === b.password;
}

/**
 * The instances this install can direct a CoS task at (#4520): this machine
 * plus every peer that can actually RECEIVE the task. Two filters, both of
 * which exist to stop a pin from stranding work:
 *
 * - `instanceId` must be set. A peer that has never completed a probe/connect
 *   has no addressable federation identity yet, so nothing could ever match a
 *   pin naming it.
 * - The peer must be an enabled full-sync peer. CoS task replication only
 *   sweeps `fullSync === true && enabled !== false` peers (see
 *   sharing/peerCosSync.js) — pin a task to any other peer and it never leaves
 *   this machine, while this machine skips it for being pinned elsewhere, so it
 *   sits pending forever.
 *
 * Returns only the id/name/isSelf triple the picker needs; no addresses, no
 * credentials, no sync state.
 */
export async function getAssignableInstances() {
  const data = await loadData();
  const assignable = [];
  if (data.self?.instanceId) {
    assignable.push({ instanceId: data.self.instanceId, name: data.self.name || 'This instance', isSelf: true });
  }
  for (const peer of data.peers || []) {
    if (!peer.instanceId || peer.fullSync !== true || peer.enabled === false) continue;
    assignable.push({ instanceId: peer.instanceId, name: peer.name || peer.address || peer.instanceId, isSelf: false });
  }
  return assignable;
}

// --- Peer CRUD ---

export async function getPeers() {
  const data = await loadData();
  return data.peers;
}

export async function addPeer({ address, port = DEFAULT_PEER_PORT, name, host, auth, transport, protocol = 'http' }) {
  const peer = await withData(async (data, afterCommit) => {
    const normalizedHost = validHost(host);
    const normalizedAuth = sanitizePeerAuth(auth);
    const entry = {
      id: crypto.randomUUID(),
      address,
      host: normalizedHost || null,
      // Optional HTTP Basic credential for peers gated behind an auth proxy.
      // null when unset; `peerAuthHeaders` no-ops on it. Stays local — never
      // synced or announced (see redactPeerForWire).
      auth: normalizedAuth || null,
      // Set to true once the user explicitly chooses a host (set/clear via UI).
      // Once true, handleAnnounce never auto-overwrites — it's the only way to
      // honor "the user explicitly cleared this; stay on IP" against a peer
      // that keeps announcing its DNS name.
      hostManual: transport === 'tailcat' || !!normalizedHost,
      port,
      name: validName(name, normalizedHost || address),
      // Optional transport marker (e.g. 'tailcat'). Never carries the tc address —
      // that capability lives only in data/tailcat-forwards.json.
      ...(transport === 'tailcat' ? { transport: 'tailcat', protocol: protocol === 'https' ? 'https' : 'http' } : {}),
      instanceId: null,
      addedAt: new Date().toISOString(),
      lastSeen: null,
      lastHealth: null,
      status: 'unknown',
      enabled: true,
      // Full-sync ("mirror everything") mode. When true, every current and
      // future sync category is implied on for this peer and a back-subscribe
      // sweep keeps all subscribable records mirrored. New peers inherit the
      // self-side default so a user who runs full-mirror node pairs doesn't have
      // to flip it on every peer by hand.
      fullSync: data.self?.defaultPeerFullSync === true,
      syncEnabled: data.self?.defaultPeerFullSync === true,
      syncCategories: { ...DEFAULT_SYNC_CATEGORIES },
      // Consumer-side routing is explicit and machine-local. Enabling a peer
      // here never changes that peer's provider settings.
      mediaProvider: { enabled: false, audioModels: [], imageModels: [], videoModels: [] },
      mediaDeleteAllowed: true,
      mediaSyncMode: NEW_PEER_MEDIA_SYNC_MODE,
      consecutiveFailures: 0,
      nextProbeAt: null,
      directions: ['outbound']
    };
    data.peers.push(entry);
    console.log(`🌐 ${peerLogLabel()} added`);
    afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    return entry;
  });
  void announceSelf(peer);
  return peer;
}

/**
 * Repoint a tailcat peer at a new loopback port.
 *
 * The public updatePeer deliberately owns no `port` field — a peer's address is
 * how the operator reached it, not something the server rewrites. A managed
 * tailcat forward is the exception: PortOS chose that loopback port itself, so
 * when a retry has to bind a different one (the old port got taken while the
 * forward was down) the peer record has to follow or every request keeps dialing
 * a dead port. Restricted to `transport: 'tailcat'` for exactly that reason.
 */
export async function setTailcatPeerPort(id, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const updated = await withData(async (data, afterCommit) => {
    const peer = data.peers.find(p => p.id === id && p.transport === 'tailcat');
    if (!peer || peer.port === port) return peer || null;
    peer.port = port;
    console.log(`🐈 Tailcat ${peerLogLabel()} repointed to loopback forward`);
    afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    return peer;
  });
  // The relay pins the peer URL at connect time, so it has to redial the new port.
  if (updated) disconnectFromPeer(id);
  return updated;
}

// Tells socket.js to drop inbound Socket.IO sessions the peer authenticated at
// connect time; a rotated secret or re-enabled peer reconnects with fresh auth.
export function emitPeerAuthRevoked(peer) {
  instanceEvents.emit('peer:auth-revoked', { peerId: peer.id, instanceId: peer.instanceId });
}

export async function removePeer(id, { stopTransport = true } = {}) {
  disconnectFromPeer(id);
  // Retire the transport outside the data lock: its lifecycle may itself need
  // that lock when rolling back a failed add. Keep the peer on retirement errors.
  if (stopTransport && (await getPeers()).some(peer => peer.id === id && peer.transport === 'tailcat')) {
    const { stopForwardForPeer } = await import('../tailcatPeer.js');
    await stopForwardForPeer(id);
  }
  const removed = await withData(async (data, afterCommit) => {
    const idx = data.peers.findIndex(p => p.id === id);
    if (idx === -1) return null;
    const [entry] = data.peers.splice(idx, 1);
    console.log(`🌐 ${peerLogLabel()} removed`);
    afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    return entry;
  });
  if (removed) emitPeerAuthRevoked(removed);
  // Retire that instance's federated usage digest. Without this the row stays in
  // the fleet report forever: our own snapshot forwards every digest we hold, so
  // a surviving peer would hand it straight back on the next cycle. Dynamic
  // import keeps peerUsage (and its usage.js graph) off this module's load path.
  if (removed?.instanceId) {
    const { forgetInstanceUsage } = await import('../peerUsage.js');
    await forgetInstanceUsage(removed.instanceId)
      .catch((err) => console.log(`⚠️ instances: retiring usage digest failed: ${err.message}`));
  }
  return removed;
}

export async function updatePeer(id, updates, { probe = true } = {}) {
  let hostChanged = false;
  // Credential edits must reconnect the live socket relay (it pins the
  // Basic-auth header into extraHeaders at connect time), not just the next
  // probe cycle — otherwise an online relayed peer keeps the stale credential
  // until a natural reconnect. Tracked like hostChanged, consumed below.
  let authChanged = false;
  let secretChanged = false;
  // Track false→true transitions for the per-record-subscribable categories
  // so we can backfill-subscribe existing local records after the data write
  // settles. Set inside withData (where we have the merged before/after
  // peer object) and consumed after the lock releases.
  const turnedOnKinds = [];
  let backfillPeerInstanceId = null;
  // Set when a syncCategories change should be mirrored back to the peer so the
  // sync is bidirectional (the user owns all machines). The actual send reads
  // the freshest persisted map at send time via enqueueReciprocalSync.
  let reciprocate = false;
  const result = await withData(async (data, afterCommit) => {
    const peer = data.peers.find(p => p.id === id);
    if (!peer) return null;
    if (updates.syncSecret !== undefined) {
      if (updates.syncSecret !== null && (typeof updates.syncSecret !== 'string' || updates.syncSecret.length < PAIR_SECRET_MIN_LENGTH || updates.syncSecret.length > 256)) {
        throw new Error('Peer sync secret must contain 32 to 256 characters');
      }
      if (updates.syncSecret !== peer.syncSecret) {
        peer.syncSecret = updates.syncSecret;
        // The pair token is derived from this secret, so the receiver's earlier
        // confirmation no longer applies: present Basic again (when stored)
        // until the next probe re-confirms, and reconnect the relay with the
        // new headers (#8356).
        peer.peerAuthAccepted = false;
        authChanged = true;
        secretChanged = true;
      }
      // Entering the pair secret is the local inbound-admission action.
      if (peer.syncSecret && !peer.directions?.includes('inbound')) {
        const directions = Array.isArray(peer.directions) && peer.directions.length ? peer.directions : ['outbound'];
        peer.directions = [...directions, 'inbound'];
      }
    }
    if (updates.name !== undefined) peer.name = validName(updates.name, peer.name);
    if (updates.mediaSyncMode !== undefined && MEDIA_SYNC_MODES.includes(updates.mediaSyncMode)) {
      peer.mediaSyncMode = updates.mediaSyncMode;
    }
    if (typeof updates.mediaDeleteAllowed === 'boolean') peer.mediaDeleteAllowed = updates.mediaDeleteAllowed;
    if (updates.enabled !== undefined) peer.enabled = updates.enabled;
    if (updates.syncEnabled !== undefined) peer.syncEnabled = updates.syncEnabled;
    // Full-sync ("mirror everything") toggle. A false→true flip implies every
    // subscribable category, so back-subscribe ALL record kinds (not just the
    // ones whose individual syncCategories bit flipped) and reciprocate so the
    // peer mirrors us back. Enabling full-sync also implies the peer is sync-
    // enabled — otherwise peerAllowsOutbound would gate every push off.
    if (updates.fullSync !== undefined && updates.fullSync !== peer.fullSync) {
      peer.fullSync = updates.fullSync === true;
      if (peer.fullSync) {
        peer.syncEnabled = true;
        for (const [, kind] of PER_RECORD_CATEGORY_KINDS) turnedOnKinds.push(kind);
        backfillPeerInstanceId = peer.instanceId || null;
      } else {
        // Turning full mirror off restores the per-category selection preserved
        // underneath — recompute syncEnabled from it so a peer with no remaining
        // enabled categories doesn't read as "sync on, nothing to sync".
        peer.syncEnabled = hasOptedInCategory(peer.syncCategories);
      }
      // Reciprocate the full-sync intent (and its all-on category view) to the
      // peer whenever we know its identity, so a node pair converges to a mutual
      // mirror in one round-trip.
      if (peer.instanceId) reciprocate = true;
    }
    if (updates.syncCategories !== undefined) {
      const prev = peer.syncCategories || DEFAULT_SYNC_CATEGORIES;
      const incoming = updates.syncCategories;
      // Detect false→true flips for kinds the per-record push pipeline owns
      // (PER_RECORD_CATEGORY_KINDS). enabled + outbound-allowed gating is
      // enforced inside peerSync.autoSubscribePeerToAllRecords.
      for (const [cat, kind] of PER_RECORD_CATEGORY_KINDS) {
        if (prev[cat] !== true && incoming[cat] === true) turnedOnKinds.push(kind);
      }
      peer.syncCategories = { ...prev, ...incoming };
      // `syncEnabled` is DERIVED from the category map — it gates per-record
      // outbound pushes (peerAllowsOutbound), so it must reflect what the user
      // opted into, not what a caller computed. Recomputing here (rather than
      // honoring `updates.syncEnabled` on this path) is what keeps a default-ON
      // category from widening outbound consent: a client that sums the whole
      // map would see `usage: true` and send `syncEnabled: true`.
      peer.syncEnabled = hasOptedInCategory(peer.syncCategories);
      if (turnedOnKinds.length > 0) backfillPeerInstanceId = peer.instanceId || null;
      // Reciprocate so the peer enables the same categories toward us. Only when
      // we know the peer's identity (post-handshake).
      if (peer.instanceId) reciprocate = true;
    }
    // Optional proxy credential. `null` (or both fields blank) clears it; a
    // valid object replaces it; malformed input (sanitizePeerAuth → undefined)
    // is ignored so a stray payload can't wipe a working credential.
    if (updates.auth !== undefined) {
      const normalizedAuth = sanitizePeerAuth(updates.auth);
      if (normalizedAuth !== undefined) {
        if (!sameAuth(peer.auth, normalizedAuth)) {
          peer.auth = normalizedAuth; // null clears, object sets
          authChanged = true;
          console.log(`🌐 Peer credential ${peer.auth ? 'set' : 'cleared'}: ${peerLogLabel()}`);
        }
        // When sameAuth was true (credential unchanged), authChanged is still
        // false. If the peer is stuck in authRequired+backoff the user is
        // explicitly asking for a retry — clear backoff so the immediate probe
        // below fires instead of waiting up to 1h.
        if (!authChanged && normalizedAuth !== null && peer.authRequired) {
          peer.consecutiveFailures = 0;
          peer.nextProbeAt = null;
          peer.authRequired = false;
          authChanged = true; // ensure probe fires
        }
      }
    }
    if (updates.mediaProvider !== undefined
      && updates.mediaProvider && typeof updates.mediaProvider === 'object'
      && !Array.isArray(updates.mediaProvider)) {
      const previous = peer.mediaProvider;
      const next = mergePeerMediaProviderConfig(previous, updates.mediaProvider);
      if (canonicalStringify(previous ?? null) !== canonicalStringify(next)) {
        peer.mediaProvider = next;
        if (!next.enabled) delete peer.mediaProviderStatus;
        console.log(`🌐 Remote media provider ${next.enabled ? 'enabled' : 'disabled'}: ${peerLogLabel()}`);
      }
    }
    if (peer.transport !== 'tailcat' && updates.host !== undefined) {
      const normalized = validHost(updates.host);
      if (normalized !== undefined && normalized !== peer.host) {
        peer.host = normalized; // null clears, string sets
        // Latch manual mode so handleAnnounce stops auto-learning (esp.
        // important for clears — without this the next inbound announce
        // re-adopts the DNS name and the user can't revert to IP).
        peer.hostManual = true;
        hostChanged = true;
        console.log(`🌐 Peer host ${peer.host ? 'set' : 'cleared'}: ${peerLogLabel()}`);
      }
    }
    // Per-(peer, category) schema-version gaps, populated by syncOrchestrator
    // when a remote snapshot is rejected because the sender's schemaVersions
    // are ahead of local. Stored on the peer record so the Instances UI's
    // SchemaGapBadge can read it via the standard peers payload. Accept
    // either a plain object (set/replace the map) or null (clear all gaps).
    // Any other value is silently ignored.
    if (updates.schemaGaps !== undefined) {
      if (updates.schemaGaps === null) {
        delete peer.schemaGaps;
      } else if (updates.schemaGaps && typeof updates.schemaGaps === 'object' && !Array.isArray(updates.schemaGaps)) {
        peer.schemaGaps = updates.schemaGaps;
      }
    }
    afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    return peer;
  });
  // Tear down the socket relay only after a real state transition so it can
  // reconnect using the new URL on the next probe cycle. Invalid/no-op host
  // writes no longer disrupt an already-healthy connection.
  if (updates.enabled === false || hostChanged || authChanged) disconnectFromPeer(id);
  // The relay above only closes our outbound socket; sockets the peer opened to
  // this server stay admitted by their handshake-time token unless revoked (#17905).
  if (result && (updates.enabled === false || secretChanged)) emitPeerAuthRevoked(result);
  // A credential edit is almost always the fix for a 401, but the peer may be
  // deep in exponential probe backoff (up to 1h) from those failures — so the
  // regular poll loop would skip it for hours. Retry immediately: probePeer
  // bypasses the nextProbeAt gate and, on success, resets backoff + reconnects
  // the relay with the new credential. Fire-and-forget; failure just re-arms
  // backoff as before.
  if (probe && authChanged && result && result.enabled !== false) {
    probePeer(result).catch((err) => console.log(`⚠️ Probe after credential change failed: ${err.message}`));
  }
  // Backfill-subscribe every local record of any kind whose category just
  // flipped on. Fire-and-forget — `autoSubscribePeerToAllRecords` is
  // idempotent + per-record-error tolerant, and we don't want to block the
  // PATCH response on a slow peer's initial-push round-trip. Goes through the
  // recordEvents subscription adapter (peerSync statically imports getPeers
  // from us, so importing it back would close a cycle). Per-kind catch so a
  // transient failure in one kind's backfill (e.g. universe) doesn't abort
  // the loop and leave the peer with no series subscriptions either; the next
  // category-toggle PATCH or peer-online event re-fires any kind that didn't
  // land.
  if (turnedOnKinds.length > 0 && backfillPeerInstanceId) {
    (async () => {
      for (const kind of turnedOnKinds) {
        await autoSubscribePeerToAllRecords(backfillPeerInstanceId, kind).catch((err) => {
          console.log(`⚠️ peer: backfill-subscribe ${kind} after category toggle failed: ${err.message}`);
        });
      }
    })();
  }
  // Mirror the category change back to the peer so sync is bidirectional.
  // Fire-and-forget, but SERIALIZED per peer (see enqueueReciprocalSync): two
  // rapid toggles must not race — an earlier send arriving after a later one
  // would push a stale full map and undo the newer change on the peer.
  if (reciprocate && result?.instanceId) {
    enqueueReciprocalSync(result.id);
  }
  return result;
}

/**
 * Set (gap object) or clear (null) one category's schema gap on the peer with
 * the given remote instanceId. The read-modify-write runs inside the serialized
 * withData write so parallel category syncs cannot overwrite each other's gaps
 * (updatePeer replaces the whole map). An empty map is stored as no key.
 */
export async function setPeerSchemaGap(instanceId, category, gapOrNull) {
  return withData(async (data, afterCommit) => {
    const peer = data.peers.find((p) => p.instanceId === instanceId);
    if (!peer) return null;
    const gaps = peer.schemaGaps && typeof peer.schemaGaps === 'object' && !Array.isArray(peer.schemaGaps) ? { ...peer.schemaGaps } : {};
    if (gapOrNull === null) {
      if (!(category in gaps)) return peer;
      delete gaps[category];
    } else {
      gaps[category] = gapOrNull;
    }
    if (Object.keys(gaps).length > 0) peer.schemaGaps = gaps;
    else delete peer.schemaGaps;
    afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    return peer;
  });
}
