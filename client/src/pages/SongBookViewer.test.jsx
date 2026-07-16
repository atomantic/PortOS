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

  it('shows a retryable load-error state (not "not found") for a non-404 failure', async () => {
    api.getSong.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    api.listSongAttachments.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText("Couldn't load this song")).toBeTruthy();
    expect(screen.queryByText('Song not found')).toBeNull();

    // Retry re-runs the load; the next attempt succeeds and renders the song.
    api.getSong.mockResolvedValue(song());
    api.listSongAttachments.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Song')).toBeTruthy();
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

  describe('instrument-view toggle (#2656)', () => {
    // Sheet with a tab staff so the non-guitar collapse note is observable.
    const TAB_SHEET = `[Chorus]
C  G  Am  F
Nonsense words here
e|--3--2--|
B|--0-----|`;

    it('defaults to the song instrument (guitar) and shows the chords-used strip', async () => {
      renderPage();
      expect(await screen.findByText('Chorus')).toBeTruthy();
      const select = screen.getByRole('combobox', { name: 'Instrument view' });
      expect(select.value).toBe('guitar');
      expect(screen.getByText('Chords used')).toBeTruthy();
    });

    it('defaults to the song instrument for piano songs and collapses guitar tab', async () => {
      api.getSong.mockResolvedValue(song({ instrument: 'piano', content: { format: 'tab', text: TAB_SHEET } }));
      renderPage();
      expect(await screen.findByText('Chorus')).toBeTruthy();
      expect(screen.getByRole('combobox', { name: 'Instrument view' }).value).toBe('piano');
      expect(screen.getByText(/guitar tab — switch to Guitar view/)).toBeTruthy();
      expect(screen.queryByText('e|--3--2--|')).toBeNull();
    });

    it('maps non-diagram instruments (bass/voice/other) to the guitar view', async () => {
      api.getSong.mockResolvedValue(song({ instrument: 'bass' }));
      renderPage();
      expect(await screen.findByText('Chorus')).toBeTruthy();
      expect(screen.getByRole('combobox', { name: 'Instrument view' }).value).toBe('guitar');
    });

    it('honors a ?view= deep link over the song instrument', async () => {
      api.getSong.mockResolvedValue(song({ content: { format: 'tab', text: TAB_SHEET } }));
      renderPage('/songbook/abc?view=ukulele');
      expect(await screen.findByText('Chorus')).toBeTruthy();
      expect(screen.getByRole('combobox', { name: 'Instrument view' }).value).toBe('ukulele');
      expect(screen.getByText(/guitar tab — switch to Guitar view/)).toBeTruthy();
    });

    it('switching the view swaps the diagrams without any record write', async () => {
      api.getSong.mockResolvedValue(song({ content: { format: 'tab', text: TAB_SHEET } }));
      renderPage();
      expect(await screen.findByText('Chorus')).toBeTruthy();
      expect(screen.getByText('e|--3--2--|')).toBeTruthy();
      fireEvent.change(screen.getByRole('combobox', { name: 'Instrument view' }), { target: { value: 'piano' } });
      // Tab staff collapses; a chord popover now shows piano chips.
      expect(screen.getByText(/guitar tab — switch to Guitar view/)).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: 'Am' })[0]);
      const dialog = screen.getByRole('dialog', { name: 'Am chord voicing' });
      expect(dialog.querySelector('svg')).toBeNull(); // piano chips, not a fretbox
      expect(api.updateSong).not.toHaveBeenCalled();
    });

    it('diagrams follow transposed chord names', async () => {
      api.getSong.mockResolvedValue(song());
      renderPage();
      expect(await screen.findByText('Chorus')).toBeTruthy();
      fireEvent.click(screen.getByLabelText('Transpose up'));
      fireEvent.click(screen.getByLabelText('Transpose up'));
      // C G Am F +2 → D A Bm G; the popover opens for the transposed name.
      fireEvent.click(screen.getAllByRole('button', { name: 'Bm' })[0]);
      expect(screen.getByRole('dialog', { name: 'Bm chord voicing' })).toBeTruthy();
    });
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
