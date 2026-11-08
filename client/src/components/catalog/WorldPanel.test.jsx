import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import WorldPanel from './WorldPanel.jsx';

vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../hooks/useCatalogPlaces', () => ({
  default: () => ({ 'cat-street': { ingredient: { id: 'cat-street', type: 'place', name: 'Example Street', payload: {} }, media: [] } }),
}));
vi.mock('../../services/apiCatalog', () => ({
  listCatalogIngredients: vi.fn(async () => ({ items: [] })),
  saveCatalogWorld: vi.fn(async (id, world) => ({ id, type: 'place', payload: { world } })),
}));

const world = {
  version: 1, seed: 5,
  sets: [{ id: 'set-a', ingredientId: 'cat-street', position: [0, 0], rotationDegrees: 0 }],
  paths: [{ id: 'main', kind: 'road', sides: 'buildings', width: 9, points: [[0, 0], [120, 0]] }],
};

// Catches a path or set edit never reaching the saved world.
it('edits the path and set picked in the URL and saves the world', async () => {
  const { saveCatalogWorld } = await import('../../services/apiCatalog');
  const onSaved = vi.fn();
  const record = { id: 'cat-world', type: 'place', payload: { world } };
  const { unmount } = render(<MemoryRouter initialEntries={['/environments/cat-world/world?worldItem=path:main']}><WorldPanel record={record} onSaved={onSaved} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Lined with'), { target: { value: 'fence' } });
  fireEvent.click(screen.getByRole('button', { name: /Save world/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(saveCatalogWorld.mock.calls[0][1].paths[0]).toMatchObject({ id: 'main', sides: 'fence' });
  unmount();

  render(<MemoryRouter initialEntries={['/environments/cat-world/world?worldItem=set:set-a']}><WorldPanel record={record} onSaved={onSaved} /></MemoryRouter>);
  expect(screen.getByText('Example Street', { selector: 'span' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Turn right 15°' }));
  fireEvent.click(screen.getByRole('button', { name: /Save world/ }));
  await waitFor(() => expect(saveCatalogWorld).toHaveBeenCalledTimes(2));
  expect(saveCatalogWorld.mock.calls[1][1].sets[0].rotationDegrees).toBe(345);
});
