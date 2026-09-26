import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
const bus = vi.hoisted(() => {
  const listeners = new Map();
  return {
    on: vi.fn((event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); }),
    off: vi.fn((event, fn) => listeners.get(event)?.delete(fn)),
    emit: vi.fn(),
    deliver: (event) => listeners.get(event)?.forEach(fn => fn({})),
  };
});
const api = vi.hoisted(() => ({
  getFleetLlmHost: vi.fn(), getFleetPeerHosts: vi.fn(), getFleetLlmHostUsage: vi.fn(),
  revealFleetLlmHostKey: vi.fn(), stopFleetLlmHost: vi.fn(),
}));
vi.mock('../../services/socket', () => ({ default: bus }));
vi.mock('../../services/apiProviders', () => api);
vi.mock('../install/RuntimeInstallModal', () => ({ default: () => null }));
import FleetHostSetup from './FleetHostSetup';
import FleetHostUsage from './FleetHostUsage';
const host = {
  recommendation: { supported: true, title: 'Example host', reason: 'Ready' },
  specs: { totalMemoryGb: 32 }, checks: [], queue: { active: 0, queued: 0 },
  enabled: true, stoppable: true,
};
const usage = { clients: [], recent: [], totals: { requests: 12 }, activeRequests: 0, queue: { queued: 0 } };
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
it('renders events and stop receipts without timer reads, then reconciles once on reconnect and tab show', async () => {
  vi.useFakeTimers();
  api.getFleetLlmHost.mockResolvedValue(host);
  api.getFleetLlmHostUsage.mockResolvedValue(usage);
  api.stopFleetLlmHost.mockResolvedValue({ success: true, containerStopped: true, status: { ...host, enabled: false, stoppable: false } });
  render(<MemoryRouter><FleetHostSetup /></MemoryRouter>);
  await settle();
  expect(screen.getByRole('button', { name: 'Stop model host' })).toBeInTheDocument();
  const initial = api.getFleetLlmHost.mock.calls.length;
  const initialUsage = api.getFleetLlmHostUsage.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(api.getFleetLlmHost).toHaveBeenCalledTimes(initial);
  expect(api.getFleetLlmHostUsage).toHaveBeenCalledTimes(initialUsage);
  api.getFleetLlmHostUsage.mockResolvedValue({ ...usage, totals: { requests: 9876 } });
  act(() => bus.deliver('fleet-host:usage:changed'));
  await settle();
  expect(screen.getByText('9,876')).toBeInTheDocument();
  const beforeReconnect = api.getFleetLlmHost.mock.calls.length;
  act(() => bus.deliver('connect'));
  await settle();
  expect(api.getFleetLlmHost).toHaveBeenCalledTimes(beforeReconnect + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fireEvent(document, new Event('visibilitychange'));
  await settle();
  expect(api.getFleetLlmHost).toHaveBeenCalledTimes(beforeReconnect + 2);
  fireEvent.click(screen.getByRole('button', { name: 'Stop model host' }));
  fireEvent.click(screen.getByRole('button', { name: /Confirm stop/ }));
  await settle();
  expect(screen.queryByRole('button', { name: 'Stop model host' })).not.toBeInTheDocument();
  expect(api.getFleetLlmHost).toHaveBeenCalledTimes(beforeReconnect + 2);
});
it('keeps failed usage distinct from an empty ledger and recovers through notifications', async () => {
  api.getFleetLlmHostUsage.mockRejectedValue(new Error('unavailable'));
  render(<FleetHostUsage />);
  await settle();
  expect(screen.getByText(/report is unavailable/)).toBeInTheDocument();
  expect(screen.queryByText(/No machine has called/)).not.toBeInTheDocument();
  api.getFleetLlmHostUsage.mockResolvedValue(usage);
  act(() => bus.deliver('fleet-host:usage:changed'));
  await settle();
  expect(screen.queryByText(/report is unavailable/)).not.toBeInTheDocument();
  expect(screen.getByText(/No machine has called/)).toBeInTheDocument();
});
it('refreshes compact discovery from configured-peer events and shows failed discovery instead of empty hosts', async () => {
  api.getFleetLlmHost.mockResolvedValue({ ...host, enabled: false });
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [] });
  render(<MemoryRouter><FleetHostSetup compact /></MemoryRouter>);
  await settle();
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [{ peerId: 'example-peer', peerName: 'Example GPU', enabled: true }] });
  act(() => bus.deliver('instances:peers:updated'));
  await settle();
  expect(screen.getByText('Example GPU', { selector: 'span' })).toBeInTheDocument();
  api.getFleetPeerHosts.mockResolvedValue({ hosts: [], unavailable: 1 });
  act(() => bus.deliver('instances:peers:updated'));
  await settle();
  expect(screen.getByText(/Could not discover peer hosts/)).toBeInTheDocument();
});
