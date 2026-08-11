import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

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
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), custom: vi.fn() }
}));

import * as api from '../services/api';
import SystemHealthPage from './SystemHealthPage';

const renderPage = () => render(
  <MemoryRouter>
    <SystemHealthPage />
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
    expect(within(banner).getByRole('link', { name: /Disk usage breakdown/ })).toHaveAttribute('href', '/data');
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
});
