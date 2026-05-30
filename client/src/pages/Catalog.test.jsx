import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/apiCatalog', () => ({
  listCatalogIngredients: vi.fn(),
  createCatalogIngredient: vi.fn(),
  deleteCatalogIngredient: vi.fn(),
  getCatalogStats: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import Catalog from './Catalog';
import {
  listCatalogIngredients,
  createCatalogIngredient,
  deleteCatalogIngredient,
  getCatalogStats,
} from '../services/apiCatalog';
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

beforeEach(() => {
  vi.clearAllMocks();
  listCatalogIngredients.mockResolvedValue({ items: sample });
  getCatalogStats.mockResolvedValue({ total: 2, byType: { character: 1, place: 1 } });
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
});
