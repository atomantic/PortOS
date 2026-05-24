import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Module mocks — must be at the top level before any imports.
// ---------------------------------------------------------------------------
vi.mock('../services/apiSystem.js', () => ({
  getInstances: vi.fn(),
}));

vi.mock('../services/apiPeerSync.js', () => ({
  fetchSyncIntegrity: vi.fn(),
}));

let useSyncIntegrity;
let syncBadgeStatus;
let getInstances;
let fetchSyncIntegrity;

// Two shared peer fixtures (online + offline).
const PEER_A = {
  instanceId: 'peer-a',
  name: 'Peer Alpha',
  status: 'online',
  syncEnabled: true,
  syncCategories: { universe: true, pipeline: true, mediaCollections: true },
};
const PEER_B = {
  instanceId: 'peer-b',
  name: 'Peer Beta',
  status: 'online',
  syncEnabled: true,
  syncCategories: { universe: true, pipeline: true, mediaCollections: true },
};
const PEER_OFFLINE = {
  instanceId: 'peer-c',
  name: 'Peer Offline',
  status: 'offline',
  syncEnabled: true,
  syncCategories: { universe: true },
};

beforeEach(async () => {
  vi.resetModules();
  ({ useSyncIntegrity, syncBadgeStatus } = await import('./useSyncIntegrity.js'));
  ({ getInstances } = await import('../services/apiSystem.js'));
  ({ fetchSyncIntegrity } = await import('../services/apiPeerSync.js'));
  getInstances.mockReset();
  fetchSyncIntegrity.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the hook with a pre-supplied peer list (skips getInstances). */
function renderWithPeers(kind, peers) {
  return renderHook(() => useSyncIntegrity(kind, { peers }));
}

/** Render the hook relying on getInstances for the peer list. */
function renderWithFetch(kind) {
  return renderHook(() => useSyncIntegrity(kind));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSyncIntegrity — no syncing peers', () => {
  it('noSyncingPeers=true and no integrity calls when peer list is empty', async () => {
    const { result } = renderWithPeers('universe', []);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.noSyncingPeers).toBe(true);
    expect(result.current.statusById.size).toBe(0);
    expect(result.current.byPeer.size).toBe(0);
    expect(fetchSyncIntegrity).not.toHaveBeenCalled();
  });

  it('noSyncingPeers=true when all peers are offline', async () => {
    const { result } = renderWithPeers('universe', [PEER_OFFLINE]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.noSyncingPeers).toBe(true);
    expect(fetchSyncIntegrity).not.toHaveBeenCalled();
  });

  it('noSyncingPeers=true when no online peer has the category enabled', async () => {
    const peerNoCat = {
      ...PEER_A,
      syncCategories: { universe: false, pipeline: true },
    };
    // 'universe' kind → 'universe' category → disabled → no eligible peers
    const { result } = renderWithPeers('universe', [peerNoCat]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.noSyncingPeers).toBe(true);
    expect(fetchSyncIntegrity).not.toHaveBeenCalled();
  });

  it('noSyncingPeers=true when syncEnabled=false', async () => {
    const peerDisabled = { ...PEER_A, syncEnabled: false };
    const { result } = renderWithPeers('universe', [peerDisabled]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.noSyncingPeers).toBe(true);
    expect(fetchSyncIntegrity).not.toHaveBeenCalled();
  });

  it('excludes a peer with enabled=false (not polled, not eligible)', async () => {
    const peerOff = { ...PEER_A, enabled: false };
    const { result } = renderWithPeers('universe', [peerOff]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.noSyncingPeers).toBe(true);
    expect(fetchSyncIntegrity).not.toHaveBeenCalled();
  });
});

describe('useSyncIntegrity — worst-case status reduction', () => {
  it('reduces diverged + in-parity → diverged for the same recordId', async () => {
    const recId = 'rec-1';
    fetchSyncIntegrity
      .mockResolvedValueOnce({
        available: true,
        records: [{ id: recId, name: 'Rec One', status: 'diverged' }],
      })
      .mockResolvedValueOnce({
        available: true,
        records: [{ id: recId, name: 'Rec One', status: 'in-parity' }],
      });

    const { result } = renderWithPeers('universe', [PEER_A, PEER_B]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.statusById.get(recId)).toBe('diverged');
  });

  it('byPeer has an entry for each peer for the same record', async () => {
    const recId = 'rec-1';
    fetchSyncIntegrity
      .mockResolvedValueOnce({
        available: true,
        records: [{ id: recId, name: 'Rec One', status: 'diverged' }],
      })
      .mockResolvedValueOnce({
        available: true,
        records: [{ id: recId, name: 'Rec One', status: 'in-parity' }],
      });

    const { result } = renderWithPeers('universe', [PEER_A, PEER_B]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    const entries = result.current.byPeer.get(recId);
    expect(entries).toHaveLength(2);
    const statuses = entries.map((e) => e.status);
    expect(statuses).toContain('diverged');
    expect(statuses).toContain('in-parity');
  });

  it('assets-missing beats diverged (worst-case wins)', async () => {
    const recId = 'rec-2';
    fetchSyncIntegrity
      .mockResolvedValueOnce({
        available: true,
        records: [{ id: recId, name: 'R', status: 'assets-missing' }],
      })
      .mockResolvedValueOnce({
        available: true,
        records: [{ id: recId, name: 'R', status: 'diverged' }],
      });

    const { result } = renderWithPeers('universe', [PEER_A, PEER_B]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.statusById.get(recId)).toBe('assets-missing');
  });

  it('excludes records from unavailable peers', async () => {
    fetchSyncIntegrity
      .mockResolvedValueOnce({ available: false, reason: 'peer-unreachable', records: [] })
      .mockResolvedValueOnce({
        available: true,
        records: [{ id: 'rec-3', name: 'R', status: 'in-parity' }],
      });

    const { result } = renderWithPeers('universe', [PEER_A, PEER_B]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Only the available peer's records surface.
    expect(result.current.statusById.get('rec-3')).toBe('in-parity');
    // byPeer has only one entry (the available peer).
    expect(result.current.byPeer.get('rec-3')).toHaveLength(1);
  });
});

describe('useSyncIntegrity — peer fetch fallback', () => {
  it('falls back to getInstances when peers prop is omitted', async () => {
    getInstances.mockResolvedValue({ peers: [PEER_A] });
    fetchSyncIntegrity.mockResolvedValue({
      available: true,
      records: [{ id: 'rec-4', name: 'R', status: 'local-only' }],
    });

    const { result } = renderWithFetch('series');
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getInstances).toHaveBeenCalledWith({ silent: true });
    expect(fetchSyncIntegrity).toHaveBeenCalledWith('peer-a', 'series');
    expect(result.current.statusById.get('rec-4')).toBe('local-only');
  });
});

describe('useSyncIntegrity — KIND_TO_CATEGORY mapping', () => {
  it('maps "series" kind to "pipeline" category', async () => {
    // PEER_A has pipeline:true, so it should be queried
    fetchSyncIntegrity.mockResolvedValue({ available: true, records: [] });
    const { result } = renderWithPeers('series', [PEER_A]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchSyncIntegrity).toHaveBeenCalledWith('peer-a', 'series');
  });

  it('maps "mediaCollection" kind to "mediaCollections" category', async () => {
    fetchSyncIntegrity.mockResolvedValue({ available: true, records: [] });
    const { result } = renderWithPeers('mediaCollection', [PEER_A]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchSyncIntegrity).toHaveBeenCalledWith('peer-a', 'mediaCollection');
  });
});

describe('useSyncIntegrity — refresh()', () => {
  it('re-runs the fetch when refresh() is called', async () => {
    fetchSyncIntegrity.mockResolvedValue({ available: true, records: [] });

    const { result } = renderWithPeers('universe', [PEER_A]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchSyncIntegrity).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchSyncIntegrity).toHaveBeenCalledTimes(2);
  });
});

describe('useSyncIntegrity — integrityUnavailable', () => {
  it('integrityUnavailable=true when eligible peers exist but none return available data', async () => {
    fetchSyncIntegrity
      .mockResolvedValueOnce({ available: false, reason: 'peer-unreachable', records: [] })
      .mockResolvedValueOnce({ available: false, reason: 'peer-too-old', records: [] });

    const { result } = renderWithPeers('universe', [PEER_A, PEER_B]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.integrityUnavailable).toBe(true);
    expect(result.current.noSyncingPeers).toBe(false); // distinct: peers ARE configured
    expect(result.current.statusById.size).toBe(0);
  });

  it('integrityUnavailable=false when at least one peer returns available data', async () => {
    fetchSyncIntegrity
      .mockResolvedValueOnce({ available: false, reason: 'peer-unreachable', records: [] })
      .mockResolvedValueOnce({ available: true, records: [{ id: 'r', name: 'R', status: 'in-parity' }] });

    const { result } = renderWithPeers('universe', [PEER_A, PEER_B]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.integrityUnavailable).toBe(false);
  });

  it('integrityUnavailable=false when there are no eligible peers (that is noSyncingPeers)', async () => {
    const { result } = renderWithPeers('universe', []);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.noSyncingPeers).toBe(true);
    expect(result.current.integrityUnavailable).toBe(false);
  });
});

describe('useSyncIntegrity — individual peer fetch errors', () => {
  it('treats a thrown error from fetchSyncIntegrity as unavailable (graceful)', async () => {
    fetchSyncIntegrity
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        available: true,
        records: [{ id: 'rec-5', name: 'R', status: 'in-parity' }],
      });

    const { result } = renderWithPeers('universe', [PEER_A, PEER_B]);
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Error peer is skipped; good peer's records still surface.
    expect(result.current.statusById.get('rec-5')).toBe('in-parity');
    expect(result.current.error).toBeNull();
  });
});

describe('syncBadgeStatus — badge precedence helper', () => {
  const make = (over = {}) => ({
    noSyncingPeers: false,
    integrityUnavailable: false,
    statusById: new Map(),
    ...over,
  });

  it('returns not-syncing when no peers sync this category (highest precedence)', () => {
    const sync = make({ noSyncingPeers: true, integrityUnavailable: true, statusById: new Map([['r', 'diverged']]) });
    expect(syncBadgeStatus(sync, 'r')).toBe('not-syncing');
  });

  it('returns the per-record status when known', () => {
    expect(syncBadgeStatus(make({ statusById: new Map([['r', 'diverged']]) }), 'r')).toBe('diverged');
  });

  it('returns unknown when integrity was unavailable and the record has no status', () => {
    expect(syncBadgeStatus(make({ integrityUnavailable: true }), 'r')).toBe('unknown');
  });

  it('returns undefined when the record is simply not seen by any peer', () => {
    expect(syncBadgeStatus(make(), 'r')).toBeUndefined();
  });
});
