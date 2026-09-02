import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const openClawApi = vi.hoisted(() => ({
  getOpenClawStatus: vi.fn(),
  getOpenClawSessions: vi.fn(),
  getOpenClawMessages: vi.fn(),
  streamOpenClawMessage: vi.fn(),
}));

vi.mock('../services/apiOpenClaw', () => openClawApi);
vi.mock('../services/api', () => ({ getApps: vi.fn(() => Promise.resolve([])) }));
vi.mock('../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled: () => true }),
}));
vi.mock('../components/settings/SettingsTabsHeader', () => ({
  default: () => <div data-testid="settings-tabs-header" />,
}));

import OpenClaw from './OpenClaw';

const renderPage = () => render(
  <MemoryRouter initialEntries={['/openclaw']}>
    <OpenClaw />
  </MemoryRouter>,
);

describe('OpenClaw page header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openClawApi.getOpenClawStatus.mockResolvedValue({
      configured: true,
      enabled: true,
      reachable: true,
      label: 'OpenClaw Runtime',
      defaultSession: 'session-1',
    });
    openClawApi.getOpenClawSessions.mockResolvedValue({
      sessions: [{ id: 'session-1', title: 'Example session' }],
    });
    openClawApi.getOpenClawMessages.mockResolvedValue({ messages: [] });
  });

  // Before #5653 the page duplicated PageHeader's structure by hand with `p-4`
  // padding, so it drifted from every other settings-group page's bar height.
  it('renders exactly one h1 through the shared PageHeader', async () => {
    renderPage();

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).toHaveAccessibleName('OpenClaw');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('uses the shared compact bar padding rather than a hand-rolled p-4 one', async () => {
    renderPage();

    const heading = await screen.findByRole('heading', { level: 1 });
    const bar = heading.closest('div.border-b');
    expect(bar.className).toContain('px-3');
    expect(bar.className).toContain('sm:px-4');
    expect(bar).toContainElement(screen.getByRole('button', { name: /Refresh/ }));
  });
});
