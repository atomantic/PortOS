/**
 * The connection-management surface, rendered (#6369).
 *
 * What only a rendered test can prove: that the screen a human actually uses
 * carries the promises the server enforces — one backend edit reported as
 * reaching every harness on it, a narrowed catalog that sends the SUBSET rather
 * than a toggle, a pin the catalog no longer offers shown instead of dropped,
 * a failed refresh that keeps the old models, and an older server answering
 * "no such API" degrading to a message instead of an error state.
 *
 * Fixtures are synthetic. Nothing here is read out of a running install.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviderManagementGraph: vi.fn(),
  updateProviderConnection: vi.fn(),
  updateProviderBinding: vi.fn(),
  refreshProviderConnectionModels: vi.fn(),
  previewProviderBindingLink: vi.fn(),
  linkProviderBinding: vi.fn(),
  unlinkProviderBinding: vi.fn(),
  deleteProviderConnection: vi.fn(),
  setActiveProvider: vi.fn(),
  isManagementUnsupported: (error) => error?.status === 404 || error?.code === 'PROVIDER_GRAPH_UNAVAILABLE',
}));
vi.mock('../../services/api', () => api);

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));

const ProviderConnections = (await import('./ProviderConnections')).default;

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLAUDE_BINDING = '33333333-3333-4333-8333-333333333333';

const graphFixture = () => ({
  schemaVersion: 1,
  activeProvider: 'claude-ollama',
  connections: [
    {
      id: CONNECTION,
      revision: 3,
      kind: 'ollama',
      label: 'Example local daemon',
      transports: { anthropic: { baseUrl: 'http://127.0.0.1:11434' } },
      hasCredentials: true,
      catalog: { state: 'known', models: ['example-model', 'other-model'] },
    },
    {
      id: OTHER,
      revision: 1,
      kind: 'ollama',
      label: 'Remote daemon',
      transports: { anthropic: { baseUrl: 'https://ollama.example.com' } },
      hasCredentials: false,
      catalog: { state: 'unknown', models: [] },
    },
  ],
  bindings: [{
    id: CLAUDE_BINDING, revision: 4, connectionId: CONNECTION, harnessId: 'claude',
    variantKey: 'default', label: '', enabled: true,
    // `retired-model` is gone from the catalog above — a stale pin, on purpose.
    selectedModels: ['example-model', 'retired-model'],
    blocked: false,
  }],
  routes: [
    { providerId: 'claude-ollama', bindingId: CLAUDE_BINDING, mode: 'cli', modelMap: {}, projectionPending: false },
    { providerId: 'claude-ollama-tui', bindingId: CLAUDE_BINDING, mode: 'tui', modelMap: {}, projectionPending: false },
  ],
});

const renderPanel = (props = {}) => render(
  <MemoryRouter>
    <ProviderConnections
      open
      connectionId={CONNECTION}
      onClose={() => {}}
      onSelectConnection={() => {}}
      {...props}
    />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getProviderManagementGraph.mockResolvedValue(graphFixture());
});

describe('backend connection management', () => {
  it('shows one backend with the harness routes that share it, and never a secret', async () => {
    renderPanel();

    expect(await screen.findByText('Example local daemon')).toBeInTheDocument();
    // The harness label comes from the mirrored registry, not a raw id.
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    // Both executable routes on that one backend are listed and deep-linkable.
    expect(screen.getByRole('link', { name: 'claude-ollama' })).toHaveAttribute('href', '/ai/edit/claude-ollama');
    expect(screen.getByRole('link', { name: 'claude-ollama-tui' })).toBeInTheDocument();
    // Presence only. The field is a placeholder, never a value to leak or resend.
    expect(screen.getByLabelText(/API key/)).toHaveValue('');
  });

  it('sends the connection revision it was showing, so a moved row is refused', async () => {
    api.updateProviderConnection.mockResolvedValue({ affectedRouteIds: ['claude-ollama', 'claude-ollama-tui'] });
    renderPanel();

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed daemon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save backend' }));

    await waitFor(() => expect(api.updateProviderConnection).toHaveBeenCalled());
    const [id, body] = api.updateProviderConnection.mock.calls[0];
    expect(id).toBe(CONNECTION);
    expect(body.expectedRevision).toBe(3);
    expect(body.label).toBe('Renamed daemon');
    // Omitted, not sent blank — the browser never had the secret to resend.
    expect(body).not.toHaveProperty('credentials');
  });

  it('reports how many routes a single backend edit moved', async () => {
    api.updateProviderConnection.mockResolvedValue({ affectedRouteIds: ['claude-ollama', 'claude-ollama-tui'] });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Save backend' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('2 route(s)')));
  });

  it('saves a narrowed catalog as the resulting SUBSET, not a toggle', async () => {
    api.updateProviderBinding.mockResolvedValue({ selectedModels: ['example-model'] });
    renderPanel();

    // `other-model` is in the catalog but not selected; checking it adds it.
    fireEvent.click(await screen.findByLabelText('other-model'));

    await waitFor(() => expect(api.updateProviderBinding).toHaveBeenCalled());
    const [bindingId, body] = api.updateProviderBinding.mock.calls[0];
    expect(bindingId).toBe(CLAUDE_BINDING);
    expect(body.expectedRevision).toBe(4);
    expect(body.selectedModels).toEqual(['example-model', 'other-model']);
  });

  it('shows a pin the catalog no longer offers instead of dropping it', async () => {
    renderPanel();
    expect(await screen.findByText(/Still selected but not in the current catalog: retired-model/))
      .toBeInTheDocument();
  });

  it('keeps the previous models visible when a refresh fails', async () => {
    api.refreshProviderConnectionModels.mockResolvedValue({
      catalog: { state: 'failed', models: ['example-model', 'other-model'], error: 'connect ECONNREFUSED' },
    });
    api.getProviderManagementGraph.mockResolvedValue({
      ...graphFixture(),
      connections: graphFixture().connections.map((connection) => (connection.id === CONNECTION
        ? { ...connection, catalog: { state: 'failed', models: ['example-model', 'other-model'], error: 'connect ECONNREFUSED' } }
        : connection)),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Refresh models/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('connect ECONNREFUSED'));
    // Not "0 models" — the distinction the catalog state exists to preserve.
    expect(await screen.findByText(/showing 2 previously known models/)).toBeInTheDocument();
  });

  it('previews a link before applying it, and applies with the reviewed revisions', async () => {
    api.previewProviderBindingLink.mockResolvedValue({
      revisions: { binding: 4, sourceConnection: 3, targetConnection: 1 },
      affectedRouteIds: ['claude-ollama', 'claude-ollama-tui'],
      differences: ['credentials'],
      unionModels: ['example-model'],
    });
    api.linkProviderBinding.mockResolvedValue({ affectedRouteIds: ['claude-ollama', 'claude-ollama-tui'] });
    renderPanel();

    fireEvent.change(await screen.findByLabelText('Move this harness to another backend'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    expect(await screen.findByText(/differ in: credentials/)).toBeInTheDocument();
    // Nothing is written by looking.
    expect(api.linkProviderBinding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply link' }));
    await waitFor(() => expect(api.linkProviderBinding).toHaveBeenCalled());
    expect(api.linkProviderBinding.mock.calls[0][1]).toEqual({
      targetConnectionId: OTHER,
      expectedRevisions: { binding: 4, sourceConnection: 3, targetConnection: 1 },
    });
  });

  it('degrades to a message on a server without the management API', async () => {
    api.getProviderManagementGraph.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    renderPanel();

    expect(await screen.findByText(/does not expose connection management/)).toBeInTheDocument();
  });

  it('keeps a real failure a real failure', async () => {
    api.getProviderManagementGraph.mockRejectedValue(
      Object.assign(new Error('Database is on fire'), { status: 500 }),
    );
    renderPanel();

    expect(await screen.findByText('Database is on fire')).toBeInTheDocument();
    expect(screen.queryByText(/does not expose connection management/)).not.toBeInTheDocument();
  });
});

describe('the empty-selection inversion', () => {
  it('refuses to clear the last model, because `[]` means the whole catalog', async () => {
    renderPanel();

    // `example-model` is the only CATALOG entry currently selected (the other
    // selection, `retired-model`, is stale and not offered), so unchecking it
    // would send `[]` — read by every consumer as "offer everything".
    fireEvent.click(await screen.findByLabelText('example-model'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('at least one model')));
    expect(api.updateProviderBinding).not.toHaveBeenCalled();
  });
});
