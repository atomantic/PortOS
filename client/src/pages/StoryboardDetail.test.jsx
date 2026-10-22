import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import StoryboardDetail from './StoryboardDetail';

const api = vi.hoisted(() => ({
  getStoryboard: vi.fn(),
  listMoodBoardNames: vi.fn(),
  updateStoryboard: vi.fn(),
  addStoryboardBeat: vi.fn(),
  addStoryboardPanel: vi.fn(),
  updateStoryboardPanel: vi.fn(),
  addStoryboardPanelTake: vi.fn(),
  createBlankSketch: vi.fn(),
  runStoryboardPanelNode: vi.fn(),
  updateStoryboardRecipe: vi.fn(),
}));
vi.mock('../services/api', () => {
  const rest = ['deleteStoryboardBeat', 'deleteStoryboardPanel', 'moveStoryboardBeat', 'moveStoryboardPanel',
    'removeStoryboardPanelTake', 'selectStoryboardPanelTake', 'updateStoryboardBeat', 'listCatalogIngredientsByIds', 'getMoodBoard',
    'updateStoryboardPanelNode', 'getStoryboardPanelMake'];
  return { ...api, ...Object.fromEntries(rest.map((name) => [name, vi.fn(() => Promise.resolve([]))])) };
});
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../components/imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../components/IngredientPicker', () => ({ default: () => null }));
vi.mock('../components/musicVideo/MusicVideoLlmPicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/RecordRenderPinRow', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const panel = (id, extra = {}) => ({
  id, action: '', dialogue: '', framing: null, camera: '', seconds: null,
  castIds: [], environmentIds: [], objectIds: [], notes: '', takes: [], selectedTakeId: null, ...extra,
});
const board = (extra = {}) => ({
  id: 'sb-1', name: 'Here to Dance', logline: '', aspectRatio: '16:9', artStyle: 'pencil',
  universeId: null, moodBoardId: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:01.000Z',
  beats: [{ id: 'beat-1', title: 'Opening', what: '', why: '', emotion: '', musicalRole: 'intro', sectionHint: '', panels: [panel('panel-1')] }],
  ...extra,
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/storyboards/:id" element={<StoryboardDetail />} />
      <Route path="/storyboards/:id/panel/:panelId" element={<StoryboardDetail />} />
      <Route path="*" element={null} />
    </Routes>
    <LocationProbe />
  </MemoryRouter>,
);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listMoodBoardNames.mockResolvedValue([]);
});

describe('StoryboardDetail', () => {
  it('keeps the newest board when an earlier save answers last', async () => {
    api.getStoryboard.mockResolvedValue(board());
    let resolveOlder;
    api.updateStoryboard
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => Promise.resolve(board({ name: 'Second', updatedAt: '2026-10-22T00:00:03.000Z' })));
    renderAt('/storyboards/sb-1');

    const name = await screen.findByLabelText('Storyboard name');
    fireEvent.change(name, { target: { value: 'First' } });
    fireEvent.blur(name);
    fireEvent.change(name, { target: { value: 'Second' } });
    fireEvent.blur(name);
    await waitFor(() => expect(name.value).toBe('Second'));

    await act(async () => { resolveOlder(board({ name: 'First', updatedAt: '2026-10-22T00:00:02.000Z' })); });
    expect(name.value).toBe('Second');
  });

  it('opens a new panel at its deep link and saves its action on blur', async () => {
    api.getStoryboard.mockResolvedValue(board());
    const withPanel = board({
      updatedAt: '2026-10-22T00:00:02.000Z',
      beats: [{ ...board().beats[0], panels: [panel('panel-1'), panel('panel-2')] }],
    });
    api.addStoryboardPanel.mockResolvedValue({ board: withPanel, panelId: 'panel-2' });
    api.updateStoryboardPanel.mockImplementation((_id, _panelId, patch) => Promise.resolve(board({
      updatedAt: '2026-10-22T00:00:03.000Z',
      beats: [{ ...board().beats[0], panels: [panel('panel-1'), panel('panel-2', patch)] }],
    })));
    renderAt('/storyboards/sb-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Panel' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/storyboards/sb-1/panel/panel-2'));
    expect(api.addStoryboardPanel).toHaveBeenCalledWith('sb-1', 'beat-1', {});

    const action = await screen.findByLabelText('Action');
    fireEvent.change(action, { target: { value: 'She laces her skates' } });
    fireEvent.blur(action);
    await waitFor(() => expect(api.updateStoryboardPanel).toHaveBeenCalledWith('sb-1', 'panel-2', { action: 'She laces her skates' }));
    expect(await screen.findByRole('button', { name: 'Open panel 2: She laces her skates' })).toBeTruthy();
  });

  it('starts a sketch as a panel take and returns to the panel after drawing', async () => {
    api.getStoryboard.mockResolvedValue(board());
    api.createBlankSketch.mockResolvedValue({ key: 'sketch:abc-123' });
    api.addStoryboardPanelTake.mockResolvedValue({ board: board({ updatedAt: '2026-10-22T00:00:02.000Z' }), takeId: 'take-1' });
    renderAt('/storyboards/sb-1/panel/panel-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Sketch' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent)
      .toBe(`/media/annotate/sketch%3Aabc-123?returnTo=${encodeURIComponent('/storyboards/sb-1/panel/panel-1')}`));
    expect(api.addStoryboardPanelTake).toHaveBeenCalledWith('sb-1', 'panel-1', { source: 'sketch', sketchKey: 'sketch:abc-123' });
  });

  it('says so when the linked panel is gone', async () => {
    api.getStoryboard.mockResolvedValue(board());
    renderAt('/storyboards/sb-1/panel/panel-missing');
    expect(await screen.findByText('This panel is no longer on the storyboard.')).toBeTruthy();
  });

  it('runs a recipe node from the Make tab and duplicates a node from its right-click menu', async () => {
    api.getStoryboard.mockResolvedValue(board({ beats: [{ ...board().beats[0], panels: [panel('panel-1', { action: 'Doors swing open' })] }] }));
    api.runStoryboardPanelNode.mockResolvedValue(board({
      updatedAt: '2026-10-22T00:00:02.000Z',
      beats: [{ ...board().beats[0], panels: [panel('panel-1', {
        action: 'Doors swing open',
        make: { nodes: { 'node-writer': { text: 'A pencil frame of doors', status: 'done', error: '', sentPrompt: '', promptAdditions: [], providerId: 'example', model: '', runId: 'r1', jobIds: [], failedJobIds: [], takeIds: [], excludedRefs: [], extraRefs: [], sentRefs: [], runAt: null } } },
      })] }],
    }));
    api.updateStoryboardRecipe.mockImplementation(async (_id, recipe) => board({ recipe, updatedAt: '2026-10-22T00:00:03.000Z' }));
    renderAt('/storyboards/sb-1/panel/panel-1?panelTab=make');

    const textNode = await screen.findByRole('region', { name: 'Shot description node' });
    expect(textNode.textContent).toContain('Doors swing open');

    fireEvent.click(screen.getByRole('button', { name: 'Run: Prompt writer' }));
    await waitFor(() => expect(api.runStoryboardPanelNode).toHaveBeenCalledWith('sb-1', 'panel-1', 'node-writer'));
    await waitFor(() => expect(screen.getByLabelText('Written prompt (yours to edit)').value).toBe('A pencil frame of doors'));

    fireEvent.contextMenu(screen.getByRole('region', { name: 'Image node' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Duplicate/ }));
    await waitFor(() => expect(api.updateStoryboardRecipe).toHaveBeenCalled());
    const [, recipe] = api.updateStoryboardRecipe.mock.calls[0];
    const copy = recipe.nodes.find((n) => n.title === 'Image copy');
    expect(copy).toMatchObject({ type: 'image', settings: { count: 4 } });
    // The copy keeps the original's inputs.
    expect(recipe.edges.filter((e) => e.to === copy.id).map((e) => e.toPort).sort()).toEqual(['images', 'prompt']);
  });

  it('opens the recipe canvas at its deep link and selects a node into the URL', async () => {
    api.getStoryboard.mockResolvedValue(board());
    renderAt('/storyboards/sb-1/panel/panel-1?panelTab=make&makeView=canvas&node=node-image');
    expect(await screen.findByRole('region', { name: 'Image node' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Prompt writer node' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Prompt writer (llm)' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('node=node-writer'));
    expect(await screen.findByRole('region', { name: 'Prompt writer node' })).toBeInTheDocument();
  });

  it('refuses a canvas wire that would close a cycle, keeping the input wired', async () => {
    const recipe = {
      nodes: [
        { id: 'node-a', type: 'text', title: 'Words', settings: { source: 'custom' }, text: 'Rain', x: 0, y: 0 },
        { id: 'node-b', type: 'llm', title: 'First', settings: {}, x: 260, y: 0 },
        { id: 'node-c', type: 'llm', title: 'Second', settings: {}, x: 520, y: 0 },
      ],
      edges: [{ from: 'node-a', to: 'node-b', toPort: 'prompt' }, { from: 'node-b', to: 'node-c', toPort: 'prompt' }],
    };
    api.getStoryboard.mockResolvedValue(board({ recipe }));
    api.updateStoryboardRecipe.mockImplementation(async (_id, next) => board({ recipe: next, updatedAt: '2026-10-22T00:00:03.000Z' }));
    renderAt('/storyboards/sb-1/panel/panel-1?panelTab=make&makeView=canvas');
    await screen.findByRole('button', { name: 'Second (llm)' });

    const dropWire = (fromId, toId, port) => {
      const out = document.querySelector(`[data-node-id="${fromId}"] [data-port-out]`);
      const input = document.querySelector(`[data-node-id="${toId}"] [data-port-in="${port}"] circle`);
      fireEvent.pointerDown(out, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
      const original = document.elementFromPoint;
      document.elementFromPoint = () => input;
      try {
        fireEvent.pointerUp(window, { clientX: 50, clientY: 50 });
      } finally {
        document.elementFromPoint = original;
      }
    };

    dropWire('node-c', 'node-b', 'prompt');
    expect(api.updateStoryboardRecipe).not.toHaveBeenCalled();

    dropWire('node-a', 'node-c', 'prompt');
    await waitFor(() => expect(api.updateStoryboardRecipe).toHaveBeenCalledTimes(1));
    expect(api.updateStoryboardRecipe.mock.calls[0][1].edges).toEqual([
      { from: 'node-a', to: 'node-b', toPort: 'prompt' },
      { from: 'node-a', to: 'node-c', toPort: 'prompt' },
    ]);
  });
});
