import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock the api barrel (RoundEditor.test.jsx harness style).
const api = vi.hoisted(() => ({
  createSong: vi.fn(),
  importSongFromUrl: vi.fn(),
}));
vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const clipboard = vi.hoisted(() => ({ readClipboard: vi.fn() }));
vi.mock('../lib/clipboard.js', () => clipboard);

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
