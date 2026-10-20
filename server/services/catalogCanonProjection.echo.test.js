import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./catalogDB.js', () => ({
  getIngredient: vi.fn(),
  getIngredientIdentityIds: vi.fn(async (id) => [id, `${id}-alias`]),
  listRefsForIngredient: vi.fn(async () => [{ refKind: 'universe', refId: 'universe-a' }]),
  getIngredientTimestamps: vi.fn(async (ids) => new Map(ids.map((id) => [id, '2026-01-01T00:00:00.000Z']))),
  updateIngredient: vi.fn(async () => ({})),
}));
vi.mock('./catalogDB/identityAccess.js', () => ({ getCatalogIdentityAccess: vi.fn(async () => null) }));

import * as catalogDB from './catalogDB.js';
import { projectToCanon, projectToCatalog } from './catalogCanonProjection.js';

const entry = (ingredientId) => ({
  id: `entry-${ingredientId}`, ingredientId, name: 'Independent edit',
  updatedAt: '2026-02-01T00:00:00.000Z',
});
const ingredient = { id: 'ingredient-a', name: 'Catalog edit', payload: {}, updatedAt: '2026-01-01T00:00:00.000Z' };

// Pause at the universe write boundary; no timers, live storage, or peer traffic.
function heldProjection() {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const updateUniverse = async (universeId, mutator, options) => {
    const projected = await mutator({ characters: [entry('ingredient-a-alias')] });
    entered.resolve({ universeId, projected, options });
    await release.promise;
    return projected;
  };
  return { entered: entered.promise, release: release.resolve, updateUniverse };
}

beforeEach(() => {
  vi.clearAllMocks();
  catalogDB.getIngredient.mockResolvedValue(ingredient);
});

describe('operation-scoped catalog projection echoes', () => {
  it('lets independent saves in the same and another universe write while a forward projection waits', async () => {
    const held = heldProjection();
    const forward = projectToCanon(ingredient.id, ingredient, held);
    await held.entered;
    try {
      for (const universeId of ['universe-a', 'universe-b']) {
        expect(await projectToCatalog(universeId, { characters: [entry(ingredient.id)] }))
          .toEqual({ written: 1, skipped: 0 });
      }
      expect(catalogDB.updateIngredient).toHaveBeenCalledTimes(2);
    } finally {
      held.release();
      await forward;
    }
  });

  it.each([[0, 1], [1, 0]])('preserves each echo guard when overlapping calls settle %s then %s', async (first, second) => {
    const held = [heldProjection(), heldProjection()];
    const pending = held.map((deps) => projectToCanon(ingredient.id, ingredient, deps));
    const calls = await Promise.all(held.map((op) => op.entered));
    try {
      held[first].release();
      await pending[first];
      for (const index of [first, second]) {
        const { universeId, projected, options } = calls[index];
        expect(projected.characters[0].ingredientId).toBe(ingredient.id);
        const result = await projectToCatalog(universeId, {
          characters: [...projected.characters, entry('ingredient-a-alias'), entry('ingredient-b')],
        }, {
          guardToken: options.canonProjectionGuard,
          guardIdentityIds: options.canonProjectionIdentityIds,
        });
        // The guard covers canonical and alias echoes only, even after another
        // overlapping projection finishes. Unrelated canon still writes.
        expect(result).toEqual({ written: 1, skipped: 2 });
      }
      expect(catalogDB.updateIngredient.mock.calls.map(([id]) => id)).toEqual(['ingredient-b', 'ingredient-b']);
      expect(await projectToCatalog('universe-a', { characters: [entry(ingredient.id)] }))
        .toEqual({ written: 1, skipped: 0 });
    } finally {
      held.forEach((op) => op.release());
      await Promise.all(pending);
    }
  });
});
