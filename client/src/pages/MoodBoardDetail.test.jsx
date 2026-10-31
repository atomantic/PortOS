import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// ── Mocks must be declared before any imports that use them ──────────────────

const mockUploadRequest = vi.fn();
vi.mock('../services/apiCore.js', async importOriginal => ({ ...await importOriginal(), request: (...args) => mockUploadRequest(...args) }));

const mockGetMoodBoard = vi.fn();
const mockUpdateMoodBoard = vi.fn();
const mockAddMoodBoardItem = vi.fn();
const mockUpdateMoodBoardItem = vi.fn();
const mockSyncMoodBoardPinterest = vi.fn();
const mockImportMoodBoardPinterest = vi.fn();
const mockImportMoodBoardXPost = vi.fn();
const mockLocalizeMoodBoardMedia = vi.fn();
const mockRenderMoodBoardItem = vi.fn();
const socketHandlers = new Map();
const mockNavigate = vi.fn();

vi.mock('../services/socket', () => ({
  default: {
    on: (evt, fn) => socketHandlers.set(evt, fn),
    off: (evt) => socketHandlers.delete(evt),
  },
}));

vi.mock('../services/api', () => ({
  getMoodBoard: (...args) => mockGetMoodBoard(...args),
  updateMoodBoard: (...args) => mockUpdateMoodBoard(...args),
  addMoodBoardItem: (...args) => mockAddMoodBoardItem(...args),
  updateMoodBoardItem: (...args) => mockUpdateMoodBoardItem(...args),
  removeMoodBoardItem: vi.fn(),
  linkMoodBoardPinterest: vi.fn(),
  unlinkMoodBoardPinterest: vi.fn(),
  syncMoodBoardPinterest: (...args) => mockSyncMoodBoardPinterest(...args),
  importMoodBoardPinterest: (...args) => mockImportMoodBoardPinterest(...args),
  importMoodBoardXPost: (...args) => mockImportMoodBoardXPost(...args),
  localizeMoodBoardMedia: (...args) => mockLocalizeMoodBoardMedia(...args),
  renderMoodBoardItem: (...args) => mockRenderMoodBoardItem(...args),
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
vi.mock('../components/imageGen/GalleryImagePicker', () => ({ default: ({ open, onSelect }) => open ? <button onClick={() => onSelect({ key: 'image:pic.png', previewUrl: '/data/images/pic.png' })}>Choose fixture</button> : null }));
vi.mock('../components/moodBoard/MoodBoardGeneratePanel', () => ({ default: () => <div data-testid="generate-more-panel" /> }));
vi.mock('../components/moodBoard/MoodBoardStylePanel', () => ({
  default: () => <div data-testid="board-style-panel" />,
}));

vi.mock('../components/media/MediaLightbox', () => ({
  default: ({ item, onClose }) => (
    <div data-testid="lightbox" data-src={item.previewUrl}>
      <button type="button" onClick={onClose}>close-lightbox</button>
    </div>
  ),
}));

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
    useNavigate: () => mockNavigate,
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

const renderPage = (initialEntries = ['/mood-boards/a']) => render(
  <MemoryRouter initialEntries={initialEntries}><MoodBoardDetail /></MemoryRouter>,
);

const boardNameValue = () => screen.getByLabelText('Name').value;
const openTool = (name) => fireEvent.click(screen.getByRole('tab', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockLocalizeMoodBoardMedia.mockResolvedValue({ board: null, localized: 0, failed: 0 });
  currentId = 'a';
  analysisDelay = null;
});

describe('MoodBoardDetail image preview', () => {
  it('opens the standard lightbox when an image item is clicked and closes it', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a', name: 'Board A',
      items: [{ id: 'i1', type: 'image', imageUrl: '/data/images/one.png', caption: 'one' }],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview image' }));
    expect(screen.getByTestId('lightbox').dataset.src).toBe('/data/images/one.png');
    fireEvent.click(screen.getByText('close-lightbox'));
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('opens lightbox automatically when initial URL has preview search param', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a', name: 'Board A',
      items: [{ id: 'i1', type: 'image', imageUrl: '/data/images/one.png', caption: 'one' }],
    });
    renderPage(['/mood-boards/a?preview=i1']);
    expect((await screen.findByTestId('lightbox')).dataset.src).toBe('/data/images/one.png');
  });

  it('opens lightbox automatically when initial URL has item search param', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a', name: 'Board A',
      items: [{ id: 'i1', type: 'image', imageUrl: '/data/images/one.png', caption: 'one' }],
    });
    renderPage(['/mood-boards/a?item=i1']);
    expect((await screen.findByTestId('lightbox')).dataset.src).toBe('/data/images/one.png');
  });
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
    openTool('Import');
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    currentId = 'missing';
    rerender(<MemoryRouter><MoodBoardDetail /></MemoryRouter>);
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await act(async () => { nextLoad.reject(Object.assign(new Error('Not found'), { status: 404 })); });
    expect(screen.getByText('This mood board doesn’t exist.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(mockToastError).toHaveBeenCalledExactlyOnceWith('Mood board not found');

    await act(async () => { oldSync.reject(new Error('Sync failed')); });
    expect(mockToastError).toHaveBeenCalledExactlyOnceWith('Mood board not found');
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

describe('MoodBoardDetail failed read', () => {
  it('offers Retry for a failed read instead of saying the board does not exist', async () => {
    mockGetMoodBoard
      .mockRejectedValueOnce(Object.assign(new Error('Server unavailable'), { status: 503 }))
      .mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Couldn’t load this mood board')).toBeInTheDocument());
    expect(screen.queryByText('This mood board doesn’t exist.')).not.toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
  });

  it('reloads the whole board when a render event arrives after a failed read', async () => {
    mockGetMoodBoard
      .mockRejectedValueOnce(Object.assign(new Error('Server unavailable'), { status: 503 }))
      .mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Couldn’t load this mood board')).toBeInTheDocument());

    await act(async () => { socketHandlers.get('connect')(); });
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
  });
});

describe('MoodBoardDetail render event during the first load', () => {
  it('lets the pending first read finish instead of restarting it', async () => {
    const first = deferred();
    mockGetMoodBoard.mockReturnValueOnce(first.promise);
    renderPage();
    await act(async () => { socketHandlers.get('mood-board:item-render')({ boardId: 'a', itemId: 'i1', status: 'failed', error: 'GPU busy' }); });
    expect(mockGetMoodBoard).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith('Render failed: GPU busy');
    await act(async () => { first.resolve({ id: 'a', name: 'Board A', items: [] }); });
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
  });
});

describe('MoodBoardDetail private Pinterest import', () => {
  it('imports a single Pin through the signed-in PortOS browser action', async () => {
    const boardUrl = 'https://www.pinterest.com/pin/9999999999999999999/';
    const importedBoard = {
      id: 'a',
      name: 'Board A',
      items: [{
        id: 'mbi-1',
        type: 'image',
        imageUrl: '/data/images/pinterest-example.jpg',
        caption: 'Example pin',
        source: 'https://www.pinterest.com/pin/9999999999999999999/',
      }],
    };
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    mockImportMoodBoardPinterest.mockResolvedValueOnce({ board: importedBoard, added: 1, found: 1, skipped: 0 });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    openTool('Import');
    fireEvent.change(screen.getByLabelText('Pin or board URL'), { target: { value: boardUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Import pins' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Added 1 of 1 Pinterest pin'));
    expect(mockImportMoodBoardPinterest).toHaveBeenCalledWith('a', boardUrl, { silent: true });
    expect(screen.getByAltText('Example pin')).toHaveAttribute('src', '/data/images/pinterest-example.jpg');
  });
});

describe('MoodBoardDetail external media re-hosting', () => {
  it('imports external pins into the gallery on load and swaps in the localized board', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a', name: 'Board A',
      items: [{ id: 'mbi-1', type: 'image', imageUrl: 'https://example.com/a.jpg' }],
    });
    mockLocalizeMoodBoardMedia.mockResolvedValueOnce({
      board: { id: 'a', name: 'Board A', items: [{ id: 'mbi-1', type: 'image', imageUrl: '/data/images/board-1.jpg' }] },
      localized: 1,
      failed: 0,
    });
    renderPage();
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Imported 1 external image into the gallery'));
    expect(mockLocalizeMoodBoardMedia).toHaveBeenCalledWith('a', { silent: true });
    expect(document.querySelector('img[src="/data/images/board-1.jpg"]')).not.toBeNull();
  });

  it('does not call the importer when every pin is already local', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a', name: 'Board A',
      items: [{ id: 'mbi-1', type: 'image', imageUrl: '/data/images/x.jpg' }],
    });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
    expect(mockLocalizeMoodBoardMedia).not.toHaveBeenCalled();
  });
});

describe('MoodBoardDetail X post import', () => {
  it('imports a post URL and merges the returned board', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    mockImportMoodBoardXPost.mockResolvedValueOnce({
      board: { id: 'a', name: 'Board A', items: [{ id: 'mbi-1', type: 'image', imageUrl: '/data/images/x.jpg' }] },
      added: 1,
    });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    openTool('Import');
    fireEvent.change(screen.getByLabelText('Post URL'), { target: { value: 'https://x.com/user/status/1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Added 1 item from the post'));
    expect(mockImportMoodBoardXPost).toHaveBeenCalledWith('a', 'https://x.com/user/status/1', { silent: true });
    expect(screen.getByLabelText('Post URL')).toHaveValue('');
  });

  it('toasts an error and keeps the typed URL on failure', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    mockImportMoodBoardXPost.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    openTool('Import');
    fireEvent.change(screen.getByLabelText('Post URL'), { target: { value: 'https://x.com/user/status/1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Could not import that post — check the URL or try again'));
    expect(screen.getByLabelText('Post URL')).toHaveValue('https://x.com/user/status/1');
  });
});

describe('MoodBoardDetail item-type tabs (#7244)', () => {
  it('keeps one tab stop on the bar and switches the add form with arrow keys', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    const image = screen.getByRole('tab', { name: 'Image' });
    const note = screen.getByRole('tab', { name: 'Note' });
    expect(image).toHaveAttribute('tabindex', '0');
    expect(note).toHaveAttribute('tabindex', '-1');

    // ArrowRight moves the tab stop and swaps the add-item form together.
    image.focus();
    fireEvent.keyDown(image, { key: 'ArrowRight' });
    expect(note).toHaveAttribute('aria-selected', 'true');
    expect(note).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(note);
    expect(screen.getByLabelText('Note')).toBeInTheDocument();
    expect(screen.queryByLabelText('Image URL')).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Prompt from media' }));
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
    expect(screen.getAllByRole('button', { name: 'Prompt from media' })).toHaveLength(1);
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

    fireEvent.click(screen.getByRole('button', { name: 'Prompt from media' }));
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
        // The caption mirrors the analysis prompt when the item had none.
        caption: 'a moody castle at dusk',
      }, { silent: true });
    });

    // The persisted item flows back into board state: the card badge flips and
    // the modal now shows the stored analysis.
    await screen.findByRole('button', { name: 'View prompt from media' });
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

    fireEvent.click(screen.getByRole('button', { name: 'View prompt from media' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(mockUpdateMoodBoardItem).toHaveBeenCalledWith('a', 'i1', { analysis: null }, { silent: true });
    });
    await screen.findByRole('button', { name: 'Prompt from media' });
  });

  it('displays the analyzed prompt indicator and value over the default caption', async () => {
    const analyzedItem = {
      id: 'i1',
      type: 'image',
      mediaKey: 'image:pic.png',
      caption: 'default caption from pin',
      analysis: {
        prompt: 'detailed analyzed prompt',
      },
    };
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [analyzedItem] });
    mockUpdateMoodBoardItem.mockResolvedValueOnce({
      ...analyzedItem,
      analysis: { prompt: 'updated analyzed prompt' },
    });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    expect(screen.getByTestId('item-indicator-analyzed')).toBeInTheDocument();
    expect(screen.getByText('Analyzed prompt')).toBeInTheDocument();
    expect(screen.getByText('default caption from pin')).toBeInTheDocument();

    const input = screen.getByLabelText('Analyzed prompt');
    expect(input).toHaveValue('detailed analyzed prompt');

    fireEvent.change(input, { target: { value: 'updated analyzed prompt' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockUpdateMoodBoardItem).toHaveBeenCalledWith('a', 'i1', {
        analysis: {
          prompt: 'updated analyzed prompt',
        },
        prompt: 'updated analyzed prompt',
      }, { silent: true });
    });
  });

  it('displays the prompt indicator and value for items with prompt but no analysis', async () => {
    const itemWithPrompt = {
      id: 'i2',
      type: 'image',
      mediaKey: 'image:pic2.png',
      prompt: 'explicit prompt text',
      caption: 'default caption',
    };
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [itemWithPrompt] });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    expect(screen.getByTestId('item-indicator-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('item-indicator-prompt')).toHaveTextContent('Prompt');
    const input = screen.getByLabelText('Item prompt');
    expect(input).toHaveValue('explicit prompt text');
    expect(input).toHaveAttribute('maxlength', '16000');
  });

  it('displays only default caption with no indicator when item has not been analyzed or given a prompt', async () => {
    const pinItem = {
      id: 'i3',
      type: 'image',
      imageUrl: '/data/images/pin.jpg',
      caption: 'simple pin description',
    };
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [pinItem] });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    expect(screen.queryByTestId('item-indicator-analyzed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('item-indicator-prompt')).not.toBeInTheDocument();
    expect(screen.getByText('Caption')).toBeInTheDocument();
    const input = screen.getByLabelText('Item caption');
    expect(input).toHaveValue('simple pin description');
  });
});

describe('MoodBoardDetail layout', () => {
  it('shows pins first with every board tool one tap away in the side rail', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a',
      name: 'Board A',
      items: [{ id: 'mbi-1', type: 'image', imageUrl: '/data/images/pic.jpg', caption: 'Pic 1' }],
    });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    const itemsSection = screen.getByRole('region', { name: 'Mood board items' });
    const tools = screen.getByRole('complementary', { name: 'Board tools' });
    expect(itemsSection.parentElement).toBe(tools.parentElement);
    expect(itemsSection.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(itemsSection.parentElement.className).toContain('@4xl/board:grid-cols-[minmax(0,1fr)_24rem]');

    // Add is the default tool; the others stay mounted but hidden.
    expect(tools).toContainElement(screen.getByRole('button', { name: 'Pin to board' }));
    expect(screen.queryByRole('button', { name: 'Import pins' })).toBeNull();
    openTool('Import');
    expect(screen.getByRole('heading', { name: 'Import from Pinterest' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Import from an X post' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pin to board' })).toBeNull();
    expect(screen.getByTestId('generate-more-panel')).toBeInTheDocument();
  });

  it('edits the board prompt as a multi-line field in the tool panel', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', description: 'Old prompt', items: [] });
    mockUpdateMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', description: 'New prompt\nSecond line', items: [] });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));

    const tools = screen.getByRole('complementary', { name: 'Board tools' });
    const field = screen.getByLabelText('Board prompt');
    expect(tools).toContainElement(field);
    expect(field.tagName).toBe('TEXTAREA');
    expect(Number(field.getAttribute('rows'))).toBeGreaterThan(1);
    expect(screen.queryByRole('button', { name: 'Save prompt' })).toBeNull();

    fireEvent.change(field, { target: { value: 'New prompt\nSecond line' } });
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));
    await waitFor(() => expect(mockUpdateMoodBoard).toHaveBeenCalledWith('a', { name: 'Board A', description: 'New prompt\nSecond line' }, { silent: true }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save prompt' })).toBeNull());
  });

  it('remembers the last tool used for the next board', async () => {
    mockGetMoodBoard.mockResolvedValue({ id: 'a', name: 'Board A', items: [] });
    const { unmount } = renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
    openTool('Import');
    unmount();
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
    expect(screen.getByRole('tab', { name: 'Import' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Import pins' })).toBeInTheDocument();
  });
});

describe('MoodBoardDetail phone tool sheet', () => {
  const desktopWidth = window.innerWidth;
  beforeEach(() => { window.innerWidth = 390; });
  afterEach(() => { window.innerWidth = desktopWidth; });

  it('opens a tool as a sheet on its own history entry and closes it with one step back', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    renderPage();
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
    expect(screen.queryByRole('dialog', { name: 'Board tools' })).toBeNull();

    const row = screen.getByRole('navigation', { name: 'Board tools' });
    fireEvent.click(within(row).getByRole('button', { name: 'Import' }));
    const sheet = screen.getByRole('dialog', { name: 'Board tools' });
    expect(sheet).toContainElement(screen.getByRole('heading', { name: 'Import from Pinterest' }));

    // Switching tools inside the sheet keeps it open on the same entry.
    fireEvent.click(screen.getByRole('tab', { name: 'Add' }));
    expect(screen.getByRole('dialog', { name: 'Board tools' })).toContainElement(screen.getByRole('button', { name: 'Pin to board' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close board tools' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('does not pop the sheet open for a ?tool= link from the desktop rail', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    renderPage(['/mood-boards/a?tool=style']);
    await waitFor(() => expect(boardNameValue()).toBe('Board A'));
    expect(screen.queryByRole('dialog', { name: 'Board tools' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Board tools' })).toBeInTheDocument();
  });
});

describe('MoodBoardDetail note render', () => {
  it('renders a text note and swaps in the image when the render event lands', async () => {
    const note = { id: 'n1', type: 'text', text: 'Palette: violet and cyan' };
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [note] });
    mockRenderMoodBoardItem.mockResolvedValueOnce({
      jobId: 'job-1', item: { ...note, render: { status: 'queued', jobId: 'job-1', error: null } },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Render' }));
    expect(mockRenderMoodBoardItem).toHaveBeenCalledWith('a', 'n1', { silent: true });
    expect(await screen.findByRole('button', { name: 'Rendering…' })).toBeDisabled();
    expect(screen.getByTestId('item-rendering')).toBeInTheDocument();

    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a', name: 'Board A',
      items: [{ id: 'n1', type: 'image', mediaKey: 'image:job-1.png', caption: note.text }],
    });
    await act(async () => { await socketHandlers.get('mood-board:item-render')({ boardId: 'a', itemId: 'n1', status: 'done' }); });
    expect(await screen.findByRole('button', { name: 'Preview image' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Render/ })).toBeNull();
  });

  it('shows why a render failed and offers it again', async () => {
    mockGetMoodBoard.mockResolvedValueOnce({
      id: 'a', name: 'Board A',
      items: [{ id: 'n1', type: 'text', text: 'Motif', render: { status: 'failed', jobId: 'j', error: 'out of memory' } }],
    });
    renderPage();
    expect(await screen.findByText('Render failed: out of memory')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Render' })).toBeEnabled();
  });
});


describe('MoodBoardDetail direct upload', () => {
  const image = new File(['synthetic image'], 'reference.png', { type: 'image/png' });
  const video = new File(['synthetic video'], 'motion.mp4', { type: 'video/mp4' });
  const savedImage = { filename: 'upload-image.png', path: '/data/images/upload-image.png', metadata: { prompt: 'Paper boat' } };
  const savedVideo = { id: 'upload-video', filename: 'upload-video.mp4', thumbnail: 'upload-video-thumb.jpg', prompt: 'Clouds' };
  const pick = files => fireEvent.change(screen.getByLabelText('Upload'), { target: { files } });

  it('uploads mixed files once, preserves embedded prompts, and retries a lost pin response without reuploading or duplicating the pin', async () => {
    const upload = deferred();
    const pins = new Map();
    let loseResponse = true;
    mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
    mockUploadRequest.mockImplementation(async (path, options) => {
      if (path === '/image-gen/upload') return upload.promise;
      if (path === '/video-gen/upload') return savedVideo;
      const payload = JSON.parse(options.body);
      if (!pins.has(payload.mediaKey)) pins.set(payload.mediaKey, { ...payload, id: `pin-${pins.size}` });
      if (loseResponse) { loseResponse = false; throw new Error('Response lost'); }
      return pins.get(payload.mediaKey);
    });
    renderPage();
    await screen.findByLabelText('Upload');
    expect(screen.getByLabelText('Upload')).toHaveAttribute('multiple');
    expect(screen.getByRole('button', { name: 'Pick from gallery' })).toBeInTheDocument();
    pick([image, video]);
    pick([image, video]);
    expect(screen.getByLabelText('Upload')).toBeDisabled();
    expect(mockUploadRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('list', { name: 'Import queue' })).toHaveTextContent('queued');
    await act(async () => upload.resolve(savedImage));
    await screen.findByText(/mood board assignment failed: Response lost/);
    await screen.findByText('1 of 2 imported');
    expect(screen.queryByRole('list', { name: 'Import queue' })).toBeNull();
    const retry = screen.getByRole('button', { name: 'Retry failed / cancelled' });
    await act(async () => { fireEvent.click(retry); fireEvent.click(retry); });
    await screen.findByText('2 of 2 imported');
    expect(screen.queryByRole('region', { name: 'Imports needing attention' })).toBeNull();
    expect(mockUploadRequest.mock.calls.filter(([path]) => path.endsWith('/upload'))).toHaveLength(2);
    expect([...pins.values()]).toEqual([
      expect.objectContaining({ type: 'image', mediaKey: 'image:upload-image.png', prompt: 'Paper boat' }),
      expect.objectContaining({ type: 'video', mediaKey: 'video:upload-video.mp4', imageUrl: '/data/video-thumbnails/upload-video-thumb.jpg', prompt: 'Clouds' }),
    ]);
    expect(screen.getAllByLabelText('Item prompt')).toHaveLength(2);
  });

  it('finishes the active upload on its original board and stops queued files after navigation', async () => {
    const upload = deferred();
    mockGetMoodBoard.mockImplementation(async id => ({ id, name: `Board ${id}`, items: [] }));
    mockUploadRequest.mockImplementation(async (path, options) => {
      if (path === '/image-gen/upload') return upload.promise;
      return { id: 'pin-old', ...JSON.parse(options.body) };
    });
    const view = renderPage();
    await screen.findByLabelText('Upload');
    pick([image, video]);
    currentId = 'b';
    view.rerender(<MemoryRouter><MoodBoardDetail /></MemoryRouter>);
    await waitFor(() => expect(boardNameValue()).toBe('Board b'));
    await act(async () => upload.resolve(savedImage));
    expect(mockUploadRequest.mock.calls.map(([path]) => path)).toEqual(['/image-gen/upload', '/mood-boards/a/items']);
    expect(screen.queryByLabelText('Item prompt')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Import queue' })).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});


it('keeps one visible item when the gallery returns an already pinned asset', async () => {
  const item = { id: 'existing-pin', type: 'image', mediaKey: 'image:pic.png', imageUrl: '/data/images/pic.png', caption: 'Legacy gallery caption' };
  mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [item] });
  mockAddMoodBoardItem.mockResolvedValue(item);
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Pick from gallery' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose fixture' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose fixture' })); });
  expect(screen.getAllByRole('button', { name: 'Preview image' })).toHaveLength(1);
  expect(screen.getByLabelText('Item prompt')).toHaveAttribute('maxlength', '2000');
});

it('accepts a >2048-char data:image URL without input truncation and surfaces server error messages when pinning fails', async () => {
  const longDataUrl = `data:image/webp;base64,${'A'.repeat(4000)}`;
  const validationError = new Error('Validation failed');
  validationError.context = { details: [{ path: 'imageUrl', message: 'Image data URL exceeds the 12MB limit' }] };
  mockGetMoodBoard.mockResolvedValueOnce({ id: 'a', name: 'Board A', items: [] });
  mockAddMoodBoardItem
    .mockRejectedValueOnce(validationError)
    .mockRejectedValueOnce(new Error('Image data URL is truncated — re-paste the full URL or upload the image'))
    .mockResolvedValueOnce({ id: 'mbi-data', type: 'image', imageUrl: '/data/images/board-1234.webp', caption: null });
  renderPage();
  const input = await screen.findByLabelText('Image URL');
  expect(input).not.toHaveAttribute('maxlength');
  fireEvent.change(input, { target: { value: longDataUrl } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pin to board' })); });
  expect(mockAddMoodBoardItem).toHaveBeenCalledWith('a', { type: 'image', imageUrl: longDataUrl, caption: null, source: null }, { silent: true });
  expect(mockToastError).toHaveBeenCalledWith('Image data URL exceeds the 12MB limit');

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pin to board' })); });
  expect(mockToastError).toHaveBeenCalledWith('Image data URL is truncated — re-paste the full URL or upload the image');

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pin to board' })); });
  expect(screen.getByRole('button', { name: 'Preview image' })).toBeInTheDocument();
  expect(input).toHaveValue('');
});
