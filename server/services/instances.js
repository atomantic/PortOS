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
import { instanceEvents } from './instanceEvents.js';
import { connectToPeer, disconnectFromPeer } from './peerSocketRelay.js';
import { DEFAULT_PEER_PORT } from '../lib/ports.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { peerFetch } from '../lib/peerHttpClient.js';
import { getSelfHost } from '../lib/peerSelfHost.js';

const INSTANCES_FILE = dataPath('instances.json');
const PROBE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 30000;
const INITIAL_PROBE_DELAY_MS = 2000;

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

function classifyProbeError(err, peer) {
  const code = err?.code;
  if (code === 'ENOTFOUND') return `🌐 ❌ DNS lookup failed for ${peer.host || peer.address} — is Tailscale MagicDNS up?`;
  if (code === 'ECONNREFUSED') return `🌐 ❌ Connection refused — peer not running on this port`;
  if (code === 'EHOSTUNREACH') return `🌐 ❌ Host unreachable — Tailscale tunnel down or peer offline`;
  // Native fetch raises AbortError when the AbortSignal fires; insecureFetch
  // (used for HTTPS peer hops via peerFetch) destroys the request with a
  // plain `new Error('Request aborted')` instead — both are timeouts here.
  if (code === 'ETIMEDOUT' || err?.name === 'AbortError' || err?.message === 'Request aborted') return `🌐 ⏱️ Probe timeout (${PROBE_TIMEOUT_MS}ms)`;
  return err?.message || String(err);
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
    return id ?? 'unknown';
  }
  return cachedInstanceId;
}

export async function updateSelf(name) {
  return withData(async (data) => {
    if (!data.self) return null;
    data.self.name = name;
    console.log(`🌐 Instance name updated: ${name}`);
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
  meatspace: false
};

export { DEFAULT_SYNC_CATEGORIES };

export async function addPeer({ address, port = DEFAULT_PEER_PORT, name, host }) {
  const peer = await withData(async (data) => {
    const normalizedHost = validHost(host);
    const entry = {
      id: crypto.randomUUID(),
      address,
      host: normalizedHost || null,
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
      syncEnabled: false,
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
  const result = await withData(async (data) => {
    const peer = data.peers.find(p => p.id === id);
    if (!peer) return null;
    if (updates.name !== undefined) peer.name = validName(updates.name, peer.name);
    if (updates.enabled !== undefined) peer.enabled = updates.enabled;
    if (updates.syncEnabled !== undefined) peer.syncEnabled = updates.syncEnabled;
    if (updates.syncCategories !== undefined) {
      peer.syncCategories = { ...(peer.syncCategories || DEFAULT_SYNC_CATEGORIES), ...updates.syncCategories };
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
    instanceEvents.emit('peers:updated', data.peers);
    return peer;
  });
  // Tear down the socket relay only after a real state transition so it can
  // reconnect using the new URL on the next probe cycle. Invalid/no-op host
  // writes no longer disrupt an already-healthy connection.
  if (updates.enabled === false || hostChanged) disconnectFromPeer(id);
  return result;
}

// --- Probing ---

export async function probePeer(peer) {
  const baseUrl = peerBaseUrl(peer);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  const previousStatus = peer.status;
  let status, lastHealth, lastSeen, remoteInstanceId, remoteVersion, remoteApps, remoteSyncSeqs;
  try {
    // Fetch health details, apps, and sync status in parallel
    const [healthRes, appsRes, syncRes] = await Promise.all([
      peerFetch(`${baseUrl}/api/system/health/details`, { signal: controller.signal }),
      peerFetch(`${baseUrl}/api/apps`, { signal: controller.signal }).catch(() => null),
      peerFetch(`${baseUrl}/api/instances/sync-status`, { signal: controller.signal }).catch(() => null)
    ]);
    if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
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
  } catch (err) {
    console.log(`⚠️ Probe failed for ${baseUrl}: ${classifyProbeError(err, peer)}`);
    status = 'offline';
    lastHealth = peer.lastHealth; // preserve last known
    lastSeen = peer.lastSeen;
  } finally {
    clearTimeout(timeout);
  }

  const stored = await withData(async (data) => {
    const entry = data.peers.find(p => p.id === peer.id);
    if (!entry) return null;
    entry.status = status;
    entry.lastSeen = lastSeen;
    entry.lastHealth = lastHealth;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await peerFetch(url, { signal: controller.signal });
    const json = await res.json();
    return { success: true, data: json };
  } catch (err) {
    return { error: `Failed to query peer: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await peerFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: selfPort,
        instanceId: data.self.instanceId,
        name: data.self.name,
        host: selfHost
      }),
      signal: controller.signal
    });
    if (res.ok) {
      console.log(`🌐 Announced self to ${url}`);
      await markDirection(peer.id, 'outbound');
    } else {
      console.log(`🌐 Announce to ${url} failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`🌐 Announce to ${url} unreachable: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
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

export function startPolling() {
  if (pollTimer) return;
  console.log(`🌐 Instance polling started (${POLL_INTERVAL_MS / 1000}s interval)`);

  // Backoff is a rate limit on the polling loop, not a durable judgment about
  // the peer — boot may itself be the deploy that fixes connectivity, so clear it.
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

  // Initial probe after a short delay
  setTimeout(() => probeAllPeers(), INITIAL_PROBE_DELAY_MS);

  pollTimer = setInterval(() => probeAllPeers(), POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('🌐 Instance polling stopped');
  }
}
