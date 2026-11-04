import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

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

  it('loads later pages and retains selected rows when a page fails and is retried', async () => {
    const first = Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}`, name: `Item ${i}`, type: 'object', payload: {} }));
    listCatalogIngredients.mockImplementation(({ offset }) => {
      if (!offset) return Promise.resolve({ items: first, nextOffset: 50 });
      return Promise.reject(new Error('later page unavailable'));
    });
    const onSelect = vi.fn();
    renderPicker({ multi: true, onSelect });
    fireEvent.click(await screen.findByLabelText('Select Item 0'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more ingredients' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('later page unavailable');
    expect(screen.getByLabelText('Select Item 0')).toBeChecked();
    listCatalogIngredients.mockResolvedValue({ items: [{ id: 'item-50', name: 'Older item', type: 'object', payload: {} }], nextOffset: 51 });
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    fireEvent.click(await screen.findByLabelText('Select Older item'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Selected' }));
    expect(onSelect).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'item-0' }), expect.objectContaining({ id: 'item-50' }),
    ]));
  });

  it('renders the empty state with a link to the catalog when nothing matches', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    renderPicker();
    await waitFor(() => expect(screen.getByText(/No matching ingredients/i)).toBeTruthy());
    expect(screen.getByRole('link', { name: /Create new in Catalog/i })).toBeTruthy();
  });

  it('shows a load error with Retry instead of the empty-catalog copy when the fetch rejects', async () => {
    listCatalogIngredients.mockRejectedValueOnce(new Error('catalog 500'));
    renderPicker();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load ingredients — catalog 500');
    expect(screen.queryByText(/No matching ingredients/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /Create new in Catalog/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
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
