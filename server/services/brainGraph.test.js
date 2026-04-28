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

import * as brainStorage from './brainStorage.js';
import * as memoryBackend from './memoryBackend.js';
import { loadBridgeMap } from './brainMemoryBridge.js';
import { getBrainGraphData } from './brainGraph.js';

describe('getBrainGraphData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadBridgeMap.mockResolvedValue({});
    memoryBackend.getGraphData.mockResolvedValue(null);
    brainStorage.getAll.mockResolvedValue([]);
  });

  it('returns empty graph when no entities exist', async () => {
    const result = await getBrainGraphData();
    expect(result).toEqual({ nodes: [], edges: [], hasEmbeddings: false });
  });

  it('skips archived records and aggregates the remaining entities into nodes', async () => {
    brainStorage.getAll.mockImplementation(async (type) => {
      if (type === 'people') return [
        { id: 'p1', name: 'Alice', tags: ['friend'], archived: false },
        { id: 'p2', name: 'Bob', tags: [], archived: true }
      ];
      if (type === 'projects') return [
        { id: 'pr1', title: 'Phoenix', context: 'launch q4', tags: ['work'] }
      ];
      return [];
    });

    const result = await getBrainGraphData();
    expect(result.nodes).toHaveLength(2);
    const labels = result.nodes.map(n => n.label);
    expect(labels).toContain('Alice');
    expect(labels).toContain('Phoenix');
  });

  it('falls back to "(untitled)" when an entity has no name/title', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'ideas' ? [{ id: 'i1', tags: [] }] : []
    );
    const result = await getBrainGraphData();
    expect(result.nodes[0].label).toBe('(untitled)');
  });

  it('emits shared_tag edges when Jaccard similarity meets the 0.3 threshold', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'people' ? [
        { id: 'a', name: 'A', tags: ['x', 'y'] },
        { id: 'b', name: 'B', tags: ['x', 'y', 'z'] }
      ] : []
    );

    const result = await getBrainGraphData();
    const tagEdges = result.edges.filter(e => e.type === 'shared_tag');
    expect(tagEdges).toHaveLength(1);
    expect(tagEdges[0].weight).toBeCloseTo(2 / 3, 5);
    expect([tagEdges[0].source, tagEdges[0].target].sort()).toEqual(['a', 'b']);
  });

  it('does not emit shared_tag edges below the 0.3 Jaccard threshold', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'people' ? [
        { id: 'a', name: 'A', tags: ['x', 'p', 'q'] },
        { id: 'b', name: 'B', tags: ['x', 'r', 's'] }
      ] : []
    );
    const result = await getBrainGraphData();
    expect(result.edges).toEqual([]);
  });

  it('remaps CoS memory edges through the bridge to brain ids', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'people' ? [
        { id: 'p1', name: 'Alice' },
        { id: 'p2', name: 'Bob' }
      ] : []
    );
    loadBridgeMap.mockResolvedValue({
      'people:p1': 'mem-1',
      'people:p2': 'mem-2'
    });
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [
        { source: 'mem-1', target: 'mem-2', type: 'similar', weight: 0.9 }
      ]
    });

    const result = await getBrainGraphData();
    expect(result.hasEmbeddings).toBe(true);
    expect(result.edges).toHaveLength(1);
    expect([result.edges[0].source, result.edges[0].target].sort()).toEqual(['p1', 'p2']);
    expect(result.edges[0].type).toBe('similar');
    expect(result.edges[0].weight).toBe(0.9);
  });

  it('preserves explicit "linked" type and does not flip hasEmbeddings on its own', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'projects' ? [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' }
      ] : []
    );
    loadBridgeMap.mockResolvedValue({
      'projects:a': 'm-a',
      'projects:b': 'm-b'
    });
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [{ source: 'm-a', target: 'm-b', type: 'linked', weight: 1 }]
    });

    const result = await getBrainGraphData();
    expect(result.edges[0].type).toBe('linked');
    expect(result.hasEmbeddings).toBe(false);
  });

  it('drops cos edges whose endpoints are not in the bridge', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'people' ? [{ id: 'p1', name: 'A' }] : []
    );
    loadBridgeMap.mockResolvedValue({});
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [{ source: 'mem-X', target: 'mem-Y', type: 'similar', weight: 0.5 }]
    });
    const result = await getBrainGraphData();
    expect(result.edges).toEqual([]);
  });

  it('handles a memoryBackend.getGraphData failure by treating it as no edges', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'people' ? [{ id: 'p1', name: 'A' }] : []
    );
    memoryBackend.getGraphData.mockRejectedValue(new Error('embeddings unavailable'));
    const result = await getBrainGraphData();
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
    expect(result.hasEmbeddings).toBe(false);
  });

  it('does not duplicate an edge that exists both as a memory link and a tag overlap', async () => {
    brainStorage.getAll.mockImplementation(async (type) =>
      type === 'people' ? [
        { id: 'a', name: 'A', tags: ['x', 'y'] },
        { id: 'b', name: 'B', tags: ['x', 'y'] }
      ] : []
    );
    loadBridgeMap.mockResolvedValue({
      'people:a': 'm-a',
      'people:b': 'm-b'
    });
    memoryBackend.getGraphData.mockResolvedValue({
      edges: [{ source: 'm-a', target: 'm-b', type: 'similar', weight: 0.95 }]
    });

    const result = await getBrainGraphData();
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe('similar');
  });
});
