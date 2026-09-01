import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../services/api', () => ({
  getCapabilities: vi.fn(),
}));

import * as api from '../services/api';
import SetupBanner from './SetupBanner';

const incomplete = {
  setup: { total: 2, ready: 0, remaining: 2, complete: false },
  network: { setup: { nextStep: { id: 'magic-dns', title: 'Enable MagicDNS' } } },
  capabilities: [
    { id: 'network', setupRequired: true, setupComplete: false },
    { id: 'providers', setupRequired: true, setupComplete: false },
  ],
};

const renderBanner = () => render(
  <MemoryRouter initialEntries={['/']}>
    <SetupBanner />
    <Routes>
      <Route path="/capabilities" element={<div>Setup destination</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('SetupBanner', () => {
  it('names the next network blocker and missing provider, then opens setup', async () => {
    api.getCapabilities.mockResolvedValue(incomplete);
    renderBanner();

    expect(await screen.findByText('Finish setup: Enable MagicDNS and a ready AI provider.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    expect(await screen.findByText('Setup destination')).toBeInTheDocument();
    await waitFor(() => expect(api.getCapabilities).toHaveBeenCalledTimes(2));
  });

  it('dismisses only the current setup state for the browser session', async () => {
    api.getCapabilities.mockResolvedValue(incomplete);
    const { unmount } = renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review setup' })).not.toBeInTheDocument());

    unmount();
    renderBanner();
    await waitFor(() => expect(api.getCapabilities).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Review setup' })).not.toBeInTheDocument();
  });

  it('reappears when setup progresses to a different incomplete state', async () => {
    api.getCapabilities.mockResolvedValueOnce(incomplete);
    const { unmount } = renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: 'Later' }));
    unmount();

    api.getCapabilities.mockResolvedValueOnce({
      ...incomplete,
      capabilities: incomplete.capabilities.map((entry) => entry.id === 'providers'
        ? { ...entry, summary: '1 enabled · sign-in required' }
        : entry),
    });
    renderBanner();

    expect(await screen.findByRole('button', { name: 'Review setup' })).toBeInTheDocument();
  });

  it('stays hidden after essential setup is complete', async () => {
    api.getCapabilities.mockResolvedValue({
      ...incomplete,
      setup: { total: 2, ready: 2, remaining: 0, complete: true },
    });
    renderBanner();
    await waitFor(() => expect(api.getCapabilities).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Review setup' })).not.toBeInTheDocument();
  });
});
