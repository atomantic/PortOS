/**
 * Instances Service
 *
 * Manages PortOS federation — self identity, peer registration, health probing, and query proxying.
 * Data persists to data/instances.json.
 */

import os from 'os';
import net from 'net';
import crypto from 'crypto';
import { dataPath, readJSONFile, ensureDir, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { instanceEvents } from './instanceEvents.js';
import { connectToPeer, disconnectFromPeer } from './peerSocketRelay.js';
import { DEFAULT_PEER_PORT } from '../lib/ports.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { peerFetch } from '../lib/peerHttpClient.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { getSelfHost } from '../lib/peerSelfHost.js';
import { getTailscaleStatus } from '../lib/tailscale.js';
import { autoSubscribePeerToAllRecords } from './sharing/recordEvents.js';

const INSTANCES_FILE = dataPath('instances.json');
const PROBE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 30000;
const INITIAL_PROBE_DELAY_MS = 2000;
// While peer probing is deferred (Tailscale not connected at boot), re-check
// Tailscale on this cadence and start polling the moment it comes up — so the
// user just has to connect Tailscale, no manual "sync now" required.
const TAILSCALE_RECHECK_MS = 60_000;

// Sentinel returned by getInstanceId() and stamped onto sender/peer fields when
// the local identity hasn't been initialized yet. Every consumer that fans
// instance-keyed state out to peers (sharing/annotationsSync.flushAll,
// mediaAnnotations.mergePeerAnnotations, manifest builders) must refuse this
// value — without that guard, every uninitialized peer would collide in the
// same bucket and clobber each other on merge.
export const UNKNOWN_INSTANCE_ID = 'unknown';

// Backoff tiers for consecutive probe failures (in ms)
// 30s → 1m → 5m → 15m → 1h → 24h
const BACKOFF_TIERS_MS = [
  30_000,      // tier 0: normal (1 failure)
  60_000,      // tier 1: 1 minute
  300_000,     // tier 2: 5 minutes
  900_000,     // tier 3: 15 minutes
  3_600_000,   // tier 4: 1 hour
  86_400_000   // tier 5: 24 hours (max)
];

const withLock = createMutex();
let pollTimer = null;
// Set while we're waiting for Tailscale to connect before starting the real
// probe loop (see startPolling). Kept separate from pollTimer so stopPolling can
// tear down either state, and so the boot gate is idempotent under double-start.
let tailscaleWatchTimer = null;
let pollingStartPending = false;
// Bumped by stopPolling() to cancel any in-flight startPolling gate or deferred
// watcher callback that is mid-await when the stop lands — without it, a stop
// during the async window is a silent no-op and a timer gets created after stop
// was requested.
let pollingGeneration = 0;

function classifyProbeError(err, peer) {
  const code = err?.code;
  if (code === 'ENOTFOUND') return `🌐 ❌ DNS lookup failed for ${peer.host || peer.address} — is Tailscale MagicDNS up?`;
  if (code === 'ECONNREFUSED') return `🌐 ❌ Connection refused — peer not running on this port`;
  if (code === 'EHOSTUNREACH') return `🌐 ❌ Host unreachable — Tailscale tunnel down or peer offline`;
  // Native fetch raises AbortError when the AbortSignal fires; insecureFetch
  // (used for HTTPS peer hops via peerFetch) destroys the request with a
  // plain `new Error('Request aborted')` instead — both are timeouts here.
  if (code === 'ETIMEDOUT' || err?.name === 'AbortError' || err?.message === 'Request aborted') return `🌐 ⏱️ Probe timeout (${PROBE_TIMEOUT_MS}ms)`;
  // The peer is reachable but gated by an auth proxy (Tailscale serve, Caddy,
  // nginx Basic auth). Point the user at the per-peer credential field rather
  // than letting it read like a generic failure.
  if (err?.httpStatus === 401 || err?.httpStatus === 403) {
    return `🔒 Authentication required (HTTP ${err.httpStatus}) — set a username/password for this peer in the Instances UI`;
  }
  return err?.message || String(err);
}

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

// Strip the locally-stored proxy credential before a peer record crosses the
// wire (e.g. the announce response echoes the matched local peer back to the
// announcing instance). The password is OUR secret for reaching THEM and must
// never leak to the peer itself.
export function redactPeerForWire(peer) {
  if (!peer || typeof peer !== 'object' || !('auth' in peer)) return peer;
  const { auth: _auth, ...rest } = peer;
  return rest;
}

// Redact the stored credential before a peer record is returned to the local
// client (API responses + socket broadcasts). Keeps the non-secret username
// and a `hasPassword` marker so the UI can show "credential set" and prefill
// the username, but never ships the password to the browser — mirrors the
// `hasApiKey` pattern in server/routes/providers.js. The password stays only
// on the server-side record, where peerAuthHeaders reads it.
export function sanitizePeerForClient(peer) {
  if (!peer || typeof peer !== 'object' || !peer.auth || typeof peer.auth !== 'object') return peer;
  return { ...peer, auth: { username: peer.auth.username ?? '', hasPassword: Boolean(peer.auth.password) } };
}

// Default data shape
const DEFAULT_DATA = {
  self: null,
  peers: []
};

// --- File I/O ---

async function loadData() {
  return await readJSONFile(INSTANCES_FILE, DEFAULT_DATA);
}

async function saveData(data) {
  await ensureDir(PATHS.data);
  await atomicWrite(INSTANCES_FILE, data);
}

async function withData(fn) {
  return withLock(async () => {
    const data = await loadData();
    const result = await fn(data);
    await saveData(data);
    return result;
  });
}

// --- Self Identity ---

export async function ensureSelf() {
  return withData(async (data) => {
    if (!data.self) {
      data.self = {
        instanceId: crypto.randomUUID(),
        name: os.hostname()
      };
      console.log(`🌐 Instance identity created: ${data.self.name} (${data.self.instanceId})`);
    }
    return data.self;
  });
}

export async function getSelf() {
  const data = await loadData();
  return data.self;
}

let cachedInstanceId = null;
export async function getInstanceId() {
  if (!cachedInstanceId) {
    const id = (await getSelf())?.instanceId;
    if (id) cachedInstanceId = id;
    return id ?? UNKNOWN_INSTANCE_ID;
  }
  return cachedInstanceId;
}

/**
 * Resolve this machine's real federation instance id, creating the local
 * identity on the cold path. `getInstanceId()` returns the
 * `UNKNOWN_INSTANCE_ID` sentinel (and never throws) before the identity exists
 * — which can happen on a boot-time always-on auto-start that runs before the
 * startup chain's `ensureSelf()` does. Callers that stamp the id onto durable
 * records (agent provenance, worktree metadata) or compare it for cross-machine
 * task claims (#1563) must never persist/compare the sentinel, so this creates
 * (or loads) the real identity before returning. The warm path is the cheap
 * cached `getInstanceId()` read; `ensureSelf()` only runs the once.
 */
export async function ensureInstanceId() {
  let instanceId = await getInstanceId();
  if (instanceId === UNKNOWN_INSTANCE_ID) {
    instanceId = (await ensureSelf())?.instanceId || instanceId;
  }
  return instanceId;
}

export async function updateSelf(name, { defaultPeerFullSync } = {}) {
  return withData(async (data) => {
    if (!data.self) return null;
    if (typeof name === 'string' && name.trim()) {
      data.self.name = name.trim();
      console.log(`🌐 Instance name updated: ${data.self.name}`);
    }
    // The default full-sync ("mirror everything") mode applied to NEW peers as
    // they're added. Existing peers are untouched — this only seeds addPeer.
    if (typeof defaultPeerFullSync === 'boolean') {
      data.self.defaultPeerFullSync = defaultPeerFullSync;
      console.log(`🌐 New-peer full-sync default: ${defaultPeerFullSync ? 'on' : 'off'}`);
    }
    return data.self;
  });
}

// --- Peer CRUD ---

export async function getPeers() {
  const data = await loadData();
  return data.peers;
}

function validName(name, fallback) {
  if (!name || typeof name !== 'string') return fallback;
  if (!name.trim()) return fallback;
  return name.trim();
}

function isIPAddress(str) {
  return net.isIP(str) !== 0;
}

// Returns: null = explicit clear, undefined = invalid input (callers should
// ignore), string = valid lowercased hostname. Three-state distinction lets
// callers choose between "noisy/optional input" (use undefined) vs "user
// asked to clear" (use null).
function validHost(str) {
  if (str === '' || str === null) return null;
  if (typeof str !== 'string') return undefined;
  const trimmed = str.trim();
  if (!trimmed) return null;
  // Accept DNS names: letters, digits, hyphens, dots. No scheme, no port, no path.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

export { validHost };

// Default sync categories — all disabled until explicitly enabled per-peer
const DEFAULT_SYNC_CATEGORIES = {
  brain: false,
  memory: false,
  goals: false,
  character: false,
  digitalTwin: false,
  meatspace: false,
  universe: false,
  pipeline: false,
  mediaCollections: false,
  videoHistory: false,
  storyBuilder: false,
  authors: false,
  artists: false,
  albums: false,
  tracks: false,
  creativeDirectorProjects: false,
  moodBoards: false,
  writersRoomWorks: false,
  writersRoomFolders: false,
  writersRoomExercises: false,
  musicVideoProjects: false,
  commissionFeedback: false,
  creativeCommissions: false,
  catalog: false
};

export { DEFAULT_SYNC_CATEGORIES };

// A category map with every key forced on — the effective view a full-sync
// ("mirror everything") peer presents. Derived from DEFAULT_SYNC_CATEGORIES so a
// newly added category is covered by full-sync peers with no per-peer change.
// Used by the snapshot orchestrator (what a full-sync peer pulls) and the
// reciprocation send (the all-on map a full-sync peer asks its mirror to adopt).
export function allSyncCategoriesOn() {
  return Object.fromEntries(Object.keys(DEFAULT_SYNC_CATEGORIES).map((k) => [k, true]));
}

// Sync categories whose records ride the PER-RECORD push pipeline (not the 60s
// snapshot loop), paired with the record kind autoSubscribePeerToAllRecords
// backfills. A false→true toggle on any of these triggers an inline backfill of
// existing local records so the user doesn't have to wait for the next
// `peer:online` / manual sync-now. Mirror of peerSync's KIND_TO_CATEGORY
// (inverted). `pipeline → series` bundles child issues at push time; authors,
// music records, and mediaCollections are standalone per-record kinds with no
// snapshot category, so toggle-time backfill is the main path that subscribes
// existing records short of a reconnect.
const PER_RECORD_CATEGORY_KINDS = Object.freeze([
  ['universe', 'universe'],
  ['pipeline', 'series'],
  ['mediaCollections', 'mediaCollection'],
  ['authors', 'author'],
  ['artists', 'artist'],
  ['albums', 'album'],
  ['tracks', 'track'],
  ['creativeDirectorProjects', 'creativeDirectorProject'],
  ['moodBoards', 'moodBoard'],
  ['writersRoomWorks', 'writersRoomWork'],
  ['writersRoomFolders', 'writersRoomFolder'],
  ['writersRoomExercises', 'writersRoomExercise'],
  ['musicVideoProjects', 'musicVideoProject'],
  ['commissionFeedback', 'commissionFeedback'],
  ['creativeCommissions', 'creativeCommission'],
]);

export async function addPeer({ address, port = DEFAULT_PEER_PORT, name, host, auth }) {
  const peer = await withData(async (data) => {
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
      hostManual: !!normalizedHost,
      port,
      name: validName(name, normalizedHost || address),
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
      consecutiveFailures: 0,
      nextProbeAt: null,
      directions: ['outbound']
    };
    data.peers.push(entry);
    console.log(`🌐 Peer added: ${entry.name} (${peerBaseUrl(entry)})`);
    instanceEvents.emit('peers:updated', data.peers);
    return entry;
  });
  announceSelf(peer);
  return peer;
}

export async function removePeer(id) {
  disconnectFromPeer(id);
  return withData(async (data) => {
    const idx = data.peers.findIndex(p => p.id === id);
    if (idx === -1) return null;
    const [removed] = data.peers.splice(idx, 1);
    console.log(`🌐 Peer removed: ${removed.name}`);
    instanceEvents.emit('peers:updated', data.peers);
    return removed;
  });
}

export async function updatePeer(id, updates) {
  let hostChanged = false;
  // Credential edits must reconnect the live socket relay (it pins the
  // Basic-auth header into extraHeaders at connect time), not just the next
  // probe cycle — otherwise an online relayed peer keeps the stale credential
  // until a natural reconnect. Tracked like hostChanged, consumed below.
  let authChanged = false;
  // Track false→true transitions for the per-record-subscribable categories
  // so we can backfill-subscribe existing local records after the data write
  // settles. Set inside withData (where we have the merged before/after
  // peer object) and consumed after the lock releases.
  const turnedOnKinds = [];
  let backfillPeerInstanceId = null;
  // Set when a syncCategories change should be mirrored back to the peer so the
  // sync is bidirectional (the user owns all machines). The actual send reads
  // the freshest persisted map at send time via the serialized queue below.
  let reciprocate = false;
  const result = await withData(async (data) => {
    const peer = data.peers.find(p => p.id === id);
    if (!peer) return null;
    if (updates.name !== undefined) peer.name = validName(updates.name, peer.name);
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
        peer.syncEnabled = Object.values(peer.syncCategories || {}).some(Boolean);
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
          console.log(`🌐 Peer credential ${peer.auth ? 'set' : 'cleared'}: ${peer.name}`);
        }
        // When sameAuth was true (credential unchanged), authChanged is still
        // false. If the peer is stuck in authRequired+backoff the user is
        // explicitly asking for a retry — clear backoff so the immediate probe
        // below fires instead of waiting up to 24h.
        if (!authChanged && normalizedAuth !== null && peer.authRequired) {
          peer.consecutiveFailures = 0;
          peer.nextProbeAt = null;
          peer.authRequired = false;
          authChanged = true; // ensure probe fires
        }
      }
    }
    if (updates.host !== undefined) {
      const normalized = validHost(updates.host);
      if (normalized !== undefined && normalized !== peer.host) {
        peer.host = normalized; // null clears, string sets
        // Latch manual mode so handleAnnounce stops auto-learning (esp.
        // important for clears — without this the next inbound announce
        // re-adopts the DNS name and the user can't revert to IP).
        peer.hostManual = true;
        hostChanged = true;
        console.log(`🌐 Peer host ${peer.host ? `set to ${peer.host}` : 'cleared'}: ${peer.name}`);
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
    instanceEvents.emit('peers:updated', data.peers);
    return peer;
  });
  // Tear down the socket relay only after a real state transition so it can
  // reconnect using the new URL on the next probe cycle. Invalid/no-op host
  // writes no longer disrupt an already-healthy connection.
  if (updates.enabled === false || hostChanged || authChanged) disconnectFromPeer(id);
  // A credential edit is almost always the fix for a 401, but the peer may be
  // deep in exponential probe backoff (up to 24h) from those failures — so the
  // regular poll loop would skip it for hours. Retry immediately: probePeer
  // bypasses the nextProbeAt gate and, on success, resets backoff + reconnects
  // the relay with the new credential. Fire-and-forget; failure just re-arms
  // backoff as before.
  if (authChanged && result && result.enabled !== false) {
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

// Per-peer tail that serializes reciprocal-sync sends. Two rapid category
// toggles for the same peer each want to push the full resulting map; if their
// fire-and-forget requests raced, the earlier (staler) map could land last on
// the peer and undo the newer change. Chaining per peer.id guarantees in-order
// delivery, and each send re-reads the FRESHEST persisted category map (not a
// value captured at enqueue time) so the final send always carries final state.
// Per-peer serialization (silence prior + self-pruning tail) via the shared
// helper — `work` runs on both fulfil and reject of the prior send, so a failed
// send can't break the chain.
const reciprocalSyncQueue = createKeyCachedQueue();

export function enqueueReciprocalSync(peerId) {
  return reciprocalSyncQueue(peerId, async () => {
    // Re-read the peer fresh at send time — the last enqueued send wins with
    // the latest persisted syncCategories, regardless of enqueue order.
    const data = await loadData();
    const peer = data.peers.find(p => p.id === peerId);
    if (!peer?.instanceId) return { ok: false, reason: 'no-peer-identity' };
    // For a full-sync peer send the all-on category view (its stored
    // syncCategories can be all-false underneath — sending that raw would tell
    // the peer to DISABLE everything, since reciprocal-sync apply is an
    // authoritative overlay; the all-on map also makes a peer too old to
    // understand the fullSync flag still mirror every category) plus the
    // fullSync flag. A regular peer keeps sending its raw partial map so a
    // category it never set stays untouched on the peer (absent ≠ false).
    const reciprocalCategories = peer.fullSync === true ? allSyncCategoriesOn() : (peer.syncCategories || {});
    return requestReciprocalSync(peer, reciprocalCategories, { fullSync: peer.fullSync === true }).catch((err) => {
      console.log(`⚠️ peer: reciprocal sync request failed: ${err.message}`);
      return { ok: false, reason: err.message };
    });
  });
}

// --- Probing ---

export async function probePeer(peer) {
  const baseUrl = peerBaseUrl(peer);

  const previousStatus = peer.status;
  let status, lastHealth, lastSeen, remoteInstanceId, remoteVersion, remoteApps, remoteSyncSeqs;
  // Latches when the peer answers 401/403 — a reachable-but-auth-gated peer, as
  // opposed to an unreachable one. The Instances UI reads this to prompt for a
  // credential instead of showing a generic offline state.
  let authRequired = false;
  // One shared abort signal spans the instanceId read, all three parallel
  // fetches, AND their body reads, so a single PROBE_TIMEOUT_MS bounds the whole
  // probe (the instanceId read is inside the budget, as it was before).
  await withAbortTimeout(PROBE_TIMEOUT_MS, async (signal) => {
    // Pass our own instanceId as `forPeer` so the peer also returns ITS cursor
    // into our data (`cursorForYou`) — our push-frontier toward it. Best-effort:
    // an unresolved/unknown id just omits the param and we get the inbound-only
    // shape (push count renders "unknown" client-side, never a misleading 0).
    const ourInstanceId = await getInstanceId().catch(() => null);
    const forPeerQs = typeof ourInstanceId === 'string' && ourInstanceId && ourInstanceId !== UNKNOWN_INSTANCE_ID
      ? `?forPeer=${encodeURIComponent(ourInstanceId)}`
      : '';
    // Fetch health details, apps, and sync status in parallel
    const [healthRes, appsRes, syncRes] = await Promise.all([
      peerFetch(`${baseUrl}/api/system/health/details`, { signal }, peer),
      peerFetch(`${baseUrl}/api/apps`, { signal }, peer).catch(() => null),
      peerFetch(`${baseUrl}/api/instances/sync-status${forPeerQs}`, { signal }, peer).catch(() => null)
    ]);
    if (!healthRes.ok) {
      const err = new Error(`HTTP ${healthRes.status}`);
      err.httpStatus = healthRes.status;
      throw err;
    }
    const json = await healthRes.json();
    status = 'online';
    lastHealth = json;
    lastSeen = new Date().toISOString();
    remoteInstanceId = json.instanceId ?? null;
    remoteVersion = json.version ?? null;

    if (appsRes?.ok) {
      const appsJson = await appsRes.json().catch(() => null);
      const appsList = Array.isArray(appsJson) ? appsJson : appsJson?.apps;
      remoteApps = appsList?.map(a => ({
        id: a.id, name: a.name, icon: a.icon,
        overallStatus: a.overallStatus, uiPort: a.uiPort, apiPort: a.apiPort, type: a.type
      })) ?? null;
    }
    if (syncRes?.ok) {
      remoteSyncSeqs = await syncRes.json().catch(() => null);
    }
  }).catch((err) => {
    console.log(`⚠️ Probe failed for ${baseUrl}: ${classifyProbeError(err, peer)}`);
    status = 'offline';
    authRequired = err?.httpStatus === 401 || err?.httpStatus === 403;
    lastHealth = peer.lastHealth; // preserve last known
    lastSeen = peer.lastSeen;
  });

  const stored = await withData(async (data) => {
    const entry = data.peers.find(p => p.id === peer.id);
    if (!entry) return null;
    entry.status = status;
    entry.lastSeen = lastSeen;
    entry.lastHealth = lastHealth;
    // Surface "reachable but needs a credential" distinctly from plain offline.
    // Cleared on any successful probe (including after the user adds the password).
    entry.authRequired = authRequired;
    entry.lastApps = remoteApps ?? entry.lastApps ?? null;
    entry.remoteSyncSeqs = remoteSyncSeqs ?? entry.remoteSyncSeqs ?? null;
    if (remoteInstanceId) entry.instanceId = remoteInstanceId;
    if (status === 'online') entry.version = remoteVersion;
    // Auto-update name from hostname if current name is just an IP address
    const remoteHostname = validName(lastHealth?.hostname, null);
    if (remoteHostname && isIPAddress(entry.name)) {
      entry.name = remoteHostname;
    }

    // Backoff tracking for failed probes
    if (status === 'online') {
      if (entry.consecutiveFailures > 0) {
        console.log(`🌐 Peer ${entry.name} recovered after ${entry.consecutiveFailures} consecutive failures`);
      }
      entry.consecutiveFailures = 0;
      entry.nextProbeAt = null;
    } else {
      entry.consecutiveFailures = (entry.consecutiveFailures ?? 0) + 1;
      const tier = Math.min(entry.consecutiveFailures - 1, BACKOFF_TIERS_MS.length - 1);
      const backoffMs = BACKOFF_TIERS_MS[tier];
      entry.nextProbeAt = new Date(Date.now() + backoffMs).toISOString();
      console.log(`⏳ Peer ${entry.name} backoff tier ${tier} (${backoffMs / 1000}s), failures: ${entry.consecutiveFailures}`);
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
  if (status === 'online' && previousStatus !== 'online') {
    if (stored) {
      announceSelf(stored);
      instanceEvents.emit('peer:online', stored);
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

// --- Query Proxy ---

export async function queryPeer(id, apiPath) {
  const data = await loadData();
  const peer = data.peers.find(p => p.id === id);
  if (!peer) return { error: 'Peer not found' };

  const url = `${peerBaseUrl(peer)}${apiPath}`;
  return withAbortTimeout(PROBE_TIMEOUT_MS, async (signal) => {
    const res = await peerFetch(url, { signal }, peer);
    return { success: true, data: await res.json() };
  }).catch((err) => ({ error: `Failed to query peer: ${err.message}` }));
}

// --- Announce (Bidirectional Registration) ---

export async function handleAnnounce({ address, port, instanceId, name, host }) {
  const result = await withData(async (data) => {
    // Check for existing peer by instanceId
    let existing = data.peers.find(p => p.instanceId === instanceId);
    // Fallback: check by address + port
    if (!existing) {
      existing = data.peers.find(p => p.address === address && p.port === port);
    }

    const normalizedHost = validHost(host);

    if (existing) {
      existing.lastSeen = new Date().toISOString();
      existing.status = 'online';
      existing.instanceId = instanceId;
      existing.port = port;
      // Only auto-update name if still an IP address (preserve user-set names)
      const sanitized = validName(name, null);
      if (sanitized && isIPAddress(existing.name)) {
        existing.name = sanitized;
      }
      // Adopt host from inbound announce only when we don't already have one
      // AND the user hasn't manually intervened. The hostManual flag covers
      // the "user explicitly cleared this — stay on IP" case that the
      // existing.host check alone can't distinguish from "never set".
      if (normalizedHost && !existing.host && !existing.hostManual) {
        existing.host = normalizedHost;
        console.log(`🌐 Peer host learned via announce: ${existing.name} → ${normalizedHost}`);
      }
      // Mark that this peer has announced to us (inbound connection)
      existing.directions = existing.directions || [];
      if (!existing.directions.includes('inbound')) existing.directions.push('inbound');
      console.log(`🌐 Peer announced (existing): ${existing.name} (${address}:${port})`);
      instanceEvents.emit('peers:updated', data.peers);
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
      consecutiveFailures: 0,
      nextProbeAt: null,
      directions: ['inbound']
    };
    data.peers.push(peer);
    console.log(`🌐 Peer announced (new): ${peer.name} (${peerBaseUrl(peer)})`);
    instanceEvents.emit('peers:updated', data.peers);
    return { created: true, peer };
  });

  // Immediately probe newly announced peers to populate health data
  if (result.created) {
    probePeer(result.peer).catch(err => {
      console.log(`⚠️ Initial probe failed for announced peer ${result.peer.name}: ${err.message}`);
    });
  }

  return result;
}

async function announceSelf(peer) {
  const data = await loadData();
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
      console.log(`🌐 Announced self to ${url}`);
      await markDirection(peer.id, 'outbound');
    } else {
      console.log(`🌐 Announce to ${url} failed: HTTP ${res.status}`);
    }
  }).catch((err) => {
    console.log(`🌐 Announce to ${url} unreachable: ${err.message}`);
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

// --- Bidirectional sync reciprocation ---
//
// A single user commonly owns every federated machine and expects enabling a
// sync category toward a peer to make it two-way without also toggling it on
// the peer by hand. Sync is pull-based per direction, so enabling category C
// toward peer B only makes US pull B's C. For B to pull OUR C, B must enable C
// toward US. `requestReciprocalSync` asks B to do exactly that; the peer side
// is `applyReciprocalSync`, invoked by the POST /sync-categories route.
//
// SEMANTICS — full mirror, NOT enable-only (resolved, issue #1094). A peer's
// announced keys are applied as an authoritative overlay onto our existing map
// (`{ ...prev, ...sanitized }`) — announced `false` values are authoritative
// (they DISABLE), while categories the peer omits are preserved untouched. So a
// peer sending `C:false` DISABLES C on our record for that peer even when we had
// independently enabled C toward them. This is intentional, not a bug:
//   - The 'Make mutual' UI deliberately pushes the sender's *current* set
//     (including its disables) so a previously-offline / one-directional peer
//     converges to the sender's view in one round-trip.
//   - It's the recovery path for clearing a stale enabled category after a peer
//     was offline during a disable (the all-false / offline-disable test below).
// Treating sync categories as a symmetric mirror (rather than two strictly
// independent per-direction switches) is the chosen model. If a future change
// wants per-direction-independent semantics, 'Make mutual' must grow a separate
// explicit-disable path so reciprocation never clobbers an independent enable —
// don't quietly switch this to enable-only, which would regress the two paths
// above. The full-mirror behavior is pinned by tests in instances.test.js.

// Keep only the keys DEFAULT_SYNC_CATEGORIES defines, coerced to booleans, so a
// peer can never inject unknown/garbage category flags onto our peer record.
function sanitizeSyncCategories(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const key of Object.keys(DEFAULT_SYNC_CATEGORIES)) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Receiver side of reciprocation: a peer is telling us it enabled `categories`
 * toward us and is asking us to mirror them so the sync is bidirectional.
 * Find the local peer record for the announcing instance and apply the same
 * category flags. Returns `{ changed, peer }`; `changed` is false when our
 * record already matched (the echo guard — the caller never re-reciprocates,
 * but this keeps a misbehaving peer from churning our state).
 */
export async function applyReciprocalSync(instanceId, categories, { fullSync } = {}) {
  const sanitized = sanitizeSyncCategories(categories);
  // A fullSync-only signal (peer asking us to mirror everything) is valid even
  // if the category map didn't sanitize to anything actionable. An explicit
  // `fullSync === false` is the peer telling us it STOPPED mirroring us, so we
  // drop our mirror toward it too — keeping enable AND disable symmetric (a peer
  // too old to send the field leaves it undefined, which touches nothing).
  const wantsFullSync = fullSync === true;
  const wantsFullSyncOff = fullSync === false;
  if (!sanitized && !wantsFullSync && !wantsFullSyncOff) return { changed: false, peer: null };
  const turnedOnKinds = [];
  let backfillInstanceId = null;
  let changed = false;
  const peer = await withData(async (data) => {
    const entry = data.peers.find(p => p.instanceId === instanceId);
    if (!entry) return null;
    // Default the baseline so a partial stored map doesn't make absent-vs-false
    // diverge — otherwise sanitized adding `goals:false` to a `prev` missing
    // `goals` reads as a change (`false !== undefined`) and defeats the guard.
    const prev = { ...DEFAULT_SYNC_CATEGORIES, ...(entry.syncCategories || {}) };
    const next = sanitized ? { ...prev, ...sanitized } : prev;
    const fullSyncFlips = wantsFullSync && entry.fullSync !== true;
    const fullSyncOffFlips = wantsFullSyncOff && entry.fullSync === true;
    const categoriesFlip = !Object.keys(next).every(k => next[k] === prev[k]);
    // Does THIS reciprocal request itself ask us to push per-record data back —
    // full mirror, or at least one per-record category carried IN the request?
    // Scope the consent decision to what the peer asked for this time (wantsFullSync
    // / sanitized), NOT the preserved `next` map: a request that only reciprocates a
    // snapshot category (or a per-record kind we merely happen to already have on
    // locally) must not silently widen us to push every locally-enabled kind back.
    // The request is the consent signal, so it also scopes what that consent covers.
    const requestEnablesPushable = wantsFullSync
      || (sanitized ? PER_RECORD_CATEGORY_KINDS.some(([cat]) => sanitized[cat] === true) : false);
    const directions = Array.isArray(entry.directions) ? entry.directions : [];
    // An `/announce`-created peer record is inbound-only (it announced to us; the
    // user here never added it back), and `peerAllowsOutbound` then refuses our
    // pushes — so the backfill below, every future per-record push, and reverse-
    // subscription creation on incoming pushes would all silently no-op, leaving
    // the mirror one-directional. An explicit reciprocal-sync request IS the peer
    // asking us to mirror our data back — its consent to receive our pushes — so
    // adopt `outbound`. Crucially this must hold even when nothing flips: a record
    // that adopted fullSync/categories BEFORE this fix (#1636) but stayed inbound-
    // only never back-fills, and the echo guard below would return first — so the
    // missing direction has to participate in change detection to heal it.
    const needsOutboundAdopt = requestEnablesPushable && directions.length > 0 && !directions.includes('outbound');
    // No-op only when nothing flips AND there's no outbound to adopt — the echo guard.
    if (!fullSyncFlips && !fullSyncOffFlips && !categoriesFlip && !needsOutboundAdopt) return entry;
    if (fullSyncFlips) {
      // Adopting full mirror. fullSync alone drives gating, so the stored
      // per-category map is PRESERVED untouched — we do NOT apply the sender's
      // all-on compat overlay. That keeps the user's own selection intact so a
      // later disable restores it, exactly like the local toggle path. (Legacy
      // receivers that don't understand fullSync fall into the category branch
      // below and mirror via the all-on overlay instead — that's its purpose.)
      entry.fullSync = true;
    } else if (fullSyncOffFlips) {
      // Dropping full mirror: clear the flag. If this SAME reciprocal request
      // also carries a changed per-category selection, adopt it too — otherwise
      // (the old combined branch fell through without touching categories) the
      // peer's intended post-full-sync set would be ignored and the stale
      // preserved map would keep mirroring the wrong categories. With no
      // category change in the request, the preserved map stands (restore path).
      entry.fullSync = false;
      if (categoriesFlip) entry.syncCategories = next;
    } else if (categoriesFlip) {
      entry.syncCategories = next;
    }
    // Adopt outbound consent from the reciprocal request (see needsOutboundAdopt).
    // Inline rather than via markDirection — that helper opens its own withData and
    // would deadlock on this same lock; idempotent (a peer already pushing has
    // outbound and never reaches here, so directions.push is never a duplicate).
    if (needsOutboundAdopt) entry.directions = [...directions, 'outbound'];
    // Recompute from the (possibly preserved) stored map — a full-sync peer is
    // always sync-enabled; otherwise it follows the per-category selection.
    entry.syncEnabled = entry.fullSync === true || Object.values(entry.syncCategories || {}).some(Boolean);
    // Backfill every per-record kind whose push toward this peer just became
    // viable: a kind that flipped false→true, all kinds when full mirror was just
    // adopted, and — when we just adopted outbound on a previously inbound-only
    // record — every kind already enabled (it was on but never pushed while we
    // couldn't push outbound). autoSubscribePeerToAllRecords is idempotent, so a
    // kind already subscribed is a harmless no-op.
    for (const [cat, kind] of PER_RECORD_CATEGORY_KINDS) {
      const enabledNow = entry.fullSync === true || !!(entry.syncCategories && entry.syncCategories[cat] === true);
      const flippedOn = prev[cat] !== true && next[cat] === true;
      // On a heal (outbound just adopted, no flip) only back-fill kinds THIS request
      // enabled — full mirror, or the specific per-record category it carried — so a
      // heal never pushes a kind the current request didn't authorize.
      const requestEnablesKind = wantsFullSync || !!(sanitized && sanitized[cat] === true);
      if ((fullSyncFlips && enabledNow) || flippedOn || (needsOutboundAdopt && enabledNow && requestEnablesKind)) {
        turnedOnKinds.push(kind);
      }
    }
    if (turnedOnKinds.length > 0) backfillInstanceId = entry.instanceId || null;
    changed = true;
    instanceEvents.emit('peers:updated', data.peers);
    return entry;
  });
  if (!peer) return { changed: false, peer: null };
  // Mirror updatePeer's backfill-subscribe so a reciprocally-enabled
  // per-record category (universe/pipeline) pushes our existing records too.
  if (changed && turnedOnKinds.length > 0 && backfillInstanceId) {
    (async () => {
      for (const kind of turnedOnKinds) {
        await autoSubscribePeerToAllRecords(backfillInstanceId, kind).catch((err) => {
          console.log(`⚠️ peer: reciprocal backfill-subscribe ${kind} failed: ${err.message}`);
        });
      }
    })();
  }
  if (changed) {
    const enabledList = sanitized ? Object.keys(sanitized).filter(k => sanitized[k]).join(',') : '';
    console.log(`🔁 Reciprocal sync applied for peer ${peer.name}: ${peer.fullSync ? 'full-mirror' : (enabledList || 'none')}`);
  }
  return { changed, peer };
}

/**
 * Sender side: ask `peer` to enable `categories` toward us (mirror what we just
 * enabled toward them). Best-effort and fire-and-forget at the call site — a
 * peer that's offline or on an older version (404s the endpoint) just stays
 * one-directional until the next toggle. Returns `{ ok, reason }`.
 */
export async function requestReciprocalSync(peer, categories, { fullSync } = {}) {
  const self = await getSelf();
  if (!self?.instanceId) return { ok: false, reason: 'no-self-identity' };
  const sanitized = sanitizeSyncCategories(categories);
  // Bail only when there's genuinely nothing to say: no actionable categories
  // AND no full-sync state to communicate. A full-sync DISABLE (fullSync:false)
  // on a peer whose stored category map is empty must still send — otherwise the
  // remote never learns to drop its mirror. `fullSync === undefined` means the
  // caller didn't communicate a full-sync state at all (legacy direct callers).
  if (!sanitized && fullSync === undefined) return { ok: false, reason: 'no-categories' };
  const url = `${peerBaseUrl(peer)}/api/instances/peers/sync-categories`;
  return withAbortTimeout(PROBE_TIMEOUT_MS, async (signal) => {
    const res = await peerFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Always carry our current full-sync state (true OR false) so a peer new
      // enough to understand it adopts mirror mode on enable AND drops it on
      // disable. Older peers ignore the field; on enable they still mirror via
      // the all-on syncCategories map we sent. syncCategories defaults to {} so
      // the receiver's required-object schema still parses a fullSync-only send.
      body: JSON.stringify({ instanceId: self.instanceId, syncCategories: sanitized || {}, fullSync: fullSync === true }),
      signal
    }, peer);
    if (res.ok) {
      const enabledList = sanitized ? Object.keys(sanitized).filter(k => sanitized[k]).join(',') : '';
      console.log(`🔁 Requested reciprocal sync from ${peer.name}: ${fullSync === false ? 'full-mirror-off' : (enabledList || 'none')}`);
      return { ok: true };
    }
    // 404 = peer predates this endpoint; not an error worth surfacing loudly.
    return { ok: false, reason: `http-${res.status}` };
  }).catch((err) => ({ ok: false, reason: err.message }));
}

async function markDirection(peerId, direction) {
  await withData(async (data) => {
    const peer = data.peers.find(p => p.id === peerId);
    if (!peer) return;
    peer.directions = peer.directions || [];
    if (!peer.directions.includes(direction)) {
      peer.directions.push(direction);
      instanceEvents.emit('peers:updated', data.peers);
    }
  });
}

// --- Polling ---

// Actually create the probe schedule (backoff clear + initial probe + interval).
// Idempotent: a no-op if the loop is already running.
function beginPolling() {
  if (pollTimer) return;
  console.log(`🌐 Instance polling started (${POLL_INTERVAL_MS / 1000}s interval)`);

  // Backoff is a rate limit on the polling loop, not a durable judgment about
  // the peer — boot (or a fresh Tailscale connect) may itself be the event that
  // fixes connectivity, so clear it.
  withData(async (data) => {
    let cleared = 0;
    for (const peer of data.peers) {
      if (peer.nextProbeAt) {
        peer.nextProbeAt = null;
        peer.consecutiveFailures = 0;
        cleared++;
      }
    }
    if (cleared > 0) console.log(`🌐 Cleared backoff on ${cleared} peer(s) for fresh probe after boot`);
  }).catch(err => console.error(`❌ Failed to clear peer backoff on boot: ${err.message}`));

  // Initial probe after a short delay. probeAllPeers() awaits fs/network work
  // that can reject; setTimeout/setInterval don't await the callback, so catch
  // here to avoid a process-killing unhandled rejection.
  setTimeout(() => {
    probeAllPeers().catch(err => console.error(`❌ Initial peer probe failed: ${err?.message || String(err)}`));
  }, INITIAL_PROBE_DELAY_MS);

  pollTimer = setInterval(() => {
    probeAllPeers().catch(err => console.error(`❌ Peer probe failed: ${err?.message || String(err)}`));
  }, POLL_INTERVAL_MS);
}

// A peer we can only reach over the tailnet: its probe URL (see peerBaseUrl)
// resolves to a MagicDNS name (*.ts.net) or a Tailscale CGNAT address
// (100.64.0.0/10 for IPv4, fd7a:115c:a1e0::/48 for IPv6). A peer addressed by a
// plain LAN/routable IP or a non-tailnet DNS host is reachable with Tailscale
// down, so it must NOT be deferred by the gate below.
function peerRequiresTailscale(peer) {
  if (peer.host) return /\.ts\.net$/i.test(peer.host.trim());
  const addr = (peer.address || '').trim();
  const v4 = addr.match(/^100\.(\d{1,3})\./);
  if (v4) {
    const second = Number(v4[1]);
    if (second >= 64 && second <= 127) return true;   // 100.64.0.0/10 CGNAT
  }
  if (/^fd7a:115c:a1e0:/i.test(addr)) return true;     // Tailscale IPv6 ULA
  return false;
}

// Decide whether to start probing now or defer until Tailscale connects.
// Probing a tailnet-only peer's MagicDNS hostname while Tailscale is down just
// spams DNS-failure + backoff logs (a laptop booted off-tailnet). So we defer
// ONLY when every enabled peer is tailnet-dependent; a LAN/IP-reachable peer is
// probed immediately (it doesn't need Tailscale). While deferred, a slow watcher
// starts polling automatically the moment Tailscale connects. `gen` is captured
// at startPolling time so a stopPolling() during either await aborts cleanly.
async function evaluatePollingGate(gen) {
  if (pollTimer || tailscaleWatchTimer) return;

  const data = await loadData();
  if (gen !== pollingGeneration) return;   // stopPolling() landed during loadData
  const enabledPeers = Array.isArray(data.peers) ? data.peers.filter(p => p.enabled) : [];

  // No peers, or at least one peer reachable without Tailscale → run the loop
  // now (silent no-op when there are no peers). Only an all-tailnet peer set
  // gets deferred, so solo installs and LAN peers are unaffected.
  const needsTailscale = enabledPeers.length > 0 && enabledPeers.every(peerRequiresTailscale);
  if (!needsTailscale) {
    beginPolling();
    return;
  }

  const status = await getTailscaleStatus();
  if (gen !== pollingGeneration) return;   // stopPolling() landed during status check
  if (status.running) {
    beginPolling();
    return;
  }

  console.log(`🌐 Peer sync deferred — Tailscale not connected (${status.state || status.reason}); polling starts automatically once it's up`);
  // Capture the handle locally so a stale in-flight callback can't clear/null a
  // watcher installed by a later startPolling() (identity guard below).
  const myTimer = setInterval(() => {
    getTailscaleStatus().then((s) => {
      if (!s.running || tailscaleWatchTimer !== myTimer) return;
      clearInterval(myTimer);
      tailscaleWatchTimer = null;
      console.log('🌐 Tailscale connected — starting peer sync polling');
      beginPolling();
    }).catch(() => {});
  }, TAILSCALE_RECHECK_MS);
  tailscaleWatchTimer = myTimer;
  // Don't let the recheck timer keep the process alive on its own.
  if (typeof myTimer.unref === 'function') myTimer.unref();
}

export function startPolling() {
  // pollingStartPending guards the async gap in evaluatePollingGate so two
  // synchronous startPolling() calls can't each spin up a schedule/watcher.
  if (pollTimer || tailscaleWatchTimer || pollingStartPending) return;
  pollingStartPending = true;
  const gen = pollingGeneration;
  evaluatePollingGate(gen)
    .catch(err => console.error(`❌ Failed to start peer polling: ${err.message}`))
    .finally(() => { pollingStartPending = false; });
}

export function stopPolling() {
  // Invalidate any in-flight startPolling gate / deferred watcher callback.
  pollingGeneration++;
  if (tailscaleWatchTimer) {
    clearInterval(tailscaleWatchTimer);
    tailscaleWatchTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('🌐 Instance polling stopped');
  }
}
