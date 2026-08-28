import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  ACCELERANDO_LICENSE_URL: 'https://creativecommons.org/licenses/by-nc-nd/2.5/',
  ACCELERANDO_SOURCE_PAGE_URL: 'http://www.antipope.org/charlie/blog-static/fiction/accelerando/accelerando-intro.html',
  getAccelerandoBook: vi.fn(),
}));

vi.mock('../services/api', () => api);

const RapidReaderPage = (await import('./RapidReader')).default;
const { writeRapidReaderProgress } = await import('../lib/rapidReaderPosition');

const BOOK = {
  id: 'accelerando',
  title: 'Accelerando',
  author: 'Charles Stross',
  text: 'A novel by Charles Stross. Chapter 1: Example.',
  wordCount: 8,
  cached: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('RapidReader Accelerando loader', () => {
  it('waits for the explicit load action and puts the book into the reader text area', async () => {
    api.getAccelerandoBook.mockResolvedValue(BOOK);
    render(<RapidReaderPage />);

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
    render(<RapidReaderPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Load Accelerando' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Author source unavailable');
    expect(screen.getByRole('button', { name: 'Load Accelerando' })).toBeEnabled();
  });

  it('rejects an invalid successful response with a retryable inline error', async () => {
    api.getAccelerandoBook.mockResolvedValue({ cached: false });
    render(<RapidReaderPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Load Accelerando' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/response was invalid/i);
    expect(screen.getByRole('button', { name: 'Load Accelerando' })).toBeEnabled();
  });
});

describe('RapidReader reading position', () => {
  it('starts from the word under the textarea cursor', () => {
    render(<RapidReaderPage />);
    const textarea = screen.getByRole('textbox', { name: 'Text to read' });
    fireEvent.change(textarea, { target: { value: 'alpha bravo charlie delta' } });
    textarea.setSelectionRange(13, 13);

    fireEvent.click(screen.getByRole('button', { name: 'Start at cursor' }));

    expect(screen.getByText(/3\/4 words/)).toBeInTheDocument();
  });

  it('offers and restores saved progress for the same text', () => {
    const text = 'alpha bravo charlie delta echo';
    writeRapidReaderProgress(text, { wordIndex: 2, wpm: 425, chunkSize: 1 });
    render(<RapidReaderPage />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Text to read' }), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume at word 3' }));

    expect(screen.getByText(/3\/5 words/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reading speed')).toHaveValue('425');
  });

  it('saves a bookmark from the reader and offers it after closing', () => {
    render(<RapidReaderPage />);
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
