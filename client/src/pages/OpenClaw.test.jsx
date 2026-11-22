import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';

const openClawApi = vi.hoisted(() => ({
  getOpenClawStatus: vi.fn(),
  getOpenClawSessions: vi.fn(),
  getOpenClawMessages: vi.fn(),
  streamOpenClawMessage: vi.fn(),
}));

vi.mock('../services/apiOpenClaw', () => openClawApi);
const coreApi = vi.hoisted(() => ({ getApps: vi.fn() }));
vi.mock('../services/apiApps.js', () => ({ getApps: coreApi.getApps }));
vi.mock('../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled: () => true }),
}));
vi.mock('../components/settings/SettingsTabsHeader', () => ({
  default: () => <div data-testid="settings-tabs-header" />,
}));

import OpenClaw from './OpenClaw';

const LocationProbe = () => {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="search">{location.search}</output>
      <button onClick={() => navigate(-1)}>history-back</button>
    </>
  );
};

const renderPage = async (entry = '/openclaw') => {
  const result = render(
    <MemoryRouter initialEntries={[entry]}>
      <OpenClaw />
      <LocationProbe />
    </MemoryRouter>,
  );
  await act(async () => {});
  return result;
};

describe('OpenClaw page header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreApi.getApps.mockResolvedValue([]);
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
    await renderPage();

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).toHaveAccessibleName('OpenClaw');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('uses the shared compact bar padding rather than a hand-rolled p-4 one', async () => {
    await renderPage();

    const heading = await screen.findByRole('heading', { level: 1 });
    const bar = heading.closest('div.border-b');
    expect(bar.className).toContain('px-3');
    expect(bar.className).toContain('sm:px-4');
    expect(bar).toContainElement(screen.getByRole('button', { name: /Refresh/ }));
  });
});

describe('OpenClaw app context picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openClawApi.getOpenClawStatus.mockResolvedValue({ configured: true, enabled: true, reachable: true, defaultSession: 'session-1' });
    openClawApi.getOpenClawSessions.mockResolvedValue({ sessions: [{ id: 'session-1', title: 'Example session' }] });
    openClawApi.getOpenClawMessages.mockResolvedValue({ messages: [] });
  });

  it('shows a load error with Retry when the app list fails, then offers the apps after Retry', async () => {
    coreApi.getApps.mockRejectedValueOnce(new Error('Apps unavailable'));
    await renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load apps for context — Apps unavailable');
    expect(screen.queryByRole('option', { name: 'Example App' })).toBeNull();

    coreApi.getApps.mockResolvedValueOnce([{ id: 'app-1', name: 'Example App' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('option', { name: 'Example App' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('OpenClaw ?session= deep link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreApi.getApps.mockResolvedValue([]);
    openClawApi.getOpenClawStatus.mockResolvedValue({ configured: true, enabled: true, reachable: true, defaultSession: 'session-1' });
    openClawApi.getOpenClawSessions.mockResolvedValue({
      sessions: [{ id: 'session-1', title: 'Example one', messageCount: 3 }, { id: 'session-2', title: 'Example two', messageCount: 2 }],
    });
    openClawApi.getOpenClawMessages.mockResolvedValue({ messages: [] });
  });

  it('restores the session from the URL on load', async () => {
    await renderPage('/openclaw?session=session-2');
    expect(await screen.findByText('Session ID: session-2')).toBeInTheDocument();
  });

  it('normalizes an unknown session id back to the default without adding history', async () => {
    await renderPage('/openclaw?session=gone');
    expect(await screen.findByText('Session ID: session-1')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?session=session-1');
  });

  it('pushes history on selection and follows Browser Back', async () => {
    await renderPage();
    expect(await screen.findByText('Session ID: session-1')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /Example two/ })[0]);
    expect(await screen.findByText('Session ID: session-2')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?session=session-2');

    await userEvent.click(screen.getByRole('button', { name: 'history-back' }));
    expect(await screen.findByText('Session ID: session-1')).toBeInTheDocument();
  });
});
