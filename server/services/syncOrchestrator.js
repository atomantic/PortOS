/**
 * Sync Orchestrator
 *
 * Unified coordinator for all data sync between PortOS peer instances.
 * Supports per-category sync: brain, memory, goals, character, digitalTwin, meatspace.
 * Maintains per-peer cursors and triggers sync on peer connect + interval.
 */

import { writeFile, rename } from 'fs/promises';
import { readJSONFile, ensureDir, PATHS, dataPath } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { instanceEvents } from './instanceEvents.js';
import { getPeers, DEFAULT_SYNC_CATEGORIES } from './instances.js';
import * as brainSync from './brainSync.js';
import * as brainSyncLog from './brainSyncLog.js';
import * as memorySync from './memorySync.js';
import * as dataSync from './dataSync.js';
import { getBackendName } from './memoryBackend.js';

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

async function readCursors(fn) {
  return withLock(async () => {
    const cursors = await loadCursors();
    return fn(cursors);
  });
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
 * Get sync status: local sequences + per-peer cursors + optional local checksums
 */
export async function getSyncStatus({ includeChecksums = false } = {}) {
  const isPostgres = getBackendName() === 'postgres';
  const snapshotCategories = includeChecksums ? dataSync.getSupportedCategories() : [];
  const [brainSeq, memorySeq, cursors, ...checksumResults] = await Promise.all([
    Promise.resolve(brainSyncLog.getCurrentSeq()),
    isPostgres ? memorySync.getMaxSequence() : Promise.resolve(null),
    loadCursors(),
    ...snapshotCategories.map(cat => dataSync.getChecksum(cat).catch(() => null))
  ]);
  const local = { brainSeq, memorySeq };
  if (includeChecksums) {
    local.checksums = {};
    for (let i = 0; i < snapshotCategories.length; i++) {
      local.checksums[snapshotCategories[i]] = checksumResults[i]?.checksum ?? null;
    }
  }
  return { local, cursors };
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
 * Safely parse a value to BigInt for BIGSERIAL comparison.
 * Returns 0n for invalid/empty/negative inputs.
 */
function safeBigInt(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : 0n;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? BigInt(Math.trunc(value)) : 0n;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    return parsed;
  }
  return 0n;
}

/**
 * Detect and reset stale cursors when peer's sequence has been reset
 * (e.g. database rebuild). Returns corrected cursor.
 *
 * Uses cached remoteSyncSeqs from periodic peer probing. If null (probe hasn't
 * run yet or failed), we skip detection — a real reset will be caught on the
 * next probe cycle. Stale probe data may trigger a conservative full re-sync
 * (cursor reset to 0), which is safe since sync is idempotent (LWW dedup).
 */
function detectCursorReset(cursor, peer) {
  const corrected = { ...cursor };
  const remote = peer.remoteSyncSeqs;
  if (!remote) return corrected;

  // Brain: integer comparison
  // Only check when peer reports a finite non-negative brainSeq (older peers may omit it)
  const remoteBrainRaw = remote.brainSeq;
  const hasNumericRemoteBrain = typeof remoteBrainRaw === 'number' &&
    Number.isFinite(remoteBrainRaw) &&
    remoteBrainRaw >= 0;
  if (hasNumericRemoteBrain) {
    const cursorBrain = corrected.brainSeq ?? 0;
    if (cursorBrain > 0 && cursorBrain > remoteBrainRaw) {
      console.log(`🔄 Brain cursor reset for ${peer.name}: cursor ${cursorBrain} > peer max ${remoteBrainRaw}`);
      corrected.brainSeq = 0;
    }
  }

  // Memory: BigInt comparison (BIGSERIAL can exceed Number.MAX_SAFE_INTEGER)
  // Only check when peer reports a numeric memorySeq (null means non-Postgres peer)
  const remoteMemRaw = remote.memorySeq;
  const hasNumericRemoteMem = remoteMemRaw != null && (
    typeof remoteMemRaw === 'bigint' ||
    (typeof remoteMemRaw === 'number' && Number.isFinite(remoteMemRaw) && remoteMemRaw >= 0) ||
    (typeof remoteMemRaw === 'string' && /^\d+$/.test(remoteMemRaw.trim()))
  );
  if (hasNumericRemoteMem) {
    const cursorMemStr = corrected.memorySeq ?? '0';
    const cursorMem = safeBigInt(cursorMemStr);
    const peerMem = safeBigInt(remoteMemRaw);
    if (cursorMem > 0n && cursorMem > peerMem) {
      console.log(`🔄 Memory cursor reset for ${peer.name}: cursor ${cursorMemStr} > peer max ${String(remoteMemRaw)}`);
      corrected.memorySeq = '0';
    }
  }

  return corrected;
}

/**
 * Resolve effective sync categories for a peer.
 * Returns object with boolean flags for each category.
 * Falls back to legacy behavior: if syncCategories is absent but syncEnabled is true,
 * enable brain + memory for backward compatibility with older peers.
 */
function getEffectiveCategories(peer) {
  if (peer.syncCategories) return peer.syncCategories;
  // Legacy fallback: peers without syncCategories but with syncEnabled get brain+memory
  if (peer.syncEnabled !== false) {
    return { ...DEFAULT_SYNC_CATEGORIES, brain: true, memory: true };
  }
  return { ...DEFAULT_SYNC_CATEGORIES };
}

/**
 * Sync a snapshot-based data category from a peer.
 * Fetches checksum first to avoid full data transfer when unchanged.
 */
async function syncDataCategoryFromPeer(peer, peerId, category, cachedChecksums) {
  // Lightweight checksum check first
  const checksumRes = await fetchPeer(peer, `/api/sync/${category}/checksum`);
  if (!checksumRes?.checksum) return { totalApplied: 0, checksum: null };

  const lastChecksum = cachedChecksums?.[category] ?? null;
  if (lastChecksum && lastChecksum === checksumRes.checksum) {
    return { totalApplied: 0, checksum: checksumRes.checksum };
  }

  // Checksum changed — fetch full snapshot
  const snapshot = await fetchPeer(peer, `/api/sync/${category}/snapshot`);
  if (!snapshot?.data) return { totalApplied: 0, checksum: null };

  const result = await dataSync.applyRemote(category, snapshot.data);
  return { totalApplied: result.applied ? result.count : 0, checksum: snapshot.checksum };
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

  const categories = getEffectiveCategories(peer);

  // Read cursor snapshot outside lock so network I/O doesn't block other peers
  // Also detect and reset stale cursors (e.g. peer DB was rebuilt)
  const cursor = await readCursors((cursors) => {
    const raw = { ...(cursors[peerId] || {}) };
    return detectCursorReset(raw, peer);
  });

  try {
    // --- Brain sync (delta-based) ---
    let brainResult = { brainSeq: cursor.brainSeq ?? 0, totalApplied: 0 };
    if (categories.brain) {
      brainResult = await syncBrainFromPeer(peer, cursor);
    }

    // --- Memory sync (delta-based, PostgreSQL only) ---
    let memoryResult = { memorySeq: cursor.memorySeq ?? '0', totalApplied: 0 };
    if (categories.memory) {
      const isPostgres = getBackendName() === 'postgres';
      if (isPostgres) {
        memoryResult = await syncMemoryFromPeer(peer, cursor);
      }
    }

    // --- Snapshot-based category syncs (parallel) ---
    const dataCategoryResults = {};
    const enabledDataCats = dataSync.getSupportedCategories().filter(cat => categories[cat]);
    const cachedChecksums = cursor.checksums || {};

    if (enabledDataCats.length > 0) {
      const settled = await Promise.allSettled(
        enabledDataCats.map(cat =>
          syncDataCategoryFromPeer(peer, peerId, cat, cachedChecksums)
            .catch(err => {
              console.error(`⚠️ ${cat} sync with ${peer.name} failed: ${err.message}`);
              return { totalApplied: 0, checksum: null };
            })
        )
      );
      for (let i = 0; i < enabledDataCats.length; i++) {
        const result = settled[i].status === 'fulfilled' ? settled[i].value : { totalApplied: 0, checksum: null };
        dataCategoryResults[enabledDataCats[i]] = result;
      }
    }

    // --- Single consolidated cursor write ---
    await withCursors(async (cursors) => {
      if (!cursors[peerId]) cursors[peerId] = {};
      if (categories.brain) cursors[peerId].brainSeq = brainResult.brainSeq;
      if (memoryResult.memorySeq !== (cursor.memorySeq ?? '0')) cursors[peerId].memorySeq = memoryResult.memorySeq;
      if (!cursors[peerId].checksums) cursors[peerId].checksums = {};
      for (const [cat, result] of Object.entries(dataCategoryResults)) {
        if (result.checksum) cursors[peerId].checksums[cat] = result.checksum;
      }
      cursors[peerId].lastSyncAt = new Date().toISOString();
    });

    // Log summary
    const parts = [];
    if (brainResult.totalApplied > 0) parts.push(`${brainResult.totalApplied} brain`);
    if (memoryResult.totalApplied > 0) parts.push(`${memoryResult.totalApplied} memory`);
    for (const [cat, result] of Object.entries(dataCategoryResults)) {
      if (result.totalApplied > 0) parts.push(`${result.totalApplied} ${cat}`);
    }
    if (parts.length > 0) {
      console.log(`🔄 Synced with ${peer.name}: ${parts.join(', ')} changes`);
    }

    return { brain: brainResult, memory: memoryResult, ...dataCategoryResults };
  } finally {
    syncingPeers.delete(peerId);
  }
}

/**
 * Check if a peer has any sync category enabled
 */
function hasAnySyncEnabled(peer) {
  if (peer.syncEnabled === false) return false;
  const cats = getEffectiveCategories(peer);
  return Object.values(cats).some(Boolean);
}

/**
 * Sync with all online peers
 */
export async function syncAllPeers() {
  const peers = await getPeers();
  const online = peers.filter(p => p.enabled && hasAnySyncEnabled(p) && p.status === 'online' && p.instanceId);

  await Promise.allSettled(online.map(p => syncWithPeer(p)));

  // Compact sync log below the minimum peer cursor to bound log growth
  // Include all enabled peers with brain sync (not just online) so offline peers don't lose unsynced entries
  const cursors = await loadCursors();
  const brainEnabledIds = new Set(
    peers
      .filter(p => p.enabled && p.instanceId && getEffectiveCategories(p).brain)
      .map(p => p.instanceId)
  );
  const seqs = Object.entries(cursors)
    .filter(([id]) => brainEnabledIds.has(id))
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
    if (!hasAnySyncEnabled(peer)) return;
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
