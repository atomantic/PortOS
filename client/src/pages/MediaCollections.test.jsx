import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Mock API calls ───────────────────────────────────────────────────────────
vi.mock('../services/api', () => ({
  listMediaCollections: vi.fn().mockResolvedValue([
    { id: 'col-1', name: 'Alpha', items: [{ kind: 'image', ref: 'img1.png', addedAt: '2024-01-01' }] },
    { id: 'col-2', name: 'Beta', items: [] },
  ]),
  createMediaCollection: vi.fn(),
  deleteMediaCollection: vi.fn(),
  listVideoHistory: vi.fn().mockResolvedValue([]),
  listImageGallery: vi.fn().mockResolvedValue([]),
}));

// ── Mock useSyncIntegrity ────────────────────────────────────────────────────
const statusById = new Map([['col-1', 'in-parity'], ['col-2', 'diverged']]);
vi.mock('../hooks/useSyncIntegrity', () => ({
  useSyncIntegrity: () => ({
    statusById,
    noSyncingPeers: false,
    integrityUnavailable: false,
    loading: false,
    error: null,
    refresh: vi.fn(),
    byPeer: new Map(),
  }),
  // Mirror the real precedence helper so badge-status assertions stay valid.
  syncBadgeStatus: (sync, recordId) => (
    sync.noSyncingPeers
      ? 'not-syncing'
      : (sync.statusById.get(recordId) ?? (sync.integrityUnavailable ? 'unknown' : undefined))
  ),
}));

// ── Mock buildUnsortedCollection ─────────────────────────────────────────────
vi.mock('../lib/unsorted', () => ({
  buildUnsortedCollection: () => ({
    id: '__unsorted__',
    name: 'Unsorted',
    items: [],
    synthetic: true,
  }),
}));

import MediaCollections from './MediaCollections';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/media/collections']}>
      <MediaCollections />
    </MemoryRouter>,
  );
}

describe('MediaCollections', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders collection names after loading', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  it('renders a SyncBadge per non-synthetic collection row', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    // 'in-parity' badge on col-1, 'diverged' on col-2
    expect(screen.getByText('In sync')).toBeInTheDocument();
    expect(screen.getByText('Diverged')).toBeInTheDocument();
  });

  it('does not render a SyncBadge for the synthetic Unsorted collection', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    // Unsorted is synthetic — only 2 badges for the 2 real collections
    const badges = screen.getAllByRole('button', { name: /in sync|diverged|assets missing|local only|on peer only|not syncing/i });
    // Should be exactly 2 (one per real collection)
    expect(badges.length).toBe(2);
  });
});
