import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { __resetProviderCatalogCache } from '../../hooks/useProviderCatalog';

/**
 * AI Providers → Harnesses (#7567). What only this boundary pins: a toggle is
 * one write to the enablement endpoint AND a catalog re-read (so every open
 * picker's compose flow follows), the direct harness offers no switch, a
 * missing binary offers the install its runtime row allows, and the bootstrap
 * table is saved whole with the new app folded in.
 */

const api = vi.hoisted(() => ({
  getProviderCatalog: vi.fn(),
  createProviderPreset: vi.fn(),
  setProviderHarnessEnabled: vi.fn(),
  getProviderBootstraps: vi.fn(),
  saveProviderBootstraps: vi.fn(),
  getHarnesses: vi.fn(),
  refreshHarnessModels: vi.fn(),
}));
vi.mock('../../services/api', () => api);

vi.mock('../install/RuntimeInstallModal', () => ({
  default: ({ open, runtime, params, title, onComplete }) => (open ? (
    <div data-testid="install-modal">
      {title} · {runtime} · {params?.action}
      <button type="button" data-testid="complete" onClick={onComplete}>complete</button>
    </div>
  ) : null),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));

import ProviderHarnessesTab from './ProviderHarnessesTab';

const CATALOG = {
  harnesses: [
    { id: 'claude', label: 'Claude Code', modes: ['cli', 'tui'], enabled: true, source: 'detected', detected: true, version: '2.1.0' },
    { id: 'pi', label: 'Pi', modes: ['cli', 'tui'], enabled: false, source: 'setting', detected: false, version: null },
    { id: 'direct', label: 'Direct API', modes: ['api'], enabled: true, source: 'always', detected: true, version: null },
  ],
  services: [
    { slug: 'nvidia-nim', label: 'NVIDIA NIM', plan: 'free', enabled: true, readiness: 'ready', catalog: { models: [] } },
    { slug: 'ollama', label: 'Ollama', plan: 'local', enabled: true, readiness: 'ready', catalog: { models: [] } },
    { slug: 'claude-subscription', label: 'Claude subscription', plan: 'subscription', enabled: true, readiness: 'ready', catalog: { models: [] }, definition: { id: 'claude-subscription', family: 'subscription', harnessOnly: 'claude' } },
  ],
  bootstraps: [],
  compatibility: { claude: ['ollama', 'claude-subscription'], pi: ['nvidia-nim', 'ollama'], direct: ['nvidia-nim', 'ollama'] },
  effortLevels: {},
  effortLevelsByModel: {},
  presets: [
    { id: 'claude-code', name: 'Claude Code', harnessId: 'claude', credentialBootstrapId: 'corp-auth' },
    { id: 'nvidia', name: 'NVIDIA', type: 'api' },
  ],
};

const RUNTIMES = {
  pi: { id: 'pi', label: 'Pi Coding Agent CLI', vendor: 'pi', installed: false, installable: true, blockedReason: null },
  claude: { id: 'claude', label: 'Claude Code CLI', vendor: 'claude', installed: true, installable: true, blockedReason: null },
};

const LocationProbe = () => <pre data-testid="location">{useLocation().pathname}</pre>;

// The page derives `selectedHarnessId` from the route param; here it is a
// prop, so the tab is mounted on both routes with whatever the case passes.
const renderTab = (path = '/ai/harnesses', props = {}) => {
  const tab = (
    <>
      <ProviderHarnessesTab runtimes={RUNTIMES} selectedHarnessId={props.selectedHarnessId ?? null} onInstallRuntime={props.onInstallRuntime || vi.fn()} />
      <LocationProbe />
    </>
  );
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/ai/harnesses" element={tab} />
        <Route path="/ai/harnesses/:harnessId" element={tab} />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetProviderCatalogCache();
  api.getProviderCatalog.mockResolvedValue(CATALOG);
  api.getProviderBootstraps.mockResolvedValue({ bootstraps: {} });
  api.getHarnesses.mockResolvedValue({ harnesses: [] });
  api.refreshHarnessModels.mockResolvedValue({ models: [], updated: [] });
});

describe('ProviderHarnessesTab', () => {
  it('renders one card per harness with its methods, compatible-service count and preset count', async () => {
    renderTab();
    expect(await screen.findByRole('heading', { name: /Claude Code/ })).toBeInTheDocument();
    const claude = screen.getByRole('article', { name: /Claude Code/ });
    expect(claude).toHaveTextContent('2 compatible services');
    expect(claude).toHaveTextContent('1 preset');
    expect(claude).toHaveTextContent('Installed · 2.1.0');
    // The subscription only this program reaches is named with its state and linked.
    expect(within(claude).getByRole('link', { name: 'Claude subscription' })).toHaveAttribute('href', '/ai/services/claude-subscription');
    expect(claude).toHaveTextContent('ready to run');
    const pi = screen.getByRole('article', { name: /^Pi/ });
    expect(pi).toHaveTextContent('2 compatible services');
    expect(pi).toHaveTextContent('Binary not found');
    // Direct API presets count under the direct harness even without a harnessId stamp.
    expect(screen.getByRole('article', { name: /Direct API/ })).toHaveTextContent('1 preset');
  });

  it('offers no switch on the direct harness — it is always on', async () => {
    renderTab();
    await screen.findByRole('heading', { name: /Direct API/ });
    expect(screen.getByRole('article', { name: /Direct API/ })).toHaveTextContent('Always on');
    // Two switches: Claude Code and Pi. None for Direct API.
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('toggling a harness writes its enablement and re-reads the catalog for every picker', async () => {
    api.setProviderHarnessEnabled.mockResolvedValue({ harness: { id: 'pi', enabled: true, source: 'setting' } });
    const enabled = { ...CATALOG, harnesses: CATALOG.harnesses.map((h) => (h.id === 'pi' ? { ...h, enabled: true } : h)) };
    renderTab();
    const pi = await screen.findByRole('article', { name: /^Pi/ });
    const toggle = within(pi).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    api.getProviderCatalog.mockResolvedValue(enabled);
    fireEvent.click(toggle);

    await waitFor(() => expect(api.setProviderHarnessEnabled).toHaveBeenCalledWith('pi', true, { silent: true }));
    // Second catalog fetch = the invalidation reached the shared hook.
    await waitFor(() => expect(api.getProviderCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(pi).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Pi enabled/));
  });

  it('keeps the switch where it was when the write fails', async () => {
    api.setProviderHarnessEnabled.mockRejectedValue(new Error('boom'));
    renderTab();
    const pi = await screen.findByRole('article', { name: /^Pi/ });
    fireEvent.click(within(pi).getByRole('switch'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Could not enable Pi/)));
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(1);
    expect(within(pi).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('offers the install for a missing binary whose runtime row allows it', async () => {
    const onInstallRuntime = vi.fn();
    renderTab('/ai/harnesses', { onInstallRuntime });
    fireEvent.click(await screen.findByRole('button', { name: 'Install Pi Coding Agent CLI' }));
    expect(onInstallRuntime).toHaveBeenCalledWith(RUNTIMES.pi);
    // An installed harness offers no install.
    expect(screen.queryByRole('button', { name: /Install Claude/ })).not.toBeInTheDocument();
  });

  it('bounces a deep link to an unknown harness back to the list', async () => {
    renderTab('/ai/harnesses/nope', { selectedHarnessId: 'nope' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No harness with id "nope"'));
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/harnesses');
  });

  it('shows the installed and latest versions, and package name from details', async () => {
    api.getHarnesses.mockResolvedValue({
      harnesses: [{
        id: 'claude',
        vendor: 'claude',
        label: 'Claude Code CLI',
        command: 'claude',
        installed: true,
        version: '2.1.0',
        latestVersion: '2.2.0',
        package: '@anthropic-ai/claude-code',
        updateAvailable: true,
        updatable: true,
        removable: true,
        listsModels: true,
        providers: [{ id: 'claude-code', name: 'Claude Code', enabled: true }],
      }],
    });
    renderTab();
    const claude = await screen.findByRole('article', { name: /Claude Code/ });
    expect(await within(claude).findByText(/Installed 2\.1\.0/)).toBeInTheDocument();
    expect(within(claude).getByText(/Latest 2\.2\.0/)).toBeInTheDocument();
    expect(within(claude).getByText(/@anthropic-ai\/claude-code/)).toBeInTheDocument();
    expect(within(claude).getByText('Update available')).toBeInTheDocument();
  });

  it('opens the shared install modal for update action', async () => {
    api.getHarnesses.mockResolvedValue({
      harnesses: [{
        id: 'claude',
        vendor: 'claude',
        label: 'Claude Code CLI',
        command: 'claude',
        installed: true,
        version: '2.1.0',
        latestVersion: '2.2.0',
        updateAvailable: true,
        updatable: true,
      }],
    });
    renderTab();
    const claude = await screen.findByRole('article', { name: /Claude Code/ });
    fireEvent.click(await within(claude).findByRole('button', { name: /Update/ }));
    expect(await screen.findByTestId('install-modal')).toHaveTextContent('claude · update');
  });

  it('confirms a removal inline before opening the stream with uninstall', async () => {
    api.getHarnesses.mockResolvedValue({
      harnesses: [{
        id: 'claude',
        vendor: 'claude',
        label: 'Claude Code CLI',
        command: 'claude',
        installed: true,
        version: '2.1.0',
        removable: true,
        providers: [{ id: 'claude-code', name: 'Claude Code', enabled: true }],
      }],
    });
    renderTab();
    const claude = await screen.findByRole('article', { name: /Claude Code/ });
    fireEvent.click(await within(claude).findByRole('button', { name: /Remove/ }));
    expect(screen.queryByTestId('install-modal')).not.toBeInTheDocument();
    expect(within(claude).getByText(/1 provider use `claude`/)).toBeInTheDocument();

    const [, confirm] = within(claude).getAllByRole('button', { name: 'Remove' });
    fireEvent.click(confirm);
    expect(await screen.findByTestId('install-modal')).toHaveTextContent('claude · uninstall');
  });

  it('refreshes harness models and renders the report banner', async () => {
    api.getHarnesses.mockResolvedValue({
      harnesses: [{
        id: 'claude',
        vendor: 'claude',
        label: 'Claude Code CLI',
        command: 'claude',
        installed: true,
        listsModels: true,
      }],
    });
    api.refreshHarnessModels.mockResolvedValue({
      models: ['claude-3-7-sonnet', 'claude-3-5-haiku'],
      updated: ['claude-code'],
    });
    renderTab();
    const claude = await screen.findByRole('article', { name: /Claude Code/ });
    fireEvent.click(await within(claude).findByRole('button', { name: /Refresh models/ }));

    expect(await within(claude).findByText(/2 models from claude → 1 provider updated/)).toBeInTheDocument();
  });

  it('re-checks with fresh: true and invalidates catalog cache', async () => {
    renderTab();
    await screen.findByRole('heading', { name: /Claude Code/ });
    fireEvent.click(screen.getByRole('button', { name: /Re-check/ }));
    await waitFor(() => expect(api.getHarnesses).toHaveBeenCalledWith(expect.objectContaining({ fresh: true })));
    await waitFor(() => expect(api.getProviderCatalog).toHaveBeenCalledTimes(2));
  });
});

describe('credential bootstraps section', () => {
  it('stays collapsed and empty-state-only until one exists', async () => {
    renderTab();
    const header = await screen.findByRole('button', { name: /Credential bootstraps/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveTextContent('None configured');
  });

  it('saves the whole table with the new app folded in, then re-reads the catalog', async () => {
    api.getProviderBootstraps.mockResolvedValue({
      bootstraps: { 'corp-auth': { label: 'Corp auth', command: 'corp-auth', args: ['run'], harnessNames: { claude: 'claude-code' } } },
    });
    api.saveProviderBootstraps.mockImplementation(async (bootstraps) => ({ bootstraps }));
    renderTab();
    const header = await screen.findByRole('button', { name: /Credential bootstraps/ });
    // The table arrives after mount; the section opens once it holds a row.
    await waitFor(() => expect(header).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByText('Corp auth').closest('li')).toHaveTextContent('Used by 1 preset');

    fireEvent.click(screen.getByRole('button', { name: 'Add bootstrap' }));
    fireEvent.change(screen.getByLabelText(/Slug/), { target: { value: 'vault' } });
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: 'Vault wrapper' } });
    fireEvent.change(screen.getByLabelText(/Command/), { target: { value: 'vault-exec' } });
    fireEvent.change(screen.getByLabelText(/Arguments/), { target: { value: 'run --' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add bootstrap' }));

    await waitFor(() => expect(api.saveProviderBootstraps).toHaveBeenCalledWith({
      'corp-auth': { label: 'Corp auth', command: 'corp-auth', args: ['run'], harnessNames: { claude: 'claude-code' } },
      vault: { label: 'Vault wrapper', command: 'vault-exec', args: ['run', '--'] },
    }, { silent: true }));
    await waitFor(() => expect(api.getProviderCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Vault wrapper')).toBeInTheDocument();
  });

  it('refuses a slug the composite grammar cannot carry', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Credential bootstraps/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add bootstrap' }));
    fireEvent.change(await screen.findByLabelText(/Slug/), { target: { value: 'Bad Slug' } });
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/Command/), { target: { value: 'x' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Add bootstrap' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/slug is lowercase/)));
    expect(api.saveProviderBootstraps).not.toHaveBeenCalled();
  });
});
