/**
 * The weighted split must stay an exact partition (a dropped or doubled file is
 * a silent coverage hole) and must actually flatten the measured imbalance.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WINDOWS_SERVER_HEAVY_FILES, shardWeightsFor, weightedShardSlice } from './shardWeights.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const weights = shardWeightsFor('server', 'win32');
const hashInput = (rel) => `/${rel}`;
const slices = (files, count, w = weights) => Array.from({ length: count }, (_, i) => weightedShardSlice(files, { index: i + 1, count, weights: w, hashInput }));

/** Mulberry32, so the generated file lists are the same on every run. */
const rng = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const syntheticSuite = (restCount) => [
  ...Object.keys(WINDOWS_SERVER_HEAVY_FILES),
  ...Array.from({ length: restCount }, (_, i) => `server/lib/generated${i}.test.js`),
];
const modeledLoad = (shard) => shard.reduce((sum, rel) => sum + (WINDOWS_SERVER_HEAVY_FILES[rel] ?? weights.rest), 0);

describe('weightedShardSlice', () => {
  it('is an exact partition for any file list, shard count and subset of heavy files', () => {
    const random = rng(7);
    const heavy = Object.keys(WINDOWS_SERVER_HEAVY_FILES);
    for (let round = 0; round < 60; round += 1) {
      const files = [
        ...heavy.filter(() => random() < 0.5),
        ...Array.from({ length: Math.floor(random() * 400) }, (_, i) => `server/lib/r${round}x${i}.test.js`),
      ];
      const count = 2 + Math.floor(random() * 3);
      const got = slices(files, count);
      expect(got.flat().sort(), `round ${round}`).toEqual([...files].sort());
    }
  });

  it('survives degenerate lists: empty, heavy-only, and fewer files than shards', () => {
    expect(slices([], 3).flat()).toEqual([]);
    const heavyOnly = Object.keys(WINDOWS_SERVER_HEAVY_FILES);
    expect(slices(heavyOnly, 3).flat().sort()).toEqual([...heavyOnly].sort());
    expect(slices(['server/lib/a.test.js'], 3).flat()).toEqual(['server/lib/a.test.js']);
  });

  it('gives every shard the same answer regardless of input order', () => {
    const files = syntheticSuite(200);
    const reversed = [...files].reverse();
    expect(slices(reversed, 3).map((s) => [...s].sort())).toEqual(slices(files, 3).map((s) => [...s].sort()));
  });

  it('flattens the measured Windows imbalance to a few percent', () => {
    // 3205 files of which 27 are listed; the unweighted measurement was a 35% overrun.
    const loads = slices(syntheticSuite(3178), 3).map(modeledLoad);
    const mean = loads.reduce((sum, n) => sum + n, 0) / loads.length;
    expect(Math.max(...loads) / mean).toBeLessThan(1.03);
    expect(Math.min(...loads) / mean).toBeGreaterThan(0.97);
  });

  it('keeps the heaviest files on different shards', () => {
    const [first, second, third] = ['heldCheckoutRecovery', 'branchReconcile.ownership', 'worktreeReap']
      .map((name) => slices(syntheticSuite(500), 3).findIndex((shard) => shard.some((rel) => rel.includes(name))));
    expect(new Set([first, second, third]).size).toBe(3);
  });
});

describe('shard weight table', () => {
  it('names only files that exist, so a rename cannot silently rot an entry', () => {
    const missing = Object.keys(WINDOWS_SERVER_HEAVY_FILES).filter((rel) => !existsSync(join(REPO_ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it('applies to the Windows server suite only', () => {
    expect(shardWeightsFor('server', 'win32')).not.toBeNull();
    expect(shardWeightsFor('server', 'linux')).toBeNull();
    expect(shardWeightsFor('client', 'win32')).toBeNull();
    expect(shardWeightsFor('db', 'win32')).toBeNull();
  });
});
