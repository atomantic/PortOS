import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('./ArtistPicker', () => ({ default: () => <div data-testid="artist-picker" /> }));
vi.mock('./AlbumTrackPicker', () => ({ default: () => <div data-testid="track-picker" /> }));
vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => ({ status: 'idle' }) }));

const listAlbums = vi.fn();
const listTracks = vi.fn();
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  listAlbums: (...a) => listAlbums(...a),
  listTracks: (...a) => listTracks(...a),
}));

import AlbumsManager from './AlbumsManager';

const ALBUM = { id: 'album-1', title: 'Example Album', trackIds: [] };

const renderAt = async (path) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/music/albums/:id" element={<AlbumsManager />} />
        <Route path="/music/albums" element={<AlbumsManager />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  listTracks.mockResolvedValue([]);
});
afterEach(cleanup);

describe('<AlbumsManager> failed load', () => {
  it('shows a load error with Retry instead of "No albums yet" or a "not found" album, then hydrates the open album', async () => {
    listAlbums.mockRejectedValueOnce(new Error('Server unavailable'));
    await renderAt('/music/albums/album-1');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load albums — Server unavailable');
    expect(screen.queryByText(/No albums yet/)).toBeNull();
    expect(screen.queryByText(/could not be found/)).toBeNull();

    listAlbums.mockResolvedValue([ALBUM]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByDisplayValue('Example Album')).toBeTruthy();
  });

  it('treats a failed track-pool read as a failed load too', async () => {
    listAlbums.mockResolvedValue([ALBUM]);
    listTracks.mockRejectedValueOnce(new Error('Tracks unavailable'));
    await renderAt('/music/albums');
    expect(screen.getByRole('alert')).toHaveTextContent('Tracks unavailable');
  });
});
