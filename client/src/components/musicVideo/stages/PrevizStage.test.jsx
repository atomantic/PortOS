import { expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PrevizStage from './PrevizStage.jsx';

vi.mock('../../../hooks/useMusicVideoGreyboxPlaces.js', () => ({
  default: () => ({ 'cat-street': { ingredient: { type: 'place', payload: { greybox: { anchors: [], shots: [{ id: 'wide', label: 'Wide', position: [0, 2, 8], target: [0, 1, 0], figures: [] }] } } }, media: [] } }),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../services/apiCatalog.js', () => ({
  createCatalogIngredient: vi.fn(async (body) => ({ id: 'cat-world', ...body })),
  saveCatalogWorld: vi.fn(async (id, world) => ({ id, type: 'place', payload: { world } })),
  listCatalogIngredientsByIds: vi.fn(async (ids) => [
    { id: 'cat-world', type: 'place', name: 'Example world', payload: { world: { version: 1, seed: 1, sets: [{ id: 'w-street', ingredientId: 'cat-street', position: [0, 0], rotationDegrees: 0 }], paths: [] } } },
    { id: 'cat-street', type: 'place', name: 'Example Street', payload: {} },
  ].filter((row) => ids.includes(row.id))),
  listCatalogIngredientMedia: vi.fn(async () => []),
}));

const project = {
  id: 'mv-1',
  concept: { subjects: [{ id: 'c-ana', kind: 'character', name: 'Ana' }, { id: 'c-bo', kind: 'character', name: 'Bo' }, { id: 'p-street', kind: 'place', name: 'Example Street', ingredientId: 'cat-street' }] },
  cameras: [{ id: 'cam', name: 'VHS camera', kind: 'in-world' }],
  scenes: [{ sceneId: 's1', startSec: 0, endSec: 4, setReference: { subjectId: 'p-street', greyboxShotId: 'wide' }, shotSheet: { cameraId: 'cam', holder: 'Bo', characters: ['Ana'] } }],
};

// Catches the backfill or the per-shot cast picker never reaching the saved project.
it('builds a cut per shot from the shot list, then saves who is in shot from the chips', () => {
  const board = { project, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /Build previz from 1 shot/ }));
  const { previz } = board.saveProjectFields.mock.calls[0][0];
  expect(previz.cuts[0]).toMatchObject({ sceneId: 's1', viewShotId: 'wide', holderSubjectId: 'c-bo', visibleSubjectIds: ['c-ana'] });

  rerender(<MemoryRouter><PrevizStage board={{ ...board, project: { ...project, previz } }} /></MemoryRouter>);
  expect(screen.getByLabelText('Held by').value).toBe('c-bo');
  // The holder is behind the camera, so only Ana is offered as in shot.
  expect(screen.queryByRole('button', { name: 'Bo' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ana', pressed: true }));
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.cuts[0].visibleSubjectIds).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: /Watch/ }));
  expect(board.seekToScene).toHaveBeenCalledWith({ startSec: 0 }, { play: true });
});

// Catches the drafted world never reaching the catalog or never being picked for the previz.
it('drafts a world environment from the route maps and links it to the previz', async () => {
  const { saveCatalogWorld } = await import('../../../services/apiCatalog.js');
  const routed = { ...project, title: 'Example', routeMaps: [{ id: 'r1', name: 'Ride', heading: 'east', stops: [{ id: 's1', subjectId: 'p-street' }] }] };
  const board = { project: routed, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /Draft world from route maps/ }));
  await waitFor(() => expect(board.saveProjectFields).toHaveBeenCalled());
  expect(saveCatalogWorld.mock.calls[0][1].sets).toEqual([expect.objectContaining({ ingredientId: 'cat-street' })]);
  expect(board.saveProjectFields.mock.calls[0][0].previz).toMatchObject({ worldId: 'cat-world', cuts: [] });
});

// Catches the night draft or a beat edit never reaching the saved previz.
it('drafts the night over the linked world from the shots, then saves a beat edit', async () => {
  const linked = { ...project, previz: { cuts: [], tracks: [], worldId: 'cat-world' } };
  const board = { project: linked, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /Draft night from 1 shot/ }));
  const { previz } = board.saveProjectFields.mock.calls.at(-1)[0];
  expect(previz).toMatchObject({ worldId: 'cat-world', night: { startClock: 1200, lengthMin: 480 } });
  expect(previz.night.beats).toEqual([expect.objectContaining({ kind: 'stay', setId: 'w-street', subjectIds: ['c-ana', 'c-bo'], startMin: 0, endMin: 480 })]);

  rerender(<MemoryRouter><PrevizStage board={{ ...board, project: { ...linked, previz } }} /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', { name: /Example Street, 20:00/ }))[0]);
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '90' } });
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.night.beats[0]).toMatchObject({ startMin: 0, endMin: 90 });
});

// Catches shots never getting a moment on the night, or the cut's story time edit not saving.
it('places shots on the night and saves a cut\'s story time', async () => {
  const night = { startClock: 1200, lengthMin: 480, beats: [{ id: 'b1', kind: 'stay', subjectIds: ['c-ana', 'c-bo'], startMin: 0, endMin: 480, setId: 'w-street', toSetId: null, pace: null }] };
  const cut = { id: 'k1', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street', viewShotId: 'wide', holderSubjectId: null, visibleSubjectIds: null, aimSubjectId: null };
  const linked = { ...project, previz: { cuts: [cut], tracks: [], worldId: 'cat-world', night } };
  const board = { project: linked, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /Place 1 shot on the night/ }));
  const { previz } = board.saveProjectFields.mock.calls.at(-1)[0];
  expect(previz.cuts[0].storyMin).toBe(0);

  rerender(<MemoryRouter><PrevizStage board={{ ...board, project: { ...linked, previz } }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('On the night at'), { target: { value: '20:30' } });
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.cuts[0]).toMatchObject({ storyMin: 30 });
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.night).toEqual(night);
  // 19:00 is before a night that starts at 20:00, so it is not a moment of it.
  const saves = board.saveProjectFields.mock.calls.length;
  fireEvent.change(screen.getByLabelText('On the night at'), { target: { value: '19:00' } });
  expect(board.saveProjectFields.mock.calls).toHaveLength(saves);
});
