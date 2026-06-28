import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Spy on navigation so the "Remix into…" handoff can assert the target route +
// the generic `remix.ingredientIds` state payload. MemoryRouter still supplies
// the real Link/router context.
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../services/apiCatalog', () => ({
  listCatalogIngredients: vi.fn(),
  createCatalogIngredient: vi.fn(),
  deleteCatalogIngredient: vi.fn(),
  linkCatalogIngredient: vi.fn(),
  getCatalogStats: vi.fn(),
  getCatalogFacets: vi.fn(),
  rerunCatalogMigration: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// useCatalogTypes (via Catalog) fetches the type registry — mock the API so a
// user-defined type surfaces as a filter chip + dropdown option.
vi.mock('../services/apiCatalogTypes', () => ({
  listCatalogTypes: vi.fn(),
}));

// MediaImage pulls in the socket service; stub it to a plain <img> so the card
// thumbnail's src/alt are assertable without the socket wiring.
vi.mock('../components/MediaImage', () => ({
  default: ({ src, alt, ...rest }) => <img src={src} alt={alt} {...rest} />,
}));

import Catalog from './Catalog';
import {
  listCatalogIngredients,
  createCatalogIngredient,
  deleteCatalogIngredient,
  linkCatalogIngredient,
  getCatalogStats,
  getCatalogFacets,
  rerunCatalogMigration,
} from '../services/apiCatalog';
import { listCatalogTypes } from '../services/apiCatalogTypes';
import toast from '../components/ui/Toast';

const sample = [
  { id: 'i-1', name: 'Echo Saint', type: 'character', payload: { physicalDescription: 'A wiry figure in a long coat.' }, tags: ['noir'] },
  { id: 'i-2', name: 'Old Harbor', type: 'place', payload: { description: 'Brine and rust.' }, tags: [] },
];

const renderCatalog = () => render(
  <MemoryRouter>
    <Catalog />
  </MemoryRouter>,
);

const sampleFacets = {
  types: [{ type: 'character', count: 1 }, { type: 'place', count: 1 }],
  universes: [{ refId: 'u-1', name: 'Echo Saints', count: 1 }],
  series: [{ refId: 's-1', name: 'Season 1', universeId: 'u-1', count: 1 }],
  tags: [{ tag: 'noir', count: 1 }],
  unlinkedCount: 1,
  orphanedCount: 0,
  total: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  listCatalogIngredients.mockResolvedValue({ items: sample, nextOffset: sample.length });
  linkCatalogIngredient.mockResolvedValue({ success: true });
  getCatalogStats.mockResolvedValue({ total: 2, byType: { character: 1, place: 1 } });
  getCatalogFacets.mockResolvedValue(sampleFacets);
  rerunCatalogMigration.mockResolvedValue({ stats: { promoted: 0 } });
  // Default: system registry only (the hook merges with the static fallback).
  listCatalogTypes.mockResolvedValue({ types: [] });
});

describe('Catalog page', () => {
  it('renders the fetched ingredient cards with snippet + count', async () => {
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());
    expect(screen.getByText('Old Harbor')).toBeTruthy();
    expect(screen.getByText(/wiry figure in a long coat/i)).toBeTruthy();
    // Total count comes from stats.
    expect(screen.getByText(/2 ingredients/i)).toBeTruthy();
  });

  it('filters by type when a type chip is clicked', async () => {
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Character/i }));
    await waitFor(() => {
      expect(listCatalogIngredients).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'character' }),
      );
    });
  });

  it('debounces search input into the list fetch', async () => {
    vi.useFakeTimers();
    renderCatalog();
    // Drain the initial mount fetch.
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    fireEvent.change(screen.getByLabelText(/Search catalog/i), { target: { value: 'harbor' } });
    // Before the debounce window elapses, q hasn't been pushed yet.
    expect(listCatalogIngredients).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 'harbor' }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(listCatalogIngredients).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'harbor' }),
    );
    vi.useRealTimers();
  });

  it('creates an ingredient and optimistically prepends it', async () => {
    createCatalogIngredient.mockResolvedValue({
      id: 'i-3', name: 'New Idea', type: 'idea', payload: { summary: 'spark' }, tags: [],
    });
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^New$/i }));
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: 'New Idea' } });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText(/^Name$/i).closest('form'));
    });

    expect(createCatalogIngredient).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Idea' }),
      { silent: true },
    );
    await waitFor(() => expect(screen.getByText('New Idea')).toBeTruthy());
    // Assert the PREPEND contract (not just existence): the new card must
    // render before the pre-existing "Echo Saint" card in document order.
    const newEl = screen.getByText('New Idea');
    const echoEl = screen.getByText('Echo Saint');
    expect(newEl.compareDocumentPosition(echoEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toast.success).toHaveBeenCalled();
  });

  it('two-click-arms then deletes a card, removing it locally', async () => {
    deleteCatalogIngredient.mockResolvedValue({ success: true });
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    // Arm: the per-card Delete button reveals the Yes/No confirm.
    fireEvent.click(screen.getByLabelText(/Delete Echo Saint/i));
    const yesBtn = await screen.findByRole('button', { name: /^Yes$/i });

    await act(async () => { fireEvent.click(yesBtn); });

    await waitFor(() => expect(screen.queryByText('Echo Saint')).toBeNull());
    expect(screen.getByText('Old Harbor')).toBeTruthy();
    expect(deleteCatalogIngredient).toHaveBeenCalledWith('i-1', { silent: true });
  });

  it('restores the row when delete fails', async () => {
    deleteCatalogIngredient.mockRejectedValue(new Error('nope'));
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/Delete Echo Saint/i));
    const yesBtn = await screen.findByRole('button', { name: /^Yes$/i });
    await act(async () => { fireEvent.click(yesBtn); });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // Optimistic removal is rolled back.
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());
  });

  it('shows the empty state when the catalog has no ingredients', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    getCatalogStats.mockResolvedValue({ total: 0, byType: {} });
    renderCatalog();
    await waitFor(() => expect(screen.getByText(/Your catalog is empty/i)).toBeTruthy());
  });

  it('surfaces a toast when the list fetch fails', async () => {
    listCatalogIngredients.mockRejectedValue(new Error('load failed'));
    renderCatalog();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('load failed'));
  });

  it('syncs from universes and reloads the list when items were promoted', async () => {
    rerunCatalogMigration.mockResolvedValue({ stats: { promoted: 3 } });
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());
    const callsBefore = listCatalogIngredients.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sync from Universes/i }));
    });

    expect(rerunCatalogMigration).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, silent: true }),
    );
    // A non-zero promote count reloads the list + stats so new items appear.
    await waitFor(() => expect(listCatalogIngredients.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Synced 3 canon items/i));
  });

  it('reports an up-to-date catalog without reloading when nothing was promoted', async () => {
    rerunCatalogMigration.mockResolvedValue({ stats: { promoted: 0 } });
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());
    const callsBefore = listCatalogIngredients.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sync from Universes/i }));
    });

    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/already up to date/i));
    expect(listCatalogIngredients.mock.calls.length).toBe(callsBefore);
  });

  it('surfaces an error toast (not a success) when the sync reports errors', async () => {
    rerunCatalogMigration.mockResolvedValue({ stats: { promoted: 0, errors: 2 } });
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sync from Universes/i }));
    });

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Sync hit 2 errors/i));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/up to date/i));
  });

  it('renders a card thumbnail when the ingredient has a thumbnail key', async () => {
    listCatalogIngredients.mockResolvedValue({
      items: [{ ...sample[0], thumbnailKey: 'hero.png' }],
    });
    renderCatalog();
    const img = await screen.findByAltText('Echo Saint');
    expect(img.getAttribute('src')).toBe('/data/images/hero.png');
  });

  it('multi-selects ingredients and remixes them into Story Builder with a generic state payload', async () => {
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    // No action bar until something is selected.
    expect(screen.queryByText(/selected$/i)).toBeNull();

    fireEvent.click(screen.getByLabelText('Select Echo Saint'));
    fireEvent.click(screen.getByLabelText('Select Old Harbor'));
    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy());

    // Open the Remix menu and choose Story Builder.
    fireEvent.click(screen.getByRole('button', { name: /Remix into/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Story Builder' }));

    expect(navigateMock).toHaveBeenCalledWith('/story-builder', {
      state: { remix: { ingredientIds: ['i-1', 'i-2'] } },
    });
  });

  it('toggling a selection checkbox does not navigate to the card detail', async () => {
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Select Echo Saint'));
    // Selection is a distinct gesture from opening the card — no navigation.
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('drops a deleted ingredient from the selection so the count stays honest', async () => {
    deleteCatalogIngredient.mockResolvedValue({ success: true });
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Select Echo Saint'));
    fireEvent.click(screen.getByLabelText('Select Old Harbor'));
    expect(screen.getByText('2 selected')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Delete Echo Saint/i));
    const yesBtn = await screen.findByRole('button', { name: /^Yes$/i });
    await act(async () => { fireEvent.click(yesBtn); });

    await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());
  });

  it('renders a user-defined type as a filter chip from the merged registry', async () => {
    listCatalogTypes.mockResolvedValue({
      types: [{ id: 'faction', label: 'Faction', system: false, badgeColor: 'bg-gray-500/20 text-gray-300 border-gray-500/40', primaryContentKey: 'creed', primaryContentLabel: 'Creed', snippetFallbackKeys: ['creed'], fields: [] }],
    });
    renderCatalog();
    // The built-in chips render synchronously; the user chip appears after the
    // type-registry fetch resolves.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Faction/i })).toBeTruthy());
  });

  it('filters by universe via the dropdown, passing a ref filter to the list fetch', async () => {
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^Universe$/i), { target: { value: 'u-1' } });
    await waitFor(() => {
      expect(listCatalogIngredients).toHaveBeenLastCalledWith(
        expect.objectContaining({ refKind: 'universe', refId: 'u-1' }),
      );
    });
  });

  it('paginates with "Load more", appending the next page at the right offset', async () => {
    const firstPage = Array.from({ length: 60 }, (_, i) => ({
      id: `p-${i}`, name: `Item ${i}`, type: 'idea', payload: {}, tags: [],
    }));
    listCatalogIngredients
      .mockResolvedValueOnce({ items: firstPage, nextOffset: 60 })
      .mockResolvedValueOnce({ items: [{ id: 'p-60', name: 'Item 60', type: 'idea', payload: {}, tags: [] }], nextOffset: 61 });
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Item 0')).toBeTruthy());

    const loadMore = screen.getByRole('button', { name: /Load more/i });
    await act(async () => { fireEvent.click(loadMore); });

    expect(listCatalogIngredients).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 60 }),
    );
    await waitFor(() => expect(screen.getByText('Item 60')).toBeTruthy());
  });

  it('switches to the Albums view and lazy-loads the Raw album', async () => {
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Albums$/i }));
    // Raw album is pinned + default-expanded → it fetches the unlinked set, and
    // the live universe album header shows from /facets.
    await waitFor(() => expect(screen.getByText('Unsorted / Raw')).toBeTruthy());
    expect(screen.getByText('Echo Saints')).toBeTruthy();
    await waitFor(() => {
      expect(listCatalogIngredients).toHaveBeenCalledWith(
        expect.objectContaining({ unlinked: true }),
      );
    });
  });

  it('paginates an album past one page with its own Load more', async () => {
    const rawPage = Array.from({ length: 60 }, (_, i) => ({
      id: `raw-${i}`, name: `Raw ${i}`, type: 'idea', payload: {}, tags: [],
    }));
    // Grid loads return the default sample; the Raw album (unlinked) gets a full
    // first page then a short second page.
    listCatalogIngredients.mockImplementation((params = {}) => {
      if (params.unlinked && params.offset === 0) return Promise.resolve({ items: rawPage, nextOffset: 60 });
      if (params.unlinked && params.offset === 60) return Promise.resolve({ items: [{ id: 'raw-60', name: 'Raw 60', type: 'idea', payload: {}, tags: [] }], nextOffset: 61 });
      return Promise.resolve({ items: sample, nextOffset: sample.length });
    });
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Albums$/i }));
    await waitFor(() => expect(screen.getByText('Raw 0')).toBeTruthy());

    const loadMore = await screen.findByRole('button', { name: /Load more/i });
    await act(async () => { fireEvent.click(loadMore); });

    expect(listCatalogIngredients).toHaveBeenCalledWith(
      expect.objectContaining({ unlinked: true, offset: 60 }),
    );
    await waitFor(() => expect(screen.getByText('Raw 60')).toBeTruthy());
  });

  it('bulk-places the selection into a universe with type-derived roles', async () => {
    renderCatalog();
    await waitFor(() => expect(screen.getByText('Echo Saint')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Select Echo Saint'));
    fireEvent.click(screen.getByLabelText('Select Old Harbor'));
    expect(screen.getByText('2 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Add to universe\/series/i }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Echo Saints' }));
    });

    // character → cast-character, place → cast-place.
    expect(linkCatalogIngredient).toHaveBeenCalledWith(
      'i-1', { refKind: 'universe', refId: 'u-1', role: 'cast-character' }, { silent: true },
    );
    expect(linkCatalogIngredient).toHaveBeenCalledWith(
      'i-2', { refKind: 'universe', refId: 'u-1', role: 'cast-place' }, { silent: true },
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Added 2 ingredients to Echo Saints/i));
  });
});
