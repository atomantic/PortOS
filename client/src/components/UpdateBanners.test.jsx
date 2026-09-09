import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// The regression this suite locks (#3786): the update / out-of-sync advisories
// must render as INLINE banners in document flow, not as `duration: Infinity`
// corner toasts that permanently occlude a bottom-anchored composer at 375px.

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
  },
}));

const getUpdateStatus = vi.fn();
const getActiveProcessing = vi.fn();
const ignoreUpdateVersion = vi.fn(() => Promise.resolve({}));
vi.mock('../services/api', () => ({
  getActiveProcessing: (...a) => getActiveProcessing(...a),
  PORTOS_APP_ID: 'portos-default',
  getUpdateStatus: (...a) => getUpdateStatus(...a),
  ignoreUpdateVersion: (...a) => ignoreUpdateVersion(...a),
}));

const navigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useNavigate: () => navigate };
});

// Toasts are the thing this component replaced — assert none are raised.
const toastFn = vi.fn();
vi.mock('./ui/Toast', () => ({ default: Object.assign((...a) => toastFn(...a), { dismiss: vi.fn() }) }));

import UpdateBanners from './UpdateBanners';
import { __internal } from '../hooks/useUpdateChecker';

const renderBanners = () => render(<MemoryRouter><UpdateBanners /></MemoryRouter>);

const flush = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  handlers.clear();
  navigate.mockClear();
  toastFn.mockClear();
  ignoreUpdateVersion.mockClear();
  getActiveProcessing.mockReset();
  getActiveProcessing.mockResolvedValue({ agents: { active: 0 }, jobs: [], extras: { imageTo3d: [] } });
  getUpdateStatus.mockReset();
  getUpdateStatus.mockResolvedValue({});
  localStorage.clear();
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('UpdateBanners', () => {
  it('renders nothing when the install is current', async () => {
    const { container } = renderBanners();
    await flush();
    expect(container).toBeEmptyDOMElement();
    expect(toastFn).not.toHaveBeenCalled();
  });

  it.each([
    ['agents', { agents: { active: 1 } }],
    ['media renders', { jobs: [{ id: 'render', status: 'running' }] }],
    ['queued media', { jobs: [{ id: 'render', status: 'queued' }] }],
    ['3D renders', { extras: { imageTo3d: [{ id: 'model' }] } }],
  ])('hides both advisories during %s and restores them when work drains', async (_label, busy) => {
    vi.useFakeTimers();
    getUpdateStatus.mockResolvedValue({
      installState: { outOfSync: true, currentCommit: 'abc123' },
      updateAvailable: true, currentVersion: '1.0.0', latestRelease: { version: '1.1.0' },
    });
    getActiveProcessing.mockResolvedValue(busy);
    renderBanners();
    await flush();
    expect(screen.queryByRole('status')).toBeNull();

    getActiveProcessing.mockResolvedValue({ agents: { active: 0 }, jobs: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();

    getActiveProcessing.mockResolvedValue(busy);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(localStorage.getItem(__internal.OUT_OF_SYNC_DISMISS_KEY)).toBeNull();
    expect(ignoreUpdateVersion).not.toHaveBeenCalled();
  });

  it('waits for the first activity snapshot before showing an advisory', async () => {
    getUpdateStatus.mockResolvedValue({ installState: { outOfSync: true, currentCommit: 'abc123' } });
    let resolveActivity;
    getActiveProcessing.mockReturnValue(new Promise(resolve => { resolveActivity = resolve; }));
    renderBanners();
    await flush();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { resolveActivity({ agents: { active: 0 }, jobs: [] }); });
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeTruthy();
  });

  it('renders the out-of-sync advisory inline (no toast)', async () => {
    getUpdateStatus.mockResolvedValue({
      installState: { outOfSync: true, currentCommit: 'abc123' }
    });
    renderBanners();
    await screen.findByText(/Install out of sync/);
    expect(toastFn).not.toHaveBeenCalled();
    // In document flow, not a fixed-position overlay.
    expect(document.querySelector('.fixed')).toBeNull();
  });

  it('gives banner actions a 44px touch target while preserving desktop density', async () => {
    getUpdateStatus.mockResolvedValue({
      installState: { outOfSync: true, currentCommit: 'abc123' },
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestRelease: { version: '1.1.0' },
    });
    renderBanners();
    await screen.findByRole('button', { name: 'Reconcile' });

    screen.getAllByRole('button').forEach((button) => {
      expect(button.className).toContain('min-h-[44px]');
      expect(button.className).toContain('lg:min-h-0');
    });
  });

  it('persists the out-of-sync dismissal per commit so it does not re-raise', async () => {
    getUpdateStatus.mockResolvedValue({
      installState: { outOfSync: true, currentCommit: 'abc123' }
    });
    renderBanners();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/Install out of sync/)).toBeNull());
    expect(localStorage.getItem(__internal.OUT_OF_SYNC_DISMISS_KEY)).toBe('abc123');

    cleanup();
    renderBanners();
    await flush();
    expect(screen.queryByText(/Install out of sync/)).toBeNull();
  });

  it('Reconcile navigates and clears the advisory for this session only', async () => {
    getUpdateStatus.mockResolvedValue({
      installState: { outOfSync: true, currentCommit: 'abc123' }
    });
    renderBanners();
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile' }));
    expect(navigate).toHaveBeenCalledWith('/apps/portos-default/update');
    // Cleared so it doesn't hover over the very page you reconcile from…
    await waitFor(() => expect(screen.queryByText(/Install out of sync/)).toBeNull());
    // …but NOT marked handled: the install is still out of sync until update.sh runs.
    expect(localStorage.getItem(__internal.OUT_OF_SYNC_DISMISS_KEY)).toBeNull();
    cleanup();
    renderBanners();
    expect(await screen.findByText(/Install out of sync/)).toBeTruthy();
  });

  it('does not re-raise an ignored version from a racing socket broadcast', async () => {
    getUpdateStatus.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestRelease: { version: '1.1.0' }
    });
    renderBanners();
    fireEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(screen.queryByText(/Update available/)).toBeNull());
    act(() => {
      handlers.get('portos:update:available')?.({ currentVersion: '1.0.0', latestVersion: '1.1.0' });
    });
    expect(screen.queryByText(/Update available/)).toBeNull();
  });

  it('re-raises out-of-sync after a later pull moves the commit', async () => {
    localStorage.setItem(__internal.OUT_OF_SYNC_DISMISS_KEY, 'abc123');
    getUpdateStatus.mockResolvedValue({
      installState: { outOfSync: true, currentCommit: 'def456' }
    });
    renderBanners();
    expect(await screen.findByText(/Install out of sync/)).toBeTruthy();
  });

  it('shows the update advisory and navigates to the update tab', async () => {
    getUpdateStatus.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestRelease: { version: '1.1.0' }
    });
    renderBanners();
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    expect(navigate).toHaveBeenCalledWith('/apps/portos-default/update');
    await waitFor(() => expect(screen.queryByText(/Update available/)).toBeNull());
  });

  it('Ignore records the version server-side exactly once', async () => {
    getUpdateStatus.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestRelease: { version: '1.1.0' }
    });
    renderBanners();
    fireEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    expect(ignoreUpdateVersion).toHaveBeenCalledTimes(1);
    expect(ignoreUpdateVersion).toHaveBeenCalledWith('1.1.0');
    await waitFor(() => expect(screen.queryByText(/Update available/)).toBeNull());
  });

  it('raises the update advisory from a live socket event', async () => {
    renderBanners();
    await flush();
    act(() => {
      handlers.get('portos:update:available')?.({ currentVersion: '1.0.0', latestVersion: '1.2.0' });
    });
    expect(await screen.findByText(/v1.2.0/)).toBeTruthy();
  });
});
