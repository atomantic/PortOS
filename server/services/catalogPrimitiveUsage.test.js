import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ stories: [], voices: [], universes: [], failure: null }));
vi.mock('../lib/db.js', () => ({ query: vi.fn(async (sql, params) => {
  if (state.failure) throw state.failure;
  if (sql.startsWith('SELECT\n    EXISTS')) return { rows: [{ blocked: state.stories.some((story) => story.universeId === params[0]) }] };
  if (sql.includes('FROM universes')) return { rows: state.universes.filter((universe) => params[0].includes(universe.id)) };
  if (sql.includes('FROM fableloom_stories')) return { rows: state.stories.filter((story) => story.universeId === params[0]) };
  if (sql.includes('FROM voice_profiles')) return { rows: state.voices.filter((voice) => voice.universeId === params[0] && voice.characterId === params[1]) };
  throw new Error('Unexpected query');
}) }));
vi.mock('./catalogDB/ingredients.js', () => ({ getIngredientIdentityIds: async () => ['canonical', 'retained-alias'] }));
vi.mock('./canonUsage.js', () => ({ getUniverseCanonUsage: async () => ({
  characters: { 'chr-1': [{ seriesId: 'series-1', seriesName: 'Example series', issueIds: ['issue-1'] }] },
}) }));
import { assertCanonRemovable, assertUniversePrimitivesRemovable, findCanonDependencies, listPrimitiveUsages } from './catalogPrimitiveUsage.js';
import { query } from '../lib/db.js';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { failure: null, universes: [{ id: 'world-1', data: { characters: [{ id: 'chr-1', ingredientId: 'retained-alias' }] } }],
    stories: [
      { id: 'loom-1', name: 'Example story', universeId: 'world-1', data: { episodes: [{ nodes: [{ visualCanon: { characterAppearances: [{ characterId: 'chr-1' }] } }] }] } },
      { id: 'loom-other', name: 'Same display name', universeId: 'world-1', data: { protagonistCharacterId: 'different-id', notes: 'chr-1' } },
      { id: 'loom-foreign', universeId: 'world-2', data: { protagonistCharacterId: 'chr-1' } },
    ], voices: [{ id: 'voice-1', name: 'Example voice', universeId: 'world-1', characterId: 'chr-1', approval_status: 'approved',
      data: { providerId: 'local-config', consent: 'not-exported' } }] });
});

describe('catalog usage across canonical consumers', () => {
  it('joins stable aliases to exact story/voice pointers and labels inferred series/issue mentions separately', async () => {
    const uses = await listPrimitiveUsages('canonical', [{ refKind: 'universe', refId: 'world-1', resolved: true }]);
    expect(uses.map((use) => [use.refKind, use.refId, use.role])).toEqual([
      ['fableloom', 'loom-1', 'canon'], ['voice-profile', 'voice-1', 'approved voice'],
      ['series', 'series-1', 'prose-mention'], ['issue', 'issue-1', 'prose-mention'],
    ]);
    expect(uses.every((use) => use.derived)).toBe(true);
    expect(JSON.stringify(uses)).not.toMatch(/local-config|not-exported|loom-foreign|loom-other/);
  });

  it('refuses removal while exact consumers remain, without treating prose or same names as identities', async () => {
    await expect(assertCanonRemovable('world-1', 'character', 'chr-1')).rejects.toMatchObject({ status: 409, code: 'UNIVERSE_CANON_IN_USE' });
    state.stories.push({ id: 'loom-object', universeId: 'world-1', data: { visualCanon: { objectIds: ['obj-1'] } } });
    await expect(assertCanonRemovable('world-1', 'object', 'obj-1')).rejects.toMatchObject({ code: 'UNIVERSE_CANON_IN_USE' });
    expect(await findCanonDependencies('world-1', 'object', 'unreferenced')).toEqual([]);
    await expect(assertCanonRemovable('world-1', 'character', 'unreferenced')).resolves.toBeUndefined();
    await expect(assertUniversePrimitivesRemovable('world-1')).rejects.toMatchObject({ status: 409, code: 'UNIVERSE_PRIMITIVES_IN_USE' });
    await expect(assertUniversePrimitivesRemovable('unreferenced')).resolves.toBeUndefined();
  });

  it('does not probe missing universe targets or turn a failed lookup into an unused result', async () => {
    expect(await listPrimitiveUsages('canonical', [{ refKind: 'universe', refId: 'missing', resolved: false }])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    state.failure = new Error('Store unavailable');
    await expect(listPrimitiveUsages('canonical', [{ refKind: 'universe', refId: 'world-1' }])).rejects.toThrow('Store unavailable');
  });
});
