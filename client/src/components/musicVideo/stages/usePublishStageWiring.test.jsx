/**
 * Music Video page suite for the Publish step container (`usePublishStageWiring`): publication copy and the publishing kit.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  MV_ROUTES,
  NavTo,
  installMusicVideoPageHooks,
} from '../../../test/musicVideoPageMocks.jsx';
import { listQueueMediaJobs } from '../../../services/apiMediaJobs.js';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { listMusicVideoProjects, getMusicVideoFestivalPacket, getMusicVideoPublishPlatforms, draftMusicVideoPublishCopy } from '../../../services/apiMusicVideo.js';

installMusicVideoPageHooks();

describe('MusicVideo stage tabs (#9243)', () => {
  it('uses the newly selected project making-of notes and links when drafting publication copy', async () => {
    const first = { ...PROJECT_WITH_CLIP, publishKit: { notes: 'Example first story', links: { youtube: 'https://example.com/first' } } };
    const second = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Example Other Project', publishKit: { notes: 'Example second story', links: { youtube: 'https://example.com/second' } } };
    listMusicVideoProjects.mockResolvedValue([first, second]);
    // Each opened project reads its own platform set.
    getMusicVideoPublishPlatforms.mockResolvedValue({ platforms: { youtube: { enabled: true } } });
    draftMusicVideoPublishCopy.mockResolvedValueOnce({ project: second });
    render(<MemoryRouter initialEntries={['/music-video/mv-1/publish']}>
      <NavTo to="/music-video/mv-other/publish" />
      {MV_ROUTES}
    </MemoryRouter>);
    const notes = await screen.findByLabelText(/Making-of notes/);
    await waitFor(() => expect(listQueueMediaJobs).toHaveBeenCalledWith({ kind: 'video-upscale', limit: 10 }));
    expect(notes).toHaveValue('Example first story');
    fireEvent.change(notes, { target: { value: 'Example unsaved first story' } });
    fireEvent.click(screen.getByRole('button', { name: 'go-/music-video/mv-other/publish' }));
    await screen.findByRole('heading', { level: 2, name: second.name });
    expect(await screen.findByLabelText(/Making-of notes/)).toHaveValue('Example second story');
    await waitFor(() => expect(getMusicVideoFestivalPacket).toHaveBeenLastCalledWith(second.id, { silent: true }));
    expect(screen.getByLabelText(/Full video URL/)).toHaveValue('https://example.com/second');
    fireEvent.click(screen.getByRole('button', { name: 'Draft copy' }));
    await waitFor(() => expect(draftMusicVideoPublishCopy).toHaveBeenCalledWith(second.id, expect.objectContaining({
      notes: 'Example second story', links: { youtube: 'https://example.com/second' }, length: 'short',
    })));
  });
});
