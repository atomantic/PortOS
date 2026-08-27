// Pure deterministic helpers for OpenWorld's collectible Cyber Shards system.
// Shards are floating, glowing crystal pickups scattered along roads, plazas, and
// landmarks. Driving or walking over a shard collects it with particle + audio feedback,
// increments the session score, and unlocks discovery recognition.
// No three.js / React imports — pure, testable in node.

import { WORLD } from './openWorldPlan';

export const SHARD_COLLECTION_RADIUS = 2.4;
export const DEFAULT_SHARD_Y = 1.0;

// Curated deterministic list of collectible Cyber Shards across all major quarters.
export const CYBER_SHARDS = [
  // Plaza & Central Spine
  { id: 'shard-plaza-n', label: 'Plaza Zenith', x: 0, y: DEFAULT_SHARD_Y, z: -12, color: '#06b6d4', value: 10 },
  { id: 'shard-plaza-s', label: 'Plaza Gateway', x: 0, y: DEFAULT_SHARD_Y, z: 14, color: '#06b6d4', value: 10 },
  { id: 'shard-plaza-e', label: 'Plaza East Wing', x: 13, y: DEFAULT_SHARD_Y, z: 0, color: '#06b6d4', value: 10 },
  { id: 'shard-plaza-w', label: 'Plaza West Wing', x: -13, y: DEFAULT_SHARD_Y, z: 0, color: '#06b6d4', value: 10 },

  // Harbor Avenue (Northbound)
  { id: 'shard-avenue-mid', label: 'Avenue Walk', x: 0, y: DEFAULT_SHARD_Y, z: -28, color: '#38bdf8', value: 15 },
  { id: 'shard-avenue-shore', label: 'Shoreline Overlook', x: 0, y: DEFAULT_SHARD_Y, z: WORLD.shorelineZ + 2, color: '#38bdf8', value: 15 },
  { id: 'shard-harbor-pier', label: 'Harbor Pier Head', x: 0, y: DEFAULT_SHARD_Y, z: -68, color: '#0ea5e9', value: 25 },

  // Western Districts (Memory, Backup, Jira, Productivity)
  { id: 'shard-memory-steps', label: 'Memory Crystal Shard', x: -38, y: DEFAULT_SHARD_Y, z: -24, color: '#a855f7', value: 20 },
  { id: 'shard-backup-vault', label: 'Vault Crypt Cache', x: -30, y: DEFAULT_SHARD_Y, z: -8, color: '#f59e0b', value: 20 },
  { id: 'shard-jira-yard', label: 'Sprint Yard Crate', x: -16, y: DEFAULT_SHARD_Y, z: -38, color: '#ec4899', value: 20, feature: 'jira' },
  { id: 'shard-productivity', label: 'Focus Terrace Spark', x: -44, y: DEFAULT_SHARD_Y, z: 24, color: '#22c55e', value: 20 },
  { id: 'shard-quiet-corner', label: 'Secret Shard', x: -44, y: DEFAULT_SHARD_Y, z: 38, color: '#e879f9', value: 30 },

  // Eastern Districts (Task Queue, Health, Goals, Artifacts)
  { id: 'shard-task-queue', label: 'Queue Stream Shard', x: 30, y: DEFAULT_SHARD_Y, z: -8, color: '#f97316', value: 20 },
  { id: 'shard-health-tower', label: 'Wellness Pulse', x: 44, y: DEFAULT_SHARD_Y, z: 24, color: '#10b981', value: 20 },
  { id: 'shard-goal-monuments', label: 'Goal Milestone Shard', x: 26, y: DEFAULT_SHARD_Y, z: -36, color: '#eab308', value: 25 },
  { id: 'shard-artifacts-hall', label: 'Hall of Trophies Shard', x: 40, y: DEFAULT_SHARD_Y, z: -24, color: '#facc15', value: 25 },

  // Downtown Ring Road Corners
  { id: 'shard-ring-ne', label: 'Boulevard North-East', x: 21, y: DEFAULT_SHARD_Y, z: -21, color: '#06b6d4', value: 15 },
  { id: 'shard-ring-sw', label: 'Boulevard South-West', x: -21, y: DEFAULT_SHARD_Y, z: 21, color: '#06b6d4', value: 15 },
];

export const TOTAL_SHARDS = CYBER_SHARDS.length;

export const isCollectibleVisible = (shard, isFeatureEnabled) => (
  !shard?.feature
  || typeof isFeatureEnabled !== 'function'
  || isFeatureEnabled(shard.feature)
);

// Return all shards with placement metadata and individual animation phase offsets.
export function getCollectiblesList(isFeatureEnabled) {
  return CYBER_SHARDS
    .filter((shard) => isCollectibleVisible(shard, isFeatureEnabled))
    .map((shard, index) => ({
      ...shard,
      pulsePhase: (index * 0.13) % 1,
    }));
}

// Check which uncollected shards are within range of the player position.
// Returns array of newly collected shard objects.
export function checkShardCollection(playerPos, shards = CYBER_SHARDS, collectedSet = new Set(), radius = SHARD_COLLECTION_RADIUS) {
  if (!playerPos || typeof playerPos.x !== 'number' || typeof playerPos.z !== 'number') {
    return [];
  }
  const rSq = radius * radius;
  const newlyCollected = [];

  for (const shard of shards) {
    if (!shard || collectedSet.has(shard.id)) continue;
    const dx = playerPos.x - shard.x;
    const dz = playerPos.z - shard.z;
    const distSq = dx * dx + dz * dz;
    if (distSq <= rSq) {
      newlyCollected.push(shard);
    }
  }

  return newlyCollected;
}

// Compute progress summary from collected set
export function getCollectionStats(collectedSet = new Set(), totalCount = TOTAL_SHARDS) {
  const count = collectedSet instanceof Set ? collectedSet.size : Array.isArray(collectedSet) ? collectedSet.length : 0;
  const clampedCount = Math.min(totalCount, Math.max(0, count));
  const percentage = totalCount > 0 ? Math.round((clampedCount / totalCount) * 100) : 0;
  return {
    collectedCount: clampedCount,
    totalCount,
    percentage,
    allCollected: clampedCount >= totalCount && totalCount > 0,
  };
}

// Session storage persistence helpers
const STORAGE_KEY = 'openworld.shards';

export function loadCollectedShardIds() {
  try {
    if (typeof sessionStorage === 'undefined') return new Set();
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

export function saveCollectedShardIds(set) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const list = Array.from(set || []);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Swallow storage exceptions safely
  }
}
