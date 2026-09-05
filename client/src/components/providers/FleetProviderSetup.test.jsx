import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import FleetProviderSetup from './FleetProviderSetup';

const api = vi.hoisted(() => ({
  revealFleetPeerHostKey: vi.fn(),
  getFleetLlmHost: vi.fn().mockResolvedValue({}),
  revealFleetLlmHostKey: vi.fn().mockResolvedValue({ apiKey: 'k' }),
}));
vi.mock('../../services/apiProviders', () => api);

const peers = [
  { id: 'peer-1', name: 'Workstation GPU', host: 'workstation.tailnet.ts.net', enabled: true },
  { id: 'peer-2', name: 'MacBook', address: '100.64.0.2', enabled: true },
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
});
