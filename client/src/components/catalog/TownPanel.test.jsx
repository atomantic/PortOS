import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import TownPanel from './TownPanel.jsx';

vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../hooks/useCatalogPlaces', () => ({
  default: () => ({ 'cat-street': { ingredient: { id: 'cat-street', type: 'place', name: 'Example Street', payload: {} }, media: [] } }),
}));
vi.mock('../../services/apiCatalog', () => ({
  listCatalogIngredients: vi.fn(async () => ({ items: [] })),
  saveCatalogTown: vi.fn(async (id, town) => ({ id, type: 'place', payload: { town } })),
}));

const town = {
  version: 1, seed: 5,
  sets: [{ id: 'set-a', ingredientId: 'cat-street', position: [0, 0], rotationDegrees: 0 }],
  streets: [{ id: 'main', kind: 'road', sides: 'houses', width: 9, points: [[0, 0], [120, 0]] }],
};

// Catches a street or set edit never reaching the saved town.
it('edits the street and set picked in the URL and saves the town', async () => {
  const { saveCatalogTown } = await import('../../services/apiCatalog');
  const onSaved = vi.fn();
  const record = { id: 'cat-town', type: 'place', payload: { town } };
  const { unmount } = render(<MemoryRouter initialEntries={['/environments/cat-town/town?townItem=street:main']}><TownPanel record={record} onSaved={onSaved} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Lined with'), { target: { value: 'fence' } });
  fireEvent.click(screen.getByRole('button', { name: /Save town/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(saveCatalogTown.mock.calls[0][1].streets[0]).toMatchObject({ id: 'main', sides: 'fence' });
  unmount();

  render(<MemoryRouter initialEntries={['/environments/cat-town/town?townItem=set:set-a']}><TownPanel record={record} onSaved={onSaved} /></MemoryRouter>);
  expect(screen.getByText('Example Street', { selector: 'span' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Turn right 15°' }));
  fireEvent.click(screen.getByRole('button', { name: /Save town/ }));
  await waitFor(() => expect(saveCatalogTown).toHaveBeenCalledTimes(2));
  expect(saveCatalogTown.mock.calls[1][1].sets[0].rotationDegrees).toBe(345);
});
