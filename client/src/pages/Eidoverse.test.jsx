import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  getApp: vi.fn(),
  getEidoverseWorldProjectionStatus: vi.fn(),
  getEidoverseWorldStatus: vi.fn(),
  getInstanceFeatures: vi.fn(),
  projectEidoverseWorld: vi.fn(),
  startApp: vi.fn(),
  startEidoverseHost: vi.fn(),
  updateEidoverseWorldConfig: vi.fn(),
}));

vi.mock('../components/BrailleSpinner', () => ({
  default: ({ text }) => <span>{text}</span>,
}));

import * as api from '../services/api';
import Eidoverse, { hostUrlFor } from './Eidoverse';

const setup = { installed: true, appId: 'app-eidoverse', uiPort: 8940, runtimeStatus: 'online' };
const featureResponse = (overrides = {}) => ({
  features: [{ id: 'eidoverse', enabled: false, setup: { ...setup, ...overrides } }],
});

const includes = {
  apps: true, agents: true, tasks: true, features: true, peers: true, health: true,
  productivity: true, activity: true, goals: true, memory: true, storage: true, jira: true, operations: true,
};
const limits = {
  apps: 8, agents: 6, tasks: 6, features: 4, peers: 4, health: 1,
  productivity: 1, activity: 3, goals: 4, memory: 3, storage: 4, jira: 3, operations: 1,
};
const scale = Object.fromEntries([
  'app', 'agent', 'task', 'feature', 'peer', 'health', 'productivity',
  'activity', 'goal', 'memory', 'storage', 'jira', 'operations',
].map((kind) => [kind, 1]));
const slot = (name) => ({
  preferredPaths: [`eidoverse/assets/models/${name}.glb`],
  fallbackQueries: [`example ${name}`],
  requiredTokens: [name],
  excludedTokens: ['car'],
  maxBytes: 20_000_000,
  format: 'glb',
  animation: 'optional',
  sourcePolicy: 'library-only',
  fallback: 'eidoverse/assets/models/orb.glb',
});
const assetSlots = Object.fromEntries([
  'nexus', 'app', 'agent', 'task', 'goal', 'memory', 'storage', 'peer', 'activity', 'district',
].map((name) => [name, slot(name)]));

const recipe = {
  version: 2,
  name: 'Luminous Systems Garden',
  maxEntities: 48,
  includes,
  limits,
  scale,
  districts: [
    { id: 'nexus', label: 'PortOS Nexus', anchor: [0, 0, 0], sources: ['health', 'operations', 'features'], accent: '#ffb86b' },
    { id: 'apps', label: 'App Terraces', anchor: [-30, 0, -18], sources: ['apps'], accent: '#65d9ff' },
    { id: 'agents', label: 'Agent Foundry', anchor: [0, 0, -34], sources: ['agents', 'tasks'], accent: '#a78bfa' },
  ],
  environment: {
    terrain: { seed: 'example', size: 180, segments: 96, amplitude: 1.4, flatRadius: 48, layers: [{ color: '#0d1629', repeat: 22 }] },
    sky: { system: 'skymesh', hours: 7.2, azimuth: 145, sun: 1.35, ambient: 1.2, fill: 1.1, exposure: 1.08, fog: 0.42, clouds: 'cirrus', weather: 'clear' },
    grass: { species: 'grass', width: 154, depth: 144, center: [0, 0], height: 0.22, color: 'gray-green', density: 0.45 },
    lights: [],
  },
  assetRecipe: { version: 2, slots: assetSlots },
  assets: { app: 'eidoverse/assets/models/app.glb' },
};

const design = {
  name: recipe.name,
  selectedVersion: 2,
  lastAppliedVersion: 1,
  pendingVersion: 2,
  assetRecipeVersion: 2,
  maxEntities: 48,
  districts: recipe.districts,
  assetResolutions: {
    app: { path: 'eidoverse/assets/models/app.glb', source: 'preferred', bytes: 4_000_000, catalogFingerprint: 'example' },
  },
  migrationReport: { status: 'ready', fromDesignVersion: 1, toDesignVersion: 2, preservedOverrides: ['limits.apps'] },
  reconciliation: { status: 'pending', checkpoint: 'migration-complete', error: null },
};

const worldResponse = {
  world: 'portos',
  identity: { name: 'example-portos-user' },
  human: { name: 'example-portos-user' },
  cos: { id: 'portos-cos', enabled: true },
  recipe,
  design,
  projection: {
    lastSummary: {
      liveEntityCount: 12,
      sourceAvailability: { apps: true, agents: false },
      sourceCounts: { apps: 3, agents: null },
    },
  },
  presence: { connected: false },
};

const renderPage = (entry = '/eidoverse') => render(
  <MemoryRouter initialEntries={[entry]}>
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
    api.getEidoverseWorldProjectionStatus.mockResolvedValue({
      design: {
        lastAppliedVersion: design.lastAppliedVersion,
        pendingVersion: design.pendingVersion,
        reconciliation: design.reconciliation,
      },
      projection: worldResponse.projection,
    });
    api.projectEidoverseWorld.mockResolvedValue({
      success: true,
      projection: { lastSuccessAt: '2026-01-01T00:00:00.000Z', lastSummary: worldResponse.projection.lastSummary },
      presence: { connected: true, role: 'owner' },
      design: { ...design, lastAppliedVersion: 2, pendingVersion: null, reconciliation: { status: 'complete', checkpoint: 'projection-committed' } },
      recipe,
    });
    api.updateEidoverseWorldConfig.mockResolvedValue({ ...worldResponse, human: worldResponse.identity });
  });

  it('loads the installed managed app and renders the PortOS spatial overlay', async () => {
    renderPage();

    const frame = await screen.findByTitle('Eidoverse Worlds');
    expect(frame).toHaveAttribute('src', `http://${window.location.hostname}:8940/?world=portos&name=example-portos-user`);
    const overlayHeading = await screen.findByText('Your PortOS, made spatial');
    expect(overlayHeading.closest('section')).toHaveClass('port-media-overlay');
    expect(screen.getByText(/The Nexus is system health/)).toHaveClass('text-port-text-muted');
    expect(screen.getByText('Design V2').parentElement).toHaveClass('text-port-text-muted');
    expect(screen.getByText(/Steady = current/)).toHaveClass('text-port-text-muted');
    expect(screen.getByRole('button', { name: 'Refresh world' }))
      .toHaveClass('port-media-overlay-strong', 'port-media-overlay-item');
    expect(screen.getByRole('button', { name: 'Refresh world' }))
      .toHaveAttribute('aria-label', 'Refresh world');
    expect(screen.getByRole('region', { name: 'PortOS district legend' }).querySelector('.port-media-overlay'))
      .toBeInTheDocument();
    expect(screen.getByText('App Terraces')).toBeInTheDocument();
    expect(screen.getByText('12/48 live signals')).toBeInTheDocument();
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledWith({ silent: true }));
    expect(screen.getByRole('link', { name: 'Manage app' })).toHaveAttribute('href', '/apps/app-eidoverse/overview');
  });

  it('starts a stopped managed app before connecting', async () => {
    api.getApp.mockResolvedValue({ id: setup.appId, overallStatus: 'stopped' });
    renderPage();

    await screen.findByTitle('Eidoverse Worlds');
    expect(api.startApp).toHaveBeenCalledWith('app-eidoverse', { silent: true });
    expect(api.startEidoverseHost).toHaveBeenCalledAfter(api.startApp);
  });

  it('sends an uninstalled user to Features', async () => {
    api.getInstanceFeatures.mockResolvedValue(featureResponse({ installed: false, appId: null }));
    renderPage();

    expect(await screen.findByRole('link', { name: 'Open Features' })).toHaveAttribute('href', '/settings/features');
    expect(api.getApp).not.toHaveBeenCalled();
  });

  it('surfaces a managed-app start failure and retries', async () => {
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

  it('keeps a successful local save visible when projection fails', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledTimes(1));
    api.projectEidoverseWorld.mockRejectedValueOnce(new Error('Example projection failure'));

    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('button', { name: 'Save and project' }));

    expect(await screen.findByText('Saved locally and queued for projection.')).toBeInTheDocument();
    expect(await screen.findByText('Example projection failure')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check the Eidoverse runtime' })).toHaveAttribute('href', '/apps/app-eidoverse/overview');
  });

  it('keeps newer edits intact while an earlier save is in flight', async () => {
    let resolveSave;
    api.updateEidoverseWorldConfig.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByRole('button', { name: 'World controls' }));

    const nameInput = screen.getByLabelText('My Eidoverse name');
    await user.click(screen.getByRole('button', { name: 'Save and project' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await user.type(nameInput, '-edited');
    resolveSave({ ...worldResponse, human: worldResponse.identity });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and project' })).toBeEnabled());
    expect(nameInput).toHaveValue('example-portos-user-edited');
    expect(screen.queryByText('Saved locally and queued for projection.')).not.toBeInTheDocument();
  });

  it('reloads the durable browser identity after a world rename', async () => {
    const user = userEvent.setup();
    const renamed = { ...worldResponse, world: 'portos-two', human: worldResponse.identity };
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    api.updateEidoverseWorldConfig.mockResolvedValueOnce(renamed);

    await user.click(screen.getByRole('button', { name: 'World controls' }));
    const worldInput = screen.getByLabelText('World name');
    await user.clear(worldInput);
    await user.type(worldInput, 'portos-two');
    await user.click(screen.getByRole('button', { name: 'Save and project' }));

    await waitFor(() => expect(screen.getByTitle('Eidoverse Worlds')).toHaveAttribute(
      'src',
      `http://${window.location.hostname}:8940/?world=portos-two&name=example-portos-user`,
    ));
  });

  it('groups data, assets, and upgrade state in a deep-linkable tabbed drawer', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByRole('button', { name: 'World controls' }));

    expect(screen.getByLabelText('World name')).toHaveAttribute('pattern', '[A-Za-z0-9_-]+');
    await user.click(screen.getByRole('tab', { name: 'Districts & Data' }));
    expect(screen.getByText(/bounded summaries, never raw records/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Apps')).toBeChecked();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open in PortOS' })
      .some((link) => link.getAttribute('href') === '/apps')).toBe(true);

    await user.click(screen.getByRole('tab', { name: 'Appearance & Assets' }));
    expect(screen.getByText('Portable asset recipe')).toBeInTheDocument();
    expect(screen.getByText('eidoverse/assets/models/app.glb')).toBeInTheDocument();
    expect(screen.getByLabelText('Sun hour')).toHaveValue(7.2);

    await user.click(screen.getByRole('tab', { name: 'Updates & Advanced' }));
    expect(screen.getByText('projection-committed')).toBeInTheDocument();
    expect(screen.getByText('1', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('limits.apps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply world update' })).toBeInTheDocument();
  });

  it('surfaces per-source omissions when the shared live-signal cap is saturated', async () => {
    const user = userEvent.setup();
    const truncatedSummary = {
      ...worldResponse.projection.lastSummary,
      liveEntityCount: 48,
      maxLiveEntities: 48,
      truncated: true,
      droppedBySource: { apps: 2, agents: 1 },
    };
    api.getEidoverseWorldStatus.mockResolvedValueOnce({
      ...worldResponse,
      projection: { lastSummary: truncatedSummary },
    });
    api.projectEidoverseWorld.mockResolvedValueOnce({
      success: true,
      projection: { lastSummary: truncatedSummary },
      presence: { connected: true, role: 'owner' },
      design: { ...design, lastAppliedVersion: 2, pendingVersion: null },
      recipe,
    });
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Districts & Data' }));

    expect(screen.getByText(/shared world cap omitted 2 Apps, 1 Agents signal/i)).toBeInTheDocument();
    expect(screen.getByText(/2 omitted by cap/)).toBeInTheDocument();
  });

  it('shows exact staged reconciliation progress while a projection is running', async () => {
    const user = userEvent.setup();
    let resolveProjection;
    api.getEidoverseWorldStatus.mockResolvedValueOnce({
      ...worldResponse,
      design: {
        ...design,
        reconciliation: {
          status: 'applying', checkpoint: 'applying-infrastructure', operationCount: 20, appliedOperations: 5,
        },
      },
    });
    api.projectEidoverseWorld.mockReturnValueOnce(new Promise((resolve) => { resolveProjection = resolve; }));
    renderPage();

    expect(await screen.findByText('Projecting 5/20')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Updates & Advanced' }));
    expect(screen.getByRole('progressbar', { name: 'World reconciliation progress' })).toHaveAttribute('aria-valuenow', '5');
    resolveProjection({
      success: true,
      projection: worldResponse.projection,
      presence: { connected: true },
      design: { ...design, reconciliation: { status: 'complete', checkpoint: 'projection-committed' } },
      recipe,
    });
    await waitFor(() => expect(screen.queryByText('Projecting 5/20')).not.toBeInTheDocument());
  });

  it('keeps a fresh-world curtain up until the dawn environment is applied', async () => {
    let resolveProjection;
    api.getEidoverseWorldStatus.mockResolvedValueOnce({
      ...worldResponse,
      design: {
        ...design,
        lastAppliedVersion: null,
        reconciliation: { status: 'applying', checkpoint: 'asset-preflight-complete' },
      },
    });
    api.projectEidoverseWorld.mockReturnValueOnce(new Promise((resolve) => { resolveProjection = resolve; }));
    renderPage();
    const frame = await screen.findByTitle('Eidoverse Worlds');
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledOnce());
    fireEvent.load(frame);

    expect(screen.getByText(/Preparing the PortOS systems garden/)).toBeInTheDocument();
    api.getEidoverseWorldProjectionStatus.mockResolvedValue({
      projection: worldResponse.projection,
      design: {
        lastAppliedVersion: null,
        reconciliation: { status: 'applying', checkpoint: 'environment-complete' },
      },
    });
    await waitFor(
      () => expect(screen.queryByText(/Preparing the PortOS systems garden/)).not.toBeInTheDocument(),
      { timeout: 2500 },
    );
    expect(api.getEidoverseWorldStatus).toHaveBeenCalledOnce();
    expect(api.getEidoverseWorldProjectionStatus).toHaveBeenCalled();

    await act(async () => {
      resolveProjection({
        success: true,
        projection: worldResponse.projection,
        presence: { connected: true },
        design,
        recipe,
      });
    });
  });

  it('resets one semantic district without clearing the full world design', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Districts & Data' }));
    await user.click(screen.getByRole('button', { name: 'Reset App Terraces' }));

    await waitFor(() => expect(api.updateEidoverseWorldConfig).toHaveBeenCalledWith(
      { reset: { scope: 'district', districtId: 'apps' } },
      { silent: true },
    ));
  });

  it('keeps newer edits intact while a scoped reset is in flight', async () => {
    let resolveReset;
    api.updateEidoverseWorldConfig.mockReturnValueOnce(new Promise((resolve) => { resolveReset = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Districts & Data' }));
    await user.click(screen.getByRole('button', { name: 'Reset App Terraces' }));
    await user.click(screen.getByRole('tab', { name: 'Experience' }));

    const nameInput = screen.getByLabelText('My Eidoverse name');
    await user.type(nameInput, '-edited');
    resolveReset({ ...worldResponse, human: worldResponse.identity });

    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledTimes(2));
    expect(nameInput).toHaveValue('example-portos-user-edited');
  });

  it('merges a scoped reset into the draft without discarding unrelated unsaved edits', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Appearance & Assets' }));

    const sunHour = screen.getByLabelText('Sun hour');
    await user.clear(sunHour);
    await user.type(sunHour, '8.4');
    await user.click(screen.getByRole('tab', { name: 'Districts & Data' }));
    const appsSection = screen.getByRole('heading', { name: 'App Terraces' }).closest('section');
    const appsLimit = within(appsSection).getByRole('spinbutton', { name: 'Cap' });
    await user.clear(appsLimit);
    await user.type(appsLimit, '5');
    await user.click(within(appsSection).getByRole('button', { name: 'Reset App Terraces' }));

    await waitFor(() => expect(api.updateEidoverseWorldConfig).toHaveBeenCalledWith(
      { reset: { scope: 'district', districtId: 'apps' } },
      { silent: true },
    ));
    await waitFor(() => expect(appsLimit).toHaveValue(8));
    await user.click(screen.getByRole('tab', { name: 'Appearance & Assets' }));
    expect(screen.getByLabelText('Sun hour')).toHaveValue(8.4);

    const save = screen.getByRole('button', { name: 'Save and project' });
    await waitFor(() => expect(save).toBeEnabled());
    expect([...save.closest('form').elements]
      .filter((element) => typeof element.checkValidity === 'function' && !element.checkValidity())
      .map((element) => ({ id: element.id, value: element.value, validationMessage: element.validationMessage })))
      .toEqual([]);
    await user.click(save);
    await waitFor(() => expect(api.updateEidoverseWorldConfig).toHaveBeenCalledTimes(2));
    const saved = api.updateEidoverseWorldConfig.mock.calls.at(-1)[0];
    expect(saved.recipe.environment.sky.hours).toBe(8.4);
    expect(saved.recipe.limits.apps).toBe(8);
  });

  it('gates projection and asset actions until the visible draft is saved', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Appearance & Assets' }));

    const sunHour = screen.getByLabelText('Sun hour');
    await user.clear(sunHour);
    await user.type(sunHour, '8.4');
    const appearanceRefresh = screen.getByRole('button', { name: 'Refresh asset matches' });
    expect(appearanceRefresh).toBeDisabled();
    expect(screen.getByText('Save changes before refreshing asset matches.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh world' })).toBeDisabled();

    await user.click(screen.getByRole('tab', { name: 'Updates & Advanced' }));
    const apply = screen.getByRole('button', { name: 'Apply world update' });
    const refresh = screen.getByRole('button', { name: 'Refresh asset matches' });
    expect(apply).toBeDisabled();
    expect(refresh).toBeDisabled();
    expect(screen.getByText(/Save your world changes before applying an update/)).toBeInTheDocument();
    await user.click(apply);
    await user.click(refresh);
    expect(api.updateEidoverseWorldConfig).not.toHaveBeenCalled();
    expect(api.projectEidoverseWorld).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Save and project' }));
    await waitFor(() => expect(api.updateEidoverseWorldConfig).toHaveBeenCalledOnce());
    await waitFor(() => expect(api.projectEidoverseWorld).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(apply).toBeEnabled());
    expect(refresh).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh world' })).toBeEnabled();
  });

  it('does not coerce temporarily cleared appearance numbers to invalid zeroes', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Appearance & Assets' }));

    await user.clear(screen.getByLabelText('Exposure'));
    await user.clear(screen.getByLabelText('Grass density'));
    const save = screen.getByRole('button', { name: 'Save and project' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.submit(save.closest('form'));

    await waitFor(() => expect(api.updateEidoverseWorldConfig).toHaveBeenCalledOnce());
    const saved = api.updateEidoverseWorldConfig.mock.calls[0][0];
    expect(saved.recipe.environment.sky.exposure).toBe(1.08);
    expect(saved.recipe.environment.grass.density).toBe(0.45);
  });

  it('does not coerce a temporarily cleared source cap to zero', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Districts & Data' }));

    const appsSection = screen.getByRole('heading', { name: 'App Terraces' }).closest('section');
    const appsLimit = within(appsSection).getByRole('spinbutton', { name: 'Cap' });
    await user.clear(appsLimit);
    expect(appsLimit).toHaveValue(null);
    const save = screen.getByRole('button', { name: 'Save and project' });
    fireEvent.submit(save.closest('form'));

    await waitFor(() => expect(api.updateEidoverseWorldConfig).toHaveBeenCalledOnce());
    expect(api.updateEidoverseWorldConfig.mock.calls[0][0].recipe.limits.apps).toBe(8);
  });

  it('surfaces a preserved legacy asset override and lets the user clear it', async () => {
    const legacyPath = 'store/example-legacy-feature';
    const legacyDesign = {
      ...design,
      userOverrides: { assets: { feature: legacyPath } },
    };
    api.getEidoverseWorldStatus.mockResolvedValue({ ...worldResponse, design: legacyDesign });
    api.projectEidoverseWorld.mockResolvedValue({
      success: true,
      projection: worldResponse.projection,
      presence: { connected: true },
      design: legacyDesign,
      recipe,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Eidoverse Worlds');
    await user.click(screen.getByRole('button', { name: 'World controls' }));
    await user.click(screen.getByRole('tab', { name: 'Appearance & Assets' }));

    expect(screen.getByText(legacyPath)).toBeInTheDocument();
    const clear = screen.getByRole('button', { name: 'Clear legacy Feature override' });
    await waitFor(() => expect(clear).toBeEnabled());
    await user.click(clear);
    expect(screen.queryByRole('button', { name: 'Clear legacy Feature override' })).not.toBeInTheDocument();

    const save = screen.getByRole('button', { name: 'Save and project' });
    expect(save).toBeEnabled();
    fireEvent.submit(save.closest('form'));
    await waitFor(() => expect(api.updateEidoverseWorldConfig).toHaveBeenCalledOnce());
    expect(api.updateEidoverseWorldConfig.mock.calls[0][0].assetOverrides).toEqual({});
  });
});
