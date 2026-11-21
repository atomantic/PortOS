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

  // Picking a set from the list under the map selects it for editing.
  render(<MemoryRouter initialEntries={['/environments/cat-world/world']}><WorldPanel record={record} onSaved={onSaved} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Example Street' }));
  expect(screen.getByRole('button', { name: 'Example Street' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(screen.getByLabelText('Position X (m)'), { target: { value: '42' } });
  fireEvent.change(screen.getByLabelText('Position Z (m)'), { target: { value: '-6000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn right 15°' }));
  fireEvent.click(screen.getByRole('button', { name: /Save world/ }));
  await waitFor(() => expect(saveCatalogWorld).toHaveBeenCalledTimes(2));
  expect(saveCatalogWorld.mock.calls[1][1].sets[0]).toMatchObject({ position: [42, -5000], rotationDegrees: 345 });
});

// Catches path point editing, keyboard path drawing, and read-only keyboard panning regressions.
it('edits path points by number fields, draws a path from the keyboard, and pans in read-only mode', async () => {
  const { saveCatalogWorld } = await import('../../services/apiCatalog');
  saveCatalogWorld.mockClear();
  const onSaved = vi.fn();
  const record = { id: 'cat-world', type: 'place', payload: { world } };

  const { unmount } = render(
    <MemoryRouter initialEntries={['/environments/cat-world/world?worldItem=path:main']}>
      <WorldPanel record={record} onSaved={onSaved} />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Point 1 X (m)'), { target: { value: '15' } });
  fireEvent.change(screen.getByLabelText('Point 2 Z (m)'), { target: { value: '75' } });
  fireEvent.click(screen.getByRole('button', { name: /Save world/ }));
  await waitFor(() => expect(saveCatalogWorld).toHaveBeenCalledTimes(1));
  expect(saveCatalogWorld.mock.calls[0][1].paths[0].points).toEqual([[15, 0], [120, 75]]);

  // Draw a new path purely from the keyboard.
  fireEvent.click(screen.getByRole('button', { name: /Draw a path/ }));
  expect(screen.getByText(/Focus the map and press Enter to add a point at the center, or tap the map\./)).toBeTruthy();
  const map = screen.getByRole('application', { name: 'World map, north is up' });
  fireEvent.keyDown(map, { key: 'Enter' });
  fireEvent.keyDown(map, { key: 'ArrowRight' });
  fireEvent.keyDown(map, { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: /Finish path/ }));
  fireEvent.click(screen.getByRole('button', { name: /Save world/ }));
  await waitFor(() => expect(saveCatalogWorld).toHaveBeenCalledTimes(2));
  const drawn = saveCatalogWorld.mock.calls[1][1].paths[1];
  expect(drawn.points).toHaveLength(2);
  expect(drawn.points[1][0]).toBeGreaterThan(drawn.points[0][0]);
  unmount();

  // Read-only mode still allows keyboard panning and does not enter edit mode.
  render(<MemoryRouter initialEntries={['/environments/cat-world/world']}><WorldPanel record={record} readOnly /></MemoryRouter>);
  const readOnlyMap = screen.getByRole('application', { name: 'World map, north is up' });
  const beforeViewBox = readOnlyMap.getAttribute('viewBox');
  fireEvent.keyDown(readOnlyMap, { key: 'ArrowRight' });
  expect(readOnlyMap.getAttribute('viewBox')).not.toBe(beforeViewBox);
  expect(screen.getByRole('button', { name: /Draw a path/ })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /Save world/ })).toBeNull();
});
