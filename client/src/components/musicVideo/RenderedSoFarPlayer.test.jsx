import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/apiMusicVideo.js', () => ({
  buildMusicVideoRenderPreview: vi.fn(),
  musicVideoShotRenderUrl: (id, name) => `/api/music-video/${id}/shot-renders/${name}`,
}));

import RenderedSoFarPlayer from './RenderedSoFarPlayer.jsx';
import { buildMusicVideoRenderPreview } from '../../services/apiMusicVideo.js';

const project = { id: 'mv-1', composition: { mode: 'composed' } };
const key = 'a'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('RenderedSoFarPlayer', () => {
  it('plays the shots stitched so far, updates as more finish, and switches to the phone copy', async () => {
    buildMusicVideoRenderPreview.mockResolvedValueOnce({ name: `preview-${key}.mp4`, light: false, durationSec: 45.5, shots: 12, totalShots: 116, complete: false });
    render(<RenderedSoFarPlayer project={project} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Play/ })));
    expect(buildMusicVideoRenderPreview).toHaveBeenCalledWith('mv-1', { light: false }, { silent: true });
    expect(screen.getByTestId('rendered-so-far-state').textContent).toBe('12 of 116 shots · 0:45');
    expect(document.querySelector('video').getAttribute('src')).toBe(`/api/music-video/mv-1/shot-renders/preview-${key}.mp4`);

    buildMusicVideoRenderPreview.mockResolvedValueOnce({ name: `preview-${key}-light.mp4`, light: true, durationSec: 248.4, shots: 116, totalShots: 116, complete: true });
    await act(async () => fireEvent.click(screen.getByLabelText('Phone copy')));
    expect(buildMusicVideoRenderPreview).toHaveBeenLastCalledWith('mv-1', { light: true }, { silent: true });
    expect(screen.getByTestId('rendered-so-far-state').textContent).toBe('Whole video · 4:08');
    expect(screen.queryByRole('button', { name: /Update/ })).toBeNull();
  });

  it('says why nothing plays yet', async () => {
    buildMusicVideoRenderPreview.mockRejectedValueOnce(new Error('No shot is rendered yet: the first shot plays here once it is done'));
    render(<RenderedSoFarPlayer project={project} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Play/ })));
    expect(screen.getByRole('alert').textContent).toMatch(/No shot is rendered yet/);
  });
});
