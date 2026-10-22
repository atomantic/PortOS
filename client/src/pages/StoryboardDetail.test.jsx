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
}));
vi.mock('../services/api', () => {
  const rest = ['deleteStoryboardBeat', 'deleteStoryboardPanel', 'moveStoryboardBeat', 'moveStoryboardPanel',
    'removeStoryboardPanelTake', 'selectStoryboardPanelTake', 'updateStoryboardBeat', 'listCatalogIngredientsByIds', 'getMoodBoard'];
  return { ...api, ...Object.fromEntries(rest.map((name) => [name, vi.fn(() => Promise.resolve([]))])) };
});
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../components/imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../components/IngredientPicker', () => ({ default: () => null }));
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
});
