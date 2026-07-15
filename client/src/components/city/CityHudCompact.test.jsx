import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CityHudCompact from './CityHudCompact';

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.search}</div>;
}

const baseVitals = {
  uptimeSeconds: 0,
  sentinel: { dot: 'bg-cyan-400', text: 'text-cyan-400', label: 'OK' },
  cpuPct: 10,
  memPct: 20,
  diskPct: 30,
  warnings: [],
  activeAgentCount: 0,
  stoppedApps: 0,
  archivedApps: 0,
  pendingReview: 0,
  alertCount: 0,
  onlinePeers: 0,
  totalNodes: 0,
  notificationCounts: { unread: 0 },
  productivityData: {},
  activeApps: 1,
  totalApps: 2,
};

const baseProps = {
  time: new Date('2026-07-14T12:00:00'),
  vitals: baseVitals,
  connected: true,
  cosStatus: { running: false },
  character: { level: 5 },
  filter: { status: 'all', search: '' },
  onFilterChange: () => {},
  onJumpToFirst: () => {},
  matchCount: 0,
  apps: [{ id: 'a1', name: 'App One', overallStatus: 'online' }],
  cosAgents: [],
  reviewCounts: { total: 0, alert: 0 },
  instances: { peers: [] },
  systemHealth: {},
  notificationCounts: { unread: 0 },
  eventLogs: [],
  onToggleExploration: () => {},
  explorationMode: false,
  onSelectApp: () => {},
  onEnterPhotoMode: () => {},
  onEnterPlayback: () => {},
};

const renderCompact = (search = '', props = {}) =>
  render(
    <MemoryRouter initialEntries={[`/city${search}`]}>
      <CityHudCompact {...baseProps} {...props} />
      <Loc />
    </MemoryRouter>,
  );

describe('CityHudCompact', () => {
  it('shows no secondary surface by default (scene stays unobscured)', () => {
    renderCompact();
    // Dock controls present…
    expect(screen.getByLabelText('System vitals')).toBeInTheDocument();
    expect(screen.getByLabelText('Attention')).toBeInTheDocument();
    // …but no disclosure sheet is open.
    expect(screen.queryByText('SYSTEM VITALS')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close panel' })).not.toBeInTheDocument();
  });

  it('opens a pane from the dock and reflects it in the URL', () => {
    renderCompact();
    fireEvent.click(screen.getByLabelText('Attention'));
    expect(screen.getByTestId('loc').textContent).toContain('cityPane=attention');
    // The sheet header for the opened pane appears.
    expect(screen.getByText('ATTENTION')).toBeInTheDocument();
  });

  it('restores the open pane from the URL on load', () => {
    renderCompact('?cityPane=vitals');
    expect(screen.getByText('SYSTEM VITALS')).toBeInTheDocument();
  });

  it('keeps only one surface open at a time (mutual exclusivity)', () => {
    renderCompact('?cityPane=vitals');
    expect(screen.getByText('SYSTEM VITALS')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Attention'));
    // Switching panes closes the previous one.
    expect(screen.queryByText('SYSTEM VITALS')).not.toBeInTheDocument();
    expect(screen.getByText('ATTENTION')).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toContain('cityPane=attention');
  });

  it('toggling the active dock launcher closes the pane', () => {
    renderCompact('?cityPane=vitals');
    fireEvent.click(screen.getByLabelText('System vitals'));
    expect(screen.queryByText('SYSTEM VITALS')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('');
  });

  it('the close button clears the surface and the URL param', () => {
    renderCompact('?cityPane=attention');
    expect(screen.getByText('ATTENTION')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByText('ATTENTION')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('');
  });
});
