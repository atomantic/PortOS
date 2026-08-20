import { describe, it, expect } from 'vitest';
import {
  CYBER_SHARDS,
  TOTAL_SHARDS,
  getCollectiblesList,
  checkShardCollection,
  getCollectionStats,
  SHARD_COLLECTION_RADIUS,
} from './openWorldCollectibles';

describe('openWorldCollectibles', () => {
  it('defines a non-empty array of valid collectible shards with unique ids', () => {
    expect(CYBER_SHARDS.length).toBeGreaterThanOrEqual(10);
    expect(TOTAL_SHARDS).toBe(CYBER_SHARDS.length);

    const ids = new Set();
    CYBER_SHARDS.forEach((shard) => {
      expect(typeof shard.id).toBe('string');
      expect(typeof shard.label).toBe('string');
      expect(typeof shard.x).toBe('number');
      expect(typeof shard.y).toBe('number');
      expect(typeof shard.z).toBe('number');
      expect(typeof shard.color).toBe('string');
      expect(typeof shard.value).toBe('number');
      expect(ids.has(shard.id)).toBe(false);
      ids.add(shard.id);
    });
  });

  it('getCollectiblesList returns copies with pulse phases', () => {
    const list = getCollectiblesList();
    expect(list.length).toBe(CYBER_SHARDS.length);
    list.forEach((s) => {
      expect(s.pulsePhase).toBeGreaterThanOrEqual(0);
      expect(s.pulsePhase).toBeLessThanOrEqual(1);
    });
  });

  it('checkShardCollection detects uncollected shards within radius', () => {
    const shard = CYBER_SHARDS[0];
    const playerPos = { x: shard.x + 0.5, z: shard.z + 0.5 };
    const collectedSet = new Set();

    const result = checkShardCollection(playerPos, CYBER_SHARDS, collectedSet, SHARD_COLLECTION_RADIUS);
    expect(result.some((s) => s.id === shard.id)).toBe(true);

    // If already in collectedSet, does not return again
    collectedSet.add(shard.id);
    const resultAfter = checkShardCollection(playerPos, CYBER_SHARDS, collectedSet, SHARD_COLLECTION_RADIUS);
    expect(resultAfter.some((s) => s.id === shard.id)).toBe(false);
  });

  it('checkShardCollection ignores far player positions or invalid inputs', () => {
    expect(checkShardCollection(null)).toEqual([]);
    expect(checkShardCollection({ x: 'invalid', z: 0 })).toEqual([]);
    expect(checkShardCollection({ x: 9999, z: 9999 }, CYBER_SHARDS, new Set())).toEqual([]);
  });

  it('getCollectionStats calculates accurate percentages and completion flags', () => {
    const emptyStats = getCollectionStats(new Set(), 10);
    expect(emptyStats).toEqual({
      collectedCount: 0,
      totalCount: 10,
      percentage: 0,
      allCollected: false,
    });

    const halfSet = new Set(['s1', 's2', 's3', 's4', 's5']);
    const halfStats = getCollectionStats(halfSet, 10);
    expect(halfStats).toEqual({
      collectedCount: 5,
      totalCount: 10,
      percentage: 50,
      allCollected: false,
    });

    const fullSet = new Set(['s1', 's2', 's3', 's4']);
    const fullStats = getCollectionStats(fullSet, 4);
    expect(fullStats).toEqual({
      collectedCount: 4,
      totalCount: 4,
      percentage: 100,
      allCollected: true,
    });
  });
});
