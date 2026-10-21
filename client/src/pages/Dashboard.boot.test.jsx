import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});

vi.mock('../services/api', () => ({
  getDashboardLayouts: vi.fn(),
  setActiveDashboardLayout: vi.fn(() => Promise.resolve({})),
  getApps: vi.fn(() => Promise.resolve([])),
  getSystemHealth: vi.fn(() => Promise.resolve({ ok: true })),
  getTribeCareSummary: vi.fn(() => Promise.resolve({ hasPeople: true })),
  getFeedStats: vi.fn(() => Promise.resolve(null)),
  getMeatspaceLoggingStats: vi.fn(() => Promise.resolve(null)),
  getCalendarAgenda: vi.fn(() => Promise.resolve(null)),
  getBrainOnThisDay: vi.fn(() => Promise.resolve(null)),
  getDailyDriverState: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../hooks/useInstanceFeatures.js', () => ({ useInstanceFeatures: () => ({ features: [] }) }));
vi.mock('../components/onboarding/FirstRunCard.jsx', () => ({ default: () => null }));
vi.mock('../components/SystemHealthWidget', () => ({ default: () => <div>Health body</div> }));
vi.mock('../components/QuickBrainCapture', () => ({ default: () => <div>Quick capture body</div> }));
vi.mock('../components/TribeCareWidget', () => ({
  default: ({ dashboardState }) => <div>Tribe body {dashboardState?.tribeCare ? 'loaded' : 'pending'}</div>,
}));

import * as api from '../services/api';
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
});
