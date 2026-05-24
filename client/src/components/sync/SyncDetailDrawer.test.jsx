import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mock useSyncIntegrity ────────────────────────────────────────────────────
const mockRefresh = vi.fn();
const mockUseSyncIntegrity = vi.fn();
vi.mock('../../hooks/useSyncIntegrity', () => ({
  useSyncIntegrity: (...args) => mockUseSyncIntegrity(...args),
}));

// ── Mock API calls ───────────────────────────────────────────────────────────
const mockGetMediaCollection = vi.fn();
const mockSyncRecordToPeer = vi.fn();
const mockPullMissingMetadata = vi.fn();

vi.mock('../../services/api', () => ({
  getMediaCollection: (...args) => mockGetMediaCollection(...args),
  syncRecordToPeer: (...args) => mockSyncRecordToPeer(...args),
  pullMissingMetadata: (...args) => mockPullMissingMetadata(...args),
}));

// ── Mock MediaImage ──────────────────────────────────────────────────────────
vi.mock('../MediaImage', () => ({
  default: ({ src, alt }) => <img src={src} alt={alt} data-testid="media-image" />,
}));

// ── Mock socket (used transitively by MediaImage's real code) ────────────────
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

import SyncDetailDrawer from './SyncDetailDrawer';

const RECORD_ID = 'col-123';

const buildByPeer = (entries) => {
  const m = new Map();
  m.set(RECORD_ID, entries);
  return m;
};

function defaultHookState(overrides = {}) {
  return {
    byPeer: buildByPeer([
      { peerId: 'peer-a', peerName: 'void', status: 'diverged' },
      { peerId: 'peer-b', peerName: 'null', status: 'in-parity' },
    ]),
    noSyncingPeers: false,
    loading: false,
    error: null,
    refresh: mockRefresh,
    ...overrides,
  };
}

// Resolved collection fixture
const COLLECTION_DATA = {
  id: RECORD_ID,
  name: 'My Collection',
  items: [
    { kind: 'image', ref: 'img1.png', addedAt: '2024-01-01' },
    { kind: 'image', ref: 'img2.png', addedAt: '2024-01-02' },
  ],
};

// A promise that never resolves — used to prevent CollectionPreview's async
// state update from firing outside of act() in tests that don't need collection data.
const pendingPromise = () => new Promise(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSyncIntegrity.mockReturnValue(defaultHookState());
  // Default: never resolve (safe for tests that don't assert on collection content).
  // Individual tests that need collection data override this with mockResolvedValue.
  mockGetMediaCollection.mockImplementation(pendingPromise);
  mockSyncRecordToPeer.mockResolvedValue({ ok: true });
  mockPullMissingMetadata.mockResolvedValue({ recovered: 2, attempted: 2 });
});

describe('SyncDetailDrawer', () => {
  it('renders a dialog with "Sync Details" heading', async () => {
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: /sync details/i })).toBeInTheDocument());
  });

  it('shows per-peer breakdown from useSyncIntegrity', async () => {
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    expect(screen.getByText('void')).toBeInTheDocument();
    expect(screen.getByText('null')).toBeInTheDocument();
    expect(screen.getByText('Diverged')).toBeInTheDocument();
    expect(screen.getByText('In parity')).toBeInTheDocument();
  });

  it('shows "Sync to peer" button for peers that are not in-parity', () => {
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    // void is diverged → should have sync button
    const syncBtns = screen.getAllByRole('button', { name: /sync to peer/i });
    expect(syncBtns.length).toBeGreaterThan(0);
  });

  it('calls syncRecordToPeer and refresh when "Sync to peer" is clicked', async () => {
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    const [syncBtn] = screen.getAllByRole('button', { name: /sync to peer/i });
    fireEvent.click(syncBtn);
    await waitFor(() => expect(mockSyncRecordToPeer).toHaveBeenCalledWith(
      'peer-a', 'mediaCollection', RECORD_ID, { silent: true },
    ));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('shows collection thumbnails when collection is fetched', async () => {
    mockGetMediaCollection.mockResolvedValue(COLLECTION_DATA);
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('My Collection')).toBeInTheDocument());
    expect(screen.getByText('2 items')).toBeInTheDocument();
    const thumbs = screen.getAllByTestId('media-image');
    expect(thumbs.length).toBeGreaterThan(0);
  });

  it('calls pullMissingMetadata and refresh when "Pull missing metadata" is clicked', async () => {
    mockGetMediaCollection.mockResolvedValue(COLLECTION_DATA);
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    // Wait for collection to load
    await waitFor(() => screen.getByText('My Collection'));
    fireEvent.click(screen.getByRole('button', { name: /pull missing metadata/i }));
    await waitFor(() => expect(mockPullMissingMetadata).toHaveBeenCalledWith(
      ['img1.png', 'img2.png'], { silent: true },
    ));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close sync details/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={onClose} />);
    // backdrop is the first fixed div
    const backdrop = document.querySelector('[aria-hidden="true"]');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows "No sync-enabled peers" when noSyncingPeers is true', async () => {
    mockUseSyncIntegrity.mockReturnValue(defaultHookState({ noSyncingPeers: true, byPeer: new Map() }));
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no sync-enabled peers/i)).toBeInTheDocument());
  });

  it('shows loading spinner while integrity data is loading', async () => {
    mockUseSyncIntegrity.mockReturnValue(defaultHookState({ loading: true, byPeer: new Map() }));
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/checking peers/i)).toBeInTheDocument());
  });

  it('shows error message when integrity fetch fails', async () => {
    mockUseSyncIntegrity.mockReturnValue(
      defaultHookState({ loading: false, error: new Error('net err'), byPeer: new Map() }),
    );
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/failed to load sync status/i)).toBeInTheDocument());
  });
});
