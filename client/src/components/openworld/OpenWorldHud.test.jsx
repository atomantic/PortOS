import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../hooks/useOpenWorldViewport', () => ({
  default: () => ({ isDesktop: true }),
}));
vi.mock('./OpenWorldIntelPane', () => ({ default: () => null }));
vi.mock('./OpenWorldFocusPanel', () => ({ default: () => null }));
vi.mock('./OpenWorldAgentBar', () => ({ default: () => null }));
vi.mock('./OpenWorldXpBadge', () => ({ default: () => null }));
vi.mock('./OpenWorldMiniMap', () => ({ default: () => null }));

import OpenWorldHud from './OpenWorldHud';

const renderHud = (overrides = {}) => render(
  <MemoryRouter initialEntries={['/openworld']}>
    <OpenWorldHud
      cosStatus={{ running: false }}
      cosAgents={[]}
      agentMap={new Map()}
      eventLogs={[]}
      connected
      apps={[{ id: 'app-1', name: 'Example App', overallStatus: 'online' }]}
      reviewCounts={{ total: 0, alert: 0 }}
      instances={{ peers: [] }}
      productivityData={null}
      systemHealth={{
        overallHealth: 'warning',
        system: {
          cpu: { usagePercent: 42 },
          memory: { usagePercent: 76 },
          disk: { usagePercent: 91 },
        },
      }}
      notificationCounts={{ unread: 0 }}
      character={null}
      filter={null}
      explorationMode={false}
      {...overrides}
    />
  </MemoryRouter>,
);

describe('OpenWorldHud', () => {
  it('keeps CPU, memory, and disk pressure visible in the desktop cockpit', () => {
    renderHud();

    const metrics = screen.getByLabelText('System resource usage');
    expect(within(metrics).getByText('CPU')).toBeInTheDocument();
    expect(within(metrics).getByText('42%')).toBeInTheDocument();
    expect(within(metrics).getByText('MEM')).toBeInTheDocument();
    expect(within(metrics).getByText('76%')).toBeInTheDocument();
    expect(within(metrics).getByText('DISK')).toBeInTheDocument();
    expect(within(metrics).getByText('91%')).toBeInTheDocument();
  });

  it('gives exploration a quiet village hierarchy instead of dashboard telemetry', () => {
    renderHud({
      explorationMode: true,
      activeRegion: { id: 'memory', label: 'Memory Wilds' },
      collectedCount: 3,
      totalShards: 17,
    });

    expect(screen.queryByLabelText('System resource usage')).not.toBeInTheDocument();
    expect(screen.getAllByText('Memory Wilds').length).toBeGreaterThan(0);
    expect(screen.getByText('PORTOS VILLAGE')).toBeInTheDocument();
    expect(screen.getByText('WELCOME TO THE VILLAGE')).toBeInTheDocument();
    expect(screen.getAllByText(/3\/17/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Take the long way/i)).toBeInTheDocument();
  });
});
