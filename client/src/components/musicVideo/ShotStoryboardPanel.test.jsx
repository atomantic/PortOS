import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ShotStoryboardPanel from './ShotStoryboardPanel';

const api = vi.hoisted(() => ({ updateShotFromStoryboardPanel: vi.fn(), sendShotStillToStoryboardPanel: vi.fn() }));
vi.mock('../../services/api', () => api);

const panel = { id: 'panel-1', action: 'She steps off the night bus', takes: [], selectedTakeId: null };
const scene = { sceneId: 'mvs-1', panelId: 'panel-1', panelRev: 'old', referenceImageId: '/data/images/still-a.png' };
const renderPanel = (linked, props = {}) => render(
  <MemoryRouter>
    <ShotStoryboardPanel projectId="mv-1" storyboardId="sb-1" scene={scene} linked={linked}
      onSceneUpdated={vi.fn()} onUnlink={vi.fn()} onBoard={vi.fn()} {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('ShotStoryboardPanel', () => {
  it('shows an edited panel until Update, and sends the still back as panel art', async () => {
    api.updateShotFromStoryboardPanel.mockResolvedValue({ scene: { ...scene, visualIntent: panel.action, panelRev: 'new' } });
    const board = { id: 'sb-1', beats: [] };
    api.sendShotStillToStoryboardPanel.mockResolvedValue({ board });
    const onSceneUpdated = vi.fn();
    const onBoard = vi.fn();
    renderPanel({ state: 'changed', panel, beat: { title: 'Arrival' }, beatIndex: 0, number: 1 }, { onSceneUpdated, onBoard });

    expect(screen.getByRole('link', { name: /Arrival · panel 1/ }).getAttribute('href')).toBe('/storyboards/sb-1/panel/panel-1');
    expect(screen.getByText(`Storyboard changed: ${panel.action}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Update/ }));
    await waitFor(() => expect(onSceneUpdated).toHaveBeenCalledWith('mvs-1', { visualIntent: panel.action, panelRev: 'new' }));

    fireEvent.click(screen.getByRole('button', { name: /Use as panel art/ }));
    await waitFor(() => expect(onBoard).toHaveBeenCalledWith(board));
  });

  it('offers Unlink for a deleted panel and marks a still that is already the panel art', () => {
    const onUnlink = vi.fn();
    const { unmount } = renderPanel({ state: 'missing', panel: null, beat: null, beatIndex: null, number: null }, { onUnlink });
    fireEvent.click(screen.getByRole('button', { name: /Unlink/ }));
    expect(onUnlink).toHaveBeenCalled();
    unmount();

    const art = { ...panel, takes: [{ id: 'take-1', source: 'gallery', image: 'still-a.png' }], selectedTakeId: 'take-1' };
    renderPanel({ state: 'current', panel: art, beat: { title: '' }, beatIndex: 2, number: 4 });
    expect(screen.getByText("This still is the panel's art")).toBeTruthy();
    expect(screen.queryByText(/Storyboard changed/)).toBeNull();
  });
});
