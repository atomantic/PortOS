import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StoryboardFitPanel from './StoryboardFitPanel';

const api = vi.hoisted(() => ({ fitMusicVideoToStoryboard: vi.fn() }));
vi.mock('../../services/api', () => api);

const board = {
  id: 'sb-1', name: 'Example Story',
  beats: [{ id: 'beat-1', panels: [{ id: 'panel-1', action: 'Wide of the gym', seconds: 4, takes: [], selectedTakeId: null }] }],
};
const renderFit = (storyboard, project, onFitted = vi.fn()) => render(
  <StoryboardFitPanel project={project} board={storyboard} onFitted={onFitted} onBoardStale={vi.fn()} />,
);

beforeEach(() => api.fitMusicVideoToStoryboard.mockReset());

describe('StoryboardFitPanel', () => {
  it('previews the fit on the song, lets a beat start move, then writes the shots after confirming the replace', async () => {
    const fitBoard = {
      id: 'sb-1', name: 'Example Story', updatedAt: '2026-01-01T00:00:00.000Z',
      beats: [
        { id: 'beat-1', title: 'Arrival', panels: [{ id: 'panel-1', action: 'Wide of the gym', seconds: 4, takes: [], selectedTakeId: null }] },
        { id: 'beat-2', title: 'Lift off', panels: [{ id: 'panel-2', action: 'Crowd lifts her', seconds: 4, takes: [], selectedTakeId: null }] },
      ],
    };
    const saved = { id: 'mv-1', scenes: [{ sceneId: 'mvs-new' }] };
    api.fitMusicVideoToStoryboard.mockResolvedValue({ project: saved, shots: 2, replaced: 1 });
    const onFitted = vi.fn();
    renderFit(fitBoard, {
      id: 'mv-1', storyboardId: 'sb-1', scenes: [{ sceneId: 'mvs-old' }],
      audioAnalysis: { durationSec: 40, beats: [], downbeats: [], sections: [{ label: 'Verse', startSec: 0, endSec: 18 }, { label: 'Chorus', startSec: 18, endSec: 40 }] },
      lyricCues: [{ id: 'c1', text: 'Here we go', startSec: 22 }],
    }, onFitted);

    fireEvent.click(screen.getByRole('button', { name: /Fit to song/ }));
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
    renderFit(board, { id: 'mv-1', storyboardId: 'sb-1', scenes: [] });
    expect(screen.getByText(/Analyze the song on the Song step/)).toBeTruthy();
  });
});
