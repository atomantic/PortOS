import { expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PrevizStage from './PrevizStage.jsx';

vi.mock('../../../hooks/useMusicVideoGreyboxPlaces.js', () => ({
  default: () => ({
    'cat-street': { ingredient: { type: 'place', payload: { greybox: { anchors: [], shots: [{ id: 'wide', label: 'Wide', position: [0, 2, 8], target: [0, 1, 0], figures: [] }] } } }, media: [] },
    'cat-alley': { ingredient: { type: 'place', payload: {} }, media: [] },
  }),
}));
const jobsState = vi.hoisted(() => ({ value: { running: [], finished: null, drafted: 0, setCount: 0, step: null } }));
vi.mock('../../../hooks/usePrevizJobs.js', () => ({ default: () => jobsState.value }));
vi.mock('../../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [{ id: 'example-api', name: 'Example API', enabled: true }],
    selectedProviderId: 'example-api',
    selectedModel: 'model-a',
    availableModels: ['model-a'],
    loading: false,
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
  }),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./PrevizAi.jsx', () => ({ default: () => null }));
vi.mock('../../../services/apiCatalog.js', () => ({
  createCatalogIngredient: vi.fn(async (body) => ({ id: 'cat-world', ...body })),
  saveCatalogWorld: vi.fn(async (id, world) => ({ id, type: 'place', payload: { world } })),
  draftCatalogGreybox: vi.fn(async () => ({
    greybox: { anchors: [{ id: 'mark-1', kind: 'figure', position: [2, 0, 3] }], shots: [{ id: 'shot-1', label: 'Shot 2', figures: [{ anchorId: 'mark-1' }] }], parts: [] },
    sentPrompt: 'Prompt',
    promptAdditions: [],
    providerId: 'example-api',
  })),
  saveCatalogGreybox: vi.fn(async (id, greybox) => ({ id, type: 'place', payload: { greybox } })),
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
it('builds a cut per shot from the shot list, then saves who is in shot from the chips', async () => {
  const board = { project, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /Build previz from 1 shot/ }));
  await act(async () => {});
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

// Catches the timeline draft or a beat edit never reaching the saved previz.
it('drafts the timeline over the linked world from the shots, then saves a beat edit', async () => {
  const linked = { ...project, previz: { cuts: [], tracks: [], worldId: 'cat-world' } };
  const board = { project: linked, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /Draft timeline from 1 shot/ }));
  const { previz } = board.saveProjectFields.mock.calls.at(-1)[0];
  expect(previz).toMatchObject({ worldId: 'cat-world', timeline: { startClock: 1200, lengthMin: 480 } });
  expect(previz.timeline.beats).toEqual([expect.objectContaining({ kind: 'stay', setId: 'w-street', subjectIds: ['c-ana', 'c-bo'], startMin: 0, endMin: 480 })]);

  rerender(<MemoryRouter><PrevizStage board={{ ...board, project: { ...linked, previz } }} /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', { name: /Example Street, 20:00/ }))[0]);
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '90' } });
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.timeline.beats[0]).toMatchObject({ startMin: 0, endMin: 90 });
});

// Catches shots never getting a moment on the timeline, or the cut's story time edit not saving.
it('places shots on the timeline and saves a cut\'s story time', async () => {
  const timeline = { startClock: 1200, lengthMin: 480, beats: [{ id: 'b1', kind: 'stay', subjectIds: ['c-ana', 'c-bo'], startMin: 0, endMin: 480, setId: 'w-street', toSetId: null, pace: null }] };
  const cut = { id: 'k1', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street', viewShotId: 'wide', holderSubjectId: null, visibleSubjectIds: null, aimSubjectId: null };
  const linked = { ...project, previz: { cuts: [cut], tracks: [], worldId: 'cat-world', timeline } };
  const board = { project: linked, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /Place 1 shot on the timeline/ }));
  const { previz } = board.saveProjectFields.mock.calls.at(-1)[0];
  expect(previz.cuts[0].storyMin).toBe(0);

  rerender(<MemoryRouter><PrevizStage board={{ ...board, project: { ...linked, previz } }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('On the timeline at'), { target: { value: '20:30' } });
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.cuts[0]).toMatchObject({ storyMin: 30 });
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.timeline).toEqual(timeline);
  // 19:00 is before a timeline that starts at 20:00, so it is not a moment of it.
  const saves = board.saveProjectFields.mock.calls.length;
  fireEvent.change(screen.getByLabelText('On the timeline at'), { target: { value: '19:00' } });
  expect(board.saveProjectFields.mock.calls).toHaveLength(saves);
});

// Catches a build that gives no feedback: no busy state while it saves, no summary of what it built after.
it('shows the build as busy until the save settles, then summarizes it with the time', async () => {
  let settle;
  const board = { project, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(() => new Promise((resolve) => { settle = resolve; })), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /Build previz from 1 shot/ }));
  const busy = screen.getByRole('button', { name: /Building…/ });
  expect(busy).toBeDisabled();
  expect(busy).toHaveAttribute('aria-busy', 'true');
  const { previz } = board.saveProjectFields.mock.calls[0][0];
  expect(Number.isNaN(Date.parse(previz.builtAt))).toBe(false);

  settle();
  await waitFor(() => expect(screen.getByRole('button', { name: /Build previz from 1 shot/ })).not.toBeDisabled());
  rerender(<MemoryRouter><PrevizStage board={{ ...board, project: { ...project, previz } }} /></MemoryRouter>);
  expect(screen.getByText(/^Built from 1 shot · 1 cut · updated /)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Sync with shots/ })).not.toBeDisabled();
});

// Catches cuts on a set with no greybox playing an empty set with nothing on the Previz step saying so.
it('lists the sets cuts use that have no greybox, with their cut counts and a link to each Greybox panel', () => {
  const alley = { id: 'p-alley', kind: 'place', name: 'Example Alley', ingredientId: 'cat-alley' };
  const cut = (id, placeSubjectId, startSec) => ({ id, sceneId: null, startSec, endSec: startSec + 2, placeSubjectId, viewShotId: null, holderSubjectId: null, visibleSubjectIds: null, aimSubjectId: null });
  const withAlley = {
    ...project,
    concept: { subjects: [...project.concept.subjects, alley] },
    previz: { cuts: [cut('k1', 'p-street', 0), cut('k2', 'p-alley', 2), cut('k3', 'p-alley', 4)], tracks: [] },
  };
  const board = { project: withAlley, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  const list = screen.getByRole('status', { name: 'Sets without a greybox' });
  const link = within(list).getByRole('link', { name: 'Example Alley' });
  expect(link.getAttribute('href')).toMatch(/\/cat-alley\/greybox$/);
  expect(within(list).getByText('2 cuts')).toBeTruthy();
  // The street has a greybox, so it is not listed.
  expect(within(list).queryByText('Example Street')).toBeNull();
});

it('drafts missing greyboxes from shots with a review step before saving and linking cameras', async () => {
  const alley = { id: 'p-alley', kind: 'place', name: 'Example Alley', ingredientId: 'cat-alley' };
  const cut = (id, placeSubjectId, startSec) => ({ id, sceneId: 's1', startSec, endSec: startSec + 2, placeSubjectId, viewShotId: null, holderSubjectId: null, visibleSubjectIds: null, aimSubjectId: null });
  const withAlley = {
    ...project,
    concept: { subjects: [...project.concept.subjects, alley] },
    previz: { cuts: [cut('k1', 'p-street', 0), cut('k2', 'p-alley', 2)], tracks: [] },
  };
  const board = { project: withAlley, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);

  const draftButton = screen.getByRole('button', { name: /Draft missing greyboxes from shots/ });
  fireEvent.click(draftButton);

  const reviewRegion = await screen.findByRole('region', { name: /Review greybox draft for Example Alley/ });
  expect(reviewRegion).toBeTruthy();

  const saveButton = within(reviewRegion).getByRole('button', { name: /Save & link cameras/ });
  fireEvent.click(saveButton);

  await waitFor(() => expect(board.saveProjectFields).toHaveBeenCalled());
  const savedPreviz = board.saveProjectFields.mock.calls.at(-1)[0].previz;
  expect(savedPreviz.cuts.find((c) => c.id === 'k2').viewShotId).toBe('shot-1');
});

it('drafts missing greyboxes in one action when review is unchecked', async () => {
  const alley = { id: 'p-alley', kind: 'place', name: 'Example Alley', ingredientId: 'cat-alley' };
  const cut = (id, placeSubjectId, startSec) => ({ id, sceneId: 's1', startSec, endSec: startSec + 2, placeSubjectId, viewShotId: null, holderSubjectId: null, visibleSubjectIds: null, aimSubjectId: null });
  const withAlley = {
    ...project,
    concept: { subjects: [...project.concept.subjects, alley] },
    previz: { cuts: [cut('k1', 'p-street', 0), cut('k2', 'p-alley', 2)], tracks: [] },
  };
  const board = { project: withAlley, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);

  const reviewCheckbox = screen.getByLabelText('Review each draft before saving');
  fireEvent.click(reviewCheckbox);
  expect(reviewCheckbox.checked).toBe(false);

  const draftButton = screen.getByRole('button', { name: /Draft missing greyboxes from shots/ });
  fireEvent.click(draftButton);

  await waitFor(() => expect(board.saveProjectFields).toHaveBeenCalled());
  const savedPreviz = board.saveProjectFields.mock.calls.at(-1)[0].previz;
  expect(savedPreviz.cuts.find((c) => c.id === 'k2').viewShotId).toBe('shot-1');
});

// Catches vehicles being unreachable from the UI: marking a cast object as a vehicle, giving it a color and a speed.
it('marks a cast object as a vehicle, then saves its color and speed', () => {
  const withCart = { ...project, concept: { subjects: [...project.concept.subjects, { id: 'o-cart', kind: 'object', name: 'Hand cart' }] },
    previz: { cuts: [{ id: 'k1', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-street' }], tracks: [] } };
  const board = { project: withCart, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(screen.getByLabelText('Hand cart is a vehicle'));
  const { previz } = board.saveProjectFields.mock.calls.at(-1)[0];
  expect(previz.vehicles).toEqual([{ subjectId: 'o-cart', speedMetersPerMin: 270 }]);

  rerender(<MemoryRouter><PrevizStage board={{ ...board, project: { ...withCart, previz } }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Speed (m/min)'), { target: { value: '120' } });
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.vehicles).toEqual([{ subjectId: 'o-cart', speedMetersPerMin: 120 }]);
  fireEvent.change(screen.getByLabelText('Color'), { target: { value: 'teal' } });
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.pawnColors['o-cart']).toEqual({ figure: 'teal' });
});

// Catches the Build button staying live, and no progress showing, while a draft runs elsewhere.
it('shows server-side Previz progress and disables Build as In progress while a job runs', () => {
  const board = { project, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  jobsState.value = { running: [{ id: 'j' }], finished: null, drafted: 2, setCount: 8, step: { label: 'Drafting greybox 3 of 8: Lawns in the headlights', value: 2, max: 8 } };
  try {
    render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
    expect(screen.getByRole('progressbar', { name: /Drafting greybox 3 of 8: Lawns in the headlights/ })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByRole('button', { name: /In progress/ })).toBeDisabled();
  } finally {
    jobsState.value = { running: [], finished: null, drafted: 0, setCount: 0, step: null };
  }
});
