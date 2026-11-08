import { expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useCatalogPlaces from './useCatalogPlaces.js';

vi.mock('./useVisibilityEvent.js', () => ({ useVisibilityEvent: () => {} }));
vi.mock('../services/apiCatalog.js', () => ({
  // Like the server, one call answers at most 50 ids; "gone" was deleted.
  listCatalogIngredientsByIds: vi.fn(async (ids) => ids.slice(0, 50).filter((id) => id !== 'gone').map((id) => ({ id, type: 'place' }))),
  listCatalogIngredientMedia: vi.fn(async (id) => { if (id === 'gone') throw new Error('Not found'); return []; }),
}));

// Catches one deleted place (or a world past the 50-id batch cap) turning every set into "missing".
it('marks only the removed place missing, across more ids than one batch read answers', async () => {
  const ids = [...Array.from({ length: 55 }, (_, i) => `p${String(i).padStart(2, '0')}`), 'gone'];
  const { result } = renderHook(() => useCatalogPlaces(ids));
  await waitFor(() => expect(Object.keys(result.current)).toHaveLength(56));
  expect(result.current.gone).toBeNull();
  expect(Object.values(result.current).filter((entry) => entry === null)).toHaveLength(1);
  expect(result.current.p54.ingredient.id).toBe('p54');
});
