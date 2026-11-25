import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});

// Dashboard imports each domain module directly, not the api barrel (#16813).
vi.mock('../services/apiDashboard.js', () => ({
  getDashboardLayouts: vi.fn(),
  setActiveDashboardLayout: vi.fn(() => Promise.resolve({})),
  getDailyDriverState: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../services/apiApps.js', () => ({ getApps: vi.fn(() => Promise.resolve([])) }));
vi.mock('../services/apiSystem.js', () => ({ getSystemHealth: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock('../services/apiTribe.js', () => ({
  getTribeCareSummary: vi.fn(() => Promise.resolve({ hasPeople: true })),
}));
vi.mock('../services/apiMessages.js', () => ({ getFeedStats: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../services/apiMeatspace.js', () => ({
  getMeatspaceLoggingStats: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../services/apiCalendar.js', () => ({ getCalendarAgenda: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../services/apiBrain.js', () => ({ getBrainOnThisDay: vi.fn(() => Promise.resolve(null)) }));

vi.mock('../hooks/useInstanceFeatures.js', () => ({ useInstanceFeatures: () => ({ features: [] }) }));
vi.mock('../components/onboarding/FirstRunCard.jsx', () => ({ default: () => null }));
vi.mock('../components/SystemHealthWidget', () => ({ default: () => <div>Health body</div> }));
vi.mock('../components/QuickBrainCapture', () => ({ default: () => <div>Quick capture body</div> }));
vi.mock('../components/TribeCareWidget', () => ({
  default: ({ dashboardState }) => <div>Tribe body {dashboardState?.tribeCare ? 'loaded' : 'pending'}</div>,
}));

import * as apiApps from '../services/apiApps.js';
import * as apiDashboard from '../services/apiDashboard.js';
import * as apiSystem from '../services/apiSystem.js';
import * as apiTribe from '../services/apiTribe.js';
import * as apiMessages from '../services/apiMessages.js';
import * as apiMeatspace from '../services/apiMeatspace.js';
import * as apiCalendar from '../services/apiCalendar.js';
import * as apiBrain from '../services/apiBrain.js';

// The page's own calls, merged so the assertions below read as they did against the barrel.
const api = { ...apiApps, ...apiDashboard, ...apiSystem, ...apiTribe, ...apiMessages, ...apiMeatspace, ...apiCalendar, ...apiBrain };
import Dashboard from './Dashboard';
import { LAYOUT_CACHE_KEY } from '../components/dashboard/dashboardBoot.js';

const LAYOUT = { id: 'mine', name: 'Mine', widgets: ['quick-brain', 'tribe-care', 'system-health'], grid: [] };
const renderPage = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);

describe('Dashboard first paint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('paints a cached layout and fetches only its streams before the layouts read returns', async () => {
    localStorage.setItem(LAYOUT_CACHE_KEY, JSON.stringify({ layouts: [LAYOUT], activeLayoutId: 'mine' }));
    api.getDashboardLayouts.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(await screen.findByText('Quick capture body')).toBeInTheDocument();
    expect(await screen.findByText('Tribe body loaded')).toBeInTheDocument();
    expect(api.getTribeCareSummary).toHaveBeenCalledTimes(1);
    expect(api.getApps).not.toHaveBeenCalled();
    expect(api.getFeedStats).not.toHaveBeenCalled();
    // Layout edits wait for the server's copy.
    expect(screen.queryByTitle('Reorder, move and resize widgets')).not.toBeInTheDocument();
  });

  it('holds data reads until the first layouts read lands, then caches it', async () => {
    let resolveLayouts;
    api.getDashboardLayouts.mockReturnValue(new Promise((resolve) => { resolveLayouts = resolve; }));

    renderPage();
    await act(async () => {});
    expect(api.getSystemHealth).not.toHaveBeenCalled();
    expect(api.getTribeCareSummary).not.toHaveBeenCalled();

    await act(async () => resolveLayouts({ layouts: [LAYOUT], activeLayoutId: 'mine' }));

    expect(await screen.findByText('Quick capture body')).toBeInTheDocument();
    await waitFor(() => expect(api.getTribeCareSummary).toHaveBeenCalledTimes(1));
    expect(api.getSystemHealth).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(LAYOUT_CACHE_KEY))).toEqual({ layouts: [LAYOUT], activeLayoutId: 'mine' });
    expect(screen.getByTitle('Reorder, move and resize widgets')).toBeInTheDocument();
  });

  describe('apps read states', () => {
    const APPS_LAYOUT = { id: 'mine', name: 'Mine', widgets: ['apps', 'quick-stats'], grid: [] };
    const app = { id: 'a1', name: 'Alpha', overallStatus: 'online', archived: false };
    beforeEach(() => {
      api.getDashboardLayouts.mockResolvedValue({ layouts: [APPS_LAYOUT], activeLayoutId: 'mine' });
    });

    it('offers Retry on a failed first read, never the empty CTA or zero counts, and recovers on retry', async () => {
      api.getApps.mockRejectedValueOnce(new Error('503 down')).mockResolvedValueOnce([app]);
      renderPage();

      const retries = await screen.findAllByRole('button', { name: 'Retry' });
      expect(retries.length).toBe(2);
      expect(screen.queryByText('No apps registered')).not.toBeInTheDocument();
      expect(screen.queryByText('Add App')).not.toBeInTheDocument();
      expect(screen.queryByText('Total Apps')).not.toBeInTheDocument();
      expect(screen.getAllByText('503 down')).toHaveLength(2);

      const callsBefore = api.getSystemHealth.mock.calls.length;
      await act(async () => retries[0].click());
      expect(await screen.findByText('Alpha')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(api.getApps).toHaveBeenCalledTimes(2);
      expect(api.getSystemHealth).toHaveBeenCalledTimes(callsBefore);
    });

    it('renders app tiles and counts from the base apps request, without the quality audit', async () => {
      api.getApps.mockResolvedValue([app]);
      renderPage();
      expect(await screen.findByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Total Apps')).toBeInTheDocument();
      expect(api.getApps).toHaveBeenCalledWith();
    });

    it('still shows the first-app action for a genuinely empty result', async () => {
      api.getApps.mockResolvedValue([]);
      renderPage();
      expect(await screen.findByText('No apps registered')).toBeInTheDocument();
      expect(screen.getByText('Add App')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });

    it('keeps loaded apps and offers one Retry when a later refresh fails', async () => {
      const { default: socket } = await import('../services/socket');
      api.getApps.mockResolvedValueOnce([app]).mockRejectedValueOnce(new Error('refresh failed'));
      renderPage();
      expect(await screen.findByText('Alpha')).toBeInTheDocument();

      await act(async () => { socket.emit('apps:changed'); });
      expect(await screen.findByText('refresh failed')).toBeInTheDocument();
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Total Apps')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    });
  });
});
