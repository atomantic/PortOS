import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  getApp: vi.fn(),
  getEidoverseWorldStatus: vi.fn(),
  getInstanceFeatures: vi.fn(),
  projectEidoverseWorld: vi.fn(),
  startApp: vi.fn(),
  startEidoverseHost: vi.fn(),
  updateEidoverseWorldConfig: vi.fn(),
}));

import * as api from '../services/api';
import Eidoverse, { hostUrlFor } from './Eidoverse';

const setup = {
  installed: true,
  appId: 'app-eidoverse',
  uiPort: 8940,
  runtimeStatus: 'online',
};

const featureResponse = (overrides = {}) => ({
  features: [{
    id: 'eidoverse',
    enabled: false,
    setup: { ...setup, ...overrides },
  }],
});

const worldResponse = {
  world: 'portos',
  identity: { name: 'example-portos-user' },
  human: { name: 'example-portos-user' },
  cos: { id: 'portos-cos', enabled: true },
  recipe: {
    includes: { apps: true, agents: true, tasks: true, features: true, peers: true, health: true },
  },
  presence: { connected: false },
};

const renderPage = () => render(
  <MemoryRouter initialEntries={['/eidoverse']}>
    <Eidoverse />
  </MemoryRouter>,
);

describe('Eidoverse hosted page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getInstanceFeatures.mockResolvedValue(featureResponse());
    api.getApp.mockResolvedValue({ id: setup.appId, overallStatus: 'online' });
    api.startApp.mockResolvedValue({ success: true, results: {} });
    api.startEidoverseHost.mockResolvedValue({ running: true, protocol: 'http', port: 5563 });
    api.getEidoverseWorldStatus.mockResolvedValue(worldResponse);
    api.projectEidoverseWorld.mockResolvedValue({
      success: true,
      projection: { lastSuccessAt: '2026-01-01T00:00:00.000Z' },
      presence: { connected: true, role: 'builder' },
    });
    api.updateEidoverseWorldConfig.mockResolvedValue({ ...worldResponse, human: worldResponse.identity });
  });

  it('loads the installed managed app even when the optional nav entry is disabled', async () => {
    renderPage();

    const frame = await screen.findByTitle('Eidoverse Worlds');
    expect(frame).toHaveAttribute('src', `http://${window.location.hostname}:8940/?world=portos&name=example-portos-user`);
    expect(api.getApp).toHaveBeenCalledWith('app-eidoverse', { silent: true });
    expect(api.startApp).not.toHaveBeenCalled();
    expect(api.startEidoverseHost).toHaveBeenCalledWith({ silent: true });
    expect(api.getEidoverseWorldStatus).toHaveBeenCalledWith({ silent: true });
    expect(api.projectEidoverseWorld).toHaveBeenCalledWith({ silent: true });
    expect(screen.getByRole('link', { name: 'Manage app' })).toHaveAttribute('href', '/apps/app-eidoverse/overview');
  });

  it('starts a stopped managed app before connecting the hosted page', async () => {
    api.getApp.mockResolvedValue({ id: setup.appId, overallStatus: 'stopped' });
    renderPage();

    await screen.findByTitle('Eidoverse Worlds');
    expect(api.startApp).toHaveBeenCalledWith('app-eidoverse', { silent: true });
    expect(api.startEidoverseHost).toHaveBeenCalledAfter(api.startApp);
  });

  it('sends an uninstalled user to the existing Features setup', async () => {
    api.getInstanceFeatures.mockResolvedValue(featureResponse({ installed: false, appId: null }));
    renderPage();

    const setupLink = await screen.findByRole('link', { name: 'Open Features' });
    expect(setupLink).toHaveAttribute('href', '/settings/features');
    expect(api.getApp).not.toHaveBeenCalled();
    expect(api.startEidoverseHost).not.toHaveBeenCalled();
  });

  it('surfaces a managed-app start failure and retries on demand', async () => {
    api.getApp.mockResolvedValue({ id: setup.appId, overallStatus: 'stopped' });
    api.startApp
      .mockResolvedValueOnce({ success: true, results: { eidoverse: { success: false, error: 'Example startup failure' } } })
      .mockResolvedValueOnce({ success: true, results: { eidoverse: { success: true } } });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Example startup failure');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByTitle('Eidoverse Worlds');
    expect(api.startApp).toHaveBeenCalledTimes(2);
  });

  it('uses the PortOS TLS bridge for an HTTPS MagicDNS page', () => {
    expect(hostUrlFor(
      { running: true, protocol: 'https', port: 5563 },
      setup,
      { protocol: 'https:', hostname: 'host-alpha.example-tailnet.ts.net' },
    )).toBe('https://host-alpha.example-tailnet.ts.net:5563/');
    expect(() => hostUrlFor(
      { running: true, protocol: 'http', port: 5563 },
      setup,
      { protocol: 'https:', hostname: 'host-alpha.example-tailnet.ts.net' },
    )).toThrow(/shared certificate/);
  });

  it('shows bridge readiness errors instead of mounting a dead iframe', async () => {
    api.startEidoverseHost.mockRejectedValue(new Error('Eidoverse Worlds did not become ready in time.'));
    renderPage();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('did not become ready'));
    expect(screen.queryByTitle('Eidoverse Worlds')).toBeNull();
  });
});
