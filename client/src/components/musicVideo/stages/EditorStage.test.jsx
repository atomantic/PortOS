/**
 * Music Video page suite for the Editor page: the shots on a timeline under the player, opening a shot in place.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import { PROJECT_WITH_CLIP, PROJECT_ANALYZED, MV_ROUTES, LocationProbe, NavTo, installMusicVideoPageHooks } from '../../../test/musicVideoPageMocks.jsx';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { listMusicVideoProjects, renderMusicVideoExcerpt } from '../../../services/apiMusicVideo.js';

installMusicVideoPageHooks();

const PROJECT = {
  ...PROJECT_WITH_CLIP,
  audioAnalysis: { ...PROJECT_ANALYZED.audioAnalysis, durationSec: 12 },
  scenes: [
    { sceneId: 's2', order: 1, startSec: 4, endSec: 12, prompt: 'Wide on the rink' },
    { sceneId: 's1', order: 0, startSec: 0, endSec: 4, prompt: 'Close on the skates', referenceImageId: 'frame-a.png', videoHistoryId: 'test-clip' },
  ],
};
const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocationProbe />
    <NavTo to="/music-video/mv-1/editor?play=excerpt:fixture" />
    <NavTo to="/music-video/mv-2/editor" />
    {MV_ROUTES}
  </MemoryRouter>,
);

describe('MusicVideo editor page', () => {
  // Uniquely catches the editor losing its own route for the open shot: a tapped clip must open the
  // shot's card on the editor (not send the director to Shots), and closing it must come back here.
  it('opens a tapped clip in the editor, keeps the timeline, and closes back to the editor', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT]);
    renderAt('/music-video/mv-1/editor');
    await screen.findByRole('heading', { level: 2, name: PROJECT.name });
    const timeline = await screen.findByRole('region', { name: 'Timeline' });
    const clips = within(within(timeline).getByRole('group', { name: 'Shots' })).getAllByRole('button');
    expect(clips.map((clip) => clip.getAttribute('data-scene-id'))).toEqual(['s1', 's2']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(clips[1]); });
    expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-1/editor/scene/s2');
    // The shot opens in the slide-in drawer over the editor; the timeline keeps the page.
    const shot = screen.getByRole('dialog', { name: 'Shot 2' });
    await waitFor(() => expect(within(shot).getByRole('button', { name: 'Close shot' })).toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'Timeline' })).getByRole('button', { name: /^Open Shot 2/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { level: 3, name: 'Editor' })).toBeInTheDocument();

    await act(async () => { fireEvent.click(within(shot).getByRole('button', { name: 'Close shot' })); });
    expect(screen.getByTestId('loc')).toHaveTextContent(/\/music-video\/mv-1\/editor$/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeInTheDocument();
  });

  it('sends the displayed song-time range from an offset preview and shares the render slot with Review', async () => {
    const fixture = {
      ...PROJECT,
      excerpts: [{ id: 'fixture', startSec: 2, endSec: 9, status: 'complete', filename: 'fixture.mp4' }],
      scenes: [...PROJECT.scenes, { sceneId: 'lead', order: -1, preMusic: { durationSec: 3 }, prompt: 'Cold open' }],
    };
    listMusicVideoProjects.mockResolvedValue([fixture, { ...PROJECT, id: 'mv-2', name: 'Second project' }]);
    renderAt('/music-video/mv-1/editor?play=excerpt:fixture');
    const video = await screen.findByLabelText('Draft excerpt preview');
    const playhead = screen.getByLabelText('Playhead time');
    await waitFor(() => expect(playhead).toHaveTextContent('0:02.00'));
    const setIn = screen.getByRole('button', { name: 'Set In' });
    const setOut = screen.getByRole('button', { name: 'Set Out' });
    const clear = screen.getByRole('button', { name: 'Clear Range' });
    const renderDraft = screen.getByRole('button', { name: 'Render Draft' });
    const loop = screen.getByRole('button', { name: 'Loop Range' });
    expect(renderDraft).toBeDisabled();
    fireEvent.click(setIn);
    fireEvent.click(setOut);
    expect(screen.getByText('Set In before Out and keep both points within the song.')).toBeInTheDocument();
    fireEvent.click(clear);
    expect(screen.queryByRole('slider', { name: 'In point' })).not.toBeInTheDocument();
    fireEvent.click(setIn);

    video.currentTime = 4.125;
    await waitFor(() => expect(playhead).toHaveTextContent('0:06.13'));
    fireEvent.click(setOut);
    const marker = screen.getByRole('slider', { name: 'Out point' });
    fireEvent.keyDown(marker, { key: 'ArrowRight', shiftKey: true });
    expect(marker).toHaveAttribute('aria-valuetext', '0:07.125');
    expect(screen.getByText('In 0:02.000 · Out 0:07.125 · 5.125s')).toBeInTheDocument();
    expect(loop).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(loop).toBeEnabled());
    fireEvent.click(loop);

    let finishKickoff;
    renderMusicVideoExcerpt.mockImplementationOnce(() => new Promise((resolve) => { finishKickoff = resolve; }));
    fireEvent.click(renderDraft);
    expect(renderMusicVideoExcerpt).toHaveBeenCalledWith('mv-1', { startSec: 2, endSec: 7.125 }, { silent: true });
    expect(renderDraft).toBeDisabled();
    await act(async () => finishKickoff({ jobId: 'draft-job' }));
    expect(screen.getByText('Rendering draft · 0%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'View drafts in Review' }));
    expect(await screen.findByRole('button', { name: 'Render excerpt' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'go-/music-video/mv-1/editor?play=excerpt:fixture' }));
    expect(await screen.findByText('In 0:02.000 · Out 0:07.125 · 5.125s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Loop Range' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'go-/music-video/mv-2/editor' }));
    await screen.findByRole('heading', { level: 2, name: 'Second project' });
    expect(screen.getByRole('button', { name: 'Loop Range' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Clear Range' })).toBeDisabled();
    expect(screen.queryByRole('slider', { name: 'In point' })).not.toBeInTheDocument();
    expect(renderMusicVideoExcerpt).toHaveBeenCalledTimes(1);
  });
});
