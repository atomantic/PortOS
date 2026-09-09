import { describe, it, expect } from 'vitest';
import {
  computeUniverseGaps, edgeDef, evolutionStageRows, indexGraph, neighbourIds, nodeInitials,
} from './universeGraphModel';

const graph = (overrides = {}) => ({
  name: 'Example Universe',
  nodes: [],
  edges: [],
  issues: [],
  series: [],
  totalIssues: 0,
  appear: {},
  ...overrides,
});

const character = (id, extra = {}) => ({
  id: `character:${id}`, kind: 'character', name: id, role: 'Lead', hasImage: true, firstIssue: 0, ...extra,
});
const place = (id, extra = {}) => ({
  id: `place:${id}`, kind: 'place', name: id, role: 'Place', hasImage: true, firstIssue: 0, ...extra,
});
const issues = (n) => Array.from({ length: n }, (_, i) => ({
  id: `issue:i${i}`, index: i, name: `#${i + 1}`, seriesId: 'series:s1',
}));

describe('indexGraph', () => {
  it('drops an edge whose endpoint is missing rather than indexing a dangling link', () => {
    const index = indexGraph(graph({
      nodes: [character('alice')],
      edges: [{ source: 'character:alice', target: 'character:ghost', type: 'ally', directed: true }],
    }));
    expect(index.edges).toHaveLength(0);
    expect(index.degree.get('character:alice')).toBe(0);
  });

  it('excludes image references from degree and series membership from story degree', () => {
    const index = indexGraph(graph({
      nodes: [
        character('alice'),
        { id: 'image:0', kind: 'image', name: 'a.png', firstIssue: 0 },
        { id: 'series:s1', kind: 'series', name: 'Arc', firstIssue: 0 },
      ],
      edges: [
        { source: 'image:0', target: 'character:alice', type: 'imageref' },
        { source: 'character:alice', target: 'series:s1', type: 'membership' },
      ],
    }));
    expect(index.degree.get('character:alice')).toBe(1);
    expect(index.storyDegree.get('character:alice')).toBe(0);
  });
});

describe('computeUniverseGaps', () => {
  it('reports a canon entry with only bookkeeping links as isolated', () => {
    const gaps = computeUniverseGaps(indexGraph(graph({
      nodes: [character('alice'), { id: 'image:0', kind: 'image', name: 'a.png', firstIssue: 0 }],
      edges: [{ source: 'image:0', target: 'character:alice', type: 'imageref' }],
    })));
    expect(gaps.filter((g) => g.cat === 'isolated').map((g) => g.nodeId)).toEqual(['character:alice']);
  });

  it('reports a one-directional relationship but not a mutual pair', () => {
    const gaps = computeUniverseGaps(indexGraph(graph({
      nodes: [character('alice'), character('bob'), character('cass')],
      edges: [
        { source: 'character:alice', target: 'character:bob', type: 'ally', directed: true },
        { source: 'character:bob', target: 'character:alice', type: 'ally', directed: true },
        { source: 'character:alice', target: 'character:cass', type: 'rival', directed: true },
      ],
    })));
    const oneway = gaps.filter((g) => g.cat === 'oneway');
    expect(oneway).toHaveLength(1);
    expect(oneway[0]).toMatchObject({ nodeId: 'character:alice', otherId: 'character:cass' });
  });

  it('flags a canon entry with no rendered reference', () => {
    const gaps = computeUniverseGaps(indexGraph(graph({
      nodes: [character('alice', { hasImage: false }), character('bob')],
      edges: [
        { source: 'character:alice', target: 'character:bob', type: 'ally', directed: true },
        { source: 'character:bob', target: 'character:alice', type: 'ally', directed: true },
      ],
    })));
    expect(gaps.filter((g) => g.cat === 'noimage').map((g) => g.nodeId)).toEqual(['character:alice']);
  });

  it('reports a place whose issues hold no cast, and stays quiet when one does', () => {
    const base = {
      nodes: [character('alice'), place('vault'), place('pier')],
      edges: [{ source: 'character:alice', target: 'place:vault', type: 'attachment' }],
      issues: issues(2),
      totalIssues: 2,
    };
    const gaps = computeUniverseGaps(indexGraph(graph({
      ...base,
      appear: { 'character:alice': [0], 'place:vault': [0], 'place:pier': [1] },
    })));
    expect(gaps.filter((g) => g.cat === 'places').map((g) => g.nodeId)).toEqual(['place:pier']);
  });

  it('suggests a relationship only once a pair shares enough issues', () => {
    const nodes = [character('alice'), character('bob'), character('cass')];
    const withShared = (shared) => computeUniverseGaps(indexGraph(graph({
      nodes,
      issues: issues(6),
      totalIssues: 6,
      appear: {
        'character:alice': [0, 1, 2, 3, 4],
        'character:bob': shared,
        'character:cass': [5],
      },
    }))).filter((g) => g.cat === 'suggest' && g.title.startsWith('Define'));
    expect(withShared([0, 1, 2])).toHaveLength(0);
    expect(withShared([0, 1, 2, 3])).toHaveLength(1);
  });

  it('suggests an evolution lens only for a well-used character that lacks one', () => {
    const gaps = computeUniverseGaps(indexGraph(graph({
      nodes: [
        character('alice'),
        character('bob', { evolution: { outcome: 'full-change', stages: [] } }),
        character('cass'),
      ],
      issues: issues(6),
      totalIssues: 6,
      appear: {
        'character:alice': [0, 1, 2, 3, 4],
        'character:bob': [0, 1, 2, 3, 4],
        'character:cass': [0],
      },
    })));
    const lens = gaps.filter((g) => g.cat === 'suggest' && g.title.includes('evolution lens'));
    expect(lens.map((g) => g.nodeId)).toEqual(['character:alice']);
  });
});

describe('evolutionStageRows', () => {
  it('renders all five canonical stages, marking only the authored ones', () => {
    const rows = evolutionStageRows({ outcome: 'partial-open', stages: [{ stageId: 'cost-tested', testedBelief: 'x' }] });
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.authored).map((r) => r.stageId)).toEqual(['cost-tested']);
  });

  it('treats an absent lens as five unauthored stages rather than throwing', () => {
    expect(evolutionStageRows(null).every((r) => !r.authored)).toBe(true);
  });
});

describe('helpers', () => {
  it('drops an honorific before taking initials', () => {
    expect(nodeInitials('Doctor Ilse Varga')).toBe('IV');
    expect(nodeInitials('The Pale Broker')).toBe('PB');
    expect(nodeInitials('')).toBe('?');
  });

  it('resolves an unknown edge type through custom instead of returning undefined', () => {
    expect(edgeDef('not-a-type')).toBe(edgeDef('custom'));
  });

  it('returns the node itself plus its neighbours', () => {
    const index = indexGraph(graph({
      nodes: [character('alice'), character('bob'), character('cass')],
      edges: [{ source: 'character:alice', target: 'character:bob', type: 'ally', directed: true }],
    }));
    expect([...neighbourIds(index, 'character:alice')].sort()).toEqual(['character:alice', 'character:bob']);
  });
});
