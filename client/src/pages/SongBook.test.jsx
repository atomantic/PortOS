import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock the api barrel (RoundEditor.test.jsx harness style).
const api = vi.hoisted(() => ({
  listSongs: vi.fn(),
  createSong: vi.fn(),
  deleteSong: vi.fn(),
  patchSongStage: vi.fn(),
}));
vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import SongBook from './SongBook.jsx';

// Invented fixture data only (privacy convention).
const song = (id, title, extra = {}) => ({
  id,
  title,
  artist: 'The Placeholders',
  instrument: 'guitar',
  stage: 'new',
  tags: ['campfire'],
  key: '',
  capo: 0,
  tuning: '',
  sourceUrl: '',
  content: { format: 'tab', text: '' },
  notes: '',
  attachments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const renderPage = (path = '/songbook') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/songbook" element={<SongBook />} /></Routes>
  </MemoryRouter>,
);

describe('SongBook index', () => {
  beforeEach(() => {
    api.listSongs.mockReset().mockResolvedValue({ songs: [song('s1', 'Example Song')] });
    api.patchSongStage.mockReset();
    api.deleteSong.mockReset();
    api.createSong.mockReset();
  });

  it('renders the loaded songs', async () => {
    renderPage();
    expect(await screen.findByText('Example Song')).toBeTruthy();
    expect(screen.getByText('The Placeholders')).toBeTruthy();
  });

  it('flips a song stage via patchSongStage and updates local state reactively', async () => {
    api.patchSongStage.mockResolvedValue(song('s1', 'Example Song', { stage: 'learning' }));
    renderPage();
    const select = await screen.findByLabelText('Stage for Example Song');
    expect(select.value).toBe('new');
    fireEvent.change(select, { target: { value: 'learning' } });
    expect(api.patchSongStage).toHaveBeenCalledWith('s1', 'learning');
    await waitFor(() => expect(screen.getByLabelText('Stage for Example Song').value).toBe('learning'));
    // Reactive local-state update — no refetch of the list.
    expect(api.listSongs).toHaveBeenCalledTimes(1);
  });

  it('deletes a song after inline confirmation and removes its card', async () => {
    api.deleteSong.mockResolvedValue({ id: 's1' });
    renderPage();
    await screen.findByText('Example Song');
    fireEvent.click(screen.getByLabelText('Delete Example Song'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.deleteSong).toHaveBeenCalledWith('s1', { silent: true });
    await waitFor(() => expect(screen.queryByText('Example Song')).toBeNull());
  });

  it('filters by stage from the URL search param', async () => {
    api.listSongs.mockResolvedValue({
      songs: [song('s1', 'Example Song'), song('s2', 'Other Tune', { stage: 'memorized' })],
    });
    renderPage('/songbook?stage=memorized');
    expect(await screen.findByText('Other Tune')).toBeTruthy();
    expect(screen.queryByText('Example Song')).toBeNull();
  });

  it('shows the teaching empty state when there are no songs', async () => {
    api.listSongs.mockResolvedValue({ songs: [] });
    renderPage();
    expect(await screen.findByText('No songs yet')).toBeTruthy();
    expect(screen.getByText('Import a song')).toBeTruthy();
  });
});
