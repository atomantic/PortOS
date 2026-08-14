import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// Mock the api barrel (RoundEditor.test.jsx harness style).
const api = vi.hoisted(() => ({
  listSongs: vi.fn(),
  createSong: vi.fn(),
  deleteSong: vi.fn(),
  updateSong: vi.fn(),
}));
vi.mock('../services/api', () => api);
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: toast }));

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
    api.updateSong.mockReset();
    api.deleteSong.mockReset();
    api.createSong.mockReset();
    toast.error.mockReset();
    toast.success.mockReset();
  });

  it('renders the loaded songs', async () => {
    renderPage();
    expect(await screen.findByText('Example Song')).toBeTruthy();
    expect(screen.getByText('The Placeholders')).toBeTruthy();
  });

  it('flips a song stage via a partial updateSong and updates local state reactively', async () => {
    api.updateSong.mockResolvedValue(song('s1', 'Example Song', { stage: 'learning' }));
    renderPage();
    const select = await screen.findByLabelText('Stage for Example Song');
    expect(select.value).toBe('new');
    fireEvent.change(select, { target: { value: 'learning' } });
    expect(api.updateSong).toHaveBeenCalledWith('s1', { stage: 'learning' });
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

  // Practice scheduling (#4102) — the "what should I practice today?" view.
  it('filters to due songs from ?due=1 and counts them on the toggle', async () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    api.listSongs.mockResolvedValue({
      songs: [
        song('s1', 'Example Song'), // no practice schedule → due
        song('s2', 'Other Tune', { practice: { nextReview: soon, sessions: 2 } }),
      ],
    });
    renderPage('/songbook?due=1');
    expect(await screen.findByText('Example Song')).toBeTruthy();
    expect(screen.queryByText('Other Tune')).toBeNull();
    // Count is over ALL songs, not the filtered view.
    expect(screen.getByRole('button', { name: 'Due (1)' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('labels each card as due or scheduled', async () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    api.listSongs.mockResolvedValue({
      songs: [song('s1', 'Example Song'), song('s2', 'Other Tune', { practice: { nextReview: soon } })],
    });
    renderPage();
    expect(await screen.findByText('Due for practice')).toBeTruthy();
    expect(screen.getByText(/^Review in \d/)).toBeTruthy();
  });

  it('toggles the due filter into the URL rather than local state', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Due/ }));
    await waitFor(() => expect(
      screen.getByRole('button', { name: /^Due/ }).getAttribute('aria-pressed'),
    ).toBe('true'));
  });

  it('shows the teaching empty state when there are no songs', async () => {
    api.listSongs.mockResolvedValue({ songs: [] });
    renderPage();
    expect(await screen.findByText('No songs yet')).toBeTruthy();
    expect(screen.getByText('Import a song')).toBeTruthy();
  });

  // A failed fetch must not collapse into the fetched-and-empty state (#3899).
  it('renders a retryable error banner instead of the empty state when the load fails', async () => {
    api.listSongs.mockRejectedValue(new Error('Network down'));
    renderPage();
    expect(await screen.findByText("Couldn't load your songs")).toBeTruthy();
    expect(screen.queryByText('No songs yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('re-fetches and clears the error banner when Retry is clicked', async () => {
    api.listSongs.mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce({ songs: [song('s1', 'Example Song')] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Song')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Couldn't load your songs")).toBeNull());
    expect(api.listSongs).toHaveBeenCalledTimes(2);
  });

  it('does not double-toast on a failed load — the banner owns the error UI', async () => {
    api.listSongs.mockRejectedValue(new Error('Network down'));
    renderPage();
    await screen.findByText("Couldn't load your songs");
    expect(api.listSongs).toHaveBeenCalledWith({ silent: true });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
