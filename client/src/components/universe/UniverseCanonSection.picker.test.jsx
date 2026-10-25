// Catalog picks use server ownership admission and preserve canonical identity.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiCatalog', () => ({
  getCatalogIngredientCards: vi.fn(async ids => ids.map(id => ({ id, type: 'character', name: 'Catalog character', payload: {} }))),
  setCatalogIngredientLock: vi.fn(),
  listCatalogIngredients: vi.fn(),
  linkCatalogIngredient: vi.fn(),
}));

vi.mock('../../services/apiUniverseBuilder', () => ({
  extractUniverseCanon: vi.fn(),
  refineUniverseCharacter: vi.fn(),
  differentiateUniverseCast: vi.fn(),
  updateUniverse: vi.fn(),
  getUniverseCanonUsage: vi.fn(),
  setUniverseCanonLock: vi.fn(),
  setUniverseCanonLockAll: vi.fn(),
  removeUniverseCanonEntry: vi.fn(),
  expandUniverseCharacter: vi.fn(),
}));

vi.mock('../../services/apiSystem', () => ({ generateImage: vi.fn() }));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import UniverseCanonSection from './UniverseCanonSection';
import { listCatalogIngredients, linkCatalogIngredient } from '../../services/apiCatalog';
import { updateUniverse, getUniverseCanonUsage } from '../../services/apiUniverseBuilder';

const baseUniverse = (over = {}) => ({
  id: 'uni-1',
  name: 'Test World',
  characters: [],
  places: [],
  objects: [],
  ...over,
});

const renderSection = (props = {}) => render(
  <MemoryRouter>
    <UniverseCanonSection
      universe={baseUniverse(props.universe)}
      universeId="uni-1"
      onUniverseChange={props.onUniverseChange || vi.fn()}
      imageCfg={{}}
      kindFilter="characters"
      {...props}
    />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  getUniverseCanonUsage.mockResolvedValue({});
  listCatalogIngredients.mockResolvedValue({ items: [] });
  linkCatalogIngredient.mockResolvedValue({ success: true });
});

describe('UniverseCanonSection — Pick from Catalog', () => {
  it('opens the picker, then appends + links the picked ingredient with role canon-character', async () => {
    const onUniverseChange = vi.fn();
    linkCatalogIngredient.mockResolvedValue({ success: true, universe: baseUniverse({
      characters: [{ id: 'chr-server-minted', name: 'Rust Vega', ingredientId: 'cat-chr-abc123' }],
    }) });
    listCatalogIngredients.mockResolvedValue({
      items: [{ id: 'cat-chr-abc123', type: 'character', name: 'Rust Vega', payload: { physicalDescription: 'drifter' } }],
    });

    renderSection({ onUniverseChange });

    fireEvent.click(screen.getByRole('button', { name: /pick character from catalog/i }));

    // Picker fetches and lists the catalog character; click its row.
    const row = await screen.findByRole('button', { name: /rust vega/i });
    fireEvent.click(row);

    await waitFor(() => expect(onUniverseChange).toHaveBeenCalledWith(expect.objectContaining({
      characters: [expect.objectContaining({ id: 'chr-server-minted', ingredientId: 'cat-chr-abc123' })],
    })));
    expect(updateUniverse).not.toHaveBeenCalled();

    await waitFor(() => expect(linkCatalogIngredient).toHaveBeenCalledWith(
      'cat-chr-abc123',
      { refKind: 'universe', refId: 'uni-1', role: 'canon-character' },
      { silent: true },
    ));
  });

  it('derives the role per-kind: a picked place links as canon-place', async () => {
    // Guards the `canon-${kind.apiKind}` derivation the backfill depends on —
    // a regression that hard-coded "character" would otherwise pass CI.
    const onUniverseChange = vi.fn();
    updateUniverse.mockResolvedValue(baseUniverse({
      places: [{ id: 'plc-server', name: 'The Hollow', ingredientId: 'cat-plc-1' }],
    }));
    listCatalogIngredients.mockResolvedValue({
      items: [{ id: 'cat-plc-1', type: 'place', name: 'The Hollow', payload: { description: 'tunnel' } }],
    });

    renderSection({ onUniverseChange, kindFilter: 'places' });
    fireEvent.click(screen.getByRole('button', { name: /pick place from catalog/i }));
    const row = await screen.findByRole('button', { name: /the hollow/i });
    fireEvent.click(row);

    await waitFor(() => expect(linkCatalogIngredient).toHaveBeenCalledWith(
      'cat-plc-1',
      { refKind: 'universe', refId: 'uni-1', role: 'canon-place' },
      { silent: true },
    ));
  });

  it('leaves the universe draft intact when ownership admission fails', async () => {
    const onUniverseChange = vi.fn();
    linkCatalogIngredient.mockRejectedValue(new Error('Resolve ownership first'));
    listCatalogIngredients.mockResolvedValue({
      items: [{ id: 'cat-chr-abc123', type: 'character', name: 'Rust Vega', payload: { physicalDescription: 'drifter' } }],
    });

    renderSection({ onUniverseChange });
    fireEvent.click(screen.getByRole('button', { name: /pick character from catalog/i }));
    const row = await screen.findByRole('button', { name: /rust vega/i });
    fireEvent.click(row);

    await waitFor(() => expect(linkCatalogIngredient).toHaveBeenCalled());
    expect(onUniverseChange).not.toHaveBeenCalled();
    expect(updateUniverse).not.toHaveBeenCalled();
  });

  it('refuses to add an ingredient already linked by ingredientId', async () => {
    const onUniverseChange = vi.fn();
    listCatalogIngredients.mockResolvedValue({
      items: [{ id: 'cat-chr-dup', type: 'character', name: 'Dup', payload: {} }],
    });

    renderSection({
      onUniverseChange,
      universe: { characters: [{ id: 'chr-1', name: 'Dup', ingredientId: 'cat-chr-dup' }] },
    });

    fireEvent.click(screen.getByRole('button', { name: /pick character from catalog/i }));
    // Already-linked ingredients are excluded from the picker list, so the
    // happy path can't even surface a duplicate. Assert the exclusion holds:
    // the picker shows its empty state rather than the duplicate row.
    await waitFor(() => expect(listCatalogIngredients).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^dup$/i })).toBeNull();
    expect(updateUniverse).not.toHaveBeenCalled();
  });
});
