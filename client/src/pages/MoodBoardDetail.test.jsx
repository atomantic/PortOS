import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks must be declared before any imports that use them ──────────────────

const mockGetMoodBoard = vi.fn();

vi.mock('../services/api', () => ({
  getMoodBoard: (...args) => mockGetMoodBoard(...args),
  updateMoodBoard: vi.fn(),
  addMoodBoardItem: vi.fn(),
  updateMoodBoardItem: vi.fn(),
  removeMoodBoardItem: vi.fn(),
  linkMoodBoardPinterest: vi.fn(),
  unlinkMoodBoardPinterest: vi.fn(),
  syncMoodBoardPinterest: vi.fn(),
}));

const mockToastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: (...args) => mockToastError(...args),
    warning: vi.fn(),
  }),
}));

// Control the board id `useParams` returns so we can simulate the user
// navigating from one board to another mid-fetch.
let currentId = 'a';
vi.mock('react-router-dom', async (importOriginal) => {
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
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
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
});
