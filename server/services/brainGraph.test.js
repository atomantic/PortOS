import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./brainStorage.js', () => ({
  getAll: vi.fn()
}));

vi.mock('./memoryBackend.js', () => ({
  getGraphData: vi.fn()
}));

vi.mock('./brainMemoryBridge.js', () => ({
  loadBridgeMap: vi.fn(),
  bridgeKey: (type, id) => `${type}:${id}`
}));

vi.mock('./identity.js', () => ({
  getGoals: vi.fn()
}));

import * as brainStorage from './brainStorage.js';
import * as memoryBackend from './memoryBackend.js';
import { loadBridgeMap } from './brainMemoryBridge.js';
import { getGoals } from './identity.js';
import {
  getBrainGraphSearchIndex,
  getBrainGraphOverview,
  getBrainGraphNeighborhood
} from './brainGraph.js';

beforeEach(() => {
  vi.clearAllMocks();
  loadBridgeMap.mockResolvedValue({});
  memoryBackend.getGraphData.mockResolvedValue(null);
  brainStorage.getAll.mockResolvedValue([]);
  getGoals.mockResolvedValue({ goals: [] });
});

// A small node set fits entirely inside one overview page, so getBrainGraphOverview
// with a generous limit exercises the same edge-derivation the full graph used to.
const onlyType = (wanted, records) =>
  brainStorage.getAll.mockImplementation(async (type) => (type === wanted ? records : []));

describe('getBrainGraphSearchIndex', () => {
  it('returns every node as {id,label,brainType} with no edges or tags', async () => {
    onlyType('memories', [
      { id: 'a', name: 'Alice', tags: ['x'], archived: false },
      { id: 'b', title: 'Bob', tags: [] }
    ]);
    const { nodes } = await getBrainGraphSearchIndex();
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual({ id: 'a', label: 'Alice', brainType: 'memories' });
    expect(nodes[0]).not.toHaveProperty('tags');
  });

  it('skips archived records', async () => {
    onlyType('people', [
      { id: 'p1', name: 'A', archived: false },
      { id: 'p2', name: 'B', archived: true }
    ]);
    const { nodes } = await getBrainGraphSearchIndex();
    expect(nodes.map(n => n.id)).toEqual(['p1']);
  });
});

describe('getBrainGraphOverview', () => {
  it('returns an empty graph when no entities exist', async () => {
    const result = await getBrainGraphOverview();
    expect(result).toEqual({ nodes: [], edges: [], hasEmbeddings: false, mode: 'overview' });
  });

  it('skips archived records and aggregates the rest into nodes', async () => {
    brainStorage.getAll.mockImplementation(async (type) => {
      if (type === 'people') return [
        { id: 'p1', name: 'Alice', tags: ['friend'], archived: false },
        { id: 'p2', name: 'Bob', tags: [], archived: true }
      ];
      if (type === 'projects') return [{ id: 'pr1', title: 'Phoenix', context: 'launch q4', tags: ['work'] }];
      return [];
    });
    const result = await getBrainGraphOverview({ limit: 100 });
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map(n => n.label).sort()).toEqual(['Alice', 'Phoenix']);
  });

  it('falls back to "(untitled)" when an entity has no name/title', async () => {
    onlyType('ideas', [{ id: 'i1', tags: [] }]);
    const result = await getBrainGraphOverview({ limit: 100 });
    expect(result.nodes[0].label).toBe('(untitled)');
  });

  it('emits a shared_tag edge when Jaccard >= 0.3', async () => {
    onlyType('people', [
      { id: 'a', name: 'A', tags: ['x', 'y'] },
      { id: 'b', name: 'B', tags: ['x', 'y', 'z'] }
    ]);
    const result = await getBrainGraphOverview({ limit: 100 });
    const tagEdges = result.edges.filter(e => e.type === 'shared_tag');
    expect(tagEdges).toHaveLength(1);
    expect(tagEdges[0].weight).toBeCloseTo(2 / 3, 5);
    expect([tagEdges[0].source, tagEdges[0].target].sort()).toEqual(['a', 'b']);
  });

  it('does not emit shared_tag edges below the 0.3 Jaccard threshold', async () => {
    onlyType('people', [
      { id: 'a', name: 'A', tags: ['x', 'p', 'q'] },
      { id: 'b', name: 'B', tags: ['x', 'r', 's'] }
    ]);
    const result = await getBrainGraphOverview({ limit: 100 });
    expect(result.edges).toEqual([]);
  });

  it('remaps CoS memory edges through the bridge to brain ids', async () => {
    onlyType('people', [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }]);
    loadBridgeMap.mockResolvedValue({ 'people:p1': 'mem-1', 'people:p2': 'mem-2' });
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [{ source: 'mem-1', target: 'mem-2', type: 'similar', weight: 0.9 }]
    });
    const result = await getBrainGraphOverview({ limit: 100 });
    expect(result.hasEmbeddings).toBe(true);
    expect(result.edges).toHaveLength(1);
    expect([result.edges[0].source, result.edges[0].target].sort()).toEqual(['p1', 'p2']);
    expect(result.edges[0].type).toBe('similar');
    expect(result.edges[0].weight).toBe(0.9);
  });

  it('preserves explicit "linked" type and does not flip hasEmbeddings on its own', async () => {
    onlyType('projects', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
    loadBridgeMap.mockResolvedValue({ 'projects:a': 'm-a', 'projects:b': 'm-b' });
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [{ source: 'm-a', target: 'm-b', type: 'linked', weight: 1 }]
    });
    const result = await getBrainGraphOverview({ limit: 100 });
    expect(result.edges[0].type).toBe('linked');
    expect(result.hasEmbeddings).toBe(false);
  });

  it('drops cos edges whose endpoints are not in the bridge', async () => {
    onlyType('people', [{ id: 'p1', name: 'A' }]);
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [{ source: 'mem-X', target: 'mem-Y', type: 'similar', weight: 0.5 }]
    });
    const result = await getBrainGraphOverview({ limit: 100 });
    expect(result.edges).toEqual([]);
  });

  it('treats a getGraphData failure as no edges', async () => {
    onlyType('people', [{ id: 'p1', name: 'A' }]);
    memoryBackend.getGraphData.mockRejectedValue(new Error('embeddings unavailable'));
    const result = await getBrainGraphOverview({ limit: 100 });
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
    expect(result.hasEmbeddings).toBe(false);
  });

  it('does not duplicate an edge that is both a memory link and a tag overlap', async () => {
    onlyType('people', [
      { id: 'a', name: 'A', tags: ['x', 'y'] },
      { id: 'b', name: 'B', tags: ['x', 'y'] }
    ]);
    loadBridgeMap.mockResolvedValue({ 'people:a': 'm-a', 'people:b': 'm-b' });
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [{ source: 'm-a', target: 'm-b', type: 'similar', weight: 0.95 }]
    });
    const result = await getBrainGraphOverview({ limit: 100 });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe('similar');
  });

  it('returns at most `limit` nodes', async () => {
    onlyType('memories', Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, tags: ['shared'] })));
    const { nodes, edges } = await getBrainGraphOverview({ limit: 5 });
    expect(nodes).toHaveLength(5);
    const ids = new Set(nodes.map(n => n.id));
    for (const e of edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
    }
  });

  it('caps the shared_tag explosion — a fully co-tagged set stays bounded', async () => {
    // 40 nodes all sharing the same tags = C(40,2)=780 pairs uncapped. The
    // per-node cap (8) holds it to <= 40*8 — this is the fix for the 1M-edge crash.
    const N = 40;
    onlyType('memories', Array.from({ length: N }, (_, i) => ({ id: `n${i}`, name: `N${i}`, tags: ['x', 'y'] })));
    const { nodes, edges } = await getBrainGraphOverview({ limit: N });
    expect(nodes).toHaveLength(N);
    expect(edges.every(e => e.type === 'shared_tag')).toBe(true);
    expect(edges.length).toBeLessThan((N * (N - 1)) / 2);
    expect(edges.length).toBeLessThanOrEqual(N * 8);
  });
});

describe('getBrainGraphNeighborhood', () => {
  it('returns the focus plus capped neighbors, each connected to the focus', async () => {
    onlyType('memories', [
      { id: 'focus', name: 'F', tags: ['t'] },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `nb${i}`, name: `NB${i}`, tags: ['t'] })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `other${i}`, name: `O${i}`, tags: ['z'] }))
    ]);
    const { nodes, edges, focusId, mode } = await getBrainGraphNeighborhood({ focusId: 'focus', limit: 80 });
    expect(mode).toBe('neighborhood');
    expect(focusId).toBe('focus');
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('focus');
    expect(ids).not.toContain('other0');
    const neighborIds = ids.filter(id => id !== 'focus');
    expect(neighborIds).toHaveLength(6);
    for (const nb of neighborIds) {
      const connected = edges.some(e =>
        (e.source === 'focus' && e.target === nb) || (e.target === 'focus' && e.source === nb));
      expect(connected).toBe(true);
    }
  });

  it('honors the neighbor limit', async () => {
    onlyType('memories', [
      { id: 'focus', name: 'F', tags: ['t'] },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `nb${i}`, name: `NB${i}`, tags: ['t'] }))
    ]);
    const { nodes } = await getBrainGraphNeighborhood({ focusId: 'focus', limit: 10 });
    expect(nodes.length).toBeLessThanOrEqual(11);
    expect(nodes.some(n => n.id === 'focus')).toBe(true);
  });

  it('flags an unknown focus as notFound', async () => {
    onlyType('memories', [{ id: 'a', name: 'A' }]);
    const res = await getBrainGraphNeighborhood({ focusId: 'missing' });
    expect(res.notFound).toBe(true);
    expect(res.nodes).toEqual([]);
  });

  it('includes neighbors reached via remapped linked/similar edges', async () => {
    onlyType('memories', [{ id: 'focus', name: 'F', tags: [] }, { id: 'friend', name: 'Fr', tags: [] }]);
    loadBridgeMap.mockResolvedValue({ 'memories:focus': 'mem-f', 'memories:friend': 'mem-r' });
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [{ source: 'mem-f', target: 'mem-r', type: 'linked', weight: 1 }]
    });
    const { nodes, edges } = await getBrainGraphNeighborhood({ focusId: 'focus' });
    expect(nodes.map(n => n.id).sort()).toEqual(['focus', 'friend']);
    expect(edges.some(e => e.type === 'linked')).toBe(true);
  });
});

describe('goals and journal nodes', () => {
  it('includes active goals as graph nodes with correct shape', async () => {
    getGoals.mockResolvedValue({ goals: [
      { id: 'g1', title: 'Run a marathon', description: 'sub-3h', tags: ['fitness'], status: 'active', progress: 42 }
    ] });
    const { nodes } = await getBrainGraphSearchIndex();
    const goalNode = nodes.find(n => n.id === 'g1');
    expect(goalNode).toBeDefined();
    expect(goalNode.brainType).toBe('goals');
    expect(goalNode.label).toBe('Run a marathon');
  });

  it('excludes completed and abandoned goals', async () => {
    getGoals.mockResolvedValue({ goals: [
      { id: 'g1', title: 'Done goal', status: 'completed', tags: [], progress: 100 },
      { id: 'g2', title: 'Dropped goal', status: 'abandoned', tags: [], progress: 0 },
      { id: 'g3', title: 'Active goal', status: 'active', tags: [], progress: 10 }
    ] });
    const { nodes } = await getBrainGraphSearchIndex();
    const ids = nodes.map(n => n.id);
    expect(ids).not.toContain('g1');
    expect(ids).not.toContain('g2');
    expect(ids).toContain('g3');
  });

  it('treats a getGoals failure as an empty goal list', async () => {
    getGoals.mockRejectedValue(new Error('identity unavailable'));
    const result = await getBrainGraphOverview();
    expect(result.nodes).toEqual([]);
  });

  it('includes non-empty journal entries as graph nodes', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'journals' ? [{ id: '2026-01-01', content: 'Hello world' }] : []
    );
    const { nodes } = await getBrainGraphSearchIndex();
    const journalNode = nodes.find(n => n.id === '2026-01-01');
    expect(journalNode).toBeDefined();
    expect(journalNode.brainType).toBe('journals');
    expect(journalNode.label).toBe('2026-01-01');
  });

  it('skips empty journal entries (no content and no segments)', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'journals' ? [
        { id: '2026-01-01', content: '' },
        { id: '2026-01-02', content: 'Has content' }
      ] : []
    );
    const { nodes } = await getBrainGraphSearchIndex();
    const ids = nodes.map(n => n.id);
    expect(ids).not.toContain('2026-01-01');
    expect(ids).toContain('2026-01-02');
  });
});
