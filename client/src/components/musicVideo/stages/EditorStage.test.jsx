/**
 * Music Video page suite for the Editor page: the shots on a timeline under the player, opening a shot in place.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import { PROJECT_WITH_CLIP, PROJECT_ANALYZED, MV_ROUTES, LocationProbe, installMusicVideoPageHooks } from '../../../test/musicVideoPageMocks.jsx';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { listMusicVideoProjects } from '../../../services/apiMusicVideo.js';

installMusicVideoPageHooks();

const PROJECT = {
  ...PROJECT_WITH_CLIP,
  audioAnalysis: { ...PROJECT_ANALYZED.audioAnalysis, durationSec: 12 },
  scenes: [
    { sceneId: 's2', order: 1, startSec: 4, endSec: 12, prompt: 'Wide on the rink' },
    { sceneId: 's1', order: 0, startSec: 0, endSec: 4, prompt: 'Close on the skates', referenceImageId: 'frame-a.png' },
  ],
};
const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocationProbe />
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
    expect(within(screen.getByRole('region', { name: 'Shot' })).getByText('Tap a shot on the timeline to edit it.')).toBeInTheDocument();

    await act(async () => { fireEvent.click(clips[1]); });
    expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-1/editor/scene/s2');
    const shot = screen.getByRole('region', { name: 'Shot' });
    await waitFor(() => expect(within(shot).getByRole('button', { name: 'Close shot' })).toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'Timeline' })).getByRole('button', { name: /^Open Shot 2/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { level: 3, name: 'Editor' })).toBeInTheDocument();

    await act(async () => { fireEvent.click(within(shot).getByRole('button', { name: 'Close shot' })); });
    expect(screen.getByTestId('loc')).toHaveTextContent(/\/music-video\/mv-1\/editor$/);
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeInTheDocument();
  });
});
