/**
 * Focused tests for the "Pick from Catalog" wiring on UniverseCanonSection:
 *   - the pure `buildCanonEntryFromIngredient` payload→entry projection
 *     (stamps `ingredientId`, never leaks the catalog id into `entry.id`),
 *   - the component flow: button → IngredientPicker → updateUniverse +
 *     linkCatalogIngredient with role `canon-<kind>`.
 *
 * The peer-reconciliation invariant the PLAN calls out lives in the helper
 * test: identity must travel as `ingredientId` so the boot-time backfill
 * (`migrateBibleToCatalog`) recreates the SAME catalog row id on every peer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/apiCatalog', () => ({
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
  expandUniverseCharacter: vi.fn(),
}));

vi.mock('../../services/apiSystem', () => ({ generateImage: vi.fn() }));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import UniverseCanonSection, { buildCanonEntryFromIngredient } from './UniverseCanonSection';
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

describe('buildCanonEntryFromIngredient', () => {
  it('stamps ingredientId and keeps payload fields, never leaking the catalog id into entry.id', () => {
    const ingredient = {
      id: 'cat-chr-abc123',
      type: 'character',
      name: 'Rust Vega',
      payload: {
        id: 'foreign-id-should-be-dropped',
        physicalDescription: 'Lanky drifter in a sun-bleached coat',
        personality: 'wry',
        createdAt: '2020-01-01',
        updatedAt: '2020-01-02',
      },
    };
    const entry = buildCanonEntryFromIngredient(ingredient);
    expect(entry.ingredientId).toBe('cat-chr-abc123');
    expect(entry.id).toBeUndefined(); // server mints a fresh kind-prefixed id
    expect(entry.createdAt).toBeUndefined();
    expect(entry.updatedAt).toBeUndefined();
    expect(entry.name).toBe('Rust Vega');
    expect(entry.physicalDescription).toBe('Lanky drifter in a sun-bleached coat');
    expect(entry.personality).toBe('wry');
  });

  it('falls back to payload.name then a placeholder when the ingredient name is blank', () => {
    expect(buildCanonEntryFromIngredient({ id: 'x', payload: { name: 'From Payload' } }).name)
      .toBe('From Payload');
    expect(buildCanonEntryFromIngredient({ id: 'x', payload: {} }).name).toBe('Untitled');
  });

  it('returns null for non-object input', () => {
    expect(buildCanonEntryFromIngredient(null)).toBeNull();
    expect(buildCanonEntryFromIngredient('nope')).toBeNull();
  });
});

describe('UniverseCanonSection — Pick from Catalog', () => {
  it('opens the picker, then appends + links the picked ingredient with role canon-character', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockResolvedValue(baseUniverse({
      characters: [{ id: 'chr-server-minted', name: 'Rust Vega', ingredientId: 'cat-chr-abc123' }],
    }));
    listCatalogIngredients.mockResolvedValue({
      items: [{ id: 'cat-chr-abc123', type: 'character', name: 'Rust Vega', payload: { physicalDescription: 'drifter' } }],
    });

    renderSection({ onUniverseChange });

    fireEvent.click(screen.getByRole('button', { name: /pick character from catalog/i }));

    // Picker fetches and lists the catalog character; click its row.
    const row = await screen.findByRole('button', { name: /rust vega/i });
    fireEvent.click(row);

    await waitFor(() => expect(updateUniverse).toHaveBeenCalled());

    // updateUniverse received a full `characters` array whose new entry stamps
    // the catalog id as ingredientId (and carries no `id`).
    const [, patch] = updateUniverse.mock.calls[0];
    expect(Array.isArray(patch.characters)).toBe(true);
    const appended = patch.characters[patch.characters.length - 1];
    expect(appended.ingredientId).toBe('cat-chr-abc123');
    expect(appended.id).toBeUndefined();

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

  it('reverts the optimistic append when the save fails', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockRejectedValue(new Error('boom'));
    listCatalogIngredients.mockResolvedValue({
      items: [{ id: 'cat-chr-abc123', type: 'character', name: 'Rust Vega', payload: { physicalDescription: 'drifter' } }],
    });

    renderSection({ onUniverseChange });
    fireEvent.click(screen.getByRole('button', { name: /pick character from catalog/i }));
    const row = await screen.findByRole('button', { name: /rust vega/i });
    fireEvent.click(row);

    await waitFor(() => expect(updateUniverse).toHaveBeenCalled());
    // Optimistic append fires first (characters carries the new entry); the
    // failed save then reverts it, so the LAST onUniverseChange restores the
    // pre-append (empty) list and the catalog link is never attempted.
    await waitFor(() => {
      const lastPatch = onUniverseChange.mock.calls.at(-1)[0];
      expect(lastPatch.characters).toEqual([]);
    });
    expect(linkCatalogIngredient).not.toHaveBeenCalled();
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
