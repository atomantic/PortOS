import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import StoryboardDetail from './StoryboardDetail';
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
  updateStoryboardRecipe: vi.fn(),
  getStoryboardMakeEmpty: vi.fn(),
  startStoryboardMakeEmpty: vi.fn(),
  listStoryboardRecipes: vi.fn(),
  saveStoryboardRecipe: vi.fn(),
  deleteStoryboardRecipe: vi.fn(),
  extractStoryboardBeats: vi.fn(),
  addStoryboardBeats: vi.fn(),
  uploadFile: vi.fn(),
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
    await waitFor(() => expect(api.startStoryboardMakeEmpty).toHaveBeenCalledWith('sb-1'));
    expect(await screen.findByText('0 of 2')).toBeInTheDocument();

    const onBatch = socketMock.on.mock.calls.findLast(([event]) => event === 'storyboard:make-batch')[1];
    act(() => onBatch({ storyboardId: 'sb-1', status: 'running', total: 2, done: 1, failed: 0 }));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    act(() => onBatch({ storyboardId: 'sb-1', status: 'done', total: 2, done: 2, failed: 0 }));
    expect(await screen.findByRole('button', { name: 'Make empty panels' })).toBeInTheDocument();
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
