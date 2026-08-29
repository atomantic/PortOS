import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({
  ACCELERANDO_LICENSE_URL: 'https://creativecommons.org/licenses/by-nc-nd/2.5/',
  ACCELERANDO_SOURCE_PAGE_URL: 'http://www.antipope.org/charlie/blog-static/fiction/accelerando/accelerando-intro.html',
  getAccelerandoBook: vi.fn(),
  listRapidReaderLibrary: vi.fn(),
  getRapidReaderLibraryEntry: vi.fn(),
  createRapidReaderLibraryEntry: vi.fn(),
  fetchRapidReaderLibraryEntry: vi.fn(),
  deleteRapidReaderLibraryEntry: vi.fn(),
}));

vi.mock('../services/api', () => api);

const RapidReaderPage = (await import('./RapidReader')).default;
const { writeRapidReaderProgress } = await import('../lib/rapidReaderPosition');

const renderPage = (path = '/rapid-reader') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/rapid-reader" element={<RapidReaderPage />} />
      <Route path="/rapid-reader/:id" element={<RapidReaderPage />} />
    </Routes>
  </MemoryRouter>,
);

const BOOK = {
  id: 'accelerando',
  title: 'Accelerando',
  author: 'Charles Stross',
  text: 'A novel by Charles Stross. Chapter 1: Example.',
  wordCount: 8,
  cached: false,
  sections: [
    { id: 'part-1', title: 'PART 1: Example', kind: 'part', wordIndex: 0 },
    { id: 'chapter-1', title: 'Chapter 1: Example', kind: 'chapter', wordIndex: 5 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listRapidReaderLibrary.mockResolvedValue([]);
  localStorage.clear();
});

describe('RapidReader Accelerando loader', () => {
  it('waits for the explicit load action and puts the book into the reader text area', async () => {
    api.getAccelerandoBook.mockResolvedValue(BOOK);
    renderPage();

    expect(api.getAccelerandoBook).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /author's page/i })).toHaveAttribute(
      'href',
      'http://www.antipope.org/charlie/blog-static/fiction/accelerando/accelerando-intro.html',
    );
    expect(screen.getByRole('link', { name: 'CC BY-NC-ND 2.5' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-nc-nd/2.5/',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load Accelerando' }));

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Text to read' })).toHaveValue(BOOK.text));
    expect(api.getAccelerandoBook).toHaveBeenCalledWith({ silent: true });
    expect(screen.getByRole('status')).toHaveTextContent(/cached on this instance/i);
  });

  it('shows a retryable inline error without a duplicate toast', async () => {
    api.getAccelerandoBook.mockRejectedValue(new Error('Author source unavailable'));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Load Accelerando' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Author source unavailable');
    expect(screen.getByRole('button', { name: 'Load Accelerando' })).toBeEnabled();
  });

  it('rejects an invalid successful response with a retryable inline error', async () => {
    api.getAccelerandoBook.mockResolvedValue({ cached: false });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Load Accelerando' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/response was invalid/i);
    expect(screen.getByRole('button', { name: 'Load Accelerando' })).toBeEnabled();
  });
});

describe('RapidReader reading position', () => {
  it('starts from the word under the textarea cursor', async () => {
    renderPage();
    await waitFor(() => expect(api.listRapidReaderLibrary).toHaveBeenCalled());
    const textarea = screen.getByRole('textbox', { name: 'Text to read' });
    fireEvent.change(textarea, { target: { value: 'alpha bravo charlie delta' } });
    textarea.setSelectionRange(13, 13);

    fireEvent.click(screen.getByRole('button', { name: 'Start at cursor' }));

    expect(screen.getByText(/3\/4 words/)).toBeInTheDocument();
  });

  it('offers and restores saved progress for the same text', async () => {
    const text = 'alpha bravo charlie delta echo';
    writeRapidReaderProgress(text, { wordIndex: 2, wpm: 425, chunkSize: 1 });
    renderPage();
    await waitFor(() => expect(api.listRapidReaderLibrary).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('textbox', { name: 'Text to read' }), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume at word 3' }));

    expect(screen.getByText(/3\/5 words/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reading speed')).toHaveValue('425');
  });

  it('offers Accelerando section navigation after loading the book', async () => {
    api.getAccelerandoBook.mockResolvedValue(BOOK);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Load Accelerando' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Text to read' })).toHaveValue(BOOK.text));
    fireEvent.click(screen.getByRole('button', { name: 'Start reading' }));

    const select = screen.getByRole('combobox', { name: 'Navigate sections' });
    expect(select).toHaveDisplayValue('Part · PART 1: Example');
    fireEvent.change(select, { target: { value: '5' } });
    expect(select).toHaveDisplayValue('Chapter · Chapter 1: Example');
  });

  it('keeps the keyboard hint for desktop layouts only', async () => {
    renderPage();
    await waitFor(() => expect(api.listRapidReaderLibrary).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('textbox', { name: 'Text to read' }), { target: { value: 'one two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start reading' }));

    expect(screen.getByText(/Space = play\/pause/)).toHaveClass('hidden', 'sm:inline');
  });

  it('saves a bookmark from the reader and offers it after closing', async () => {
    renderPage();
    await waitFor(() => expect(api.listRapidReaderLibrary).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('textbox', { name: 'Text to read' }), {
      target: { value: 'alpha bravo charlie delta echo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start reading' }));
    fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Save bookmark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.getByRole('button', { name: 'Resume at word 2' })).toBeInTheDocument();
  });
});

describe('RapidReader shelf', () => {
  const ENTRY = {
    id: 'shelf-1', title: 'Saved Article', author: null, sourceUrl: 'https://example.com/article',
    sourceType: 'fetch', wordCount: 4, addedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  };

  it('lists shelf metadata on mount without requesting any book text', async () => {
    api.listRapidReaderLibrary.mockResolvedValue([ENTRY]);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Open Saved Article' })).toBeInTheDocument();
    expect(api.getRapidReaderLibraryEntry).not.toHaveBeenCalled();
    expect(api.getAccelerandoBook).not.toHaveBeenCalled();
  });

  it('loads the entry named by the URL exactly once', async () => {
    api.listRapidReaderLibrary.mockResolvedValue([ENTRY]);
    api.getRapidReaderLibraryEntry.mockResolvedValue({ ...ENTRY, text: 'alpha bravo charlie delta' });
    renderPage('/rapid-reader/shelf-1');

    await waitFor(() => expect(api.getRapidReaderLibraryEntry).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/1\/4 words/)).toBeInTheDocument();
    expect(api.getRapidReaderLibraryEntry).toHaveBeenCalledWith('shelf-1', { silent: true });
  });

  it('puts the opened entry in the URL rather than local state', async () => {
    api.listRapidReaderLibrary.mockResolvedValue([ENTRY]);
    api.getRapidReaderLibraryEntry.mockResolvedValue({ ...ENTRY, text: 'alpha bravo charlie delta' });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Open Saved Article' }));

    await waitFor(() => expect(api.getRapidReaderLibraryEntry).toHaveBeenCalledWith('shelf-1', { silent: true }));
    expect(api.getRapidReaderLibraryEntry).toHaveBeenCalledTimes(1);
  });

  it('saves the current text and prepends the new entry without refetching the list', async () => {
    api.createRapidReaderLibraryEntry.mockResolvedValue({ ...ENTRY, id: 'shelf-2', title: 'My Notes', sourceType: 'paste', text: 'alpha bravo' });
    renderPage();
    await waitFor(() => expect(api.listRapidReaderLibrary).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('textbox', { name: 'Text to read' }), { target: { value: 'alpha bravo' } });
    fireEvent.change(screen.getByPlaceholderText('Title to save'), { target: { value: 'My Notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to shelf' }));

    expect(await screen.findByRole('button', { name: 'Open My Notes' })).toBeInTheDocument();
    expect(api.createRapidReaderLibraryEntry).toHaveBeenCalledWith({ title: 'My Notes', text: 'alpha bravo' }, { silent: true });
    expect(api.listRapidReaderLibrary).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('Title to save')).toHaveValue('');
  });

  it('adds a URL-fetched entry to the shelf', async () => {
    api.fetchRapidReaderLibraryEntry.mockResolvedValue({ ...ENTRY, id: 'shelf-3', title: 'Fetched Page', text: 'alpha bravo' });
    renderPage();
    await waitFor(() => expect(api.listRapidReaderLibrary).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('https://example.com/article'), { target: { value: 'https://example.com/article' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch URL to shelf' }));

    expect(await screen.findByRole('button', { name: 'Open Fetched Page' })).toBeInTheDocument();
    expect(api.fetchRapidReaderLibraryEntry).toHaveBeenCalledWith({ url: 'https://example.com/article' }, { silent: true });
    expect(screen.getByPlaceholderText('https://example.com/article')).toHaveValue('');
  });

  it('requires a second click to delete a shelf entry', async () => {
    api.listRapidReaderLibrary.mockResolvedValue([ENTRY]);
    api.deleteRapidReaderLibraryEntry.mockResolvedValue(undefined);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Saved Article' }));
    expect(api.deleteRapidReaderLibraryEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Saved Article' })).not.toBeInTheDocument());
    expect(api.deleteRapidReaderLibraryEntry).toHaveBeenCalledWith('shelf-1', { silent: true });
  });

  it('keeps pasting usable when the shelf list fails, and retries', async () => {
    api.listRapidReaderLibrary.mockRejectedValueOnce(new Error('Shelf unavailable')).mockResolvedValueOnce([ENTRY]);
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Shelf unavailable');
    expect(screen.getByRole('textbox', { name: 'Text to read' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Open Saved Article' })).toBeInTheDocument();
  });
});
