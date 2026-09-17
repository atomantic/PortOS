import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router';
import useProviderCatalog, { __resetProviderCatalogCache } from '../../hooks/useProviderCatalog';

/**
 * AI Providers → Services (#7567). What only this boundary pins: the list
 * contacts no provider on mount (catalog refresh is the one explicit outbound
 * action), a toggle and an edit go through the revision-gated PATCH and
 * re-read the composition catalog, the add drawer walks definition → plan →
 * credential/endpoint and lands on the new card, and a service with presets
 * on it offers no delete.
 */

const api = vi.hoisted(() => ({
  getProviderCatalog: vi.fn(),
  createProviderPreset: vi.fn(),
  getProviderServices: vi.fn(),
  getProviderServiceDefinitions: vi.fn(),
  createProviderService: vi.fn(),
  updateProviderService: vi.fn(),
  deleteProviderService: vi.fn(),
  refreshProviderServiceCatalog: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));

import ProviderServicesTab from './ProviderServicesTab';

const nvidia = {
  id: 'uuid-nvidia', revision: 3, kind: 'gateway:nvidia-nim', label: 'NVIDIA NIM', slug: 'nvidia-nim', definitionId: 'nvidia-nim',
  plan: 'free', enabled: true, credentialVia: 'stored', hasCredentials: false, credentialSource: 'none', bindingCount: 0,
  readiness: 'needs-credential',
  transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } },
  catalog: { state: 'unknown', models: [] },
  definition: { id: 'nvidia-nim', label: 'NVIDIA NIM', family: 'api-key', plans: ['free', 'paid'], catalogStrategy: 'probe', harnessOnly: null, keyUrl: 'https://build.nvidia.com', envVars: ['NVIDIA_API_KEY'] },
};
const ollama = {
  id: 'uuid-ollama', revision: 1, kind: 'ollama', label: 'Ollama', slug: 'ollama', definitionId: 'ollama',
  plan: 'local', enabled: true, credentialVia: 'stored', hasCredentials: false, credentialSource: 'none', bindingCount: 2,
  readiness: 'ready',
  transports: { openai: { baseUrl: 'http://localhost:11434/v1' } },
  catalog: { state: 'known', models: ['qwen3:8b', 'llama3:8b'] },
  definition: { id: 'ollama', label: 'Ollama', family: 'local', plans: ['local'], catalogStrategy: 'daemon', harnessOnly: null, keyUrl: null, envVars: [] },
};

const PRESETS = [
  { id: 'claude-ollama', name: 'Claude Ollama', serviceId: 'ollama' },
  { id: 'opencode-ollama', name: 'OpenCode Ollama', serviceId: 'ollama' },
];

const Probe = () => <pre data-testid="location">{useLocation().pathname}</pre>;
// A stand-in for any open picker: mounted beside the tab, it must re-read the
// composition catalog after a service write without being told.
const PickerProbe = () => { useProviderCatalog(); return null; };

function Host({ presets = PRESETS, onChanged = vi.fn() }) {
  const { serviceSlug } = useParams();
  const { pathname } = useLocation();
  return (
    <>
      <ProviderServicesTab
        selectedServiceSlug={serviceSlug || null}
        creating={pathname.endsWith('/new')}
        presets={presets}
        readiness={{}}
        readinessActions={{}}
        onChanged={onChanged}
      />
      <Probe />
      <PickerProbe />
    </>
  );
}

const renderTab = (path = '/ai/services', props = {}) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/ai/services" element={<Host {...props} />} />
      <Route path="/ai/services/new" element={<Host {...props} />} />
      <Route path="/ai/services/:serviceSlug" element={<Host {...props} />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  __resetProviderCatalogCache();
  api.getProviderCatalog.mockResolvedValue({ harnesses: [], services: [], bootstraps: [], compatibility: {}, effortLevels: {}, effortLevelsByModel: {}, presets: [] });
  api.getProviderServices.mockResolvedValue({ services: [nvidia, ollama] });
});

describe('ProviderServicesTab', () => {
  it('lists every instance with plan, readiness and catalog state, and contacts no provider on mount', async () => {
    renderTab();
    const card = await screen.findByRole('article', { name: /NVIDIA NIM/ });
    expect(card).toHaveTextContent('free');
    expect(card).toHaveTextContent('Needs a credential');
    expect(card).toHaveTextContent('Not refreshed yet');
    expect(screen.getByRole('article', { name: /Ollama/ })).toHaveTextContent('2 models');
    expect(api.refreshProviderServiceCatalog).not.toHaveBeenCalled();
  });

  it('opens the card the URL names, links a key source, and lists the presets on it', async () => {
    renderTab('/ai/services/ollama');
    const card = await screen.findByRole('article', { name: /Ollama/ });
    expect(within(card).getByRole('button', { name: /Ollama/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(card).getByRole('link', { name: 'Claude Ollama' })).toHaveAttribute('href', '/ai/presets/claude-ollama');
    // Presets still name this service, so it cannot be deleted.
    expect(within(card).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    // The keyed vendor with no key offers where to get one.
    fireEvent.click(within(screen.getByRole('article', { name: /NVIDIA NIM/ })).getByRole('button', { name: /NVIDIA NIM/ }));
    expect(await screen.findByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://build.nvidia.com');
  });

  it('refreshes a catalog only on the explicit click, re-derives presets and re-reads the composition catalog', async () => {
    const onChanged = vi.fn();
    api.refreshProviderServiceCatalog.mockResolvedValue({ service: { ...ollama, revision: 2, catalog: { state: 'known', models: ['qwen3:8b', 'llama3:8b', 'phi4'] } } });
    renderTab('/ai/services/ollama', { onChanged });
    fireEvent.click(await screen.findByRole('button', { name: /Refresh catalog/ }));
    await waitFor(() => expect(api.refreshProviderServiceCatalog).toHaveBeenCalledWith('ollama', { silent: true }));
    expect(await screen.findByText(/3 models/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    // The picker probe re-read the catalog: one fetch on mount, one after the write.
    await waitFor(() => expect(api.getProviderCatalog).toHaveBeenCalledTimes(2));
  });

  it('keeps the previous catalog and says so when a refresh fails', async () => {
    api.refreshProviderServiceCatalog.mockResolvedValue({ service: { ...ollama, catalog: { state: 'failed', models: ollama.catalog.models, error: 'daemon not running' } } });
    renderTab('/ai/services/ollama');
    fireEvent.click(await screen.findByRole('button', { name: /Refresh catalog/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('daemon not running'));
    expect(screen.getByRole('article', { name: /Ollama/ })).toHaveTextContent('Last refresh failed — showing 2 previously known models');
  });

  it('toggles an instance through the revision-gated PATCH', async () => {
    api.updateProviderService.mockResolvedValue({ service: { ...nvidia, revision: 4, enabled: false, readiness: 'disabled' } });
    renderTab();
    const card = await screen.findByRole('article', { name: /NVIDIA NIM/ });
    fireEvent.click(within(card).getByRole('switch'));
    await waitFor(() => expect(api.updateProviderService).toHaveBeenCalledWith('nvidia-nim', { expectedRevision: 3, enabled: false }, { silent: true }));
    await waitFor(() => expect(card).toHaveTextContent('Switched off'));
  });

  it('saves label, endpoint and a new key together, never echoing a stored key', async () => {
    api.updateProviderService.mockResolvedValue({ service: { ...nvidia, revision: 4, label: 'NVIDIA (free)', hasCredentials: true, credentialSource: 'settings', readiness: 'ready' } });
    renderTab('/ai/services/nvidia-nim');
    const card = await screen.findByRole('article', { name: /NVIDIA NIM/ });
    fireEvent.change(within(card).getByLabelText('Name'), { target: { value: 'NVIDIA (free)' } });
    fireEvent.change(within(card).getByLabelText(/API key/), { target: { value: 'nvapi-example' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save service' }));
    await waitFor(() => expect(api.updateProviderService).toHaveBeenCalledWith('nvidia-nim', {
      expectedRevision: 3,
      label: 'NVIDIA (free)',
      transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } },
      credentials: { apiKey: 'nvapi-example' },
    }, { silent: true }));
    expect(await screen.findByText('Key stored on this service')).toBeInTheDocument();
  });

  it('deletes an unused instance and returns to the list', async () => {
    api.deleteProviderService.mockResolvedValue({ deleted: true });
    renderTab('/ai/services/nvidia-nim');
    const card = await screen.findByRole('article', { name: /NVIDIA NIM/ });
    fireEvent.click(within(card).getByRole('button', { name: /Delete/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Delete service' }));
    await waitFor(() => expect(api.deleteProviderService).toHaveBeenCalledWith('nvidia-nim', { silent: true }));
    await waitFor(() => expect(screen.queryByRole('article', { name: /NVIDIA NIM/ })).not.toBeInTheDocument());
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/services');
  });

  it('bounces a deep link to an unknown service back to the list', async () => {
    renderTab('/ai/services/nope');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No service with id "nope"'));
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/services');
  });
});

describe('add service drawer', () => {
  const definitions = [
    { id: 'nvidia-nim', label: 'NVIDIA NIM', family: 'api-key', plans: ['free', 'paid'], catalogStrategy: 'probe', harnessOnly: null, keyUrl: 'https://build.nvidia.com', envVars: ['NVIDIA_API_KEY'], transports: { openai: { defaultBaseUrl: 'https://integrate.api.nvidia.com/v1' } } },
    { id: 'lmstudio', label: 'LM Studio', family: 'local', plans: ['local'], catalogStrategy: 'daemon', harnessOnly: null, keyUrl: null, envVars: [], transports: { openai: { defaultBaseUrl: null } } },
    { id: 'claude-subscription', label: 'Claude subscription', family: 'subscription', plans: ['subscription'], catalogStrategy: 'harness', harnessOnly: 'claude', keyUrl: null, envVars: [], transports: {} },
  ];

  beforeEach(() => {
    api.getProviderServiceDefinitions.mockResolvedValue({ definitions });
  });

  it('walks definition → plan → credential and lands on the new card', async () => {
    api.createProviderService.mockResolvedValue({ service: { ...nvidia, id: 'uuid-2', slug: 'nvidia-nim-paid', label: 'NVIDIA paid', plan: 'paid', hasCredentials: true, credentialSource: 'settings', readiness: 'ready' } });
    renderTab('/ai/services/new');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Service \*/), { target: { value: 'nvidia-nim' } });
    fireEvent.change(within(dialog).getByLabelText(/Plan \*/), { target: { value: 'paid' } });
    fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'nvapi-example' } });
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'NVIDIA paid' } });
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: 'nvidia-nim-paid' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add service' }));
    await waitFor(() => expect(api.createProviderService).toHaveBeenCalledWith({
      definitionId: 'nvidia-nim',
      plan: 'paid',
      label: 'NVIDIA paid',
      slug: 'nvidia-nim-paid',
      transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } },
      credentialVia: 'stored',
      credentials: { apiKey: 'nvapi-example' },
    }, { silent: true }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/ai/services/nvidia-nim-paid'));
    expect(await screen.findByRole('article', { name: /NVIDIA paid/ })).toBeInTheDocument();
    expect(api.refreshProviderServiceCatalog).not.toHaveBeenCalled();
  });

  it('demands an endpoint for a local runtime that declares no default, and none for a subscription', async () => {
    renderTab('/ai/services/new');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Service \*/), { target: { value: 'lmstudio' } });
    expect(within(dialog).getByLabelText(/openai endpoint \*/)).toBeRequired();
    expect(within(dialog).queryByLabelText('API key')).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/Service \*/), { target: { value: 'claude-subscription' } });
    expect(within(dialog).queryByLabelText(/endpoint/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Sign-in lives inside the claude program/)).toBeInTheDocument();
  });
});
