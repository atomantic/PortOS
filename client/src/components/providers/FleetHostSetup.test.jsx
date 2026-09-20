import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
const api = vi.hoisted(() => ({
  getFleetLlmHost: vi.fn(),
  getFleetLlmHostUsage: vi.fn(),
  getFleetPeerHosts: vi.fn(),
  revealFleetLlmHostKey: vi.fn(),
  stopFleetLlmHost: vi.fn(),
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
 // The banner names the page that manages the recommended runtime — on Apple
 // Silicon, "Use the managed MTPLX setup on Models → Runtimes" — so the button
 // under it has to open that page. It pointed at /models/llms, which #7414 left
 // holding the weights catalog and no server controls at all.
 it.each([
  ['mtplx', '/models/llms-runtimes'],
  // vLLM has no PortOS page of its own; the runtimes tab is still where every
  // local server this host CAN manage lives, so the button must not go dead.
  ['vllm', '/models/llms-runtimes'],
  [null, '/models/llms-runtimes'],
 ])('sends "Manage model servers" to the runtime surface for %s', async (runtime, href) => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, recommendation: { ...state.recommendation, runtime } });
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  render(<MemoryRouter><FleetHostSetup /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'Manage model servers' })).toHaveAttribute('href', href);
 });

 // The reported bug: the host was enabled from this page, the machine was
 // running and serving, and there was no control anywhere that turned it off.
 it('offers a two-step stop whenever there is something to turn off, and only acts on the second click', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, enabled: true, listening: true, serving: false, stoppable: true });
  api.getFleetLlmHostUsage.mockResolvedValue({ activeRequests: 0, clients: [], recent: [], totals: {}, queue: null });
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  api.stopFleetLlmHost.mockResolvedValue({ success: true, containerStopped: true });
  render(<MemoryRouter><FleetHostSetup /></MemoryRouter>);

  const arm = await screen.findByRole('button', { name: 'Stop model host' });
  fireEvent.click(arm);
  // Arming alone must not disconnect anyone.
  expect(api.stopFleetLlmHost).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Confirm stop/ }));
  await waitFor(() => expect(api.stopFleetLlmHost).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/image and weights are still on disk/)).toBeInTheDocument();
 });

 it('hides the stop control on a machine that has nothing hosting', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, enabled: false, listening: false, stoppable: false });
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  render(<MemoryRouter><FleetHostSetup /></MemoryRouter>);
  await screen.findByText(/32 GB RAM/);
  expect(screen.queryByRole('button', { name: 'Stop model host' })).not.toBeInTheDocument();
 });

 it('names the machines using this host, flagging one that matches no peer or tailnet node', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, enabled: true, listening: true, stoppable: true });
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  api.getFleetLlmHostUsage.mockResolvedValue({
   activeRequests: 1,
   queue: { active: 1, queued: 2 },
   totals: { requests: 40, errors: 0, tokenReports: 12, promptTokens: 1000, completionTokens: 2762 },
   clients: [
    { address: '192.0.2.10', label: 'Workstation GPU', known: true, activeRequests: 1, requests: 30, errors: 0, tokenReports: 12, promptTokens: 1000, completionTokens: 2762, models: ['qwen3.8-27b'], lastSeen: Date.now(), days: [] },
    { address: '192.0.2.99', label: null, known: false, activeRequests: 0, requests: 10, errors: 1, tokenReports: 0, promptTokens: 0, completionTokens: 0, models: [], lastSeen: Date.now(), days: [] },
   ],
   recent: [],
  });
  render(<MemoryRouter><FleetHostSetup /></MemoryRouter>);

  expect(await screen.findByText('Workstation GPU')).toBeInTheDocument();
  expect(screen.getByText('192.0.2.99')).toBeInTheDocument();
  expect(screen.getByText('Unrecognized')).toBeInTheDocument();
  // Thousands-grouped, and the partial token coverage is stated rather than
  // implying the other 28 requests were free.
  expect(screen.getByText('2,762')).toBeInTheDocument();
  expect(screen.getByText('12 of 40 reported counts')).toBeInTheDocument();
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

 it('prompts to set up this machine itself when its own host is serving and unconfigured', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, serving: true });
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  render(<MemoryRouter><FleetHostSetup compact providers={[]} /></MemoryRouter>);
  expect(await screen.findByText(/serving its own model host/)).toBeInTheDocument();
  const setupLink = screen.getByRole('link', { name: 'Set up as provider' });
  expect(setupLink).toHaveAttribute('href', '/ai/fleet?fleetStep=client&selfHost=1');
 });

 it('does not prompt for this machine when it already has a matching provider', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...state, serving: true });
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  // Self-host providers are wired to the loopback queue address (both the
  // auto-created Direct API one and the `?selfHost=1` OpenCode one) — never
  // to `state.endpoint`, which is the tailnet address published for OTHER
  // machines to connect to.
  const providers = [{ id: 'self-p1', endpoint: 'http://127.0.0.1:18022/v1' }];
  render(<MemoryRouter><FleetHostSetup compact providers={providers} /></MemoryRouter>);
  expect(await screen.findByText('Recommended model host setup')).toBeInTheDocument();
  expect(screen.queryByText(/serving its own model host/)).not.toBeInTheDocument();
 });

 it('offers a one-click self-host OpenCode TUI setup on the full host panel', async () => {
  api.getFleetLlmHost.mockResolvedValue(state);
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  render(<MemoryRouter><FleetHostSetup /></MemoryRouter>);
  const link = await screen.findByRole('link', { name: 'Set up OpenCode TUI on this machine' });
  expect(link).toHaveAttribute('href', '/ai/fleet?fleetStep=client&selfHost=1');
 });
});

