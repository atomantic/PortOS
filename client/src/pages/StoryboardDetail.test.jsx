import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router';
import StoryboardDetail from './StoryboardDetail';
import StoryboardEditor from '../components/storyboards/StoryboardEditor';
import { updateStoryboardBeat } from '../services/api';

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
  correctStoryboardPanel: vi.fn(),
  drawStoryboardPanel: vi.fn(),
  updateStoryboardRecipe: vi.fn(),
  getStoryboardMakeEmpty: vi.fn(),
  startStoryboardMakeEmpty: vi.fn(),
  listStoryboardRecipes: vi.fn(),
  saveStoryboardRecipe: vi.fn(),
  deleteStoryboardRecipe: vi.fn(),
  extractStoryboardBeats: vi.fn(),
  addStoryboardBeats: vi.fn(),
  uploadFile: vi.fn(),
  sendStoryboardPanelToFableLoom: vi.fn(),
  getUploadUrl: (filename) => `/api/uploads/${filename}`,
}));
vi.mock('../services/api', () => {
  const rest = ['deleteStoryboardBeat', 'deleteStoryboardPanel', 'moveStoryboardBeat', 'moveStoryboardPanel',
    'removeStoryboardPanelTake', 'selectStoryboardPanelTake', 'updateStoryboardBeat', 'listCatalogIngredientsByIds', 'getMoodBoard',
    'updateStoryboardPanelNode', 'getStoryboardPanelMake'];
  return { ...api, ...Object.fromEntries(rest.map((name) => [name, vi.fn(() => Promise.resolve([]))])) };
});
const socketMock = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../services/socket', () => ({ default: socketMock }));
vi.mock('../components/imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../components/IngredientPicker', () => ({ default: () => null }));
vi.mock('../components/musicVideo/MusicVideoLlmPicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/RecordRenderPinRow', () => ({ default: () => null }));
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock('../lib/clipboard', () => clipboard);
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
  for (const fn of Object.values(api)) fn.mockReset?.();
  api.listMoodBoardNames.mockResolvedValue([]);
  api.getStoryboardMakeEmpty.mockResolvedValue({ batch: null, panelCount: 0, steps: [] });
});

describe('StoryboardDetail', () => {
  // Uniquely catches the embedded editor losing its board-first view, or the side panel's previous / next panel.
  it('opens a music video\'s board as the panel grid and steps between panels in the side panel', async () => {
    api.getStoryboard.mockResolvedValue(board({ beats: [
      { id: 'beat-1', title: 'Intro', what: '', why: '', emotion: '', musicalRole: 'intro', sectionHint: '', panels: [panel('panel-1')] },
      { id: 'beat-2', title: 'Chorus', what: '', why: '', emotion: '', musicalRole: 'chorus', sectionHint: '', panels: [panel('panel-2')] },
    ] }));
    function Embedded() {
      const { panelId } = useParams();
      return <StoryboardEditor embedded boardId="sb-1" panelId={panelId} boardPath="/music-video/mv-1/board" />;
    }
    render(
      <MemoryRouter initialEntries={['/music-video/mv-1/board/panel/panel-1']}>
        <Routes>
          <Route path="/music-video/:projectId/board" element={<Embedded />} />
          <Route path="/music-video/:projectId/board/panel/:panelId" element={<Embedded />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    const panelDialog = await screen.findByRole('dialog', { name: 'Panel 1' });
    expect(screen.getByRole('tab', { name: /Board/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Logline')).toBeNull();
    expect(within(panelDialog).getByRole('button', { name: 'Previous panel' })).toBeDisabled();
    fireEvent.click(within(panelDialog).getByRole('button', { name: 'Next panel' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/music-video/mv-1/board/panel/panel-2'));
    expect(await screen.findByRole('dialog', { name: 'Panel 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next panel' })).toBeDisabled();
  });

  it('edits a music video\'s board in place: panels open under the step and keep its query', async () => {
    api.getStoryboard.mockResolvedValue(board());
    function Embedded() {
      const { panelId } = useParams();
      return <StoryboardEditor embedded boardId="sb-1" panelId={panelId} boardPath="/music-video/mv-1/board" />;
    }
    render(
      <MemoryRouter initialEntries={['/music-video/mv-1/board?mvPanel=render&view=board']}>
        <Routes>
          <Route path="/music-video/:projectId/board" element={<Embedded />} />
          <Route path="/music-video/:projectId/board/panel/:panelId" element={<Embedded />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Open panel 1/ }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/music-video/mv-1/board/panel/panel-1?mvPanel=render&view=board'));
    expect(screen.getByRole('link', { name: 'Open in Storyboards' }).getAttribute('href')).toBe('/storyboards/sb-1');
    expect(screen.queryByRole('button', { name: /Song brief/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Make video/ })).toBeNull();
  });

  it('corrects the selected frame with a note, linking to markup that returns to the open form', async () => {
    const framed = board({ beats: [{ ...board().beats[0], panels: [panel('panel-1', {
      takes: [{ id: 'take-1', source: 'generated', image: 'frame-a.png' }], selectedTakeId: 'take-1',
    })] }] });
    api.getStoryboard.mockResolvedValue(framed);
    api.correctStoryboardPanel.mockResolvedValue({ ...framed, updatedAt: '2026-10-22T00:00:02.000Z' });
    renderAt('/storyboards/sb-1/panel/panel-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/storyboards/sb-1/panel/panel-1?correct=open'));
    expect(screen.getByRole('link', { name: /Edit markup/ }).getAttribute('href'))
      .toBe(`/media/annotate/image%3Aframe-a.png?returnTo=${encodeURIComponent('/storyboards/sb-1/panel/panel-1?correct=open')}`);
    const redraw = screen.getByRole('button', { name: 'Redraw' });
    expect(redraw).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What to change'), { target: { value: 'Move her to the left third' } });
    fireEvent.click(redraw);
    await waitFor(() => expect(api.correctStoryboardPanel).toHaveBeenCalledWith('sb-1', 'panel-1', { takeId: 'take-1', note: 'Move her to the left third' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/storyboards/sb-1/panel/panel-1'));
  });

  it('changes the board\'s art style', async () => {
    api.getStoryboard.mockResolvedValue(board());
    api.updateStoryboard.mockResolvedValue(board({ artStyle: 'production-sketch', updatedAt: '2026-10-22T00:00:02.000Z' }));
    renderAt('/storyboards/sb-1');
    fireEvent.change(await screen.findByLabelText('Art style'), { target: { value: 'production-sketch' } });
    await waitFor(() => expect(api.updateStoryboard).toHaveBeenCalledWith('sb-1', { artStyle: 'production-sketch' }));
    expect(screen.getByLabelText('Art style').value).toBe('production-sketch');
  });

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

  it('sends a panel made from a FableLoom scene back as its scene art', async () => {
    const linked = board({
      source: { kind: 'fableloom', loomId: 'loom-1', episodeId: 'ep-1' },
      beats: [{ id: 'beat-1', title: 'Arrival', what: '', why: '', emotion: '', musicalRole: null, sectionHint: '', panels: [
        panel('panel-1', { sourceSceneId: 'node-1', takes: [{ id: 'take-1', source: 'generated', image: 'harbor.png', sketchKey: null }], selectedTakeId: 'take-1' }),
      ] }],
    });
    api.getStoryboard.mockResolvedValue(linked);
    api.sendStoryboardPanelToFableLoom.mockResolvedValue({ board: linked, node: { id: 'node-1', image: 'harbor.png' } });
    renderAt('/storyboards/sb-1/panel/panel-1');

    expect(await screen.findByRole('link', { name: 'FableLoom episode' })).toHaveAttribute('href', '/fableloom/loom-1/ep-1/board');
    fireEvent.click(screen.getByRole('button', { name: 'Use as scene art' }));
    await waitFor(() => expect(api.sendStoryboardPanelToFableLoom).toHaveBeenCalledWith('sb-1', 'panel-1'));
  });

  it('says so when the linked panel is gone', async () => {
    api.getStoryboard.mockResolvedValue(board());
    renderAt('/storyboards/sb-1/panel/panel-missing');
    expect(await screen.findByText('This panel is no longer on the storyboard.')).toBeTruthy();
  });

  it('runs a recipe node from the Prompts tab and duplicates a node from its right-click menu', async () => {
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
    expect(copy).toMatchObject({ type: 'image', settings: { count: 1 } });
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

  it('names the models and panel count before making empty panels, then shows progress', async () => {
    api.getStoryboard.mockResolvedValue(board());
    api.getStoryboardMakeEmpty.mockResolvedValue({
      batch: null,
      panelCount: 2,
      steps: [
        { nodeId: 'node-writer', title: 'Prompt writer', type: 'llm', model: 'Example · example-model', frames: 0 },
        { nodeId: 'node-image', title: 'Image', type: 'image', model: 'Default image model', frames: 4 },
      ],
    });
    api.startStoryboardMakeEmpty.mockResolvedValue({ batch: { storyboardId: 'sb-1', status: 'running', total: 2, done: 0, failed: 0 } });
    renderAt('/storyboards/sb-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Make empty panels' }));
    const confirm = await screen.findByLabelText('Make empty panels');
    expect(confirm.textContent).toContain('Make 2 empty panels? Prompt writer runs on Example · example-model; Image makes 4 frames each with Default image model.');
    expect(api.startStoryboardMakeEmpty).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Make' }));
    await waitFor(() => expect(api.startStoryboardMakeEmpty).toHaveBeenCalledWith('sb-1', {}));
    expect(await screen.findByText('0 of 2')).toBeInTheDocument();

    const onBatch = socketMock.on.mock.calls.findLast(([event]) => event === 'storyboard:make-batch')[1];
    act(() => onBatch({ storyboardId: 'sb-1', status: 'running', total: 2, done: 1, failed: 0 }));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    act(() => onBatch({ storyboardId: 'sb-1', status: 'done', total: 2, done: 2, failed: 0 }));
    expect(await screen.findByRole('button', { name: 'Make empty panels' })).toBeInTheDocument();
  });

  // Uniquely catches a panel losing its one-tap Draw, or the button not showing the panel is drawing.
  it('draws one panel from its side panel and shows it drawing until the frame lands', async () => {
    api.getStoryboard.mockResolvedValue(board());
    api.drawStoryboardPanel.mockResolvedValue(board({ updatedAt: '2026-10-22T00:00:02.000Z', beats: [{ ...board().beats[0],
      panels: [panel('panel-1', { make: { nodes: { 'node-image': { status: 'queued' } } } })] }] }));
    renderAt('/storyboards/sb-1/panel/panel-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Draw panel' }));
    await waitFor(() => expect(api.drawStoryboardPanel).toHaveBeenCalledWith('sb-1', 'panel-1'));
    expect(await screen.findByRole('button', { name: /Drawing/ })).toBeDisabled();
  });

  // Uniquely catches Redraw all losing its own count, its one-frame redraw, or the "Select the new drawings" choice.
  it('redraws every panel with one frame each, selecting the new drawings unless unticked', async () => {
    api.getStoryboard.mockResolvedValue(board());
    api.getStoryboardMakeEmpty.mockResolvedValue({
      batch: null,
      panelCount: 0,
      allCount: 3,
      steps: [
        { nodeId: 'node-writer', title: 'Prompt writer', type: 'llm', model: 'Example · example-model', frames: 0 },
        { nodeId: 'node-image', title: 'Image', type: 'image', model: 'Default image model', frames: 4 },
      ],
    });
    api.startStoryboardMakeEmpty.mockResolvedValue({ batch: { storyboardId: 'sb-1', status: 'running', redraw: true, total: 3, done: 0, failed: 0 } });
    renderAt('/storyboards/sb-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Redraw all' }));
    const confirm = await screen.findByLabelText('Redraw all panels');
    expect(confirm.textContent).toContain('Redraw all 3 panels? Prompt writer rewrites each prompt on Example · example-model; Image makes 1 frame each with Default image model.');
    const select = screen.getByLabelText('Select the new drawings');
    expect(select).toBeChecked();
    fireEvent.click(select);
    fireEvent.click(screen.getByRole('button', { name: 'Redraw' }));
    await waitFor(() => expect(api.startStoryboardMakeEmpty).toHaveBeenCalledWith('sb-1', { redraw: true, selectNew: false }));
    expect(await screen.findByLabelText('Redrawing panels')).toBeInTheDocument();
  });

  it('saves the recipe to the library and loads a saved one onto the board as a copy', async () => {
    api.getStoryboard.mockResolvedValue(board());
    const savedRecipe = { nodes: [{ id: 'node-a', type: 'text', title: 'Words', settings: { source: 'panel' }, x: 0, y: 0 }], edges: [] };
    api.saveStoryboardRecipe.mockImplementation(async (name, recipe) => ({ id: 'sbr-1', name, recipe, createdAt: '', updatedAt: '' }));
    api.listStoryboardRecipes.mockResolvedValue([{ id: 'sbr-2', name: 'Words only', recipe: savedRecipe, createdAt: '', updatedAt: '' }]);
    api.updateStoryboardRecipe.mockImplementation(async (_id, recipe) => board({ recipe, updatedAt: '2026-10-22T00:00:03.000Z' }));
    renderAt('/storyboards/sb-1/panel/panel-1?panelTab=make');

    fireEvent.click(await screen.findByRole('button', { name: 'Save as…' }));
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Pencil frames' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveStoryboardRecipe).toHaveBeenCalled());
    const [name, sent] = api.saveStoryboardRecipe.mock.calls[0];
    expect(name).toBe('Pencil frames');
    expect(sent.nodes.map((n) => n.id)).toEqual(['node-text', 'node-system', 'node-writer', 'node-refs', 'node-image', 'node-panel']);

    fireEvent.click(screen.getByRole('button', { name: 'Load…' }));
    expect(await screen.findByLabelText('Saved recipe')).toHaveValue('sbr-2');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(api.updateStoryboardRecipe).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Load' }).at(-1));
    await waitFor(() => expect(api.updateStoryboardRecipe).toHaveBeenCalledWith('sb-1', savedRecipe));
    expect(await screen.findByRole('region', { name: 'Words node' })).toBeInTheDocument();
  });

  it('draws beats from a plot summary as a preview and adds only the ticked ones', async () => {
    api.getStoryboard.mockResolvedValue(board({ beats: [] }));
    const beats = [
      { title: 'Arrival', what: 'She reaches the gym', why: '', emotion: '', musicalRole: 'intro', panels: [{ action: 'Doors open', dialogue: '', framing: 'wide', camera: '', seconds: 3 }] },
      { title: 'Exit', what: 'She leaves', why: '', emotion: '', musicalRole: null, panels: [] },
    ];
    api.extractStoryboardBeats.mockImplementation(async (_id, input) => ({
      board: board({ beats: [], plot: input.plot, updatedAt: '2026-10-22T00:00:02.000Z' }),
      beats, sentPrompt: `Instructions\n\n---\n\nPlot summary:\n${input.plot}`,
      promptAdditions: [{ id: 'beat-instructions', label: 'Beat instructions', text: 'Instructions' }], providerId: 'example', model: 'example-model',
    }));
    api.addStoryboardBeats.mockImplementation(async (_id, added) => board({ beats: added.map((b, i) => ({ ...b, id: `beat-${i}`, sectionHint: '' })), updatedAt: '2026-10-22T00:00:03.000Z' }));
    renderAt('/storyboards/sb-1?plot=open');

    fireEvent.change(await screen.findByLabelText('Plot summary'), { target: { value: 'A shy teen finds her courage.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draw beats' }));
    await waitFor(() => expect(api.extractStoryboardBeats).toHaveBeenCalledWith('sb-1', { plot: 'A shy teen finds her courage.', providerId: '', model: '', effort: '' }));
    expect(await screen.findByRole('button', { name: '+ Beat instructions' })).toBeInTheDocument();
    expect(api.addStoryboardBeats).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /Exit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 beat' }));
    await waitFor(() => expect(api.addStoryboardBeats).toHaveBeenCalledWith('sb-1', [beats[0]]));
    await waitFor(() => expect(screen.getByTestId('location').textContent).not.toContain('plot=open'));
  });

  it('plays the animatic with a temp track attached from an upload', async () => {
    api.getStoryboard.mockResolvedValue(board({ tempTrack: null }));
    api.uploadFile.mockResolvedValue({ filename: '0a1b2c3d-demo.mp3' });
    api.updateStoryboard.mockImplementation((_id, patch) => Promise.resolve(board({ ...patch, updatedAt: '2026-10-22T00:00:05.000Z' })));
    renderAt('/storyboards/sb-1?view=play');

    expect(await screen.findByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.getByText('Opening')).toBeTruthy();
    expect(screen.getByText('0:00.00 / 0:03.00')).toBeTruthy();

    const file = new File(['x'], 'demo.mp3', { type: 'audio/mpeg' });
    fireEvent.change(document.getElementById('storyboard-temp-track'), { target: { files: [file] } });
    await waitFor(() => expect(api.updateStoryboard).toHaveBeenCalledWith('sb-1', { tempTrack: { filename: '0a1b2c3d-demo.mp3', name: 'demo.mp3' } }));
    expect(await screen.findByText('demo.mp3')).toBeTruthy();
    expect(document.querySelector('audio').getAttribute('src')).toBe('/api/uploads/0a1b2c3d-demo.mp3');
  });

  it('copies the song brief built from the beats', async () => {
    api.getStoryboard.mockResolvedValue(board());
    renderAt('/storyboards/sb-1?brief=open');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('Structure: [Intro]'), 'Song brief copied');
  });

  it('stamps lyric lines on the temp track and pins a beat to a song mark', async () => {
    const track = { filename: '0a1b2c3d-demo.mp3', name: 'demo.mp3', sections: [], lines: [] };
    api.getStoryboard.mockResolvedValue(board({ tempTrack: track }));
    let latest = board({ tempTrack: track });
    api.updateStoryboard.mockImplementation((_id, patch) => {
      latest = { ...latest, ...patch, updatedAt: new Date(Date.parse(latest.updatedAt) + 1000).toISOString() };
      return Promise.resolve(latest);
    });
    renderAt('/storyboards/sb-1?view=play');

    fireEvent.change(await screen.findByLabelText('Lyrics, one line per row'), { target: { value: 'Here I am\n\nStill here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save lines' }));
    fireEvent.click(await screen.findByRole('button', { name: /Stamp next line/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mark section at/ }));
    await waitFor(() => expect(api.updateStoryboard).toHaveBeenCalledTimes(3));
    // Each save carries every change before it, in order.
    const last = api.updateStoryboard.mock.calls[2][1].tempTrack;
    expect(last.lines.map((line) => [line.text, line.at])).toEqual([['Here I am', 0], ['Still here', null]]);
    expect(last.sections).toEqual([expect.objectContaining({ label: 'Section 1', at: 0 })]);
    // The stamped line plays as the lyric over the panel.
    expect(await screen.findByText('Here I am', { selector: 'p' })).toBeTruthy();
  });

  it('pins a beat to a song section from its details', async () => {
    const track = { filename: '0a1b2c3d-demo.mp3', name: 'demo.mp3', sections: [{ id: 'sec-1', label: 'Chorus 1', at: 45.5 }], lines: [] };
    api.getStoryboard.mockResolvedValue(board({ tempTrack: track }));
    renderAt('/storyboards/sb-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Beat details' }));
    fireEvent.change(screen.getByLabelText('Starts at (temp track)'), { target: { value: 'sec-1' } });
    expect(updateStoryboardBeat).toHaveBeenCalledWith('sb-1', 'beat-1', { pin: 'sec-1' });
  });
});
