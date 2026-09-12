import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// ── Mocks must be declared before any imports that use them ──────────────────

const mockGetMoodBoard = vi.fn();
const mockUpdateMoodBoard = vi.fn();
const mockAddMoodBoardItem = vi.fn();
const mockUpdateMoodBoardItem = vi.fn();
const mockSyncMoodBoardPinterest = vi.fn();

vi.mock('../services/api', () => ({
  getMoodBoard: (...args) => mockGetMoodBoard(...args),
  updateMoodBoard: (...args) => mockUpdateMoodBoard(...args),
  addMoodBoardItem: (...args) => mockAddMoodBoardItem(...args),
  updateMoodBoardItem: (...args) => mockUpdateMoodBoardItem(...args),
  removeMoodBoardItem: vi.fn(),
  linkMoodBoardPinterest: vi.fn(),
  unlinkMoodBoardPinterest: vi.fn(),
  syncMoodBoardPinterest: (...args) => mockSyncMoodBoardPinterest(...args),
}));

const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: (...args) => mockToastSuccess(...args),
    error: (...args) => mockToastError(...args),
    warning: vi.fn(),
  }),
}));

// Stub the prompt-from-media modal (#4188 Phase 3) — the analysis flow under
// test is the page's own wiring (open, persist via onResult, stored-analysis
// children), not the analyzer internals, which have their own suite.
let analysisDelay = null;
vi.mock('../components/media/PromptFromMedia', () => ({
  PromptFromMediaModal: ({ open, item, onResult, children }) => (open && item ? (
    <div data-testid="pfm-modal">
      {children}
      <button
        type="button"
        onClick={() => {
          const deliver = () => onResult?.({
            imagePrompt: 'a moody castle at dusk',
            imageNegativePrompt: 'blurry',
            rationale: 'gothic look',
            providerId: 'openai',
            model: 'gpt-4o',
          });
          if (analysisDelay) analysisDelay.then(deliver);
          else deliver();
        }}
      >
        mock-generate
      </button>
    </div>
  ) : null),
}));

// Control the board id `useParams` returns so we can simulate the user
// navigating from one board to another mid-fetch.
let currentId = 'a';
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useParams: () => ({ id: currentId }),
    useNavigate: () => vi.fn(),
  };
});

import MoodBoardDetail from './MoodBoardDetail.jsx';

// A promise plus its resolver, so a test can control exactly when (and in what
// order) each fetch settles.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// Flush pending microtasks + one macrotask so an awaited fetch continuation
// (including its `.catch()` link) has fully run before we assert.
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

const renderPage = () => render(
  <MemoryRouter><MoodBoardDetail /></MemoryRouter>,
);

const boardNameValue = () => screen.getByLabelText('Name').value;

beforeEach(() => {
  vi.clearAllMocks();
  currentId = 'a';
  analysisDelay = null;
});

describe('MoodBoardDetail stale-response guards', () => {
  it('renders the loaded board', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
  });

  it('ignores an out-of-order (stale) response after the board id changes', async () => {
    const first = deferred();
    const second = deferred();
    mockGetMoodBoard
      .mockReturnValueOnce(first.promise)   // board 'a'
      .mockReturnValueOnce(second.promise); // board 'b'

    const { rerender } = renderPage();
    // The user navigates to board 'b' before board 'a' has resolved.
    currentId = 'b';
    rerender(<MemoryRouter><MoodBoardDetail /></MemoryRouter>);

    // Newer request resolves first — its data should show.
    second.resolve({ id: 'b', name: 'Board B', items: [] });
    await waitFor(() => expect(boardNameValue()).toBe('Board B'));
    // GalleryImagePicker mounts with the loaded board and resets its filter
    // state in a mount effect. Settle it before the unwrapped stale response.
    await act(async () => {});

    // Older (stale) request resolves last — it must NOT overwrite current state.
    first.resolve({ id: 'a', name: 'Board A', items: [] });
    await flush();
    expect(boardNameValue()).toBe('Board B');
  });

  it('still renders under StrictMode (mount guard re-arms on remount)', async () => {
    // StrictMode double-invokes mount/effects in dev; the mount guard must be
    // re-armed on the real mount or the board would be stuck on "Loading…".
    mockGetMoodBoard.mockResolvedValue({ id: 'a', name: 'Board A', items: [] });
    render(
      <StrictMode><MemoryRouter><MoodBoardDetail /></MemoryRouter></StrictMode>,
    );
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
  });

  it('drops updates from a response that resolves after unmount', async () => {
    const pending = deferred();
    mockGetMoodBoard.mockReturnValueOnce(pending.promise);

    const { unmount } = renderPage();
    unmount();

    // A not-found response after unmount must not fire its error toast — the
    // unmounted guard returns before any setState / toast.
    pending.resolve(null);
    await flush();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('keeps the new board drafts and pending save when the old save and pin finish', async () => {
    const oldSave = deferred();
    const newSave = deferred();
    const oldPin = deferred();
    mockGetMoodBoard
      .mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] })
      .mockResolvedValueOnce({ id: 'b', name: 'Board B', items: [] });
    mockUpdateMoodBoard.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise);
    mockAddMoodBoardItem.mockReturnValueOnce(oldPin.promise);
    const { rerender } = renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    fireEvent.click(screen.getByRole('tab', { name: 'Note' }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'A note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin to board' }));

    currentId = 'b';
    rerender(<MemoryRouter><MoodBoardDetail /></MemoryRouter>);
    await waitFor(() => expect(boardNameValue()).toBe('Board B'));
    expect(screen.getByLabelText('Image URL')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Pin to board' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://example.com/b.png' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));

    await act(async () => {
      oldSave.resolve({ id: 'a', name: 'Edited A', items: [] });
      oldPin.resolve({ id: 'a-note', type: 'text', text: 'A note' });
    });
    expect(boardNameValue()).toBe('Edited B');
    expect(screen.getByLabelText('Image URL')).toHaveValue('https://example.com/b.png');
    expect(screen.queryByText('A note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    await act(async () => { newSave.resolve({ id: 'b', name: 'Edited B', items: [] }); });
    expect(mockUpdateMoodBoard).toHaveBeenLastCalledWith('b', { name: 'Edited B', description: '' }, { silent: true });
    expect(mockToastSuccess).toHaveBeenCalledWith('Board saved');
  });

  it('clears the old board when the next GET fails and ignores a rejected old sync', async () => {
    const nextLoad = deferred();
    const oldSync = deferred();
    mockGetMoodBoard
      .mockResolvedValueOnce({
        id: 'a', name: 'Board A', items: [],
        pinterest: { boardUrl: 'https://www.pinterest.com/example/board/', feedUrl: 'https://example.com/feed.rss' },
      })
      .mockReturnValueOnce(nextLoad.promise);
    mockSyncMoodBoardPinterest.mockReturnValueOnce(oldSync.promise);
    const { rerender } = renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    currentId = 'missing';
    rerender(<MemoryRouter><MoodBoardDetail /></MemoryRouter>);
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await act(async () => { nextLoad.reject(new Error('Not found')); });
    expect(screen.getByText('This mood board doesn’t exist.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(mockToastError).toHaveBeenCalledExactlyOnceWith('Mood board not found');

    await act(async () => { oldSync.reject(new Error('Sync failed')); });
    expect(mockToastError).toHaveBeenCalledExactlyOnceWith('Mood board not found');
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

describe('MoodBoardDetail video items (#4188)', () => {
  it('renders a video item as a poster with a play affordance, then plays inline', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a',
      name: 'Board A',
      items: [{
        id: 'mbi-1',
        type: 'video',
        mediaKey: 'video:upload-ab12cd34.mp4',
        imageUrl: '/data/video-thumbnails/upload-ab12cd34.jpg',
        caption: null,
        source: null,
      }],
    });
    const { container } = renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    const playButton = screen.getByRole('button', { name: 'Play video' });
    expect(playButton.querySelector('img').getAttribute('src')).toBe('/data/video-thumbnails/upload-ab12cd34.jpg');
    fireEvent.click(playButton);
    await waitFor(() => {
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      expect(video.getAttribute('src')).toBe('/data/videos/upload-ab12cd34.mp4');
    });
  });

  it('falls back to the derived stem poster when the stored thumbnail 404s (synced download pin)', async () => {
    // A downloaded video's sender-side thumbnail is `<id>.jpg`, but a peer
    // regenerates `<filename-stem>.jpg` on pull — the stored URL 404s there.
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a',
      name: 'Board A',
      items: [{
        id: 'mbi-1',
        type: 'video',
        mediaKey: 'video:downloaded-abc123.mp4',
        imageUrl: '/data/video-thumbnails/abc123.jpg',
        caption: null,
        source: null,
      }],
    });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    const poster = screen.getByRole('button', { name: 'Play video' }).querySelector('img');
    expect(poster.getAttribute('src')).toBe('/data/video-thumbnails/abc123.jpg');
    fireEvent.error(poster);
    expect(poster.getAttribute('src')).toBe('/data/video-thumbnails/downloaded-abc123.jpg');
  });
});

describe('MoodBoardDetail item analysis (#4188 Phase 3)', () => {
  const galleryImageItem = {
    id: 'i1', type: 'image', mediaKey: 'image:ref.png', imageUrl: null, caption: null, source: null,
  };

  it('does not persist an analysis callback delivered after leaving its board', async () => {
    const pendingAnalysis = deferred();
    analysisDelay = pendingAnalysis.promise;
    mockGetMoodBoard
      .mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [galleryImageItem] })
      .mockResolvedValueOnce({ id: 'b', name: 'Board B', items: [] });
    const { rerender } = renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze with AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-generate' }));

    currentId = 'b';
    rerender(<MemoryRouter><MoodBoardDetail /></MemoryRouter>);
    await waitFor(() => expect(boardNameValue()).toBe('Board B'));
    expect(screen.queryByTestId('pfm-modal')).not.toBeInTheDocument();
    await act(async () => { pendingAnalysis.resolve(); });
    expect(mockUpdateMoodBoardItem).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('offers the analyze action only on gallery-backed media items', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a',
      name: 'Board A',
      items: [
        galleryImageItem,
        { id: 'i2', type: 'text', text: 'note', caption: null, source: null },
        { id: 'i3', type: 'image', mediaKey: null, imageUrl: 'https://x/y.png', caption: null, source: null },
      ],
    });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    // One analyzable item → exactly one analyze button; the text item and the
    // external-URL pin get none.
    expect(screen.getAllByRole('button', { name: 'Analyze with AI' })).toHaveLength(1);
  });

  it('persists a run onto the item and flips the card to its analyzed state', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [galleryImageItem] });
    const analyzedItem = {
      ...galleryImageItem,
      analysis: {
        prompt: 'a moody castle at dusk',
        negativePrompt: 'blurry',
        rationale: 'gothic look',
        providerId: 'openai',
        model: 'gpt-4o',
        analyzedAt: '2026-08-14T00:00:00.000Z',
      },
    };
    mockUpdateMoodBoardItem.mockResolvedValueOnce(analyzedItem);
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    fireEvent.click(screen.getByRole('button', { name: 'Analyze with AI' }));
    expect(screen.getByTestId('pfm-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mock-generate' }));
    await waitFor(() => {
      expect(mockUpdateMoodBoardItem).toHaveBeenCalledWith('a', 'i1', {
        analysis: {
          prompt: 'a moody castle at dusk',
          negativePrompt: 'blurry',
          rationale: 'gothic look',
          providerId: 'openai',
          model: 'gpt-4o',
        },
      }, { silent: true });
    });

    // The persisted item flows back into board state: the card badge flips and
    // the modal now shows the stored analysis.
    await screen.findByRole('button', { name: 'View AI analysis' });
    expect(screen.getByLabelText('Saved analysis prompt')).toHaveValue('a moody castle at dusk');
  });

  it('removes a stored analysis via the modal', async () => {
    const analyzed = {
      ...galleryImageItem,
      analysis: {
        prompt: 'a moody castle at dusk', negativePrompt: null, rationale: null,
        providerId: null, model: null, analyzedAt: '2026-08-14T00:00:00.000Z',
      },
    };
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [analyzed] });
    mockUpdateMoodBoardItem.mockResolvedValueOnce({ ...galleryImageItem, analysis: null });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    fireEvent.click(screen.getByRole('button', { name: 'View AI analysis' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(mockUpdateMoodBoardItem).toHaveBeenCalledWith('a', 'i1', { analysis: null }, { silent: true });
    });
    await screen.findByRole('button', { name: 'Analyze with AI' });
  });
});
