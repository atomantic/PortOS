import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';

// Mock the api barrel — the editor only needs these few calls, and we control
// getSong timing to exercise the song→song navigation load window.
const api = vi.hoisted(() => ({
  getSong: vi.fn(),
  listSongs: vi.fn(),
  updateSong: vi.fn(),
  refreshSongTemplate: vi.fn(),
  getUploadUrl: (f) => `/api/uploads/${f}`,
  resolveB: null,
}));
vi.mock('../services/api', () => api);
// Stub the heavy child panels — this suite is about the load/navigation window.
vi.mock('../components/songs/SongAiPanel', () => ({ default: () => null }));
vi.mock('../components/songs/SongRecordings', () => ({ default: () => null }));
vi.mock('../components/songs/SongScoreEditor', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import SongEditor from './SongEditor.jsx';

const song = (id, title) => ({
  id, title, artist: '', key: '', tempo: null, rhythmShapeId: '', notation: '', score: '',
  notes: '', learned: false, sections: [], layers: [], recordings: [], references: [],
  partnerSongIds: [], builtIn: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/songs/b')}>go-b</button>
      <Routes><Route path="/songs/:id" element={<SongEditor />} /></Routes>
    </>
  );
}

describe('SongEditor song→song navigation', () => {
  beforeEach(() => {
    api.getSong.mockReset();
    api.listSongs.mockReset().mockResolvedValue({ songs: [song('a', 'Song A'), song('b', 'Song B')] });
    api.getSong.mockImplementation((id) => {
      if (id === 'a') return Promise.resolve({ song: song('a', 'Song A') });
      return new Promise((res) => { api.resolveB = () => res({ song: song('b', 'Song B') }); }); // deferred
    });
  });

  it('clears the previous draft while the next song loads (no stale-save window)', async () => {
    render(<MemoryRouter initialEntries={['/songs/a']}><Harness /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Song A')).toBeTruthy());

    // Navigate to the partner song; its fetch is still pending.
    fireEvent.click(screen.getByText('go-b'));

    // The old draft must be gone (so a Save can't write Song A into Song B) and
    // the loading state shown until the new song arrives.
    await waitFor(() => expect(screen.getByText(/Loading song/)).toBeTruthy());
    expect(screen.queryByText('Song A')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();

    api.resolveB();
    await waitFor(() => expect(screen.getByText('Song B')).toBeTruthy());
  });
});
