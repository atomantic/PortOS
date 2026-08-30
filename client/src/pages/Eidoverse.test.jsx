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
    version: 1,
    includes: {
      apps: true, agents: true, tasks: true, features: true, peers: true, health: true,
      productivity: true, activity: true, goals: true, memory: true, storage: true, jira: true, operations: true,
    },
    limits: {
      apps: 10, agents: 10, tasks: 10, features: 10, peers: 10, health: 1,
      productivity: 1, activity: 10, goals: 10, memory: 10, storage: 10, jira: 10, operations: 1,
    },
    layout: { origin: [0, 0, 0], spacing: 7, laneGap: 6, columns: 8 },
    scale: {
      app: 1, agent: 1, task: 1, feature: 1, peer: 1, health: 1,
      productivity: 1, activity: 1, goal: 1, memory: 1, storage: 1, jira: 1, operations: 1,
    },
    assets: Object.fromEntries([
      'app', 'agent', 'task', 'feature', 'peer', 'health', 'productivity', 'activity',
      'goal', 'memory', 'storage', 'jira', 'operations',
    ].map((kind) => [kind, `eidoverse/assets/models/${kind}.glb`])),
    terrain: {
      seed: 'example', size: 128, segments: 64, amplitude: 1.8, flatRadius: 28,
      layers: [{ color: '#142338', repeat: 18 }],
    },
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
      presence: { connected: true, role: 'owner' },
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
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledWith({ silent: true }));
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

  it('keeps a successful local save visible when the follow-up projection fails', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledTimes(1));
    api.projectEidoverseWorld.mockRejectedValueOnce(new Error('Example projection failure'));

    await user.click(screen.getByText('World identity and projection recipe'));
    await user.click(screen.getByRole('button', { name: 'Save and project' }));

    expect(await screen.findByText('Saved locally.')).toBeInTheDocument();
    expect(await screen.findByText('Example projection failure')).toBeInTheDocument();
    expect(api.updateEidoverseWorldConfig).toHaveBeenCalledOnce();
  });

  it('clears the saved marker as soon as the local recipe draft changes again', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByText('World identity and projection recipe'));
    await user.click(screen.getByRole('button', { name: 'Save and project' }));
    expect(await screen.findByText('Saved locally.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('My Eidoverse name'), '-edited');
    expect(screen.queryByText('Saved locally.')).not.toBeInTheDocument();
  });

  it('keeps newer draft edits intact while an earlier save is in flight', async () => {
    let resolveSave;
    api.updateEidoverseWorldConfig.mockReturnValueOnce(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByText('World identity and projection recipe'));

    const nameInput = screen.getByLabelText('My Eidoverse name');
    const saveButton = screen.getByRole('button', { name: 'Save and project' });
    await user.click(saveButton);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    await user.type(nameInput, '-edited');
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    resolveSave({ ...worldResponse, human: worldResponse.identity });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and project' })).toBeEnabled());
    expect(nameInput).toHaveValue('example-portos-user-edited');
    expect(screen.queryByText('Saved locally.')).not.toBeInTheDocument();
    expect(api.updateEidoverseWorldConfig).toHaveBeenCalledOnce();
  });

  it('reloads the durable browser identity and reports projection failure separately after a world rename', async () => {
    const user = userEvent.setup();
    const renamed = { ...worldResponse, world: 'portos-two', human: worldResponse.identity };
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledTimes(1));
    api.updateEidoverseWorldConfig.mockResolvedValueOnce(renamed);
    api.projectEidoverseWorld.mockRejectedValueOnce(new Error('Example renamed-world failure'));

    await user.click(screen.getByText('World identity and projection recipe'));
    const worldInput = screen.getByLabelText('World name');
    await user.clear(worldInput);
    await user.type(worldInput, 'portos-two');
    await user.click(screen.getByRole('button', { name: 'Save and project' }));

    expect(await screen.findByText('Saved locally.')).toBeInTheDocument();
    expect(await screen.findByText('Example renamed-world failure')).toBeInTheDocument();
    expect(screen.getByTitle('Eidoverse Worlds')).toHaveAttribute(
      'src',
      `http://${window.location.hostname}:8940/?world=portos-two&name=example-portos-user`,
    );
  });

  it('mirrors the strict world recipe constraints in the browser form', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByText('World identity and projection recipe'));

    expect(screen.getByLabelText('World name')).toHaveAttribute('pattern', '[A-Za-z0-9_-]+');
    const assetInput = screen.getByLabelText('Asset path', { selector: '#eidoverse-asset-app' });
    expect(assetInput).toBeRequired();
    expect(assetInput).toHaveAttribute(
      'pattern',
      '(?:[Ee][Ii][Dd][Oo][Vv][Ee][Rr][Ss][Ee]|[Ss][Tt][Oo][Rr][Ee])[\\\\/](?!.*\\.\\.).*',
    );
    await user.clear(assetInput);
    await user.type(assetInput, 'EIDOVERSE\\assets\\models\\example.glb');
    expect(assetInput).toBeValid();

    const scaleInput = screen.getByLabelText('Scale', { selector: '#eidoverse-scale-app' });
    await user.clear(scaleInput);
    await user.type(scaleInput, '0.001');
    expect(scaleInput).toBeValid();
    expect(screen.getByLabelText('Seed')).toBeRequired();
    expect(screen.getByLabelText('size')).toHaveAttribute('min', '0.01');
    expect(screen.getByLabelText('amplitude')).toHaveAttribute('max', '100');
  });
});
