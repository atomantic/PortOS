import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

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
    // Six staff lines: identifiably GUITAR tab, so non-guitar views collapse
    // it under the guitar-specific label (a ≤4-line staff would stay visible
    // in ukulele view — pinned in TabSheetView.test.jsx).
    const TAB_SHEET = `[Chorus]
C  G  Am  F
Nonsense words here
e|--3--2--|
B|--0-----|
G|--0-----|
D|--0-----|
A|--2-----|
E|--3-----|`;

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

  describe('drum charts (#3115)', () => {
    // Invented groove (privacy convention).
    const DRUM_CHART = `time: 4/4
tempo: 96
subdivision: 2

# Groove x2
HH: x x x x x x x x
S:  - - - - o - - -
K:  o - - - - - o -`;

    const drumSong = (extra = {}) => song({
      instrument: 'drums',
      content: { format: 'drum', text: DRUM_CHART },
      ...extra,
    });

    it('renders the kit sheet and the drum transport instead of the tab sheet', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      expect(await screen.findByText('Example Song')).toBeTruthy();
      // The kit sheet drew — one continuous lane for the whole song.
      expect(screen.getByLabelText(/^Drum chart —/)).toBeTruthy();
      // The frozen label column names every kit row the chart uses.
      expect(screen.getAllByText('Hi-Hat').length).toBeGreaterThan(0);
      // Transport controls are present.
      expect(screen.getByLabelText('Play along')).toBeTruthy();
      expect(screen.getByLabelText('Practice tempo (BPM)')).toBeTruthy();
      expect(screen.getByLabelText('Enable loop')).toBeTruthy();
      // The metronome defaults ON for a play-along, so the button offers to
      // turn it off.
      expect(screen.getByLabelText('Turn the metronome off')).toBeTruthy();
    });

    it('hides transpose, chord voicings AND the rival autoscroll transport for a drum chart', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      expect(await screen.findByLabelText('Play along')).toBeTruthy();
      expect(screen.queryByLabelText('Transpose up')).toBeNull();
      expect(screen.queryByLabelText('Transpose down')).toBeNull();
      expect(screen.queryByRole('combobox', { name: 'Instrument view' })).toBeNull();
      // The kit strip scrolls horizontally under its own playhead — a vertical
      // autoscroll play button beside it would be a second, conflicting "play".
      expect(screen.queryByLabelText('Autoscroll speed')).toBeNull();
      expect(screen.queryByLabelText('Play autoscroll')).toBeNull();
    });

    it('seeds BPM from the chart tempo and persists an edit per song (never the record)', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      await screen.findByLabelText('Practice tempo (BPM)');
      await waitFor(() => expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('96'));
      fireEvent.change(screen.getByLabelText('Practice tempo (BPM)'), { target: { value: '72' } });
      await waitFor(() => expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('72'));
      expect(globalThis.localStorage.getItem('songbook:drumBpm:abc')).toBe('72');
      // A practice tempo is a per-machine preference — never a record write.
      expect(api.updateSong).not.toHaveBeenCalled();
    });

    it('restores the stored BPM on reload instead of the written tempo', async () => {
      globalThis.localStorage.setItem('songbook:drumBpm:abc', '60');
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      await screen.findByLabelText('Practice tempo (BPM)');
      await waitFor(() => expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('60'));
    });

    it('recomputes BPM from a percent-of-written button', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      expect(await screen.findByLabelText('Practice tempo (BPM)')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '50%' }));
      await waitFor(() => expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('48'));
      fireEvent.click(screen.getByRole('button', { name: '100%' }));
      await waitFor(() => expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('96'));
    });

    it('clamps a BPM outside the metronome band', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      const bpm = await screen.findByLabelText('Practice tempo (BPM)');
      fireEvent.change(bpm, { target: { value: '9999' } });
      await waitFor(() => expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('320'));
      fireEvent.change(screen.getByLabelText('Practice tempo (BPM)'), { target: { value: '1' } });
      await waitFor(() => expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('20'));
    });

    it('disables Play for an all-rest chart, and space cannot route around it', async () => {
      api.getSong.mockResolvedValue(drumSong({ content: { format: 'drum', text: 'HH: ----\nK: ----' } }));
      renderPage();
      const play = await screen.findByLabelText('Play along');
      expect(play.disabled).toBe(true);
      // The keyboard binding shares the button's gate — no AudioContext is
      // touched (jsdom has none, so a start attempt would throw).
      fireEvent.keyDown(window, { key: ' ' });
      expect(screen.getByLabelText('Play along').disabled).toBe(true);
    });

    it('defaults the metronome ON and remembers it being turned off', async () => {
      api.getSong.mockResolvedValue(drumSong());
      const { unmount } = renderPage();
      // A play-along without a pulse is the unusual case, so the click starts on
      // — and "never chosen" (no stored value) must not read as "chosen off".
      fireEvent.click(await screen.findByLabelText('Turn the metronome off'));
      expect(globalThis.localStorage.getItem('songbook:drumClick')).toBe('0');
      unmount();

      renderPage();
      expect(await screen.findByLabelText('Turn the metronome on')).toBeTruthy();
    });

    it('mutes the metronome from the m shortcut as well as the button', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      await screen.findByLabelText('Turn the metronome off');
      fireEvent.keyDown(window, { key: 'm' });
      expect(await screen.findByLabelText('Turn the metronome on')).toBeTruthy();
      fireEvent.keyDown(window, { key: 'm' });
      expect(await screen.findByLabelText('Turn the metronome off')).toBeTruthy();
    });

    it('defaults the metronome to full and persists a level per machine', async () => {
      api.getSong.mockResolvedValue(drumSong());
      const { unmount } = renderPage();
      const volume = await screen.findByLabelText('Metronome volume');
      // No stored level is "never chosen" → full, NOT silent.
      expect(volume.value).toBe('100');
      fireEvent.change(volume, { target: { value: '30' } });
      await waitFor(() => expect(screen.getByLabelText('Metronome volume').value).toBe('30'));
      expect(globalThis.localStorage.getItem('songbook:drumClickVolume')).toBe('0.3');
      // The click is a reference pulse, not song content — no record write, and
      // the level is global rather than keyed by song.
      expect(api.updateSong).not.toHaveBeenCalled();
      unmount();

      renderPage();
      await waitFor(() => expect(screen.getByLabelText('Metronome volume').value).toBe('30'));
    });

    it('raising the level off silence unmutes, so the slider is never a dead control', async () => {
      globalThis.localStorage.setItem('songbook:drumClick', '0');
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      const volume = await screen.findByLabelText('Metronome volume');
      expect(screen.getByLabelText('Turn the metronome on')).toBeTruthy(); // muted
      fireEvent.change(volume, { target: { value: '60' } });
      // Reaching for the level is an intent to HEAR it.
      expect(await screen.findByLabelText('Turn the metronome off')).toBeTruthy();

      // The reverse is deliberately not wired: dragging to zero leaves the
      // toggle alone, so unmuting later can't come back silent.
      fireEvent.change(screen.getByLabelText('Metronome volume'), { target: { value: '0' } });
      await waitFor(() => expect(screen.getByLabelText('Metronome volume').value).toBe('0'));
      expect(screen.getByLabelText('Turn the metronome off')).toBeTruthy();
    });

    it('reveals the loop bar range only when looping is on', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      expect(await screen.findByLabelText('Enable loop')).toBeTruthy();
      expect(screen.queryByLabelText('Loop from bar')).toBeNull();
      fireEvent.click(screen.getByLabelText('Enable loop'));
      const from = await screen.findByLabelText('Loop from bar');
      // The repeated block expands to two real bars, so both are selectable.
      expect(from.querySelectorAll('option')).toHaveLength(2);
      expect(screen.getByLabelText('Loop to bar').value).toBe('2');
    });

    it('previews the kit sheet in edit mode and defaults Drums to the drum format', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage('/songbook/abc?mode=edit');
      expect(await screen.findByLabelText('Title')).toBeTruthy();
      expect(screen.getByLabelText('Format').value).toBe('drum');
      expect(screen.getByLabelText(/^Drum chart —/)).toBeTruthy();
      expect(screen.getByLabelText('Play along')).toBeTruthy();
    });

    it('keeps the idle edit preview synchronized before Play', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage('/songbook/abc?mode=edit');
      const editor = await screen.findByLabelText('Content');
      fireEvent.change(editor, { target: { value: `${DRUM_CHART}\nC: x - x -` } });

      expect(screen.queryByText('Chart changed — press Play to reload.')).toBeNull();
      expect(screen.getByLabelText('Play along')).toBeTruthy();
    });

    it('keeps edit-preview practice settings when returning to play mode', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage('/songbook/abc?mode=edit');
      const bpm = await screen.findByLabelText('Practice tempo (BPM)');
      fireEvent.change(bpm, { target: { value: '72' } });
      fireEvent.click(screen.getByRole('button', { name: 'View' }));

      await waitFor(() => expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('72'));
    });

    it('inherits play-mode count-in and loop settings when entering edit mode', async () => {
      api.getSong.mockResolvedValue(drumSong());
      renderPage();
      await screen.findByLabelText('Count-in');
      fireEvent.change(screen.getByLabelText('Count-in'), { target: { value: '2' } });
      fireEvent.click(screen.getByLabelText('Enable loop'));
      fireEvent.change(screen.getByLabelText('Loop from bar'), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

      await waitFor(() => expect(screen.getByLabelText('Count-in').value).toBe('2'));
      expect(screen.getByLabelText('Disable loop')).toBeTruthy();
      expect(screen.getByLabelText('Loop from bar').value).toBe('2');
    });

    it('keeps an unknown stored instrument/format selectable and preserves it on save', async () => {
      // A song synced from a NEWER peer carrying values this client doesn't list.
      api.getSong.mockResolvedValue(song({
        instrument: 'hurdy-gurdy',
        content: { format: 'futureformat', text: 'anything' },
      }));
      api.updateSong.mockImplementation((sid, patch) => Promise.resolve(song({ ...patch })));
      renderPage('/songbook/abc?mode=edit');
      const instrument = await screen.findByLabelText('Instrument');
      expect(instrument.value).toBe('hurdy-gurdy');
      expect(screen.getByLabelText('Format').value).toBe('futureformat');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.updateSong).toHaveBeenCalled());
      const [, patch] = api.updateSong.mock.calls[0];
      expect(patch.instrument).toBe('hurdy-gurdy');
      expect(patch.content.format).toBe('futureformat');
    });

    it('switching a blank song to Drums defaults its format to drum', async () => {
      api.getSong.mockResolvedValue(song({ instrument: 'guitar', content: { format: 'tab', text: '' } }));
      renderPage('/songbook/abc?mode=edit');
      const instrument = await screen.findByLabelText('Instrument');
      fireEvent.change(instrument, { target: { value: 'drums' } });
      await waitFor(() => expect(screen.getByLabelText('Format').value).toBe('drum'));
    });

    it('does NOT re-format a song that already has sheet text', async () => {
      api.getSong.mockResolvedValue(song());
      renderPage('/songbook/abc?mode=edit');
      const instrument = await screen.findByLabelText('Instrument');
      fireEvent.change(instrument, { target: { value: 'drums' } });
      await waitFor(() => expect(screen.getByLabelText('Instrument').value).toBe('drums'));
      expect(screen.getByLabelText('Format').value).toBe('tab');
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
    // The WHOLE content object goes in the PATCH (format would otherwise reset).
    expect(patch.content).toEqual({ format: 'tab', text: SHEET });
    // attachments is server-managed — never sent.
    expect('attachments' in patch).toBe(false);
  });
});
