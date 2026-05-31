import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/apiCatalog', () => ({
  listCatalogIngredients: vi.fn(),
}));

import IngredientPicker from './IngredientPicker';
import { listCatalogIngredients } from '../services/apiCatalog';

const sample = [
  { id: 'i-1', name: 'Ada Lovelace', type: 'character', payload: { description: 'Mathematician, programmer, dreamer.' }, tags: ['historical'] },
  { id: 'i-2', name: 'Babbage Hall', type: 'place', payload: { description: 'A drafty workshop full of brass.' } },
];

const renderPicker = (props = {}) => render(
  <MemoryRouter>
    <IngredientPicker open onClose={() => {}} onSelect={() => {}} {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  listCatalogIngredients.mockResolvedValue({ items: sample });
});

describe('IngredientPicker', () => {
  it('does not fetch or render its chrome while closed', () => {
    render(
      <MemoryRouter>
        <IngredientPicker open={false} onClose={() => {}} onSelect={() => {}} />
      </MemoryRouter>,
    );
    expect(listCatalogIngredients).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: /Pick an ingredient/i })).toBeNull();
  });

  it('fetches and renders the ingredient rows when open', async () => {
    renderPicker();
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
    expect(screen.getByText('Babbage Hall')).toBeTruthy();
    expect(screen.getByText(/Mathematician, programmer/i)).toBeTruthy();
    // The first fetch goes out with no query and silent mode.
    expect(listCatalogIngredients).toHaveBeenCalledWith(
      expect.objectContaining({ q: undefined, limit: 50, silent: true }),
    );
  });

  it('scopes the fetch to the supplied type and labels the heading', async () => {
    renderPicker({ type: 'character' });
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
    expect(listCatalogIngredients).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'character' }),
    );
    expect(screen.getByText('(character)')).toBeTruthy();
  });

  it('hides ingredients listed in excludeIds', async () => {
    renderPicker({ excludeIds: ['i-1'] });
    await waitFor(() => expect(screen.getByText('Babbage Hall')).toBeTruthy());
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('single-select fires onSelect with the row then closes', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderPicker({ onSelect, onClose });
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());

    fireEvent.click(screen.getByText('Ada Lovelace'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'i-1' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('multi-select collects checked rows and fires onSelect with an array', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderPicker({ multi: true, onSelect, onClose });
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/Select Ada Lovelace/i));
    fireEvent.click(screen.getByLabelText(/Select Babbage Hall/i));
    expect(screen.getByText('2 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Add Selected/i }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'i-1' }),
        expect.objectContaining({ id: 'i-2' }),
      ]),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the empty state with a link to the catalog when nothing matches', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    renderPicker();
    await waitFor(() => expect(screen.getByText(/No matching ingredients/i)).toBeTruthy());
    expect(screen.getByRole('link', { name: /Create new in Catalog/i })).toBeTruthy();
  });

  it('falls back to an empty list when the fetch rejects', async () => {
    listCatalogIngredients.mockRejectedValue(new Error('boom'));
    renderPicker();
    await waitFor(() => expect(screen.getByText(/No matching ingredients/i)).toBeTruthy());
  });

  it('disables Add Selected until at least one row is checked', async () => {
    renderPicker({ multi: true });
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
    const addBtn = screen.getByRole('button', { name: /Add Selected/i });
    expect(addBtn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Select Ada Lovelace/i));
    await act(async () => {}); // flush state
    expect(addBtn.disabled).toBe(false);
  });
});
