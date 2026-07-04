import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O boundaries; keep catalogSeed + catalogTypes real (pure transforms).
// The catalogDB mock must still provide cdRefRoleForType because the real
// catalogSeed imports it for role mapping.
vi.mock('../catalogDB.js', () => ({
  hybridSearchIngredients: vi.fn(),
  linkIngredientsToCreativeDirector: vi.fn(async () => []),
  cdRefRoleForType: (type) => ({ character: 'cast', place: 'location', object: 'prop', scene: 'scene' }[type] || 'reference'),
}));
vi.mock('../memoryEmbeddings.js', () => ({
  generateQueryEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));
vi.mock('./local.js', () => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
}));

import {
  deriveBriefFromProject,
  suggestCastForBrief,
  applyAutoCastToProject,
  toSuggestionView,
  DEFAULT_CASTABLE_TYPES,
} from './autoCast.js';
import { hybridSearchIngredients, linkIngredientsToCreativeDirector } from '../catalogDB.js';
import { generateQueryEmbedding } from '../memoryEmbeddings.js';
import { getProject, updateProject } from './local.js';

const hit = (id, type, name, rrfScore = 0.5, searchMethod = 'hybrid') => ({
  ingredient: { id, type, name, payload: {} },
  rrfScore,
  searchMethod,
});

// suggestCastForBrief now queries hybridSearchIngredients once per castable type,
// so the mock must honor the `type` filter (the real query does) — return only
// the rows whose ingredient.type matches the requested type.
const mockSearch = (rows) =>
  hybridSearchIngredients.mockImplementation(async (_q, _emb, { type } = {}) =>
    rows.filter((r) => !type || r.ingredient.type === type));

beforeEach(() => {
  vi.clearAllMocks();
  generateQueryEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  linkIngredientsToCreativeDirector.mockResolvedValue([]);
});

describe('deriveBriefFromProject', () => {
  it('joins name + style spec + user story', () => {
    expect(deriveBriefFromProject({ name: 'Neon Run', styleSpec: 'rain noir', userStory: 'a courier flees' }))
      .toBe('Neon Run\n\nrain noir\n\na courier flees');
  });

  it('skips missing / blank fields', () => {
    expect(deriveBriefFromProject({ name: 'Neon Run', styleSpec: '   ', userStory: null }))
      .toBe('Neon Run');
  });

  it('returns "" for a null or empty project', () => {
    expect(deriveBriefFromProject(null)).toBe('');
    expect(deriveBriefFromProject({})).toBe('');
  });

  it('caps an overly long brief', () => {
    const brief = deriveBriefFromProject({ name: 'x'.repeat(9000) });
    expect(brief.length).toBeLessThanOrEqual(8000);
  });
});

describe('suggestCastForBrief', () => {
  it('returns [] for an empty brief without searching', async () => {
    expect(await suggestCastForBrief({ brief: '   ' })).toEqual([]);
    expect(hybridSearchIngredients).not.toHaveBeenCalled();
  });

  it('filters hits to the castable types and slices to the limit', async () => {
    mockSearch([
      hit('c1', 'character', 'Mara'),
      hit('i1', 'idea', 'A loose notion'), // not castable by default → dropped
      hit('p1', 'place', 'The Spire'),
      hit('x1', 'concept', 'Theme'),       // not castable → dropped
    ]);
    const out = await suggestCastForBrief({ brief: 'rain noir', limit: 5 });
    expect(out.map((h) => h.ingredient.id)).toEqual(['c1', 'p1']);
  });

  it('respects an explicit types override', async () => {
    mockSearch([hit('c1', 'character', 'Mara'), hit('i1', 'idea', 'Notion')]);
    const out = await suggestCastForBrief({ brief: 'x', types: ['idea'] });
    expect(out.map((h) => h.ingredient.id)).toEqual(['i1']);
  });

  it('degrades to FTS-only when the embedding provider fails', async () => {
    generateQueryEmbedding.mockRejectedValue(new Error('no provider'));
    mockSearch([hit('c1', 'character', 'Mara')]);
    const out = await suggestCastForBrief({ brief: 'rain noir' });
    expect(out).toHaveLength(1);
    // embedding arg is null when the provider failed
    expect(hybridSearchIngredients).toHaveBeenCalledWith('rain noir', null, expect.any(Object));
  });

  it('defaults to the castable type set', () => {
    expect(DEFAULT_CASTABLE_TYPES).toContain('character');
    expect(DEFAULT_CASTABLE_TYPES).not.toContain('idea');
  });
});

describe('toSuggestionView', () => {
  it('slims a hit to the cast-member shape + score + method', () => {
    const view = toSuggestionView(hit('c1', 'character', 'Mara', 0.73, 'vector'));
    expect(view).toMatchObject({ ingredientId: 'c1', name: 'Mara', type: 'character', role: 'cast', score: 0.73, searchMethod: 'vector' });
    expect(view).not.toHaveProperty('payload'); // no full ingredient leak
  });
});

describe('applyAutoCastToProject', () => {
  it('404s when the project is missing', async () => {
    getProject.mockResolvedValue(null);
    await expect(applyAutoCastToProject('missing', {})).rejects.toMatchObject({ status: 404 });
  });

  it('400s (NO_BRIEF) when the project and request carry no brief', async () => {
    getProject.mockResolvedValue({ id: 'p1', name: '', styleSpec: '', userStory: '' });
    await expect(applyAutoCastToProject('p1', {})).rejects.toMatchObject({ status: 400, code: 'NO_BRIEF' });
    expect(hybridSearchIngredients).not.toHaveBeenCalled();
  });

  it('appends fresh members, dedupes against existing cast, and links refs', async () => {
    getProject.mockResolvedValue({
      id: 'p1', name: 'Neon Run', styleSpec: 'rain noir', userStory: null,
      cast: [{ ingredientId: 'c1', name: 'Mara', type: 'character', role: 'cast' }],
    });
    mockSearch([
      hit('c1', 'character', 'Mara'),   // already cast → skipped
      hit('p1', 'place', 'The Spire'),  // fresh → added
    ]);
    updateProject.mockImplementation(async (_id, patch) => ({ id: 'p1', ...patch }));

    const result = await applyAutoCastToProject('p1', {});
    expect(result.added.map((m) => m.ingredientId)).toEqual(['p1']);
    // cast persisted = existing + fresh
    expect(updateProject).toHaveBeenCalledWith('p1', { cast: expect.arrayContaining([
      expect.objectContaining({ ingredientId: 'c1' }),
      expect.objectContaining({ ingredientId: 'p1' }),
    ]) });
    // refs linked only for the fresh ingredient
    expect(linkIngredientsToCreativeDirector).toHaveBeenCalledWith('p1', [expect.objectContaining({ id: 'p1' })]);
    // suggestions include both (already-cast match still surfaced)
    expect(result.suggestions.map((s) => s.ingredientId).sort()).toEqual(['c1', 'p1']);
  });

  it('no-ops the write when every match is already cast', async () => {
    getProject.mockResolvedValue({
      id: 'p1', name: 'Neon Run', styleSpec: 'rain noir',
      cast: [{ ingredientId: 'c1', name: 'Mara', type: 'character', role: 'cast' }],
    });
    mockSearch([hit('c1', 'character', 'Mara')]);
    const result = await applyAutoCastToProject('p1', {});
    expect(result.added).toEqual([]);
    expect(updateProject).not.toHaveBeenCalled();
    expect(linkIngredientsToCreativeDirector).not.toHaveBeenCalled();
  });

  it('uses an explicit brief over the project-derived one', async () => {
    getProject.mockResolvedValue({ id: 'p1', name: 'Neon Run', styleSpec: 'rain noir', cast: [] });
    mockSearch([]);
    await applyAutoCastToProject('p1', { brief: 'sunlit meadow' });
    expect(hybridSearchIngredients).toHaveBeenCalledWith('sunlit meadow', expect.anything(), expect.any(Object));
  });

  it('caps the merged cast at 50 members', async () => {
    const existing = Array.from({ length: 49 }, (_, i) => ({ ingredientId: `e${i}`, name: `E${i}`, type: 'character', role: 'cast' }));
    getProject.mockResolvedValue({ id: 'p1', name: 'Neon Run', styleSpec: 'rain noir', cast: existing });
    mockSearch([
      hit('n1', 'character', 'N1'), hit('n2', 'character', 'N2'), hit('n3', 'character', 'N3'),
    ]);
    updateProject.mockImplementation(async (_id, patch) => ({ id: 'p1', ...patch }));
    const result = await applyAutoCastToProject('p1', {});
    // only one fresh member fits (49 + 1 = 50)
    expect(result.added).toHaveLength(1);
    expect(updateProject.mock.calls[0][1].cast).toHaveLength(50);
  });
});
