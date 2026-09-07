import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../hooks/useAutoRefetch', () => ({
  useAutoRefetch: () => ({
    loading: false,
    data: {
      networkSetupPreference: 'tailscale',
      setup: { total: 1, ready: 0, remaining: 1, complete: false },
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

vi.mock('../services/api', () => ({ updateSettings: vi.fn() }));
import * as api from '../services/api';

import CapabilityMap from './CapabilityMap';

describe('CapabilityMap setup walkthrough', () => {
  it('keeps essential network/provider setup above optional capabilities', () => {
    render(<MemoryRouter><CapabilityMap /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Setup & Capabilities' })).toBeInTheDocument();
    expect(screen.getByText('1 essential step remaining')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Optional networking' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Tailscale DNS admin' })).toHaveAttribute(
      'href',
      'https://login.tailscale.com/admin/dns',
    );
    expect(screen.getByRole('heading', { name: 'AI provider' })).toBeInTheDocument();
    expect(screen.getByText('Subscription CLI')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Optional capabilities' })).toBeInTheDocument();
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByText('1 not set up')).toBeInTheDocument();
    expect(screen.queryByText('2 degraded')).not.toBeInTheDocument();
  });
});

it('saves Tailcat and not-desired choices and retains the saved choice on failure', async () => {
  api.updateSettings.mockResolvedValue({});
  render(<MemoryRouter><CapabilityMap /></MemoryRouter>);
  const select = screen.getByLabelText('Networking preference');
  fireEvent.change(select, { target: { value: 'tailcat' } });
  await waitFor(() => expect(screen.getByRole('link', { name: 'Configure Tailcat bridge' })).toHaveAttribute('href', '/instances'));
  expect(screen.queryByText('Enable MagicDNS')).not.toBeInTheDocument();
  fireEvent.change(select, { target: { value: 'none' } });
  await waitFor(() => expect(select).toHaveValue('none'));
  expect(api.updateSettings).toHaveBeenLastCalledWith({ networkSetupPreference: 'none' }, { silent: true });
  api.updateSettings.mockRejectedValueOnce(new Error('Save failed'));
  fireEvent.change(select, { target: { value: 'tailscale' } });
  await waitFor(() => expect(select).not.toBeDisabled());
  expect(select).toHaveValue('none');
});
