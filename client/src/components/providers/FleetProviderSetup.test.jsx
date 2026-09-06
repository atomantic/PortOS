import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import FleetProviderSetup from './FleetProviderSetup';

const api = vi.hoisted(() => ({
  revealFleetPeerHostKey: vi.fn(),
  getFleetLlmHost: vi.fn().mockResolvedValue({}),
  revealFleetLlmHostKey: vi.fn().mockResolvedValue({ apiKey: 'k' }),
}));
vi.mock('../../services/apiProviders', () => api);

const existingProviders = [
  { id: 'opencode-1', name: 'My OpenCode', type: 'tui', command: 'opencode', envVars: { OTHER_VAR: '1' }, models: ['old-model'] },
  { id: 'claude-tui-1', name: 'My Claude Code', type: 'tui', command: 'claude' },
];

const peers = [
  { id: 'peer-1', name: 'Workstation GPU', host: 'workstation.tailnet.ts.net', enabled: true },
  { id: 'peer-2', name: 'MacBook', address: '192.168.1.50', enabled: true },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FleetProviderSetup', () => {
  it('pre-selects peer from URL search params on client tab', async () => {
    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&peerId=peer-1']}>
        <FleetProviderSetup peers={peers} onClose={() => {}} onCreate={vi.fn()} />
      </MemoryRouter>
    );

    const peerSelect = await screen.findByLabelText('Known PortOS peer');
    expect(peerSelect.value).toBe('peer-1');

    const endpointInput = screen.getByLabelText('GPU host endpoint');
    expect(endpointInput.value).toBe('http://workstation.tailnet.ts.net:18022/v1');
  });

  it('auto-fetches the API key as soon as a peer is selected from the URL, with no extra click', async () => {
    api.revealFleetPeerHostKey.mockResolvedValue({ apiKey: 'auto-fetched-key-123456789012' });

    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&peerId=peer-1']}>
        <FleetProviderSetup peers={peers} onClose={() => {}} onCreate={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(api.revealFleetPeerHostKey).toHaveBeenCalledWith('peer-1', { silent: true });
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter host API key').value).toBe('auto-fetched-key-123456789012');
    });
  });

  it('auto-fetches the API key when a peer is chosen from the dropdown, not just from the URL', async () => {
    api.revealFleetPeerHostKey.mockResolvedValue({ apiKey: 'dropdown-fetched-key-12345678' });

    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client']}>
        <FleetProviderSetup peers={peers} onClose={() => {}} onCreate={vi.fn()} />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Known PortOS peer'), { target: { value: 'peer-2' } });

    await waitFor(() => {
      expect(api.revealFleetPeerHostKey).toHaveBeenCalledWith('peer-2', { silent: true });
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter host API key').value).toBe('dropdown-fetched-key-12345678');
    });
  });

  it('fetches API key from host when clicked', async () => {
    api.revealFleetPeerHostKey.mockResolvedValue({ apiKey: 'host-secret-key-123456789012' });

    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&peerId=peer-1']}>
        <FleetProviderSetup peers={peers} onClose={() => {}} onCreate={vi.fn()} />
      </MemoryRouter>
    );

    const fetchBtn = await screen.findByRole('button', { name: 'Fetch API key from host' });
    fireEvent.click(fetchBtn);

    await waitFor(() => {
      expect(api.revealFleetPeerHostKey).toHaveBeenCalledWith('peer-1', { silent: true });
    });

    const apiKeyInput = screen.getByPlaceholderText('Enter host API key');
    expect(apiKeyInput.value).toBe('host-secret-key-123456789012');
  });

  it('creates provider with correct options on submit', async () => {
    const onCreate = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();

    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&peerId=peer-1']}>
        <FleetProviderSetup peers={peers} onClose={onClose} onCreate={onCreate} />
      </MemoryRouter>
    );

    const apiKeyInput = await screen.findByPlaceholderText('Enter host API key');
    fireEvent.change(apiKeyInput, { target: { value: 'my-secret-key-at-least-24-characters' } });

    const submitBtn = screen.getByRole('button', { name: 'Create fleet provider' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Fleet GPU · OpenCode TUI',
          endpoint: 'http://workstation.tailnet.ts.net:18022/v1',
          apiKey: 'my-secret-key-at-least-24-characters',
          defaultModel: 'qwen3.8-27b',
          type: 'tui',
          vllmBacked: true,
        })
      );
    });
  });

  it('prefills this machine\'s own loopback endpoint and key in self-host mode', async () => {
    api.getFleetLlmHost.mockResolvedValue({ hasApiKey: true, model: 'qwen3.8-27b' });
    api.revealFleetLlmHostKey.mockResolvedValue({ apiKey: 'self-host-key-1234567890123456' });

    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&selfHost=1']}>
        <FleetProviderSetup onClose={() => {}} onCreate={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('GPU host endpoint').value).toBe('http://127.0.0.1:18022/v1');
    });
    expect(screen.getByPlaceholderText('Enter host API key').value).toBe('self-host-key-1234567890123456');
  });

  it('surfaces an error in self-host mode when the host has not been set up yet', async () => {
    api.getFleetLlmHost.mockResolvedValue({ hasApiKey: false });

    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&selfHost=1']}>
        <FleetProviderSetup onClose={() => {}} onCreate={vi.fn()} />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Complete Model host setup/)).toBeInTheDocument();
  });

  it('updates an existing provider in place instead of creating a new one when repointing', async () => {
    const onUpdate = vi.fn().mockResolvedValue({});
    const onCreate = vi.fn();
    const onClose = vi.fn();

    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&peerId=peer-1']}>
        <FleetProviderSetup peers={peers} providers={existingProviders} onClose={onClose} onCreate={onCreate} onUpdate={onUpdate} />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByLabelText('Provider'), { target: { value: 'opencode-1' } });
    fireEvent.change(screen.getByPlaceholderText('Enter host API key'), { target: { value: 'repoint-key-at-least-24-characters' } });

    fireEvent.click(screen.getByRole('button', { name: 'Update provider' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'opencode-1',
        expect.objectContaining({
          name: 'My OpenCode',
          apiKey: 'repoint-key-at-least-24-characters',
          type: 'tui',
          // The provider's other env var and previously-served model survive
          // the repoint instead of being clobbered by the fleet defaults.
          envVars: expect.objectContaining({ OTHER_VAR: '1' }),
          models: expect.arrayContaining(['old-model', 'qwen3.8-27b']),
        })
      );
    });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('does not offer a non-OpenCode TUI provider as a repoint target', async () => {
    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&peerId=peer-1']}>
        <FleetProviderSetup peers={peers} providers={existingProviders} onClose={() => {}} onCreate={vi.fn()} onUpdate={vi.fn()} />
      </MemoryRouter>
    );

    const providerSelect = await screen.findByLabelText('Provider');
    // buildFleetProvider always overwrites command/args/envVars with the
    // OpenCode wiring — repointing a Claude Code TUI provider here would
    // silently convert it into an OpenCode one out from under the user.
    expect(within(providerSelect).queryByText(/My Claude Code/)).not.toBeInTheDocument();
    expect(within(providerSelect).getByText(/My OpenCode/)).toBeInTheDocument();
  });

  it('resets name/model/harness back to defaults when switching from a selected target back to "create a new provider"', async () => {
    render(
      <MemoryRouter initialEntries={['/ai/fleet?fleetStep=client&peerId=peer-1']}>
        <FleetProviderSetup peers={peers} providers={existingProviders} onClose={() => {}} onCreate={vi.fn()} onUpdate={vi.fn()} />
      </MemoryRouter>
    );

    const providerSelect = await screen.findByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'opencode-1' } });
    expect(screen.getByDisplayValue('My OpenCode')).toBeInTheDocument();

    fireEvent.change(providerSelect, { target: { value: '' } });
    expect(screen.getByDisplayValue('Fleet GPU · OpenCode TUI')).toBeInTheDocument();
    expect(screen.getByDisplayValue('qwen3.8-27b')).toBeInTheDocument();
  });
});
