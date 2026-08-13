import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// Mock the api barrel (RoundEditor.test.jsx harness style).
const api = vi.hoisted(() => ({
  createSong: vi.fn(),
  importSongFromUrl: vi.fn(),
}));
vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const clipboard = vi.hoisted(() => ({ readClipboard: vi.fn() }));
vi.mock('../lib/clipboard.js', () => clipboard);

import toast from '../components/ui/Toast';
import SongBookImport from './SongBookImport.jsx';

const renderPage = (path = '/songbook/import') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/songbook/import" element={<SongBookImport />} /></Routes>
  </MemoryRouter>,
);

// All fixture content is invented (privacy convention).
describe('SongBookImport', () => {
  beforeEach(() => {
    api.createSong.mockReset().mockResolvedValue({ id: 'new-song-1' });
    api.importSongFromUrl.mockReset();
    clipboard.readClipboard.mockReset();
    toast.error.mockReset();
  });

  it('paste button stores the RAW clipboard text — normalization runs exactly once', async () => {
    // Pre-normalizing before setPasted would double entity-decode:
    // &amp;lt; → &lt; (first pass) → < (memo's second pass), turning
    // entity-encoded markup into tags that get stripped.
    clipboard.readClipboard.mockResolvedValue('&amp;lt; C   G   Am');
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    const textarea = await screen.findByLabelText('Pasted tab content');
    await waitFor(() => expect(textarea.value).toBe('&amp;lt; C   G   Am'));

    // Save sends the single-pass-normalized text (&amp;lt; → &lt;, not <).
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Example Song' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save song' }));
    await waitFor(() => expect(api.createSong).toHaveBeenCalled());
    const [body] = api.createSong.mock.calls[0];
    expect(body.content.text).toBe('&lt; C   G   Am');
  });

  it('clamps ChordPro meta before sending: out-of-range capo dropped, long key sliced to 20', async () => {
    const sheet = '{key: ThisKeyNameIsWayTooLongForTheSchema}\n{capo: 13}\nC   G   Am\nInvented lyric line';
    renderPage();
    fireEvent.change(screen.getByLabelText('Pasted tab content'), { target: { value: sheet } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Example Song' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save song' }));
    await waitFor(() => expect(api.createSong).toHaveBeenCalled());
    const [body] = api.createSong.mock.calls[0];
    expect(body.key).toBe('ThisKeyNameIsWayTooL'); // sliced at songInputSchema's 20-char max
    expect('capo' in body).toBe(false); // 13 is outside 0..12 — dropped, POST can't 400
  });

  it('a second meta-less import clears a stale auto-fill but never a user edit', async () => {
    renderPage();
    const textarea = screen.getByLabelText('Pasted tab content');
    const title = screen.getByLabelText('Title');

    // Song A auto-fills the title from its ChordPro directive on blur.
    fireEvent.change(textarea, { target: { value: '{title: First Song}\nC G' } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(title.value).toBe('First Song'));

    // Song B has NO metadata — the stale auto-fill must clear, not silently
    // save First Song's title onto B's content.
    fireEvent.change(textarea, { target: { value: 'D A\nDifferent invented line' } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(title.value).toBe(''));

    // A user-typed title survives a later meta-less import.
    fireEvent.change(title, { target: { value: 'My Own Name' } });
    fireEvent.change(textarea, { target: { value: 'E B\nThird invented line' } });
    fireEvent.blur(textarea);
    expect(title.value).toBe('My Own Name');
  });

  it('switching tabs re-applies the active draft metadata to auto-filled fields', async () => {
    api.importSongFromUrl.mockResolvedValue({
      draft: { title: 'Url Song', artist: 'Url Artist', content: { format: 'tab', text: 'C G' }, sourceUrl: 'https://example.com/t' },
    });
    renderPage();
    const title = screen.getByLabelText('Title');

    // Paste tab fills from ChordPro meta.
    const textarea = screen.getByLabelText('Pasted tab content');
    fireEvent.change(textarea, { target: { value: '{title: Paste Song}\nC G' } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(title.value).toBe('Paste Song'));

    // Fetch on the URL tab — its meta takes over while that tab is active.
    fireEvent.click(screen.getByRole('tab', { name: 'From URL' }));
    fireEvent.change(screen.getByLabelText('Tab / chord-sheet URL'), { target: { value: 'https://example.com/t' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(title.value).toBe('Url Song'));

    // Back to paste — Save would submit the PASTED content, so the auto-fill
    // must follow it back instead of keeping the URL song's metadata.
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    await waitFor(() => expect(title.value).toBe('Paste Song'));
  });

  describe('drum charts (#3115)', () => {
    // Invented groove (privacy convention).
    const DRUM_CHART = 'time: 4/4\ntempo: 96\nsubdivision: 2\n\nHH: x x x x x x x x\nS:  - - - - o - - -\nK:  o - - - - - o -';

    it('auto-detects a pasted drum chart and previews it on the kit grid', async () => {
      renderPage();
      fireEvent.change(screen.getByLabelText('Pasted tab content'), { target: { value: DRUM_CHART } });
      // isDrumNotation runs BEFORE detectFormat — a grid row would otherwise
      // classify as plain text.
      expect(await screen.findByText('drum')).toBeTruthy();
      expect(screen.getByLabelText(/^Drum chart —/)).toBeTruthy();
      expect(screen.getAllByText('Hi-Hat').length).toBeGreaterThan(0);
      expect(screen.getByLabelText('Play along')).toBeTruthy();
    });

    it('saves the drum format with the chart text', async () => {
      renderPage();
      fireEvent.change(screen.getByLabelText('Pasted tab content'), { target: { value: DRUM_CHART } });
      fireEvent.change(screen.getByLabelText('Instrument'), { target: { value: 'drums' } });
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Example Groove' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save song' }));
      await waitFor(() => expect(api.createSong).toHaveBeenCalled());
      const [body] = api.createSong.mock.calls[0];
      expect(body.instrument).toBe('drums');
      expect(body.content.format).toBe('drum');
      expect(body.content.text).toContain('HH: x x x x x x x x');
    });

    it('choosing the Drums instrument defaults the format to drum', async () => {
      renderPage();
      // Content the drum sniff would NOT recognize — the instrument decides.
      fireEvent.change(screen.getByLabelText('Pasted tab content'), { target: { value: 'K: o\nnot yet a grid' } });
      fireEvent.change(screen.getByLabelText('Instrument'), { target: { value: 'drums' } });
      expect(await screen.findByText('drum')).toBeTruthy();
    });

    it('a recognized grid and the Drums instrument both outrank the URL extractor\'s format', async () => {
      // The URL extractor returns generic text with no drum awareness, so its
      // tab/plain guess must not override an unmistakable chart — nor the user
      // explicitly saying "this is a kit chart".
      api.importSongFromUrl.mockResolvedValue({
        draft: { title: 'Fetched Groove', artist: '', content: { format: 'tab', text: DRUM_CHART }, sourceUrl: 'https://example.com/g' },
      });
      renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'From URL' }));
      fireEvent.change(screen.getByLabelText('Tab / chord-sheet URL'), { target: { value: 'https://example.com/g' } });
      fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
      await waitFor(() => expect(screen.getByLabelText(/^Drum chart —/)).toBeTruthy());

      // And for content the sniff can't read, the instrument still wins.
      api.importSongFromUrl.mockResolvedValue({
        draft: { title: 'Ambiguous', artist: '', content: { format: 'tab', text: 'K: o\nnot yet a grid' }, sourceUrl: 'https://example.com/a' },
      });
      fireEvent.change(screen.getByLabelText('Tab / chord-sheet URL'), { target: { value: 'https://example.com/a' } });
      fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
      await waitFor(() => expect(screen.getByText('tab')).toBeTruthy());
      fireEvent.change(screen.getByLabelText('Instrument'), { target: { value: 'drums' } });
      await waitFor(() => expect(screen.getByText('drum')).toBeTruthy());
    });

    it('leaves a chord sheet on its detected format with the tab preview', async () => {
      renderPage();
      fireEvent.change(screen.getByLabelText('Pasted tab content'), { target: { value: '[Verse]\nC  G  Am  F\nInvented lyric line' } });
      expect(await screen.findByText('tab')).toBeTruthy();
      expect(screen.queryByLabelText(/^Drum bar/)).toBeNull();
      expect(screen.getByText('Verse')).toBeTruthy();
    });
  });

  describe('failed URL import (#3903)', () => {
    const fetchFailure = Object.assign(new Error('Bad gateway'), { code: 'SONG_IMPORT_FETCH_FAILED' });

    const failFetch = async (url = 'https://example.com/missing') => {
      renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'From URL' }));
      fireEvent.change(screen.getByLabelText('Tab / chord-sheet URL'), { target: { value: url } });
      fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
      return screen.findByRole('alert');
    };

    it('shows an inline alert with retry context and clears it when the URL changes', async () => {
      api.importSongFromUrl.mockRejectedValue(fetchFailure);
      const alert = await failFetch();
      expect(alert.textContent).toContain('Couldn\'t fetch that page');
      // The URL stays put so Retry is meaningful.
      expect(screen.getByLabelText('Tab / chord-sheet URL').value).toBe('https://example.com/missing');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      // Save explains ITSELF rather than waiting for the unrelated click-time toast.
      expect(screen.getByRole('button', { name: 'Save song' }).disabled).toBe(true);
      expect(screen.getByText(/That URL import failed/)).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Tab / chord-sheet URL'), { target: { value: 'https://example.com/other' } });
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it('Retry re-runs the import and a success clears the alert', async () => {
      api.importSongFromUrl.mockRejectedValueOnce(fetchFailure).mockResolvedValueOnce({
        draft: { title: 'Recovered Song', artist: '', content: { format: 'tab', text: 'C G' }, sourceUrl: 'https://example.com/missing' },
      });
      await failFetch();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(api.importSongFromUrl).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.getByLabelText('Title').value).toBe('Recovered Song'));
    });

    it('drops the previous draft so a failed fetch never leaves a stale preview or auto-fill', async () => {
      api.importSongFromUrl.mockResolvedValueOnce({
        draft: { title: 'First Fetch', artist: '', content: { format: 'tab', text: 'C G Am' }, sourceUrl: 'https://example.com/a' },
      }).mockRejectedValueOnce(fetchFailure);
      renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'From URL' }));
      const input = screen.getByLabelText('Tab / chord-sheet URL');
      fireEvent.change(input, { target: { value: 'https://example.com/a' } });
      fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
      await waitFor(() => expect(screen.getByLabelText('Title').value).toBe('First Fetch'));

      fireEvent.change(input, { target: { value: 'https://example.com/b' } });
      fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
      await screen.findByRole('alert');
      expect(screen.queryByText('Preview')).toBeNull();
      // The stale auto-fill goes with the draft — it must not save onto a later import.
      expect(screen.getByLabelText('Title').value).toBe('');
    });
  });

  it('ignores a fetch that resolves after the user has edited the URL away', async () => {
    // The input stays editable during the fetch, so a late result must not
    // write a draft (or an error) under a URL that never produced it.
    let rejectFetch;
    api.importSongFromUrl.mockReturnValue(new Promise((_, reject) => { rejectFetch = reject; }));
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'From URL' }));
    const input = screen.getByLabelText('Tab / chord-sheet URL');
    fireEvent.change(input, { target: { value: 'https://example.com/slow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));

    fireEvent.change(input, { target: { value: 'https://example.com/typed-more' } });
    rejectFetch(Object.assign(new Error('Bad gateway'), { code: 'SONG_IMPORT_FETCH_FAILED' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fetch' }).textContent).toContain('Fetch'));
    expect(screen.queryByRole('alert')).toBeNull();
    // Nor a toast — it isn't news about the URL now in the input.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('sends an in-range pasted capo through unchanged', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Pasted tab content'), {
      target: { value: '{capo: 3}\nC   G   Am' },
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Example Song' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save song' }));
    await waitFor(() => expect(api.createSong).toHaveBeenCalled());
    expect(api.createSong.mock.calls[0][0].capo).toBe(3);
  });
});
