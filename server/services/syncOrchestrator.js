/**
 * Sync Orchestrator
 *
 * Unified coordinator for brain + memory sync between PortOS peer instances.
 * Maintains per-peer cursors and triggers sync on peer connect + interval.
 */

import { writeFile, rename } from 'fs/promises';
import { readJSONFile, ensureDir, PATHS, dataPath } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { instanceEvents } from './instanceEvents.js';
import { getPeers } from './instances.js';
import * as brainSync from './brainSync.js';
import * as brainSyncLog from './brainSyncLog.js';
import * as memorySync from './memorySync.js';

const CURSORS_FILE = dataPath('instances_sync_cursors.json');
const SYNC_INTERVAL_MS = 60000;
const FETCH_TIMEOUT_MS = 15000;

const withLock = createMutex();
let syncTimer = null;
let peerOnlineHandler = null;
const syncingPeers = new Set();

// --- Cursor persistence ---

async function loadCursors() {
  return await readJSONFile(CURSORS_FILE, {});
}

async function saveCursors(cursors) {
  await ensureDir(PATHS.data);
  const tmp = `${CURSORS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cursors, null, 2));
  await rename(tmp, CURSORS_FILE);
}

async function withCursors(fn) {
  return withLock(async () => {
    const cursors = await loadCursors();
    const result = await fn(cursors);
    await saveCursors(cursors);
    return result;
  });
}

// --- Peer fetch helper ---

async function fetchPeer(peer, path) {
  const url = `http://${peer.address}:${peer.port}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Status ---

/**
 * Get sync status: local sequences + per-peer cursors
 */
export async function getSyncStatus() {
  const [brainSeq, memorySeq, cursors] = await Promise.all([
    Promise.resolve(brainSyncLog.getCurrentSeq()),
    memorySync.getMaxSequence(),
    loadCursors()
  ]);
  return {
    local: { brainSeq, memorySeq },
    cursors
  };
}

// --- Sync logic ---

/**
 * Sync brain data from a peer (pull all changes since cursor)
 */
async function syncBrainFromPeer(peer, cursor) {
  let brainSeq = cursor.brainSeq ?? 0;
  let totalApplied = 0;

  // Loop to consume all batches
  let hasMore = true;
  while (hasMore) {
    const data = await fetchPeer(peer, `/api/brain/sync?since=${brainSeq}&limit=100`);
    if (!data?.changes?.length) break;

    const result = await brainSync.applyRemoteChanges(data.changes);
    totalApplied += result.inserted + result.updated + result.deleted;
    brainSeq = data.maxSeq;
    hasMore = data.hasMore;
  }

  return { brainSeq, totalApplied };
}

/**
 * Sync CoS memories from a peer (pull all changes since cursor)
 */
async function syncMemoryFromPeer(peer, cursor) {
  let memorySeq = cursor.memorySeq ?? '0';
  let totalApplied = 0;

  let hasMore = true;
  while (hasMore) {
    const data = await fetchPeer(peer, `/api/memory/sync?since=${memorySeq}&limit=100`);
    if (!data?.memories?.length) break;

    const result = await memorySync.applyRemoteChanges(data.memories);
    totalApplied += result.inserted + result.updated;
    memorySeq = data.maxSequence;
    hasMore = data.hasMore;
  }

  return { memorySeq, totalApplied };
}

/**
 * Sync all data from a single peer
 */
export async function syncWithPeer(peer) {
  if (!peer.instanceId) return { brain: { totalApplied: 0 }, memory: { totalApplied: 0 } };

  const peerId = peer.instanceId;

  // Prevent concurrent syncs for the same peer
  if (syncingPeers.has(peerId)) return { brain: { totalApplied: 0 }, memory: { totalApplied: 0 } };
  syncingPeers.add(peerId);

  // Read cursor snapshot outside lock so network I/O doesn't block other peers
  const cursor = await withCursors(async (cursors) => {
    if (!cursors[peerId]) cursors[peerId] = {};
    return { ...cursors[peerId] };
  });

  try {
    const brainResult = await syncBrainFromPeer(peer, cursor);

    // Save brain cursor immediately so progress is preserved if memory sync fails
    await withCursors(async (cursors) => {
      if (!cursors[peerId]) cursors[peerId] = {};
      cursors[peerId].brainSeq = brainResult.brainSeq;
      cursors[peerId].lastSyncAt = new Date().toISOString();
    });

    const memoryResult = await syncMemoryFromPeer(peer, cursor);

    await withCursors(async (cursors) => {
      if (!cursors[peerId]) cursors[peerId] = {};
      cursors[peerId].memorySeq = memoryResult.memorySeq;
      cursors[peerId].lastSyncAt = new Date().toISOString();
    });

    const total = brainResult.totalApplied + memoryResult.totalApplied;
    if (total > 0) {
      console.log(`🔄 Synced with ${peer.name}: ${brainResult.totalApplied} brain, ${memoryResult.totalApplied} memory changes`);
    }

    return { brain: brainResult, memory: memoryResult };
  } finally {
    syncingPeers.delete(peerId);
  }
}

/**
 * Sync with all online peers
 */
export async function syncAllPeers() {
  const peers = await getPeers();
  const online = peers.filter(p => p.enabled && p.status === 'online' && p.instanceId);

  await Promise.allSettled(online.map(p => syncWithPeer(p)));

  // Compact sync log below the minimum peer cursor to bound log growth
  // Include all enabled peers (not just online) so offline peers don't lose unsynced entries
  const cursors = await loadCursors();
  const allEnabledIds = new Set(peers.filter(p => p.enabled && p.instanceId).map(p => p.instanceId));
  const seqs = Object.entries(cursors)
    .filter(([id]) => allEnabledIds.has(id))
    .map(([, c]) => c.brainSeq ?? 0);
  if (seqs.length > 0) {
    const minSeq = Math.min(...seqs);
    await brainSyncLog.compactLog(minSeq);
  }
}

/**
 * Initialize the sync orchestrator
 */
export function initSyncOrchestrator() {
  // Sync immediately when a peer comes online
  peerOnlineHandler = (peer) => {
    syncWithPeer(peer).catch(err => {
      console.error(`❌ Sync with ${peer.name} failed: ${err.message}`);
    });
  };
  instanceEvents.on('peer:online', peerOnlineHandler);

  // Background safety-net interval
  syncTimer = setInterval(() => {
    syncAllPeers().catch(err => {
      console.error(`❌ Periodic sync failed: ${err.message}`);
    });
  }, SYNC_INTERVAL_MS);

  console.log(`🔄 Sync orchestrator started (${SYNC_INTERVAL_MS / 1000}s interval)`);
}

/**
 * Stop the sync orchestrator
 */
export function stopSyncOrchestrator() {
  if (peerOnlineHandler) {
    instanceEvents.removeListener('peer:online', peerOnlineHandler);
    peerOnlineHandler = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  console.log('🔄 Sync orchestrator stopped');
}
