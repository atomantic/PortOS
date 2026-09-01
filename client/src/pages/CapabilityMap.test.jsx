import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../hooks/useAutoRefetch', () => ({
  useAutoRefetch: () => ({
    loading: false,
    data: {
      setup: { total: 2, ready: 0, remaining: 2, complete: false },
      summary: { ok: 0, warn: 2, error: 0, unconfigured: 1, total: 3, overall: 'warn' },
      optionalSummary: { ok: 0, warn: 0, error: 0, unconfigured: 1, total: 1, overall: 'unconfigured' },
      network: {
        bind: { port: 5555 },
        setup: {
          complete: false,
          summary: 'Enable MagicDNS',
          nextStep: {
            id: 'magic-dns',
            title: 'Enable MagicDNS',
            status: 'action',
            detail: 'Enable MagicDNS in the tailnet DNS admin.',
            action: { type: 'external', label: 'Open Tailscale DNS admin', url: 'https://login.tailscale.com/admin/dns' },
          },
          steps: [{
            id: 'magic-dns',
            title: 'Enable MagicDNS',
            status: 'action',
            detail: 'Enable MagicDNS in the tailnet DNS admin.',
            action: { type: 'external', label: 'Open Tailscale DNS admin', url: 'https://login.tailscale.com/admin/dns' },
          }],
        },
      },
      capabilities: [
        { id: 'network', label: 'Tailscale & HTTPS', settingsPath: '/instances', status: 'warn', summary: 'Enable MagicDNS', setupRequired: true, setupComplete: false },
        { id: 'providers', label: 'AI Providers', settingsPath: '/ai', status: 'error', summary: '1 enabled · 0 ready · 1 needs setup', setupRequired: true, setupComplete: false },
        { id: 'calendar', label: 'Calendar', settingsPath: '/calendar/config', status: 'unconfigured', summary: 'No accounts', setupRequired: false, setupComplete: false },
      ],
    },
  }),
}));

import CapabilityMap from './CapabilityMap';

describe('CapabilityMap setup walkthrough', () => {
  it('keeps essential network/provider setup above optional capabilities', () => {
    render(<MemoryRouter><CapabilityMap /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Setup & Capabilities' })).toBeInTheDocument();
    expect(screen.getByText('2 essential steps remaining')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1. Tailscale, MagicDNS & HTTPS' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Tailscale DNS admin' })).toHaveAttribute(
      'href',
      'https://login.tailscale.com/admin/dns',
    );
    expect(screen.getByRole('heading', { name: '2. AI provider' })).toBeInTheDocument();
    expect(screen.getByText('Subscription CLI')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Optional capabilities' })).toBeInTheDocument();
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByText('1 not set up')).toBeInTheDocument();
    expect(screen.queryByText('2 degraded')).not.toBeInTheDocument();
  });
});
