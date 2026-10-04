import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SystemHealthWidget from './SystemHealthWidget.jsx';
import { dismissHealthWarning } from '../services/apiSystem.js';
import toast from './ui/Toast';

vi.mock('../services/apiSystem.js', () => ({
  dismissHealthWarning: vi.fn().mockResolvedValue({ message: 'x', dismissedAt: '2026-01-01T00:00:00.000Z' }),
  undismissHealthWarning: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('./ui/Toast', () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() });
  return { default: toast };
});

const HEALTH = {
  overallHealth: 'warning',
  warnings: [{ type: 'disk', severity: 'warning', message: 'Disk usage at or above 90%' }],
  thresholds: { memoryWarn: 85, memoryCritical: 95, diskWarn: 90, diskCritical: 98 },
  system: {
    uptimeFormatted: '3h 12m',
    memory: { usagePercent: 40, usedFormatted: '12 GB', totalFormatted: '32 GB' },
    cpu: { usagePercent: 20, cores: 8 },
    disk: { usagePercent: 60, usedFormatted: '600 GB', totalFormatted: '1 TB' },
  },
  processes: { online: 3, total: 3, errored: 0, stopped: 0 },
  apps: { online: 2, total: 2, stopped: 0, notStarted: 0, unmanaged: 0 },
  cos: null,
};

const renderWidget = (dashboardState) => render(
  <MemoryRouter>
    <SystemHealthWidget dashboardState={dashboardState} />
  </MemoryRouter>
);

describe('SystemHealthWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes the displayed stats from the widget control', async () => {
    const user = userEvent.setup();
    let currentHealth = HEALTH;
    const refreshedHealth = {
      ...HEALTH,
      system: { ...HEALTH.system, memory: { ...HEALTH.system.memory, usagePercent: 55 } },
    };
    const refetchHealth = vi.fn(async () => {
      currentHealth = refreshedHealth;
      return currentHealth;
    });
    const { rerender } = renderWidget({ health: currentHealth, refetchHealth });

    expect(screen.getByText('40%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh system health' }));
    expect(refetchHealth).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <SystemHealthWidget dashboardState={{ health: currentHealth, refetchHealth }} />
      </MemoryRouter>
    );

    expect(screen.getByText('55%')).toBeInTheDocument();
  });

  it('links details to overview and disk usage directly to storage', () => {
    renderWidget({ health: HEALTH, refetchHealth: vi.fn() });
    expect(screen.getByRole('link', { name: 'Open disk usage report' })).toHaveAttribute('href', '/system-resources/storage');
    expect(screen.getByRole('link', { name: /Details/ })).toHaveAttribute('href', '/system-resources/overview');
  });

  it('hides unavailable app counts and restores the empty inventory after recovery', () => {
    const apps = { total: 0, online: 0, stopped: 0, notStarted: 0, unknown: 0, unmanaged: 0, degraded: true, status: 'unavailable' };
    const warnings = [{ type: 'probe-unavailable', source: 'apps', status: 'unavailable', severity: 'warning', message: 'Apps unavailable', dismissible: false }];
    const { rerender } = renderWidget({ health: { ...HEALTH, apps, warnings }, refetchHealth: vi.fn() });
    const card = screen.getByText('Services').parentElement.parentElement;
    expect(card).toHaveTextContent('Apps unavailable');
    expect(card).not.toHaveTextContent('No apps');
    expect(card).not.toHaveTextContent('0');
    expect(screen.queryByRole('button', { name: /Dismiss warning:/ })).not.toBeInTheDocument();

    rerender(<MemoryRouter><SystemHealthWidget dashboardState={{ health: {
      ...HEALTH, overallHealth: 'healthy', warnings: [], apps: { ...apps, degraded: false, status: undefined },
    } }} /></MemoryRouter>);
    expect(screen.getByText('No apps')).toBeInTheDocument();
    expect(screen.queryByText('Apps unavailable')).not.toBeInTheDocument();
  });

  it('keeps failed disk and CoS probes visible without offering dismissal', () => {
    const warnings = [
      { type: 'probe-unavailable', source: 'disk', status: 'unavailable', severity: 'warning', message: 'Disk status unavailable', dismissible: false },
      { type: 'probe-unavailable', source: 'cos', status: 'unavailable', severity: 'warning', message: 'Chief of Staff status unavailable', dismissible: false },
    ];
    renderWidget({ health: { ...HEALTH, warnings, system: { ...HEALTH.system, disk: null }, cos: null }, refetchHealth: vi.fn() });

    expect(screen.getByLabelText('Disk status unavailable')).toHaveTextContent('Unavailable');
    expect(screen.getByText('Chief of Staff').parentElement).toHaveTextContent('Unavailable');
    expect(screen.queryByRole('button', { name: /Dismiss warning:/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument();
  });

  it('shows unavailable queue and agent telemetry without marking the daemon stopped', () => {
    const warnings = [
      { type: 'probe-unavailable', source: 'cos-queue', status: 'unavailable', severity: 'warning', message: 'Chief of Staff queue unavailable', dismissible: false },
      { type: 'probe-unavailable', source: 'cos-agents', status: 'unavailable', severity: 'warning', message: 'Chief of Staff agent census unavailable', dismissible: false },
    ];
    renderWidget({ health: { ...HEALTH, warnings, cos: { running: true, paused: false, activeAgents: 0, queuedTasks: null } }, refetchHealth: vi.fn() });

    expect(screen.getByText('Chief of Staff').parentElement).toHaveTextContent('Active');
    expect(screen.getByText('Queue unavailable')).toBeInTheDocument();
    expect(screen.getByText('Agents unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument();
  });

  it('shows only the queue as unavailable when agents are readable, and clears on recovery', () => {
    const warnings = [{ type: 'probe-unavailable', source: 'cos-queue', status: 'unavailable', severity: 'warning', message: 'Chief of Staff queue unavailable', dismissible: false }];
    const { rerender } = renderWidget({ health: { ...HEALTH, warnings, cos: { running: true, paused: true, activeAgents: 2, queuedTasks: null } }, refetchHealth: vi.fn() });

    expect(screen.getByText('Queue unavailable')).toBeInTheDocument();
    expect(screen.getByText('2 agents')).toBeInTheDocument();
    expect(screen.queryByText('Agents unavailable')).not.toBeInTheDocument();

    rerender(<MemoryRouter><SystemHealthWidget dashboardState={{ health: { ...HEALTH, warnings: [], cos: { running: true, paused: true, activeAgents: 2, queuedTasks: 3 } } }} /></MemoryRouter>);
    expect(screen.queryByText('Queue unavailable')).not.toBeInTheDocument();
    expect(screen.getByText('3 queued')).toBeInTheDocument();
  });

  it('keeps memory neutral while honoring configured disk thresholds', () => {
    const health = {
      ...HEALTH,
      system: {
        ...HEALTH.system,
        memory: { ...HEALTH.system.memory, usagePercent: 80 },
        disk: { ...HEALTH.system.disk, usagePercent: 91 },
      },
      thresholds: { memoryWarn: 70, memoryCritical: 90, diskWarn: 95, diskCritical: 99 },
    };
    renderWidget({ health, refetchHealth: vi.fn() });

    expect(screen.getByText('80%')).toHaveClass('text-port-accent');
    expect(screen.getByText('91%')).toHaveClass('text-port-success');
  });

  it('uses the server defaults when threshold data is absent', () => {
    const health = {
      ...HEALTH,
      system: { ...HEALTH.system, memory: { ...HEALTH.system.memory, usagePercent: 80 } },
      thresholds: undefined,
    };
    renderWidget({ health, refetchHealth: vi.fn() });

    expect(screen.getByText('80%')).toHaveClass('text-port-accent');
  });

  it('does not offer dismissal for an unavailable health-settings warning', () => {
    const message = 'System health settings are unavailable; default thresholds are being used and saved warning dismissals were ignored.';
    renderWidget({
      health: {
        ...HEALTH,
        thresholds: undefined,
        warnings: [{ type: 'health-settings', severity: 'warning', message, dismissible: false }],
      },
      refetchHealth: vi.fn(),
    });

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Dismiss warning: ${message}` })).not.toBeInTheDocument();
  });

  it('dismisses a warning as resolved and refetches health', async () => {
    const user = userEvent.setup();
    const refetchHealth = vi.fn().mockResolvedValue(undefined);
    renderWidget({ health: HEALTH, refetchHealth });

    await user.click(screen.getByRole('button', { name: /Dismiss warning: Disk usage at or above 90%/ }));

    expect(dismissHealthWarning).toHaveBeenCalledWith('disk', 'Disk usage at or above 90%', { silent: true });
    expect(refetchHealth).toHaveBeenCalledTimes(1);
  });

  it('toasts an error and does not refetch when dismissing fails', async () => {
    const user = userEvent.setup();
    dismissHealthWarning.mockRejectedValueOnce(new Error('offline'));
    const refetchHealth = vi.fn();
    renderWidget({ health: HEALTH, refetchHealth });

    await user.click(screen.getByRole('button', { name: /Dismiss warning: Disk usage at or above 90%/ }));

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('offline'));
    expect(refetchHealth).not.toHaveBeenCalled();
  });
});


it('distinguishes root and data capacity and never hides unavailable data behind root', () => {
  const health = { ...HEALTH, system: { ...HEALTH.system, dataDisk: { usagePercent: 99, usedFormatted: '99 GB', totalFormatted: '100 GB' } } };
  const { rerender } = renderWidget({ health });
  expect(screen.getByText('Root disk')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open runtime data disk usage report' })).toHaveTextContent('99%');
  rerender(<MemoryRouter><SystemHealthWidget dashboardState={{ health: { ...health, system: { ...health.system, dataDisk: null } } }} /></MemoryRouter>);
  expect(screen.getByLabelText('Runtime data disk status unavailable')).toHaveTextContent('Unavailable');
  expect(screen.getByRole('link', { name: 'Open disk usage report' })).toHaveTextContent('60%');
});
