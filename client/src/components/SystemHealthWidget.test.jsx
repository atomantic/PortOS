import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SystemHealthWidget from './SystemHealthWidget.jsx';

const HEALTH = {
  overallHealth: 'healthy',
  warnings: [],
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
});
