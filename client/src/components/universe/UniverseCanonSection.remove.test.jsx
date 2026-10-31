/**
 * Tests for the per-entry Remove (X) affordance on UniverseCanonSection.
 *
 * The contract mirrors the X button that already exists on category
 * variations + composite sheets: one click drops the entry from THIS
 * universe's canon bucket and nothing else. In particular it must go through
 * the dedicated DELETE endpoint (never a wholesale `updateUniverse` PATCH of
 * the array, which would clobber a concurrent render-completion imageRefs[]
 * append on a sibling) and it must not touch the gallery or the Catalog.
 *
 * The harness below owns the universe in real state rather than passing a
 * frozen prop, because the revert path reads the LIVE draft (via the
 * component's `latestUniverseRef`) to decide whether the optimistic removal
 * still needs undoing. A vi.fn() that swallows the change would make the
 * revert look like a no-op for the wrong reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiCatalog', () => ({
  getCatalogIngredientCards: vi.fn(async ids => ids.map(id => ({ id, type: 'character', name: id === 'ing-alex' ? 'Alex' : 'Catalog character', payload: {} }))),
  setCatalogIngredientLock: vi.fn(),
  listCatalogIngredients: vi.fn(),
  linkCatalogIngredient: vi.fn(),
  unlinkCatalogIngredient: vi.fn(),
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
  removeUniverseCanonImageRef: vi.fn(),
  expandUniverseCharacter: vi.fn(),
}));

vi.mock('../../services/apiSystem', () => ({ generateImage: vi.fn() }));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import UniverseCanonSection from './UniverseCanonSection';
import {
  removeUniverseCanonEntry, updateUniverse, getUniverseCanonUsage,
} from '../../services/apiUniverseBuilder';
import { unlinkCatalogIngredient } from '../../services/apiCatalog';

const ALEX = {
  id: 'chr-1',
  name: 'Alex',
  physicalDescription: 'jacket',
  imageRefs: ['alex.png'],
  primaryImageRef: 'alex.png',
  ingredientId: 'ing-alex',
  locked: false,
};
const BLAIR = { id: 'chr-2', name: 'Blair', physicalDescription: 'scarf', locked: false };

const baseUniverse = (over = {}) => ({
  id: 'uni-1',
  name: 'Test World',
  characters: [],
  places: [],
  objects: [],
  ...over,
});

// Stateful host so `onUniverseChange` actually swaps the rendered draft.
// `api.editLive(fn)` lets a test write into the live draft the way an async
// render completion does — i.e. without going through the component.
function Harness({ initial, onChange, kindFilter, api }) {
  const [universe, setUniverse] = useState(baseUniverse(initial));
  if (api) api.editLive = setUniverse;
  return (
    <UniverseCanonSection
      universe={universe}
      universeId="uni-1"
      onUniverseChange={(next) => { onChange?.(next); setUniverse(next); }}
      imageCfg={{}}
      kindFilter={kindFilter || 'characters'}
    />
  );
}

const renderSection = async ({ universe, onChange, kindFilter, api } = {}) => {
  const result = render(
    <MemoryRouter>
      <Harness initial={universe} onChange={onChange} kindFilter={kindFilter} api={api} />
    </MemoryRouter>,
  );
  // Settle the mount-time canon-usage fetch before the test interacts.
  await act(async () => {});
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
  getUniverseCanonUsage.mockResolvedValue({});
});

describe('UniverseCanonSection — remove entry', () => {
  it('shows shared canonical cards rather than expanded editors, with the catalog-selected cover and return context', async () => {
    const { getCatalogIngredientCards, setCatalogIngredientLock } = await import('../../services/apiCatalog');
    getCatalogIngredientCards.mockResolvedValueOnce([{ id: ALEX.ingredientId, type: 'character', name: ALEX.name,
      thumbnailKey: 'chosen-cover.png', payload: { ...ALEX, locked: true }, owningUniverse: { id: 'uni-1', name: 'Example world' }, usage: { universe: 1 } }]);
    setCatalogIngredientLock.mockResolvedValue({ id: ALEX.ingredientId, type: 'character', name: ALEX.name, payload: { ...ALEX, locked: false } });
    await renderSection({ universe: { characters: [ALEX] } });
    expect(screen.queryByLabelText('Pronouns')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Alex' })).toHaveAttribute('src', '/data/image-thumbnails/chosen-cover.webp');
    const href = screen.getByRole('link', { name: 'Open Alex' }).getAttribute('href');
    expect(href).toMatch(/^\/casting\/ing-alex\?returnTo=/);
    expect(screen.getByRole('button', { name: 'Render reference for Alex' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'AI differentiate Alex' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Alex' }));
    await screen.findByRole('button', { name: 'Lock Alex' });
    expect(setCatalogIngredientLock).toHaveBeenCalledWith(ALEX.ingredientId, false, { silent: true });
    expect(updateUniverse).not.toHaveBeenCalled();
  });
  it('calls the canon DELETE endpoint with the kind + entry id, touching nothing else', async () => {
    removeUniverseCanonEntry.mockResolvedValue({
      universe: baseUniverse({ characters: [BLAIR] }),
      entry: ALEX,
    });
    await renderSection({ universe: { characters: [ALEX, BLAIR] } });

    fireEvent.click(screen.getByRole('button', { name: /remove alex/i }));

    await waitFor(() => expect(removeUniverseCanonEntry).toHaveBeenCalled());
    expect(removeUniverseCanonEntry).toHaveBeenCalledWith(
      'uni-1', 'character', 'chr-1', expect.objectContaining({ silent: true }),
    );
    // Never the wholesale-array PATCH, and never a catalog mutation — the
    // entry's rendered image + catalog ingredient both survive.
    expect(updateUniverse).not.toHaveBeenCalled();
    expect(unlinkCatalogIngredient).not.toHaveBeenCalled();
    expect(screen.queryByText('Alex')).not.toBeInTheDocument();
    expect(screen.getByText('Blair')).toBeInTheDocument();
  });

  it('drops the card optimistically, before the request resolves', async () => {
    let resolveRemove;
    removeUniverseCanonEntry.mockReturnValue(new Promise((res) => { resolveRemove = res; }));
    const onChange = vi.fn();
    await renderSection({ universe: { characters: [ALEX, BLAIR] }, onChange });

    fireEvent.click(screen.getByRole('button', { name: /remove alex/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].characters.map((c) => c.id)).toEqual(['chr-2']);
    expect(screen.queryByText('Alex')).not.toBeInTheDocument();

    await act(async () => {
      resolveRemove({ universe: baseUniverse({ characters: [BLAIR] }), entry: ALEX });
    });
    expect(screen.queryByText('Alex')).not.toBeInTheDocument();
  });

  it('restores the entry, whole and in place, when the request fails', async () => {
    removeUniverseCanonEntry.mockRejectedValue(new Error('nope'));
    const onChange = vi.fn();
    await renderSection({ universe: { characters: [ALEX, BLAIR] }, onChange });

    fireEvent.click(screen.getByRole('button', { name: /remove alex/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    const restored = onChange.mock.calls[1][0].characters;
    expect(restored.map((c) => c.id)).toEqual(['chr-1', 'chr-2']);
    // Restored whole — the image refs + catalog backlink round-trip intact.
    expect(restored[0]).toEqual(ALEX);
    expect(screen.getByText('Alex')).toBeInTheDocument();
  });

  it('reverts without clobbering a sibling edit that landed mid-request', async () => {
    // A reference render completing during the request stamps a SIBLING's
    // imageRefs[] with no user action at all, so the revert must merge against
    // the LIVE draft rather than the pre-removal snapshot — otherwise the
    // failed removal rolls that stamp back out of view. `editLive` stands in
    // for that async completion writing into the parent's draft.
    let rejectRemove;
    removeUniverseCanonEntry.mockReturnValue(new Promise((_, rej) => { rejectRemove = rej; }));
    const onChange = vi.fn();
    const api = {};
    await renderSection({ universe: { characters: [ALEX, BLAIR] }, onChange, api });

    fireEvent.click(screen.getByRole('button', { name: /remove alex/i }));

    // Mid-flight: a render completion stamps Blair with a new image ref.
    await act(async () => {
      api.editLive((u) => ({
        ...u,
        characters: u.characters.map((c) =>
          (c.id === 'chr-2' ? { ...c, imageRefs: ['blair-new.png'] } : c)),
      }));
    });

    await act(async () => { rejectRemove(new Error('nope')); });

    await waitFor(() => expect(screen.getByText('Alex')).toBeInTheDocument());
    const final = onChange.mock.calls.at(-1)[0].characters;
    // Alex is back at index 0...
    expect(final.map((c) => c.id)).toEqual(['chr-1', 'chr-2']);
    // ...and the sibling's mid-flight stamp survived the revert.
    expect(final.find((c) => c.id === 'chr-2').imageRefs).toEqual(['blair-new.png']);
  });

  it('offers Remove on locked entries — the lock guards AI rewrites, not removal', async () => {
    await renderSection({ universe: { characters: [{ ...ALEX, locked: true }] } });
    expect(screen.getByRole('button', { name: /remove alex/i })).toBeEnabled();
  });

  it.each([
    ['places', { id: 'plc-1', name: 'The Vault', description: 'a room' }],
    ['objects', { id: 'obj-1', name: 'The Key', description: 'brass' }],
  ])('renders a Remove button for %s too', async (kindKey, entry) => {
    await renderSection({ kindFilter: kindKey, universe: { [kindKey]: [entry] } });
    expect(screen.getByRole('button', { name: new RegExp(`remove ${entry.name}`, 'i') }))
      .toBeInTheDocument();
  });
});
