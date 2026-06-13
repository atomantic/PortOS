/**
 * Tests for the manual "Add" affordance on UniverseCanonSection — minting a
 * blank canon entry from a typed name (+ optional description) without going
 * through Extract-from-prose / Pick-from-Catalog / promote-variation.
 *
 * Mirrors the optimistic-append-then-persist contract the catalog-pick path
 * uses: the new entry carries no `id` (server mints it), lands `locked: false`
 * so the card is immediately editable, and the typed description is written to
 * the kind's `descField` (physicalDescription for characters, description for
 * places/objects).
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

import UniverseCanonSection from './UniverseCanonSection';
import { updateUniverse, getUniverseCanonUsage } from '../../services/apiUniverseBuilder';
import toast from '../ui/Toast';

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
      kindFilter={props.kindFilter || 'characters'}
      {...props}
    />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  getUniverseCanonUsage.mockResolvedValue({});
});

describe('UniverseCanonSection — manual Add', () => {
  it('opens the form and persists a new character with locked:false + description in physicalDescription', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockResolvedValue(baseUniverse({
      characters: [{ id: 'chr-server', name: 'Rust Vega', physicalDescription: 'drifter', locked: false }],
    }));

    renderSection({ onUniverseChange });

    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: '  Rust Vega  ' } });
    fireEvent.change(screen.getByLabelText(/new character description/i), { target: { value: 'drifter' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(updateUniverse).toHaveBeenCalled());
    const [, patch] = updateUniverse.mock.calls[0];
    expect(Array.isArray(patch.characters)).toBe(true);
    const appended = patch.characters[patch.characters.length - 1];
    expect(appended.name).toBe('Rust Vega'); // trimmed
    expect(appended.id).toBeUndefined(); // server mints it
    expect(appended.locked).toBe(false); // immediately editable
    expect(appended.physicalDescription).toBe('drifter');
  });

  it('writes the description to `description` for places', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockResolvedValue(baseUniverse({
      places: [{ id: 'plc-server', name: 'The Hollow', description: 'a tunnel', locked: false }],
    }));

    renderSection({ onUniverseChange, kindFilter: 'places' });

    fireEvent.click(screen.getByRole('button', { name: /add place/i }));
    fireEvent.change(screen.getByLabelText(/new place name/i), { target: { value: 'The Hollow' } });
    fireEvent.change(screen.getByLabelText(/new place description/i), { target: { value: 'a tunnel' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(updateUniverse).toHaveBeenCalled());
    const [, patch] = updateUniverse.mock.calls[0];
    const appended = patch.places[patch.places.length - 1];
    expect(appended.description).toBe('a tunnel');
  });

  it('omits the description field entirely when left blank', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockResolvedValue(baseUniverse({
      characters: [{ id: 'chr-server', name: 'Nameless', locked: false }],
    }));

    renderSection({ onUniverseChange });
    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: 'Nameless' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(updateUniverse).toHaveBeenCalled());
    const [, patch] = updateUniverse.mock.calls[0];
    const appended = patch.characters[patch.characters.length - 1];
    expect('physicalDescription' in appended).toBe(false);
  });

  it('refuses to add a duplicate name (case-insensitive) without calling the server', async () => {
    const onUniverseChange = vi.fn();
    renderSection({
      onUniverseChange,
      universe: { characters: [{ id: 'chr-1', name: 'Dup' }] },
    });

    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: 'dup' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already in this universe/i)));
    expect(updateUniverse).not.toHaveBeenCalled();
  });

  it('reverts the optimistic append when the save fails', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockRejectedValue(new Error('boom'));

    renderSection({ onUniverseChange });
    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: 'Rust Vega' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(updateUniverse).toHaveBeenCalled());
    // Optimistic append fires first; the failed save reverts to the empty list.
    await waitFor(() => {
      const lastPatch = onUniverseChange.mock.calls.at(-1)[0];
      expect(lastPatch.characters).toEqual([]);
    });
  });
});
