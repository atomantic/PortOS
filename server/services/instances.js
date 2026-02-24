/**
 * Instances Service
 *
 * Manages PortOS federation — self identity, peer registration, health probing, and query proxying.
 * Data persists to data/instances.json.
 */

import { writeFile } from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import { dataPath, readJSONFile, ensureDir, PATHS } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { instanceEvents } from './instanceEvents.js';

const INSTANCES_FILE = dataPath('instances.json');
const PROBE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 30000;

const withLock = createMutex();
let pollTimer = null;

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
  const tmp = `${INSTANCES_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  const { rename } = await import('fs/promises');
  await rename(tmp, INSTANCES_FILE);
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

export async function addPeer({ address, port = 5554, name }) {
  return withData(async (data) => {
    const peer = {
      id: crypto.randomUUID(),
      address,
      port,
      name: name || address,
      addedAt: new Date().toISOString(),
      lastSeen: null,
      lastHealth: null,
      status: 'unknown',
      enabled: true
    };
    data.peers.push(peer);
    console.log(`🌐 Peer added: ${peer.name} (${peer.address}:${peer.port})`);
    instanceEvents.emit('peers:updated', data.peers);
    return peer;
  });
}

export async function removePeer(id) {
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
  return withData(async (data) => {
    const peer = data.peers.find(p => p.id === id);
    if (!peer) return null;
    if (updates.name !== undefined) peer.name = updates.name;
    if (updates.enabled !== undefined) peer.enabled = updates.enabled;
    instanceEvents.emit('peers:updated', data.peers);
    return peer;
  });
}

// --- Probing ---

export async function probePeer(peer) {
  const url = `http://${peer.address}:${peer.port}/api/health/system`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let status, lastHealth, lastSeen;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    status = 'online';
    lastHealth = json;
    lastSeen = new Date().toISOString();
  } catch {
    status = 'offline';
    lastHealth = peer.lastHealth; // preserve last known
    lastSeen = peer.lastSeen;
  } finally {
    clearTimeout(timeout);
  }

  return withData(async (data) => {
    const stored = data.peers.find(p => p.id === peer.id);
    if (!stored) return null;
    stored.status = status;
    stored.lastSeen = lastSeen;
    stored.lastHealth = lastHealth;
    return stored;
  });
}

export async function probeAllPeers() {
  const data = await loadData();
  const enabled = data.peers.filter(p => p.enabled);
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

  const url = `http://${peer.address}:${peer.port}${apiPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const json = await res.json();
    return { success: true, data: json };
  } catch (err) {
    return { error: `Failed to query peer: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Polling ---

export function startPolling() {
  if (pollTimer) return;
  console.log(`🌐 Instance polling started (${POLL_INTERVAL_MS / 1000}s interval)`);

  // Initial probe after a short delay
  setTimeout(() => probeAllPeers(), 2000);

  pollTimer = setInterval(() => probeAllPeers(), POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('🌐 Instance polling stopped');
  }
}
