import { describe, it, expect, vi, beforeEach } from 'vitest';

// The graph builder composes four read-only collaborators. Mock them so the
// assertions are about the DERIVATION (node/edge shape, timeline indices)
// rather than about storage.
const mockUniverses = new Map();
const mockSeriesList = [];
const mockIssuesBySeries = new Map();
let mockUsage = null;

vi.mock('./universeBuilder.js', () => ({
  ERR_NOT_FOUND: 'NOT_FOUND',
  getUniverse: vi.fn(async (id) => {
    const universe = mockUniverses.get(id);
    if (!universe) throw Object.assign(new Error(`Universe not found: ${id}`), { code: 'NOT_FOUND' });
    return universe;
  }),
}));

vi.mock('./canonUsage.js', () => ({
  getUniverseCanonUsage: vi.fn(async () => mockUsage),
}));

vi.mock('./pipeline/series.js', () => ({
  listSeries: vi.fn(async () => [...mockSeriesList]),
}));

vi.mock('./pipeline/issues.js', () => ({
  listAllIssues: vi.fn(async ({ seriesIds } = {}) => {
    const wanted = Array.isArray(seriesIds) ? new Set(seriesIds) : null;
    const out = [];
    for (const [seriesId, issues] of mockIssuesBySeries) {
      if (wanted && !wanted.has(seriesId)) continue;
      for (const issue of issues) out.push({ ...issue, seriesId });
    }
    return out;
  }),
}));

const { buildUniverseGraph, IMAGE_NODES_PER_ENTRY_MAX } = await import('./universeGraph.js');

const emptyUsage = () => ({
  characters: {}, places: {}, objects: {}, seriesNameMap: {}, seriesCount: 0, issueCount: 0,
});

beforeEach(() => {
  mockUniverses.clear();
  mockSeriesList.length = 0;
  mockIssuesBySeries.clear();
  mockUsage = emptyUsage();
});

const seedUniverse = (overrides = {}) => {
  const universe = {
    id: 'u1',
    name: 'Example Universe',
    characters: [],
    places: [],
    objects: [],
    compositeSheets: [],
    ...overrides,
  };
  mockUniverses.set('u1', universe);
  return universe;
};

const nodeOf = (graph, id) => graph.nodes.find((n) => n.id === id);

describe('buildUniverseGraph — canon nodes', () => {
  it('does not print a slugline-only place name twice', async () => {
    seedUniverse({ places: [{ id: 'p1', slugline: 'INT. VAULT' }] });
    const node = nodeOf(await buildUniverseGraph('u1'), 'place:p1');
    expect(node.name).toBe('INT. VAULT');
    expect(node.role).toBe('Place');
  });

  it('emits kind-namespaced nodes so a place and a character can share a canon id', async () => {
    seedUniverse({
      characters: [{ id: 'shared', name: 'Alice', role: 'Lead', imageRefs: ['a.png'] }],
      places: [{ id: 'shared', name: 'The Vault', slugline: 'INT. VAULT' }],
    });
    const graph = await buildUniverseGraph('u1');
    expect(nodeOf(graph, 'character:shared').name).toBe('Alice');
    expect(nodeOf(graph, 'place:shared').name).toBe('The Vault');
  });

  it('projects the character framework, sliders and arc onto the node', async () => {
    seedUniverse({
      characters: [{
        id: 'c1',
        name: 'Alice',
        arcType: 'positive',
        ghost: 'Lost the vault key.',
        want: 'Get it back.',
        sliders: { proactivity: 7, likability: null, competence: null },
      }],
    });
    const node = nodeOf(await buildUniverseGraph('u1'), 'character:c1');
    expect(node.arcType).toBe('positive');
    expect(node.framework).toEqual({ ghost: 'Lost the vault key.', want: 'Get it back.' });
    expect(node.sliders).toEqual({ proactivity: 7 });
  });

  it('reports an unrated slider set and an unwritten framework as absent, not empty', async () => {
    seedUniverse({
      characters: [{ id: 'c1', name: 'Alice', sliders: { proactivity: null, likability: null, competence: null } }],
    });
    const node = nodeOf(await buildUniverseGraph('u1'), 'character:c1');
    expect(node.sliders).toBeNull();
    expect(node.framework).toBeNull();
  });

  it('caps the image nodes it emits per entry', async () => {
    const refs = Array.from({ length: IMAGE_NODES_PER_ENTRY_MAX + 4 }, (_, i) => `ref-${i}.png`);
    seedUniverse({ characters: [{ id: 'c1', name: 'Alice', imageRefs: refs, primaryImageRef: 'ref-2.png' }] });
    const graph = await buildUniverseGraph('u1');
    const images = graph.nodes.filter((n) => n.kind === 'image');
    expect(images).toHaveLength(IMAGE_NODES_PER_ENTRY_MAX);
    expect(graph.edges.filter((e) => e.type === 'imageref')).toHaveLength(IMAGE_NODES_PER_ENTRY_MAX);
    expect(images.find((n) => n.imageRef === 'ref-2.png').primary).toBe(true);
  });
});

describe('buildUniverseGraph — authored links', () => {
  it('keeps a one-directional relationship one-directional', async () => {
    seedUniverse({
      characters: [
        { id: 'c1', name: 'Alice', relationshipLinks: [{ targetCharacterId: 'c2', type: 'rival', description: 'Wants her post.' }] },
        { id: 'c2', name: 'Bob' },
      ],
    });
    const graph = await buildUniverseGraph('u1');
    const rels = graph.edges.filter((e) => e.directed);
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      source: 'character:c1', target: 'character:c2', type: 'rival', label: 'Wants her post.',
    });
  });

  it('drops a relationship link whose target is not in this universe', async () => {
    seedUniverse({
      characters: [{ id: 'c1', name: 'Alice', relationshipLinks: [{ targetCharacterId: 'gone', type: 'ally' }] }],
    });
    expect((await buildUniverseGraph('u1')).edges.filter((e) => e.directed)).toHaveLength(0);
  });

  it('turns an object attachment into an object ↔ character edge carrying its role', async () => {
    seedUniverse({
      characters: [{ id: 'c1', name: 'Alice' }],
      objects: [{ id: 'o1', name: 'The Key', attachments: [{ characterId: 'c1', role: 'talisman' }] }],
    });
    const edge = (await buildUniverseGraph('u1')).edges.find((e) => e.type === 'attachment');
    expect(edge).toMatchObject({ source: 'object:o1', target: 'character:c1', label: 'talisman' });
  });

  it('links a composite sheet to the canon its own prompt names', async () => {
    seedUniverse({
      characters: [{ id: 'c1', name: 'Alice' }, { id: 'c2', name: 'Bob' }],
      compositeSheets: [{ id: 'sheet1', label: 'Lineup', kind: 'reference_sheet', prompt: 'Alice standing at the gate', imageRefs: ['s.png'] }],
    });
    const graph = await buildUniverseGraph('u1');
    const links = graph.edges.filter((e) => e.source === 'composite:sheet1');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('character:c1');
  });
});

describe('buildUniverseGraph — timeline', () => {
  beforeEach(() => {
    mockSeriesList.push(
      { id: 's1', name: 'First Arc', universeId: 'u1', createdAt: '2026-01-01T00:00:00Z' },
      { id: 's2', name: 'Second Arc', universeId: 'u1', createdAt: '2026-02-01T00:00:00Z' },
      { id: 'other', name: 'Unrelated', universeId: 'u2', createdAt: '2026-01-01T00:00:00Z' },
    );
    // Deliberately out of order so the builder has to sort by issue number.
    mockIssuesBySeries.set('s1', [{ id: 'i2', number: 2, title: 'Two' }, { id: 'i1', number: 1, title: 'One' }]);
    mockIssuesBySeries.set('s2', [{ id: 'i3', number: 1, title: 'Three' }]);
  });

  it('numbers issues globally by series order then issue number', async () => {
    seedUniverse();
    const graph = await buildUniverseGraph('u1');
    expect(graph.totalIssues).toBe(3);
    expect(graph.issues.map((i) => [i.recordId, i.index])).toEqual([['i1', 0], ['i2', 1], ['i3', 2]]);
    expect(graph.series.map((s) => s.recordId)).toEqual(['s1', 's2']);
  });

  it('anchors a series node to the index of its own first issue', async () => {
    seedUniverse();
    const graph = await buildUniverseGraph('u1');
    expect(nodeOf(graph, 'series:s1').firstIssue).toBe(0);
    expect(nodeOf(graph, 'series:s2').firstIssue).toBe(2);
  });

  it('keeps every id in the payload namespaced, so a node id resolves against the node list', async () => {
    seedUniverse();
    const graph = await buildUniverseGraph('u1');
    const ids = new Set(graph.nodes.map((n) => n.id));
    // The issue NODE's seriesId and the issues[] row's seriesId must name the
    // same id space — a raw record id under either would silently miss lookups.
    for (const node of graph.nodes.filter((n) => n.kind === 'issue')) {
      expect(ids.has(node.seriesId)).toBe(true);
    }
    for (const issue of graph.issues) {
      expect(ids.has(issue.id)).toBe(true);
      expect(ids.has(issue.seriesId)).toBe(true);
    }
  });

  it('anchors an entry firstIssue to its earliest appearance and records every appearance', async () => {
    seedUniverse({ characters: [{ id: 'c1', name: 'Alice' }] });
    mockUsage = {
      ...emptyUsage(),
      characters: { c1: [{ seriesId: 's2', seriesName: 'Second Arc', issueIds: ['i3'], issueCount: 1 }, { seriesId: 's1', seriesName: 'First Arc', issueIds: ['i2'], issueCount: 1 }] },
    };
    const graph = await buildUniverseGraph('u1');
    expect(nodeOf(graph, 'character:c1').firstIssue).toBe(1);
    expect(graph.appear['character:c1']).toEqual([1, 2]);
    expect(graph.edges.filter((e) => e.type === 'appearance').map((e) => e.target))
      .toEqual(['issue:i2', 'issue:i3']);
    expect(graph.edges.filter((e) => e.type === 'membership' && e.source === 'character:c1'))
      .toHaveLength(2);
  });

  it('gives an entry with no appearances firstIssue 0 so it is never hidden by the scrubber', async () => {
    seedUniverse({ places: [{ id: 'p1', name: 'The Vault' }] });
    expect(nodeOf(await buildUniverseGraph('u1'), 'place:p1').firstIssue).toBe(0);
  });
});

describe('buildUniverseGraph — errors', () => {
  it('maps a missing universe to a 404', async () => {
    await expect(buildUniverseGraph('nope')).rejects.toMatchObject({ status: 404, code: 'UNIVERSE_NOT_FOUND' });
  });
});
