import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/apiMusicVideo.js', () => ({
  listMusicVideoProjectSummaries: vi.fn(),
}));

import { listMusicVideoProjectSummaries } from '../../services/apiMusicVideo.js';
import ExistingSongSelect from './ExistingSongSelect.jsx';

const page = {
  items: [
    { id: 'p1', name: 'Example Song', trackId: 't1' },
    { id: 'p2', name: 'No Audio Yet' },
  ],
};

describe('ExistingSongSelect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists only projects that have a song', async () => {
    listMusicVideoProjectSummaries.mockResolvedValue(page);
    render(<ExistingSongSelect id="song" value="" onChange={vi.fn()} />);
    expect(await screen.findByRole('option', { name: 'Use the song from Example Song' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /No Audio Yet/ })).toBeNull();
  });

  it('shows a load error with Retry, not a "(not found)" song, when the read fails', async () => {
    listMusicVideoProjectSummaries.mockRejectedValueOnce(new Error('Projects unavailable'));
    render(<ExistingSongSelect id="song" value="p1" onChange={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load projects with a song — Projects unavailable');
    expect(screen.queryByRole('option', { name: /not found/ })).toBeNull();

    listMusicVideoProjectSummaries.mockResolvedValueOnce(page);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'Use the song from Example Song' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
