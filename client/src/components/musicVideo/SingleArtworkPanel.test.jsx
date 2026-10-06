import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getMusicVideoSingleArtwork = vi.fn();
vi.mock('../../services/apiMusicVideo.js', () => ({ getMusicVideoSingleArtwork: (...a) => getMusicVideoSingleArtwork(...a) }));

import SingleArtworkPanel from './SingleArtworkPanel.jsx';

const view = (extra = {}) => ({
  stylePrompt: 'Proposed look', proposedStylePrompt: 'Proposed look', options: [], approvedImageId: null, composedPath: null,
  type: { position: 'bottom', color: '#ffffff', titleScale: 1 }, ...extra,
});
const actions = () => ({ busy: null, generate: vi.fn(), adjust: vi.fn(), compose: vi.fn(), approve: vi.fn(), unapprove: vi.fn(), save: vi.fn() });

describe('SingleArtworkPanel', () => {
  beforeEach(() => getMusicVideoSingleArtwork.mockReset());

  it('prefills the proposed style and generates with the edited prompt', async () => {
    getMusicVideoSingleArtwork.mockResolvedValue({ singleArtwork: view() });
    const a = actions();
    render(<SingleArtworkPanel project={{ id: 'p1' }} singleArtwork={a} />);
    const box = await screen.findByLabelText('Visual style prompt');
    await waitFor(() => expect(box).toHaveValue('Proposed look'));
    await userEvent.clear(box);
    await userEvent.type(box, 'Neon harbor');
    await userEvent.click(screen.getByRole('button', { name: /Generate 2 options/ }));
    expect(a.generate).toHaveBeenCalledWith({ stylePrompt: 'Neon harbor', count: 2 });
  });

  it('offers approve only once the selected option is composed', async () => {
    const opt = { id: 'sa-1', filename: 'a.png', kind: 'generate' };
    getMusicVideoSingleArtwork.mockResolvedValue({ singleArtwork: view({ options: [opt], composedOptionId: 'sa-1', composedPath: 'c.jpg' }) });
    const a = actions();
    render(<SingleArtworkPanel project={{ id: 'p1' }} singleArtwork={a} />);
    await userEvent.click(await screen.findByRole('button', { name: /Approve for DistroKid/ }));
    expect(a.approve).toHaveBeenCalledWith('sa-1');
  });
});
