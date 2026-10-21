import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../Drawer', () => ({ default: () => null }));
vi.mock('../settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('./StoryboardBibleTab', () => ({ default: () => null }));
vi.mock('./StoryboardScenesTab', () => ({ default: () => null }));
vi.mock('./StoryboardBoardsTab', () => ({
  default: ({ scenes }) => <div data-testid="boards-tab">{scenes.length} scenes</div>,
}));
vi.mock('./StoryboardConfigTab', () => ({
  default: ({ models }) => <div data-testid="config-tab">{models.length} models</div>,
}));

const listWritersRoomAnalyses = vi.fn();
const getWritersRoomAnalysis = vi.fn();
vi.mock('../../services/apiWritersRoom', () => ({
  listWritersRoomAnalyses: (...a) => listWritersRoomAnalyses(...a),
  getWritersRoomAnalysis: (...a) => getWritersRoomAnalysis(...a),
}));
const getSettings = vi.fn();
const listImageStylePresets = vi.fn();
vi.mock('../../services/apiSystem', () => ({
  getSettings: (...a) => getSettings(...a),
  patchSettingsSlice: vi.fn(),
  listImageStylePresets: (...a) => listImageStylePresets(...a),
}));
const listImageModels = vi.fn();
vi.mock('../../services/apiImageVideo', () => ({ listImageModels: (...a) => listImageModels(...a) }));

import StoryboardPanel, { STORYBOARD_TAB } from './StoryboardPanel';

const work = { id: 'work-1', drafts: [], activeDraftVersionId: null };

const renderPanel = async (tab) => {
  render(
    <MemoryRouter>
      <StoryboardPanel work={work} tab={tab} onTabChange={() => {}} />
    </MemoryRouter>,
  );
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
  listImageModels.mockResolvedValue([]);
  listImageStylePresets.mockResolvedValue([]);
  listWritersRoomAnalyses.mockResolvedValue([]);
});
afterEach(cleanup);

describe('StoryboardPanel failed reads', () => {
  it('shows a storyboard load error with Retry instead of the empty boards view, then loads the script', async () => {
    listWritersRoomAnalyses.mockRejectedValueOnce(new Error('Server unavailable'));
    await renderPanel(STORYBOARD_TAB.BOARDS);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the storyboard — Server unavailable');
    expect(screen.queryByTestId('boards-tab')).toBeNull();

    listWritersRoomAnalyses.mockResolvedValueOnce([{ id: 'a1', kind: 'script', status: 'succeeded', createdAt: '2026-01-01T00:00:00Z' }]);
    getWritersRoomAnalysis.mockResolvedValueOnce({ id: 'a1', kind: 'script', result: { scenes: [{ id: 's1' }] } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('boards-tab')).toHaveTextContent('1 scenes');
  });

  it('shows a catalog error with Retry on the config tab when the model or preset read fails', async () => {
    listImageModels.mockRejectedValueOnce(new Error('Models unavailable'));
    listImageStylePresets.mockRejectedValueOnce(new Error('Presets unavailable'));
    await renderPanel(STORYBOARD_TAB.CONFIG);
    const alerts = screen.getAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('Could not load the local model catalog — Models unavailable');
    expect(alerts[1]).toHaveTextContent('Could not load style presets — Presets unavailable');

    listImageModels.mockResolvedValueOnce([{ id: 'model-a', name: 'Model A' }]);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]); });
    expect(screen.getByTestId('config-tab')).toHaveTextContent('1 models');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
