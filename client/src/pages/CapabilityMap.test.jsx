import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { awaitEnabled } from '../test/enabledBarrier.js';

const fixture = vi.hoisted(() => ({ override: null }));

vi.mock('../hooks/useSocketResource', () => ({
  useSocketResource: () => ({
    loading: false,
    data: fixture.override ?? {
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
  it('keeps the essential provider setup above optional networking and capabilities', () => {
    render(<MemoryRouter><CapabilityMap /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Setup & Capabilities' })).toBeInTheDocument();
    expect(screen.getByText('1 essential step remaining')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Optional networking' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Tailscale DNS admin' })).toHaveAttribute(
      'href',
      'https://login.tailscale.com/admin/dns',
    );
    expect(screen.getByRole('heading', { name: 'AI provider' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI provider' }).compareDocumentPosition(
      screen.getByRole('heading', { name: 'Optional networking' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  await awaitEnabled(select);
  expect(select).toHaveValue('none');
});


describe('CapabilityMap with setup complete', () => {
  const completeData = {
    networkSetupPreference: 'tailcat',
    setup: { total: 1, ready: 1, remaining: 0, complete: true },
    summary: { ok: 2, warn: 1, error: 1, unconfigured: 1, total: 5, overall: 'error' },
    optionalSummary: { ok: 1, warn: 1, error: 1, unconfigured: 1, total: 4, overall: 'error' },
    capabilities: [
      { id: 'providers', label: 'AI Providers', settingsPath: '/ai', status: 'ok', summary: 'ready', setupRequired: true },
      { id: 'drive', label: 'Drive', settingsPath: '/drive', status: 'ok', summary: 'fine' },
      { id: 'calendar', label: 'Calendar', settingsPath: '/calendar', status: 'unconfigured', summary: 'No accounts' },
      { id: 'messages', label: 'Messages', settingsPath: '/messages', status: 'warn', summary: 'degraded' },
      { id: 'apps', label: 'Apps', settingsPath: '/apps', status: 'error', summary: 'broken' },
    ],
  };

  it('orders problems first, drops first-time copy, and keeps setup options behind a disclosure', () => {
    fixture.override = completeData;
    try {
      render(<MemoryRouter><CapabilityMap /></MemoryRouter>);
      const labels = ['Apps', 'Messages', 'Calendar', 'Drive'].map((l) => screen.getByText(l));
      for (let i = 0; i < labels.length - 1; i += 1) {
        expect(labels[i].compareDocumentPosition(labels[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(screen.queryByText(/Enable at least one runnable AI provider/)).not.toBeInTheDocument();
      expect(screen.getAllByText('Setup options')).toHaveLength(2);
      expect(screen.getAllByText('Setup options')[0].closest('details')).not.toHaveAttribute('open');
      expect(screen.getByLabelText('Networking preference').closest('details')).not.toHaveAttribute('open');
      expect(screen.getByRole('button', { name: '1 error · 1 degraded · 1 not set up' })).toBeInTheDocument();
      fireEvent.click(screen.getAllByText('Setup options')[1]);
      expect(screen.getByLabelText('Networking preference').closest('details')).toHaveAttribute('open');
    } finally {
      fixture.override = null;
    }
  });
});
