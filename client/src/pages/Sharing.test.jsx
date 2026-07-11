import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

// Sharing.jsx pulls in socket.io-client at module scope (auto-connects).
// Stub it so the test runner doesn't try to open a network socket.
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../services/api', () => ({
  listShareBuckets: vi.fn(),
  createShareBucket: vi.fn(),
  updateShareBucket: vi.fn(),
  deleteShareBucket: vi.fn(),
  listShareInbox: vi.fn(),
  promoteShareInboxItem: vi.fn(),
  dismissShareInboxItem: vi.fn(),
  listShareActivity: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import Sharing, { isLiveSubscription } from './Sharing';
import * as api from '../services/api';

const NOW = Date.parse('2026-05-18T12:00:00Z');

describe('isLiveSubscription', () => {
  it('returns true for a subscription row received within the live window', () => {
    const item = {
      subscription: { recordKind: 'universe', recordId: 'u-1' },
      receivedAt: '2026-05-18T11:57:00Z', // 3 min ago
    };
    expect(isLiveSubscription(item, NOW)).toBe(true);
  });

  it('returns false for a subscription row received outside the live window', () => {
    const item = {
      subscription: { recordKind: 'universe', recordId: 'u-1' },
      receivedAt: '2026-05-18T11:50:00Z', // 10 min ago
    };
    expect(isLiveSubscription(item, NOW)).toBe(false);
  });

  it('returns false for a one-shot share (no subscription field) even if recent', () => {
    const item = { subscription: null, receivedAt: '2026-05-18T11:59:30Z' };
    expect(isLiveSubscription(item, NOW)).toBe(false);
  });

  it('returns false when receivedAt is missing or unparseable', () => {
    const subscription = { recordKind: 'universe', recordId: 'u-1' };
    expect(isLiveSubscription({ subscription }, NOW)).toBe(false);
    expect(isLiveSubscription({ subscription, receivedAt: '' }, NOW)).toBe(false);
    expect(isLiveSubscription({ subscription, receivedAt: 'not-a-date' }, NOW)).toBe(false);
  });

  it('returns false for null / non-object inputs without throwing', () => {
    expect(isLiveSubscription(null, NOW)).toBe(false);
    expect(isLiveSubscription(undefined, NOW)).toBe(false);
  });
});

// The per-bucket detail sub-tab (Inbox | Activity | Settings) is derived from the
// `?tab=` URL search param — not component-local state — so it's deep-linkable
// and stays in sync with browser back/forward.
describe('Sharing bucket detail tab (URL-derived)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listShareBuckets.mockResolvedValue({
      buckets: [{ id: 'b1', name: 'Bucket One', path: '/tmp/b1', mode: 'inbox' }],
      localSchemaVersion: 1,
    });
    api.getSettings.mockResolvedValue({});
    api.listShareInbox.mockResolvedValue({ items: [] });
    api.listShareActivity.mockResolvedValue({ manifests: [] });
  });

  // Routes mirror App.jsx so `useParams()` resolves section + bucketId.
  const routes = [
    { path: '/sharing', element: <Sharing /> },
    { path: '/sharing/:section', element: <Sharing /> },
    { path: '/sharing/:section/:bucketId', element: <Sharing /> },
  ];
  const renderAt = (entries, initialIndex = entries.length - 1) => {
    const router = createMemoryRouter(routes, { initialEntries: entries, initialIndex });
    render(<RouterProvider router={router} />);
    return router;
  };

  it('renders the tab named by the URL param on a direct link', async () => {
    renderAt(['/sharing/buckets/b1?tab=activity']);
    await waitFor(() => expect(screen.getByText('Bucket One')).toBeInTheDocument());
    // Activity tab content — not the Inbox empty-state.
    expect(screen.getByText('No share activity yet.')).toBeInTheDocument();
    expect(screen.queryByText('No pending imports.')).not.toBeInTheDocument();
  });

  it('falls back to the Inbox tab for a stale/invalid param', async () => {
    renderAt(['/sharing/buckets/b1?tab=bogus']);
    await waitFor(() => expect(screen.getByText('Bucket One')).toBeInTheDocument());
    expect(screen.getByText('No pending imports.')).toBeInTheDocument();
    expect(screen.queryByText('No share activity yet.')).not.toBeInTheDocument();
  });

  it('follows browser back/forward between tabs', async () => {
    const router = renderAt([
      '/sharing/buckets/b1?tab=inbox',
      '/sharing/buckets/b1?tab=settings',
    ], 1);
    // Start on Settings (last history entry).
    await waitFor(() => expect(screen.getByText('Import mode')).toBeInTheDocument());

    // Back → Inbox tab.
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(screen.getByText('No pending imports.')).toBeInTheDocument());
    expect(screen.queryByText('Import mode')).not.toBeInTheDocument();

    // Forward → Settings tab again.
    await act(async () => { await router.navigate(1); });
    await waitFor(() => expect(screen.getByText('Import mode')).toBeInTheDocument());
  });
});
