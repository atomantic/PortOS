import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const HEALTH = {
  overallHealth: 'warning',
  warnings: [],
  thresholds: { memoryWarn: 85, memoryCritical: 95, diskWarn: 90, diskCritical: 98 },
  system: {
    uptimeFormatted: '3h 12m',
    memory: { usagePercent: 40, usedFormatted: '12 GB', totalFormatted: '32 GB' },
    cpu: { usagePercent: 20, cores: 8, loadAvg1m: 1.2 },
    disk: { usagePercent: 92, usedFormatted: '900 GB', totalFormatted: '1 TB' },
  },
  topProcesses: [],
};

const withWarnings = warnings => ({ ...HEALTH, warnings });

vi.mock('../services/api', () => ({
  getSystemHealth: vi.fn(),
  updateHealthThresholds: vi.fn(() => Promise.resolve({})),
  runSystemResourceReport: vi.fn(),
  triageSystemResources: vi.fn(),
  purgeDataCategory: vi.fn(),
  deleteCachedModel: vi.fn(),
  deleteLora: vi.fn(),
  deleteLocalLlmModel: vi.fn(),
}));

vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [],
    selectedProviderId: '',
    selectedModel: '',
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), custom: vi.fn() }
}));

import * as api from '../services/api';
import SystemHealthPage from './SystemHealthPage';

const renderPage = (path = '/system-resources/overview') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/system-resources/:tab" element={<SystemHealthPage />} />
    </Routes>
  </MemoryRouter>
);

describe('SystemHealthPage remediation links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links a disk alert to the disk usage breakdown', async () => {
    api.getSystemHealth.mockResolvedValue(withWarnings([
      { type: 'disk', message: 'Disk usage at or above 90%' },
    ]));
    renderPage();

    const banner = (await screen.findByText('Disk usage at or above 90%')).parentElement;
    // The alert itself carries the link, not just the drill-in nav below it.
    expect(within(banner).getByRole('link', { name: /Disk usage breakdown/ })).toHaveAttribute('href', '/system-resources/storage');
  });

  it('links memory, process and app alerts to their own remediation page', async () => {
    api.getSystemHealth.mockResolvedValue(withWarnings([
      { type: 'memory', message: 'Memory usage at or above 85%' },
      { type: 'apps', message: 'App status unavailable for 2 app(s) — PM2 read failed' },
      { type: 'database', message: 'PostgreSQL disconnected' },
    ]));
    renderPage();

    await screen.findByText('Memory usage at or above 85%');
    expect(screen.getByRole('link', { name: /Database settings/ })).toHaveAttribute('href', '/settings/database');
    expect(screen.getAllByRole('link', { name: /All processes/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /^Apps/ }).length).toBeGreaterThan(0);
  });

  it('leaves an alert with no in-app remedy as a plain statement', async () => {
    api.getSystemHealth.mockResolvedValue(withWarnings([
      { type: 'forge', message: 'GitHub CLI unusable (unauthenticated)' },
    ]));
    renderPage();

    const banner = (await screen.findByText('GitHub CLI unusable (unauthenticated)')).closest('div');
    expect(within(banner).queryByRole('link')).toBeNull();
    // The drill-in nav is unaffected — it always offers its three destinations.
    const nav = screen.getByRole('navigation', { name: 'System drill-downs' });
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
  });

  it('renders the drill-in links above the metric cards', async () => {
    api.getSystemHealth.mockResolvedValue(withWarnings([]));
    renderPage();

    const nav = await screen.findByRole('navigation', { name: 'System drill-downs' });
    const cards = screen.getByText('Memory').closest('section');
    expect(nav.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('refreshes the displayed stats from the page control', async () => {
    const user = userEvent.setup();
    api.getSystemHealth
      .mockResolvedValueOnce(HEALTH)
      .mockResolvedValueOnce({
        ...HEALTH,
        system: { ...HEALTH.system, memory: { ...HEALTH.system.memory, usagePercent: 55 } },
      });
    renderPage();

    await screen.findByText('40%');
    await user.click(screen.getByRole('button', { name: 'Refresh system health' }));

    await waitFor(() => expect(screen.getByText('55%')).toBeInTheDocument());
    expect(api.getSystemHealth).toHaveBeenCalledTimes(2);
  });

  it('keeps the active section in the URL and runs storage scans explicitly', async () => {
    api.runSystemResourceReport.mockResolvedValue({
      generatedAt: '2026-08-16T00:00:00.000Z',
      filesystem: { totalBytes: 1000, usedBytes: 750, freeBytes: 250, usagePercent: 75 },
      summary: { managedReclaimableBytes: 100 },
      storageAreas: [{
        id: 'cache', label: 'Cache', kind: 'cache', sizeBytes: 100,
        status: 'ready', managePath: null, protected: false, note: 'Reproducible data.',
      }],
      cleanupCandidates: [],
      sourceErrors: [],
      models: { downloaded: [], loaded: [], totals: { all: 0 } },
      queues: { media: { queued: 0, running: 0 }, agents: null },
    });
    renderPage('/system-resources/storage');

    expect(screen.getByRole('link', { name: /Storage/ })).toHaveAttribute('href', '/system-resources/storage');
    expect(api.runSystemResourceReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run system report' }));
    await waitFor(() => expect(api.runSystemResourceReport).toHaveBeenCalledWith({ silent: true }));
    expect(await screen.findByText('Known storage areas')).toBeInTheDocument();
  });

  it('locks every cleanup action and invalidates stale rows until reconciliation finishes', async () => {
    let finishRemoval;
    let finishRescan;
    const removal = new Promise((resolve) => { finishRemoval = resolve; });
    const rescan = new Promise((resolve) => { finishRescan = resolve; });
    const candidate = (key) => ({
      id: `data:${key}`,
      label: `Cache ${key.toUpperCase()}`,
      kind: 'data',
      estimatedBytes: 100,
      risk: 'low',
      reason: 'Reproducible cache.',
      loaded: false,
      busy: false,
      manualOnly: false,
      managePath: '/data',
      action: { type: 'data-category', key },
    });
    const firstReport = {
      generatedAt: '2026-08-16T00:00:00.000Z',
      filesystem: { totalBytes: 1000, usedBytes: 750, freeBytes: 250, usagePercent: 75 },
      summary: { managedReclaimableBytes: 200 },
      storageAreas: [],
      cleanupCandidates: [candidate('a'), candidate('b')],
      sourceErrors: [],
      models: { downloaded: [], loaded: [], totals: { all: 0 } },
      queues: { media: { queued: 0, running: 0 }, agents: null },
    };
    api.runSystemResourceReport
      .mockResolvedValueOnce(firstReport)
      .mockReturnValueOnce(rescan);
    api.purgeDataCategory.mockReturnValue(removal);
    renderPage('/system-resources/storage');

    fireEvent.click(screen.getByRole('button', { name: 'Run system report' }));
    expect(await screen.findByRole('button', { name: 'Remove Cache A' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cache A' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm removal of Cache A' })).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.purgeDataCategory).toHaveBeenCalledWith('a', {}, { silent: true }));
    expect(screen.getByRole('button', { name: 'Remove Cache B' })).toBeDisabled();

    await act(async () => { finishRemoval({ success: true }); });
    await waitFor(() => expect(screen.queryByText('Cache A')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Remove Cache B' })).not.toBeInTheDocument();

    await act(async () => { finishRescan({ ...firstReport, generatedAt: '2026-08-16T00:01:00.000Z', cleanupCandidates: [] }); });
  });
});
