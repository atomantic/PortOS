import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
const api = vi.hoisted(() => ({
  getFleetLlmHost: vi.fn(),
  getFleetPeerHosts: vi.fn(),
  revealFleetLlmHostKey: vi.fn(),
}));
vi.mock('../../services/apiProviders', () => api);
vi.mock('../install/RuntimeInstallModal', () => ({ default: ({ open, installUrlBase, streamMethod }) => open ? <div data-testid="setup" data-url={installUrlBase} data-method={streamMethod} /> : null }));
import FleetHostSetup from './FleetHostSetup';
const state = {
 recommendation: { supported: true, title: 'Qwen3.8-27B · vLLM + DFlash 2', reason: 'Validated RTX 3090 recipe' },
 specs: { platform: 'win32', totalMemoryGb: 32, cuda: { gpus: [{ name: 'RTX 3090', vramGb: 24 }] } },
 checks: [{ id: 'docker', label: 'Docker engine responding', ok: false, detail: 'Restart Docker Desktop' }],
 endpoint: 'http://host-XXXX.example.ts.net:18022/v1', model: 'qwen3.8-27b', hasApiKey: true,
 queue: { active: 0, queued: 0, maxActive: 1, maxQueued: 16 },
};
describe('dedicated model host setup', () => {
 it('shows hardware and blockers, starts setup only on click and reveals credentials only on request', async () => {
  api.getFleetLlmHost.mockResolvedValue(state);
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  api.revealFleetLlmHostKey.mockResolvedValue({ apiKey: 'example-private-token' });
  render(<MemoryRouter><FleetHostSetup /></MemoryRouter>);
  expect(await screen.findByText(/32 GB RAM/)).toBeInTheDocument();
  expect(screen.getByText('Restart Docker Desktop')).toBeInTheDocument();
  expect(screen.queryByTestId('setup')).not.toBeInTheDocument();
  expect(api.revealFleetLlmHostKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Set up dedicated host/ }));
  expect(screen.getByTestId('setup')).toHaveAttribute('data-method', 'POST');
  expect(screen.getByTestId('setup')).toHaveAttribute('data-url', '/api/providers/fleet-host/setup');
  fireEvent.click(screen.getByRole('button', { name: 'Reveal host API key' }));
  expect(await screen.findByText('example-private-token')).toBeInTheDocument();
 });
 it('keeps unsupported hardware on a connection path without offering the CUDA installer', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, recommendation: { supported: false, title: 'Connect to a model host' } });
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  render(<MemoryRouter><FleetHostSetup /></MemoryRouter>);
  await screen.findByText('Connect to a model host');
  expect(screen.queryByRole('button', { name: /Set up dedicated host/ })).not.toBeInTheDocument();
 });

 it('prompts to setup an available peer host when not yet configured', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, serving: false });
  api.getFleetPeerHosts.mockResolvedValue({
   hosts: [
    {
     peerId: 'peer-42',
     peerName: 'Dedicated GPU Box',
     endpoint: 'http://gpu-box.ts.net:18022/v1',
     model: 'qwen3.8-27b',
     serving: true,
    },
   ],
  });
  render(<MemoryRouter><FleetHostSetup compact providers={[]} /></MemoryRouter>);
  expect(await screen.findByText(/Available federated host:/)).toBeInTheDocument();
  expect(screen.getAllByText('Dedicated GPU Box').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText(/Set it up as a provider on this machine\?/)).toBeInTheDocument();
  const setupLink = screen.getByRole('link', { name: 'Set up as provider' });
  expect(setupLink).toHaveAttribute('href', '/ai/fleet?fleetStep=client&peerId=peer-42');
 });

 it('does not prompt when the peer host is already configured as a provider', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, serving: false });
  api.getFleetPeerHosts.mockResolvedValue({
   hosts: [
    {
     peerId: 'peer-42',
     peerName: 'Dedicated GPU Box',
     endpoint: 'http://gpu-box.ts.net:18022/v1',
     model: 'qwen3.8-27b',
     serving: true,
    },
   ],
  });
  const providers = [
   { id: 'fleet-p1', endpoint: 'http://gpu-box.ts.net:18022/v1' },
  ];
  render(<MemoryRouter><FleetHostSetup compact providers={providers} /></MemoryRouter>);
  expect(await screen.findByText('Recommended model host setup')).toBeInTheDocument();
  expect(screen.queryByText(/Available federated host:/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Set up as provider' })).not.toBeInTheDocument();
 });
});

