import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import StoryboardLinkPanel from './StoryboardLinkPanel';

const api = vi.hoisted(() => ({ getStoryboard: vi.fn(), listStoryboards: vi.fn(), makeStoryboardFromMusicVideo: vi.fn(), fitMusicVideoToStoryboard: vi.fn() }));
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

  it('previews the fit on the song, lets a beat start move, then writes the shots after confirming the replace', async () => {
    const fitBoard = {
      id: 'sb-1', name: 'Example Story', updatedAt: '2026-01-01T00:00:00.000Z',
      beats: [
        { id: 'beat-1', title: 'Arrival', panels: [{ id: 'panel-1', action: 'Wide of the gym', seconds: 4, takes: [], selectedTakeId: null }] },
        { id: 'beat-2', title: 'Lift off', panels: [{ id: 'panel-2', action: 'Crowd lifts her', seconds: 4, takes: [], selectedTakeId: null }] },
      ],
    };
    api.getStoryboard.mockResolvedValue(fitBoard);
    const saved = { id: 'mv-1', scenes: [{ sceneId: 'mvs-new' }] };
    api.fitMusicVideoToStoryboard.mockResolvedValue({ project: saved, shots: 2, replaced: 1 });
    const onFitted = vi.fn();
    renderPanel({
      id: 'mv-1', storyboardId: 'sb-1', scenes: [{ sceneId: 'mvs-old' }],
      audioAnalysis: { durationSec: 40, beats: [], downbeats: [], sections: [{ label: 'Verse', startSec: 0, endSec: 18 }, { label: 'Chorus', startSec: 18, endSec: 40 }] },
      lyricCues: [{ id: 'c1', text: 'Here we go', startSec: 22 }],
    }, vi.fn(), onFitted);

    fireEvent.click(await screen.findByRole('button', { name: /Fit to song/ }));
    expect(screen.getByText('0:18.00–0:40.00')).toBeTruthy();
    const start = screen.getByLabelText('Starts');
    fireEvent.change(start, { target: { value: '22' } });
    expect(screen.getByText('0:22.00–0:40.00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Write 2 shots/ }));
    expect(api.fitMusicVideoToStoryboard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Write shots' }));
    await waitFor(() => expect(onFitted).toHaveBeenCalledWith(saved));
    expect(api.fitMusicVideoToStoryboard).toHaveBeenCalledWith('mv-1', { boardUpdatedAt: fitBoard.updatedAt, starts: { 'beat-2': 22 } }, { silent: true });
  });

  it('asks for an analyzed song before fitting', async () => {
    api.getStoryboard.mockResolvedValue(board);
    renderPanel({ id: 'mv-1', storyboardId: 'sb-1', scenes: [] });
    expect(await screen.findByText(/Analyze the song on the Song step/)).toBeTruthy();
  });
});
