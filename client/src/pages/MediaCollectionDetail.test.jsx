import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

// ── Mocks must be declared before any imports that use them ──────────────────

const mockPullMissingMetadata = vi.fn();
const mockListImageGallery = vi.fn();
const mockListVideoHistory = vi.fn();
const mockListMediaCollections = vi.fn();
const mockGetMediaCollection = vi.fn();
const mockAddMediaCollectionItem = vi.fn();
const mockRemoveMediaCollectionItem = vi.fn();

vi.mock('../services/api', () => ({
  listImageGallery: (...args) => mockListImageGallery(...args),
  listVideoHistory: (...args) => mockListVideoHistory(...args),
  listMediaCollections: (...args) => mockListMediaCollections(...args),
  getMediaCollection: (...args) => mockGetMediaCollection(...args),
  updateMediaCollection: vi.fn(),
  addMediaCollectionItem: (...args) => mockAddMediaCollectionItem(...args),
  removeMediaCollectionItem: (...args) => mockRemoveMediaCollectionItem(...args),
  deleteImage: vi.fn(),
  deleteVideoHistoryItem: vi.fn(),
  pullMissingMetadata: (...args) => mockPullMissingMetadata(...args),
}));

vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

const mockUpdateAnnotation = vi.fn();

vi.mock('../hooks/useMediaAnnotations', () => ({
  useMediaAnnotations: () => ({
    annotations: {},
    toggleStar: vi.fn(),
    updateAnnotation: (...args) => mockUpdateAnnotation(...args),
    getCardProps: () => ({}),
  }),
}));

vi.mock('../hooks/useMediaPreviewActions', () => ({
  default: () => ({
    handleRemix: vi.fn(),
    handleSendToVideo: vi.fn(),
    handleContinue: vi.fn(),
    handleClean: vi.fn(),
  }),
}));

vi.mock('../hooks/usePreviewRoute', () => ({
  default: () => [null, vi.fn()],
}));

vi.mock('../components/media/MediaCard', () => ({
  default: ({ item }) => <div data-testid="media-card">{item.filename || item.key}</div>,
}));

vi.mock('../components/media/MediaPreview', () => ({
  default: () => null,
}));

// Stands in for the popover's collection rows: one clickable destination so a
// test can drive bulkMoveOrCopy end to end.
vi.mock('../components/media/BulkTargetPicker', () => ({
  default: ({ onPick }) => (
    <button type="button" onClick={() => onPick('col-target', 'Target Collection')}>
      pick target
    </button>
  ),
}));

vi.mock('../components/sharing/ShareToButton', () => ({
  default: () => null,
}));

vi.mock('../components/media/normalize', () => ({
  normalizeImage: (i) => ({
    kind: 'image',
    key: `image:${i.filename}`,
    filename: i.filename,
    ref: i.filename,
  }),
  normalizeVideo: (v) => ({
    kind: 'video',
    key: `video:${v.id}`,
    id: v.id,
    ref: v.id,
  }),
}));

import toast from '../components/ui/Toast';
import MediaCollectionDetail from './MediaCollectionDetail';
import { UNSORTED_ID } from '../lib/unsorted';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const IMAGE_A = { filename: 'a.png', createdAt: '2024-01-02' };
const IMAGE_B = { filename: 'b.png', createdAt: '2024-01-01' };
const VIDEO_C = { id: 'vid-c', createdAt: '2024-01-03' };

// A collection that contains IMAGE_A (so IMAGE_B and VIDEO_C are "unsorted").
const REAL_COLLECTION = {
  id: 'col-real',
  name: 'My Collection',
  items: [{ kind: 'image', ref: IMAGE_A.filename, addedAt: '2024-01-02' }],
};

function renderUnsorted() {
  return render(
    <MemoryRouter initialEntries={[`/media/collections/${UNSORTED_ID}`]}>
      <Routes>
        <Route path="/media/collections/:id" element={<MediaCollectionDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderReal() {
  return render(
    <MemoryRouter initialEntries={['/media/collections/col-real']}>
      <Routes>
        <Route path="/media/collections/:id" element={<MediaCollectionDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Setup default mock return values ─────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: all three images + video; one real collection that contains IMAGE_A
  mockListImageGallery.mockResolvedValue([IMAGE_A, IMAGE_B]);
  mockListVideoHistory.mockResolvedValue([VIDEO_C]);
  mockListMediaCollections.mockResolvedValue([REAL_COLLECTION]);
  mockGetMediaCollection.mockResolvedValue(REAL_COLLECTION);
  mockPullMissingMetadata.mockResolvedValue({ attempted: 1, recovered: 1 });
  mockUpdateAnnotation.mockResolvedValue({ ok: true, entry: null });
  mockAddMediaCollectionItem.mockResolvedValue({ id: 'col-target', name: 'Target Collection', items: [] });
  mockRemoveMediaCollectionItem.mockResolvedValue(REAL_COLLECTION);
});

// ── Unsorted view tests ───────────────────────────────────────────────────────

describe('MediaCollectionDetail — Unsorted view', () => {
  it('renders "Pull missing prompts" button on the unsorted view', async () => {
    renderUnsorted();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /pull missing prompts/i })).toBeInTheDocument();
    });
  });

  it('button is disabled when there are no unsorted images', async () => {
    // Make every image belong to the real collection so nothing is unsorted.
    mockListMediaCollections.mockResolvedValue([
      {
        ...REAL_COLLECTION,
        items: [
          { kind: 'image', ref: IMAGE_A.filename, addedAt: '2024-01-02' },
          { kind: 'image', ref: IMAGE_B.filename, addedAt: '2024-01-01' },
          { kind: 'video', ref: VIDEO_C.id, addedAt: '2024-01-03' },
        ],
      },
    ]);
    renderUnsorted();
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /pull missing prompts/i });
      expect(btn).toBeDisabled();
    });
  });

  it('calls pullMissingMetadata with only image filenames (not video ids)', async () => {
    const user = userEvent.setup();
    renderUnsorted();
    await waitFor(() => screen.getByRole('button', { name: /pull missing prompts/i }));

    await user.click(screen.getByRole('button', { name: /pull missing prompts/i }));

    await waitFor(() => expect(mockPullMissingMetadata).toHaveBeenCalledOnce());
    // IMAGE_B is unsorted (IMAGE_A is in col-real); VIDEO_C should not appear.
    const [filenames] = mockPullMissingMetadata.mock.calls[0];
    expect(filenames).toContain(IMAGE_B.filename);
    expect(filenames).not.toContain(IMAGE_A.filename);
    expect(filenames).not.toContain(VIDEO_C.id);
  });

  it('toasts success when prompts are recovered', async () => {
    mockPullMissingMetadata.mockResolvedValue({ attempted: 1, recovered: 1 });
    const user = userEvent.setup();
    renderUnsorted();
    await waitFor(() => screen.getByRole('button', { name: /pull missing prompts/i }));

    await user.click(screen.getByRole('button', { name: /pull missing prompts/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/recovered prompts for 1\/1/i),
    ));
  });

  it('toasts neutral message when no prompts are found', async () => {
    mockPullMissingMetadata.mockResolvedValue({ attempted: 1, recovered: 0 });
    const user = userEvent.setup();
    renderUnsorted();
    await waitFor(() => screen.getByRole('button', { name: /pull missing prompts/i }));

    await user.click(screen.getByRole('button', { name: /pull missing prompts/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/no missing prompts found/i),
    ));
  });

  it('refreshes the image list after a successful pull', async () => {
    // First load: IMAGE_B unsorted. After pull: IMAGE_B is now in a collection.
    const updatedCollection = {
      ...REAL_COLLECTION,
      items: [
        ...REAL_COLLECTION.items,
        { kind: 'image', ref: IMAGE_B.filename, addedAt: '2024-01-01' },
      ],
    };
    mockPullMissingMetadata.mockResolvedValue({ attempted: 1, recovered: 1 });
    mockListMediaCollections
      .mockResolvedValueOnce([REAL_COLLECTION])   // initial load
      .mockResolvedValue([updatedCollection]);     // refresh after pull

    const user = userEvent.setup();
    renderUnsorted();
    await waitFor(() => screen.getByRole('button', { name: /pull missing prompts/i }));
    await user.click(screen.getByRole('button', { name: /pull missing prompts/i }));

    // listMediaCollections should be called a second time (the refresh).
    await waitFor(() => {
      expect(mockListMediaCollections.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ── Non-unsorted view: button must NOT appear ─────────────────────────────────

describe('MediaCollectionDetail — regular collection view', () => {
  it('does NOT render "Pull missing prompts" on a real collection', async () => {
    renderReal();
    await waitFor(() => screen.getByText('My Collection'));
    expect(screen.queryByRole('button', { name: /pull missing prompts/i })).toBeNull();
  });
});

// ── bulkStar (#6018): must not report false success when items fail ──────────

describe('MediaCollectionDetail — bulkStar', () => {
  const THREE_ITEM_COLLECTION = {
    ...REAL_COLLECTION,
    items: [
      { kind: 'image', ref: IMAGE_A.filename, addedAt: '2024-01-02' },
      { kind: 'image', ref: IMAGE_B.filename, addedAt: '2024-01-01' },
      { kind: 'video', ref: VIDEO_C.id, addedAt: '2024-01-03' },
    ],
  };

  beforeEach(() => {
    mockGetMediaCollection.mockResolvedValue(THREE_ITEM_COLLECTION);
  });

  async function enterSelectModeAndSelectAll(user) {
    await waitFor(() => screen.getByRole('button', { name: /^select$/i }));
    await user.click(screen.getByRole('button', { name: /^select$/i }));
    await user.click(screen.getByRole('button', { name: /select all/i }));
  }

  it('toasts a single success message when every item succeeds', async () => {
    mockUpdateAnnotation.mockResolvedValue({ ok: true, entry: null });
    const user = userEvent.setup();
    renderReal();
    await enterSelectModeAndSelectAll(user);

    await user.click(screen.getByRole('button', { name: /^star$/i }));

    await waitFor(() => expect(mockUpdateAnnotation).toHaveBeenCalledTimes(3));
    expect(mockUpdateAnnotation.mock.calls.every(([, , opts]) => opts?.silent === true)).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('Favorited 3 items');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts a single failure message with no success toast when every item fails', async () => {
    mockUpdateAnnotation.mockResolvedValue({ ok: false, entry: null });
    const user = userEvent.setup();
    renderReal();
    await enterSelectModeAndSelectAll(user);

    await user.click(screen.getByRole('button', { name: /^star$/i }));

    await waitFor(() => expect(mockUpdateAnnotation).toHaveBeenCalledTimes(3));
    expect(toast.error).toHaveBeenCalledWith('Failed to favorite items');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('toasts a single consolidated message on partial failure (no contradictory success toast)', async () => {
    mockUpdateAnnotation
      .mockResolvedValueOnce({ ok: true, entry: null })
      .mockResolvedValueOnce({ ok: false, entry: null })
      .mockResolvedValueOnce({ ok: true, entry: null });
    const user = userEvent.setup();
    renderReal();
    await enterSelectModeAndSelectAll(user);

    await user.click(screen.getByRole('button', { name: /^star$/i }));

    await waitFor(() => expect(mockUpdateAnnotation).toHaveBeenCalledTimes(3));
    expect(toast.error).toHaveBeenCalledWith('Favorited 2 items; 1 failed');
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// ── bulkMoveOrCopy (#6017): a move whose removal half fails is NOT a success ──

describe('MediaCollectionDetail — bulkMoveOrCopy move/remove failures', () => {
  const KEY_A = `image:${IMAGE_A.filename}`;
  const KEY_B = `image:${IMAGE_B.filename}`;
  const KEY_C = `video:${VIDEO_C.id}`;

  const THREE_ITEM_COLLECTION = {
    ...REAL_COLLECTION,
    items: [
      { kind: 'image', ref: IMAGE_A.filename, addedAt: '2024-01-02' },
      { kind: 'image', ref: IMAGE_B.filename, addedAt: '2024-01-01' },
      { kind: 'video', ref: VIDEO_C.id, addedAt: '2024-01-03' },
    ],
  };
  // The server state after the only successful removal in the partial test.
  const AFTER_B_REMOVED = {
    ...REAL_COLLECTION,
    items: [
      { kind: 'video', ref: VIDEO_C.id, addedAt: '2024-01-03' },
      { kind: 'image', ref: IMAGE_A.filename, addedAt: '2024-01-02' },
    ],
  };

  beforeEach(() => {
    mockGetMediaCollection.mockResolvedValue(THREE_ITEM_COLLECTION);
  });

  async function selectAllAndMove(user) {
    await waitFor(() => screen.getByRole('button', { name: /^select$/i }));
    await user.click(screen.getByRole('button', { name: /^select$/i }));
    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /move…/i }));
    await user.click(screen.getByRole('button', { name: /pick target/i }));
  }

  it('toasts a plain success and exits select mode when every removal succeeds', async () => {
    const user = userEvent.setup();
    renderReal();
    await selectAllAndMove(user);

    await waitFor(() => expect(mockRemoveMediaCollectionItem).toHaveBeenCalledTimes(3));
    expect(toast.success).toHaveBeenCalledWith('Moved 3 to "Target Collection"');
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByText(/of 3 selected/)).toBeNull();
  });

  it('reports the removal failure instead of a false success when every removal fails', async () => {
    mockRemoveMediaCollectionItem.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderReal();
    await selectAllAndMove(user);

    await waitFor(() => expect(mockRemoveMediaCollectionItem).toHaveBeenCalledTimes(3));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Copied 3 to "Target Collection", but 3 could not be removed from "My Collection"',
    );
    // Nothing left the source collection, and the half-moved items stay
    // selected so the user can retry.
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    expect(screen.getByText(/of 3 selected/)).toBeInTheDocument();
  });

  it('counts add and removal failures separately and narrows the selection to the failed items', async () => {
    // Removal order follows the rendered (newest-first) order: C, A, B.
    mockAddMediaCollectionItem.mockImplementation((_targetId, { ref }) => (
      ref === VIDEO_C.id
        ? Promise.reject(new Error('add failed'))
        : Promise.resolve({ id: 'col-target', name: 'Target Collection', items: [] })
    ));
    mockRemoveMediaCollectionItem.mockImplementation((_id, key) => (
      key === KEY_A ? Promise.reject(new Error('boom')) : Promise.resolve(AFTER_B_REMOVED)
    ));
    const user = userEvent.setup();
    renderReal();
    await selectAllAndMove(user);

    await waitFor(() => expect(mockRemoveMediaCollectionItem).toHaveBeenCalledTimes(2));
    // The video never got added, so it is never removed.
    const removedKeys = mockRemoveMediaCollectionItem.mock.calls.map(([, key]) => key);
    expect(removedKeys).toEqual([KEY_A, KEY_B]);
    expect(removedKeys).not.toContain(KEY_C);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Copied 2 to "Target Collection", but 1 could not be removed from "My Collection"; 1 failed to add',
    );
    // setCollection reconciled to the last authoritative server state (B gone),
    // and only the item whose removal failed stays selected.
    await waitFor(() => expect(screen.getByText(/of 2 selected/)).toBeInTheDocument());
    expect(screen.queryByText(IMAGE_B.filename)).toBeNull();
  });
});
