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
const mockGetUniverse = vi.fn();
const mockGetPipelineSeries = vi.fn();
const mockSyncRecordToPeer = vi.fn();
const mockPullMissingMetadata = vi.fn();

vi.mock('../../services/api', () => ({
  getMediaCollection: (...args) => mockGetMediaCollection(...args),
  getUniverse: (...args) => mockGetUniverse(...args),
  getPipelineSeries: (...args) => mockGetPipelineSeries(...args),
  syncRecordToPeer: (...args) => mockSyncRecordToPeer(...args),
  pullMissingMetadata: (...args) => mockPullMissingMetadata(...args),
}));

// ── Mock MediaImage ──────────────────────────────────────────────────────────
vi.mock('../MediaImage', () => ({
  default: ({ src, alt }) => <img src={src} alt={alt} data-testid="media-image" />,
}));

// ── Mock socket (used transitively by MediaImage's real code) ────────────────
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

// ── Mock toast (default export is callable AND has .success/.error) ──────────
// vi.hoisted so the value exists when the hoisted vi.mock factory runs.
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: mockToast }));

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
    integrityUnavailable: false,
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
  // Default: never resolve (safe for tests that don't assert on record content).
  // Individual tests that need record data override this with mockResolvedValue.
  mockGetMediaCollection.mockImplementation(pendingPromise);
  mockGetUniverse.mockImplementation(pendingPromise);
  mockGetPipelineSeries.mockImplementation(pendingPromise);
  mockSyncRecordToPeer.mockResolvedValue({ pushed: true });
  mockPullMissingMetadata.mockResolvedValue({ recovered: 2, attempted: 2 });
});

describe('SyncDetailDrawer', () => {
  it('renders a dialog with "Sync Details" heading', async () => {
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: /sync details/i })).toBeInTheDocument());
  });

  it('does not fetch the record when recordId is empty (param-less mount)', async () => {
    render(<SyncDetailDrawer kind="mediaCollection" recordId="" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: /sync details/i })).toBeInTheDocument());
    // The per-kind fetcher must not be hit with an empty id (would 404 on `/media/collections/`).
    expect(mockGetMediaCollection).not.toHaveBeenCalled();
  });

  it('drops a stale in-flight fetch when recordId changes mid-flight (latest wins)', async () => {
    let resolveFirst;
    mockGetMediaCollection
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = () => r({ id: 'col-A', name: 'Alpha Collection', items: [] }); }))
      .mockImplementationOnce(() => Promise.resolve({ id: 'col-B', name: 'Beta Collection', items: [] }));

    const { rerender } = render(<SyncDetailDrawer kind="mediaCollection" recordId="col-A" onClose={() => {}} />);
    // Switch to col-B before col-A's fetch resolves.
    rerender(<SyncDetailDrawer kind="mediaCollection" recordId="col-B" onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('Beta Collection').length).toBeGreaterThan(0));
    // Now let the stale col-A fetch resolve — it must NOT overwrite Beta.
    resolveFirst();
    await waitFor(() => expect(screen.queryAllByText('Alpha Collection')).toHaveLength(0));
    expect(screen.getAllByText('Beta Collection').length).toBeGreaterThan(0);
  });

  it('clears a previously-loaded record when recordId becomes empty (no stale name/preview)', async () => {
    mockGetMediaCollection.mockResolvedValue(COLLECTION_DATA);
    const { rerender } = render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    // Name renders in both the header and the preview, so match all occurrences.
    await waitFor(() => expect(screen.getAllByText('My Collection').length).toBeGreaterThan(0));
    rerender(<SyncDetailDrawer kind="mediaCollection" recordId="" onClose={() => {}} />);
    await waitFor(() => expect(screen.queryAllByText('My Collection')).toHaveLength(0));
  });

  it('shows an "integrity unavailable" message (not "No peer data") when every peer is unreachable', async () => {
    mockUseSyncIntegrity.mockReturnValue(defaultHookState({
      byPeer: new Map(), // no peer contributed records
      noSyncingPeers: false, // sync IS configured
      integrityUnavailable: true, // …but no peer answered
    }));
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    expect(screen.getByText(/sync status unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no peer data for this record/i)).not.toBeInTheDocument();
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

  it('toasts success only when the push actually happened (pushed:true)', async () => {
    mockSyncRecordToPeer.mockResolvedValue({ pushed: true });
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: /sync to peer/i })[0]);
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/synced to void/i)));
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('toasts an error with the reason when the server reports pushed:false (HTTP 200)', async () => {
    // The endpoint returns 200 with { pushed:false, reason } when nothing went
    // out (category disabled, record missing, etc.) — must NOT claim success.
    mockSyncRecordToPeer.mockResolvedValue({ pushed: false, reason: 'category-disabled' });
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: /sync to peer/i })[0]);
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(
      expect.stringMatching(/nothing synced to void.*not enabled/i),
    ));
    expect(mockToast.success).not.toHaveBeenCalled();
    // Still refreshes so the badge reflects current state.
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

  it('toasts success for "Pull missing metadata" only when something was recovered', async () => {
    mockGetMediaCollection.mockResolvedValue(COLLECTION_DATA);
    mockPullMissingMetadata.mockResolvedValue({ recovered: 1, attempted: 2 });
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => screen.getByText('My Collection'));
    fireEvent.click(screen.getByRole('button', { name: /pull missing metadata/i }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/pulled 1\/2/i)));
  });

  it('toasts a neutral message for "Pull missing metadata" when recovered=0 (not success)', async () => {
    mockGetMediaCollection.mockResolvedValue(COLLECTION_DATA);
    mockPullMissingMetadata.mockResolvedValue({ recovered: 0, attempted: 2 });
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => screen.getByText('My Collection'));
    fireEvent.click(screen.getByRole('button', { name: /pull missing metadata/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/no missing metadata found \(2 checked\)/i)));
    expect(mockToast.success).not.toHaveBeenCalled();
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

  it('shows a category-accurate message (not "no peers at all") when noSyncingPeers is true', async () => {
    mockUseSyncIntegrity.mockReturnValue(defaultHookState({ noSyncingPeers: true, byPeer: new Map() }));
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no peers are syncing this category/i)).toBeInTheDocument());
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

  it('locks body scroll while open and restores it on unmount', async () => {
    document.body.style.overflow = 'scroll';
    mockGetMediaCollection.mockResolvedValue(COLLECTION_DATA);
    const { unmount } = render(
      <SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />,
    );
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));
    unmount();
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('fetches the collection only once (preview + pull share the same state)', async () => {
    mockGetMediaCollection.mockResolvedValue(COLLECTION_DATA);
    render(<SyncDetailDrawer kind="mediaCollection" recordId={RECORD_ID} onClose={() => {}} />);
    await waitFor(() => screen.getByText('My Collection'));
    expect(mockGetMediaCollection).toHaveBeenCalledTimes(1);
    // Clicking pull reads from the already-loaded state — must NOT re-fetch
    // the collection before calling pullMissingMetadata.
    fireEvent.click(screen.getByRole('button', { name: /pull missing metadata/i }));
    await waitFor(() => expect(mockPullMissingMetadata).toHaveBeenCalled());
    // pull triggers a post-pull preview refresh (the 2nd fetch), but the
    // action itself did not add a redundant fetch before pulling.
    expect(mockGetMediaCollection).toHaveBeenCalledTimes(2);
  });
});

// ── universe kind ────────────────────────────────────────────────────────────
describe('SyncDetailDrawer — kind="universe"', () => {
  const UNIVERSE_ID = 'uni-abc';
  const UNIVERSE_DATA = { id: UNIVERSE_ID, name: 'Iron Veil' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSyncIntegrity.mockReturnValue({
      byPeer: (() => {
        const m = new Map();
        m.set(UNIVERSE_ID, [
          { peerId: 'peer-a', peerName: 'void', status: 'diverged' },
          { peerId: 'peer-b', peerName: 'null', status: 'in-parity' },
        ]);
        return m;
      })(),
      noSyncingPeers: false,
      loading: false,
      error: null,
      refresh: mockRefresh,
    });
    mockGetUniverse.mockResolvedValue(UNIVERSE_DATA);
    mockGetPipelineSeries.mockImplementation(pendingPromise);
    mockGetMediaCollection.mockImplementation(pendingPromise);
    mockSyncRecordToPeer.mockResolvedValue({ pushed: true });
    mockPullMissingMetadata.mockResolvedValue({ recovered: 0, attempted: 0 });
  });

  it('shows the universe name in the header', async () => {
    render(<SyncDetailDrawer kind="universe" recordId={UNIVERSE_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Iron Veil')).toBeInTheDocument());
  });

  it('shows per-peer breakdown', async () => {
    render(<SyncDetailDrawer kind="universe" recordId={UNIVERSE_ID} onClose={() => {}} />);
    expect(screen.getByText('void')).toBeInTheDocument();
    expect(screen.getByText('null')).toBeInTheDocument();
    expect(screen.getByText('Diverged')).toBeInTheDocument();
  });

  it('calls syncRecordToPeer with kind="universe" when "Sync to peer" is clicked', async () => {
    render(<SyncDetailDrawer kind="universe" recordId={UNIVERSE_ID} onClose={() => {}} />);
    const [syncBtn] = screen.getAllByRole('button', { name: /sync to peer/i });
    fireEvent.click(syncBtn);
    await waitFor(() => expect(mockSyncRecordToPeer).toHaveBeenCalledWith(
      'peer-a', 'universe', UNIVERSE_ID, { silent: true },
    ));
  });

  it('does NOT render the thumbnail grid or pull-prompts button', async () => {
    render(<SyncDetailDrawer kind="universe" recordId={UNIVERSE_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Iron Veil')).toBeInTheDocument());
    expect(screen.queryByTestId('media-image')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pull missing metadata/i })).not.toBeInTheDocument();
  });

  it('calls getUniverse (not getMediaCollection or getPipelineSeries)', async () => {
    render(<SyncDetailDrawer kind="universe" recordId={UNIVERSE_ID} onClose={() => {}} />);
    await waitFor(() => expect(mockGetUniverse).toHaveBeenCalledWith(UNIVERSE_ID));
    expect(mockGetMediaCollection).not.toHaveBeenCalled();
    expect(mockGetPipelineSeries).not.toHaveBeenCalled();
  });
});

// ── series kind ──────────────────────────────────────────────────────────────
describe('SyncDetailDrawer — kind="series"', () => {
  const SERIES_ID = 'ser-xyz';
  const SERIES_DATA = { id: SERIES_ID, name: 'Salt Run' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSyncIntegrity.mockReturnValue({
      byPeer: (() => {
        const m = new Map();
        m.set(SERIES_ID, [
          { peerId: 'peer-a', peerName: 'NaN', status: 'local-only' },
        ]);
        return m;
      })(),
      noSyncingPeers: false,
      loading: false,
      error: null,
      refresh: mockRefresh,
    });
    mockGetPipelineSeries.mockResolvedValue(SERIES_DATA);
    mockGetUniverse.mockImplementation(pendingPromise);
    mockGetMediaCollection.mockImplementation(pendingPromise);
    mockSyncRecordToPeer.mockResolvedValue({ pushed: true });
    mockPullMissingMetadata.mockResolvedValue({ recovered: 0, attempted: 0 });
  });

  it('shows the series name in the header', async () => {
    render(<SyncDetailDrawer kind="series" recordId={SERIES_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Salt Run')).toBeInTheDocument());
  });

  it('calls syncRecordToPeer with kind="series"', async () => {
    render(<SyncDetailDrawer kind="series" recordId={SERIES_ID} onClose={() => {}} />);
    const [syncBtn] = screen.getAllByRole('button', { name: /sync to peer/i });
    fireEvent.click(syncBtn);
    await waitFor(() => expect(mockSyncRecordToPeer).toHaveBeenCalledWith(
      'peer-a', 'series', SERIES_ID, { silent: true },
    ));
  });

  it('does NOT render the thumbnail grid or pull-prompts button', async () => {
    render(<SyncDetailDrawer kind="series" recordId={SERIES_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Salt Run')).toBeInTheDocument());
    expect(screen.queryByTestId('media-image')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pull missing metadata/i })).not.toBeInTheDocument();
  });

  it('calls getPipelineSeries (not getMediaCollection or getUniverse)', async () => {
    render(<SyncDetailDrawer kind="series" recordId={SERIES_ID} onClose={() => {}} />);
    await waitFor(() => expect(mockGetPipelineSeries).toHaveBeenCalledWith(SERIES_ID));
    expect(mockGetMediaCollection).not.toHaveBeenCalled();
    expect(mockGetUniverse).not.toHaveBeenCalled();
  });
});
