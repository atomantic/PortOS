import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => ({ status: 'idle' }) }));
const copyToClipboard = vi.fn(async () => true);
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: (...a) => copyToClipboard(...a) }));

const listArtists = vi.fn();
const updateArtist = vi.fn();
const getArtistSubmissionProfile = vi.fn();
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  listArtists: (...a) => listArtists(...a),
  updateArtist: (...a) => updateArtist(...a),
  getArtistSubmissionProfile: (...a) => getArtistSubmissionProfile(...a),
}));

import ArtistsManager from './ArtistsManager';

// A record saved before the press & submission profile existed: no profile keys.
const LEGACY = { id: 'artist-1', name: 'Nova Vale', genre: 'dream pop', bio: 'Long bio.' };

const renderAt = async (path) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/music/artists/:id" element={<ArtistsManager />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  listArtists.mockResolvedValue([LEGACY]);
});
afterEach(cleanup);

describe('<ArtistsManager> press & submission profile', () => {
  it('edits a bio on an older artist, saves it with the record, then copies the saved profile', async () => {
    await renderAt('/music/artists/artist-1');
    expect(screen.getByText('Bios').closest('summary')).toHaveTextContent('1/3 filled');
    expect(screen.getByLabelText('Full bio')).toHaveValue('Long bio.');

    fireEvent.change(screen.getByLabelText('Short bio'), { target: { value: 'Writes folk songs.' } });
    expect(screen.getByText('3 words · 18/1500 characters')).toBeTruthy();
    const copy = screen.getByRole('button', { name: /Copy profile/ });
    expect(copy).toBeDisabled();

    updateArtist.mockImplementation(async (id, patch) => ({ ...LEGACY, ...patch, id }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(updateArtist).toHaveBeenCalledWith('artist-1', expect.objectContaining({ bioShort: 'Writes folk songs.', bio: 'Long bio.', creditName: '' }), { silent: true });
    expect(copy).not.toBeDisabled();

    getArtistSubmissionProfile.mockResolvedValue({ markdown: '# Nova Vale\n' });
    await act(async () => { fireEvent.click(copy); });
    expect(getArtistSubmissionProfile).toHaveBeenCalledWith('artist-1', { silent: true });
    expect(copyToClipboard).toHaveBeenCalledWith('# Nova Vale\n', 'Profile copied');
  });
});
