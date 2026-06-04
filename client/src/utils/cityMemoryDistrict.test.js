import { describe, it, expect } from 'vitest';
import {
  MEMORY_DISTRICT,
  categoryColor,
  categoryKey,
  groupByCategory,
  placeCluster,
  clusterHeight,
  computeBridges,
  computeMemoryDistrict,
} from './cityMemoryDistrict';

describe('categoryKey', () => {
  it('lowercases and trims a category', () => {
    expect(categoryKey({ category: '  Work ' })).toBe('work');
  });
  it('falls back to "other" for missing/blank categories', () => {
    expect(categoryKey({})).toBe('other');
    expect(categoryKey({ category: '   ' })).toBe('other');
    expect(categoryKey(null)).toBe('other');
  });
});

describe('categoryColor', () => {
  it('maps known categories to their token color', () => {
    expect(categoryColor('work')).toBe('#3b82f6');
    expect(categoryColor('Health')).toBe('#22c55e'); // case-insensitive
  });
  it('is deterministic for unknown categories', () => {
    expect(categoryColor('quokkas')).toBe(categoryColor('quokkas'));
  });
});

describe('groupByCategory', () => {
  it('counts nodes and sums importance per category', () => {
    const nodes = [
      { id: 'a', category: 'work', importance: 3 },
      { id: 'b', category: 'work', importance: 2 },
      { id: 'c', category: 'health', importance: 5 },
    ];
    const grouped = groupByCategory(nodes);
    expect(grouped[0]).toMatchObject({ category: 'work', count: 2, importance: 5 });
    expect(grouped[1]).toMatchObject({ category: 'health', count: 1, importance: 5 });
  });
  it('defaults importance to 1 when absent', () => {
    const grouped = groupByCategory([{ id: 'a', category: 'x' }, { id: 'b', category: 'x' }]);
    expect(grouped[0].importance).toBe(2);
  });
  it('sorts by count desc then category asc', () => {
    const nodes = [
      { id: '1', category: 'zeta' },
      { id: '2', category: 'alpha' },
      { id: '3', category: 'alpha' },
      { id: '4', category: 'beta' },
    ];
    expect(groupByCategory(nodes).map(g => g.category)).toEqual(['alpha', 'beta', 'zeta']);
  });
  it('handles non-array input', () => {
    expect(groupByCategory(undefined)).toEqual([]);
  });
});

describe('placeCluster', () => {
  it('is deterministic for the same category regardless of fan index span', () => {
    const a = placeCluster('work', 1, 4);
    const b = placeCluster('work', 1, 4);
    expect(a).toEqual(b);
  });
  it('places the cluster near the district ring radius from the base', () => {
    const base = MEMORY_DISTRICT.base;
    const [x, , z] = placeCluster('work', 0, 3);
    const r = Math.hypot(x - base[0], z - base[2]);
    expect(r).toBeCloseTo(MEMORY_DISTRICT.radius, 5);
  });
  it('gives different categories different positions', () => {
    expect(placeCluster('aaa', 0, 3)).not.toEqual(placeCluster('zzz', 1, 3));
  });
});

describe('clusterHeight', () => {
  it('clamps to the configured band', () => {
    expect(clusterHeight(0)).toBeGreaterThanOrEqual(MEMORY_DISTRICT.minCrystalHeight);
    expect(clusterHeight(1e9)).toBeLessThanOrEqual(MEMORY_DISTRICT.maxCrystalHeight);
  });
  it('grows monotonically with importance', () => {
    expect(clusterHeight(10)).toBeGreaterThan(clusterHeight(2));
  });
});

describe('computeBridges', () => {
  const nodes = [
    { id: 'a', category: 'work' },
    { id: 'b', category: 'health' },
    { id: 'c', category: 'work' },
  ];
  it('only bridges cross-category edges', () => {
    const edges = [
      { source: 'a', target: 'c', type: 'similar' }, // intra-category → skipped
      { source: 'a', target: 'b', type: 'similar' }, // cross → bridge
    ];
    const bridges = computeBridges(nodes, edges);
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toMatchObject({ from: 'health', to: 'work', count: 1 });
  });
  it('weights linked edges double vs similar', () => {
    const linked = computeBridges(nodes, [{ source: 'a', target: 'b', type: 'linked' }]);
    const similar = computeBridges(nodes, [{ source: 'a', target: 'b', type: 'similar' }]);
    expect(linked[0].weight).toBe(2 * similar[0].weight);
  });
  it('aggregates multiple edges between the same category pair', () => {
    const edges = [
      { source: 'a', target: 'b', type: 'similar' },
      { source: 'c', target: 'b', type: 'similar' },
    ];
    const bridges = computeBridges(nodes, edges);
    expect(bridges).toHaveLength(1);
    expect(bridges[0].count).toBe(2);
  });
  it('handles missing edges/nodes gracefully', () => {
    expect(computeBridges(undefined, undefined)).toEqual([]);
    expect(computeBridges(nodes, [{ source: 'a', target: 'missing' }])).toEqual([]);
  });
});

describe('computeMemoryDistrict', () => {
  it('marks empty when there are no nodes', () => {
    const d = computeMemoryDistrict({ nodes: [], edges: [] });
    expect(d.empty).toBe(true);
    expect(d.clusters).toEqual([]);
    expect(d.totalMemories).toBe(0);
  });
  it('handles undefined graph', () => {
    expect(computeMemoryDistrict(undefined).empty).toBe(true);
  });
  it('builds one cluster per category with positions and labels', () => {
    const graph = {
      nodes: [
        { id: 'a', category: 'work', importance: 3 },
        { id: 'b', category: 'health', importance: 1 },
      ],
      edges: [{ source: 'a', target: 'b', type: 'linked' }],
    };
    const d = computeMemoryDistrict(graph);
    expect(d.clusters).toHaveLength(2);
    expect(d.clusters.map(c => c.label)).toContain('WORK');
    expect(d.totalMemories).toBe(2);
    expect(d.bridges).toHaveLength(1);
    expect(d.bridges[0].fromPos).toBeDefined();
    expect(d.bridges[0].toPos).toBeDefined();
  });
  it('folds the long tail into a single overflow cluster', () => {
    const nodes = [];
    for (let i = 0; i < 12; i++) nodes.push({ id: `n${i}`, category: `cat${i}` });
    const d = computeMemoryDistrict({ nodes, edges: [] }, { maxClusters: 5 });
    expect(d.clusters).toHaveLength(5);
    const overflow = d.clusters.find(c => c.isOverflow);
    expect(overflow).toBeDefined();
    expect(overflow.label).toMatch(/MORE/);
  });
  it('drops bridges whose endpoint folded into overflow', () => {
    const nodes = [];
    for (let i = 0; i < 12; i++) nodes.push({ id: `n${i}`, category: `cat${i}` });
    // edge between two rare categories that both fold away
    const d = computeMemoryDistrict(
      { nodes, edges: [{ source: 'n10', target: 'n11', type: 'linked' }] },
      { maxClusters: 5 },
    );
    // n10/n11's categories aren't rendered as their own clusters → bridge dropped
    expect(d.bridges.every(b => b.fromPos && b.toPos)).toBe(true);
  });
});
