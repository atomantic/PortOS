import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import StoryboardLinkPanel from './StoryboardLinkPanel';

const api = vi.hoisted(() => ({ createStoryboard: vi.fn(), getStoryboard: vi.fn(), listStoryboards: vi.fn(), makeStoryboardFromMusicVideo: vi.fn() }));
vi.mock('../../services/api', () => api);

const board = {
  id: 'sb-1', name: 'Example Story',
  beats: [{ id: 'beat-1', panels: [{ id: 'panel-1', action: 'Wide of the gym', seconds: 4, takes: [], selectedTakeId: null }] }],
};
const renderPanel = (project, onLink = vi.fn(), onFitted = vi.fn()) => {
  render(<MemoryRouter><StoryboardLinkPanel project={project} onLink={onLink} onFitted={onFitted} /></MemoryRouter>);
  return onLink;
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('StoryboardLinkPanel', () => {
  it('links on Story and opens the board on the Storyboard step, leaving fit to it', async () => {
    api.getStoryboard.mockResolvedValue(board);
    const project = { id: 'mv-1', storyboardId: 'sb-1', scenes: [], audioAnalysis: { durationSec: 10, beats: [], sections: [] } };
    render(<MemoryRouter><StoryboardLinkPanel project={project} onLink={vi.fn()} openPath="/music-video/mv-1/board" /></MemoryRouter>);
    await screen.findByText('Example Story');
    expect(screen.getByRole('button', { name: /Unlink/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('/music-video/mv-1/board');
    expect(screen.queryByRole('button', { name: /Fit to song/ })).toBeNull();
  });

  it('links a picked board, or makes one from the video shots', async () => {
    api.listStoryboards.mockResolvedValue([{ id: 'sb-1', name: 'Example Story', panelCount: 1 }]);
    api.makeStoryboardFromMusicVideo.mockResolvedValue({ board: { ...board, id: 'sb-2' } });
    const onLink = renderPanel({ id: 'mv-1', storyboardId: null, scenes: [{ sceneId: 'mvs-1' }] });

    const picker = screen.getByLabelText('Link a storyboard');
    expect(api.listStoryboards).not.toHaveBeenCalled();
    fireEvent.focus(picker);
    expect(await screen.findByRole('option', { name: 'Example Story (1 panel)' })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'sb-1' } });
    expect(onLink).toHaveBeenCalledWith('sb-1');

    fireEvent.click(screen.getByRole('button', { name: /Make storyboard from this video/ }));
    await waitFor(() => expect(onLink).toHaveBeenCalledWith('sb-2', { saved: true }));
    expect(api.makeStoryboardFromMusicVideo).toHaveBeenCalledWith('mv-1');
  });

  it('shows the linked board at a glance and unlinks it', async () => {
    api.getStoryboard.mockResolvedValue(board);
    const onLink = renderPanel({ id: 'mv-1', storyboardId: 'sb-1', scenes: [] });
    expect(await screen.findByText('Example Story')).toBeTruthy();
    expect(screen.getByText('1 beat · 1 panel · 0:04.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('/storyboards/sb-1');
    fireEvent.click(screen.getByRole('button', { name: /Unlink/ }));
    expect(onLink).toHaveBeenCalledWith(null);
  });

});
