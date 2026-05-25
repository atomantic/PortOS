import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── Mocks must be declared before any imports that use them ──────────────────

const mockPullMissingMetadata = vi.fn();
const mockListImageGallery = vi.fn();
const mockListVideoHistory = vi.fn();
const mockListMediaCollections = vi.fn();
const mockGetMediaCollection = vi.fn();

vi.mock('../services/api', () => ({
  listImageGallery: (...args) => mockListImageGallery(...args),
  listVideoHistory: (...args) => mockListVideoHistory(...args),
  listMediaCollections: (...args) => mockListMediaCollections(...args),
  getMediaCollection: (...args) => mockGetMediaCollection(...args),
  updateMediaCollection: vi.fn(),
  addMediaCollectionItem: vi.fn(),
  removeMediaCollectionItem: vi.fn(),
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

vi.mock('../hooks/useMediaAnnotations', () => ({
  useMediaAnnotations: () => ({
    annotations: {},
    toggleStar: vi.fn(),
    updateAnnotation: vi.fn(),
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

vi.mock('../components/media/BulkTargetPicker', () => ({
  default: () => null,
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
