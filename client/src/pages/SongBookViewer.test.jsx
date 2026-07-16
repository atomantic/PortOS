import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock the api barrel (RoundEditor.test.jsx harness style).
const api = vi.hoisted(() => ({
  getSong: vi.fn(),
  updateSong: vi.fn(),
  deleteSong: vi.fn(),
  listSongAttachments: vi.fn(),
  uploadSongAttachment: vi.fn(),
  deleteSongAttachment: vi.fn(),
  songAttachmentUrl: (id, filename) => `/api/brain/songbook/${id}/attachments/${filename}`,
}));
vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import SongBookViewer from './SongBookViewer.jsx';

// Invented fixture data only (privacy convention) — nonsense sheet content.
const SHEET = `[Chorus]
C  G  Am  F
Nonsense words here`;

const song = (extra = {}) => ({
  id: 'abc',
  title: 'Example Song',
  artist: 'The Placeholders',
  instrument: 'guitar',
  stage: 'new',
  tags: [],
  key: 'C',
  capo: 2,
  tuning: '',
  sourceUrl: '',
  content: { format: 'tab', text: SHEET },
  notes: '',
  attachments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const renderPage = (path = '/songbook/abc') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/songbook/:id" element={<SongBookViewer />} /></Routes>
  </MemoryRouter>,
);

describe('SongBookViewer', () => {
  beforeEach(() => {
    api.getSong.mockReset().mockResolvedValue(song());
    api.listSongAttachments.mockReset().mockResolvedValue([]);
    api.updateSong.mockReset();
    api.deleteSong.mockReset();
    globalThis.localStorage?.clear?.();
  });

  it('renders the parsed sheet in play mode', async () => {
    renderPage();
    expect(await screen.findByText('Example Song')).toBeTruthy();
    // Section header + lyric line from parseTabSheet.
    expect(await screen.findByText('Chorus')).toBeTruthy();
    expect(screen.getByText('Nonsense words here')).toBeTruthy();
    // Meta badges
    expect(screen.getByText('Key C')).toBeTruthy();
    expect(screen.getByText('Capo 2')).toBeTruthy();
    // Attachments settle to the empty message (no act warnings left pending).
    expect(await screen.findByText(/No attachments/)).toBeTruthy();
  });

  it('shows the not-found fallback for a stale id', async () => {
    api.getSong.mockRejectedValue(Object.assign(new Error('Song not found'), { status: 404 }));
    api.listSongAttachments.mockRejectedValue(new Error('Song not found'));
    renderPage();
    expect(await screen.findByText('Song not found')).toBeTruthy();
    expect(screen.getByText('Back to SongBook')).toBeTruthy();
  });

  it('flips the stage via a partial updateSong and merges the server record', async () => {
    api.updateSong.mockResolvedValue(song({ stage: 'learned' }));
    renderPage();
    const select = await screen.findByLabelText('Learning stage');
    fireEvent.change(select, { target: { value: 'learned' } });
    expect(api.updateSong).toHaveBeenCalledWith('abc', { stage: 'learned' });
    await waitFor(() => expect(screen.getByLabelText('Learning stage').value).toBe('learned'));
  });

  it('marks synced-but-absent attachments as not on this machine', async () => {
    api.listSongAttachments.mockResolvedValue([
      { filename: 'aaaa1111-sheet.pdf', label: 'Sheet music', mime: 'application/pdf', size: 1024, sha256: 'x', present: false },
      { filename: 'bbbb2222-local.pdf', label: 'Local copy', mime: 'application/pdf', size: 2048, sha256: 'y', present: true },
    ]);
    renderPage();
    expect(await screen.findByText('not on this machine')).toBeTruthy();
    // The present attachment is a link to the serve URL; the absent one is not.
    const link = screen.getByRole('link', { name: 'Local copy' });
    expect(link.getAttribute('href')).toBe('/api/brain/songbook/abc/attachments/bbbb2222-local.pdf');
    expect(screen.queryByRole('link', { name: /Sheet music/ })).toBeNull();
  });

  it('renders the edit form in ?mode=edit and saves the whole content object', async () => {
    api.updateSong.mockImplementation((id, patch) => Promise.resolve(song({ ...patch })));
    renderPage('/songbook/abc?mode=edit');
    const titleInput = await screen.findByLabelText('Title');
    expect(titleInput.value).toBe('Example Song');
    fireEvent.change(titleInput, { target: { value: 'Renamed Song' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateSong).toHaveBeenCalled());
    const [, patch] = api.updateSong.mock.calls[0];
    expect(patch.title).toBe('Renamed Song');
    // The WHOLE content object goes in the PUT (format would otherwise reset).
    expect(patch.content).toEqual({ format: 'tab', text: SHEET });
    // attachments is server-managed — never sent.
    expect('attachments' in patch).toBe(false);
  });
});
