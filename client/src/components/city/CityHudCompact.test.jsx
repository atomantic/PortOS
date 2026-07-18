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

  describe('birth-date level CTA (#2757)', () => {
    it('shows a SET prompt (LV —) for a genuinely unset birth date', () => {
      renderCompact('', { character: { level: null, birthDateStatus: 'unset' } });
      expect(screen.getByRole('button', { name: /set your birth date/i })).toBeInTheDocument();
      expect(screen.getByText('LV —')).toBeInTheDocument();
    });

    it('shows a FIX prompt (LV !) for a present-but-invalid birth date', () => {
      renderCompact('', { character: { level: null, birthDateStatus: 'invalid' } });
      const btn = screen.getByRole('button', { name: /fix your birth date/i });
      expect(btn).toBeInTheDocument();
      expect(screen.getByText('LV !')).toBeInTheDocument();
      expect(screen.queryByText('LV —')).not.toBeInTheDocument();
    });

    it('shows a FIX prompt for an unreadable config, not a set prompt', () => {
      renderCompact('', { character: { level: null, birthDateStatus: 'unreadable' } });
      expect(screen.getByRole('button', { name: /fix your birth date/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /set your birth date/i })).not.toBeInTheDocument();
    });

    it('shows the numeric level (no CTA) when a level exists', () => {
      renderCompact('', { character: { level: 7, birthDateStatus: 'ok' } });
      expect(screen.getByText('LV 7')).toBeInTheDocument();
      expect(screen.queryByText('LV —')).not.toBeInTheDocument();
      expect(screen.queryByText('LV !')).not.toBeInTheDocument();
    });
  });
});
