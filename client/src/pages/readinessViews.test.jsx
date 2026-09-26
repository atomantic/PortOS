import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { handlers, socket, getSystemHealth, getCapabilities } = vi.hoisted(() => {
  const handlers = new Map();
  return {
    handlers,
    socket: {
      on: vi.fn((event, fn) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
      }),
      off: vi.fn((event, fn) => handlers.get(event)?.delete(fn)),
      emit: vi.fn(),
    },
    getSystemHealth: vi.fn(),
    getCapabilities: vi.fn(),
  };
});
vi.mock('../services/socket', () => ({ default: socket }));
vi.mock('../services/api', () => ({ getSystemHealth, getCapabilities }));
vi.mock('../hooks/useSystemResourceReport.js', () => ({
  useSystemResourceReport: () => ({ report: null, cleanup: {} }),
}));
vi.mock('../components/system-resources/MediaCapacityPanel.jsx', () => ({ default: () => null }));
vi.mock('../components/system-resources/BuildStampPanel.jsx', () => ({ default: () => null }));
import SystemHealthPage from './SystemHealthPage';
import CapabilityMap from './CapabilityMap';

const health = message => ({
  overallHealth: 'warning',
  warnings: [{ type: 'process', message }],
  system: {
    uptimeFormatted: '1h',
    memory: { usagePercent: 30, usedFormatted: '3 GB', totalFormatted: '10 GB' },
    cpu: { usagePercent: 5, cores: 4, loadAvg1m: 0.2 },
    disk: null,
  },
  topProcesses: [],
});
const capabilities = message => ({
  capabilities: [{ id: 'calendar', label: 'Calendar', status: 'warn', summary: message, settingsPath: '/calendar' }],
});
const emit = event => act(async () => {
  for (const fn of handlers.get(event) || []) fn({});
});
const visibility = state => act(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  cleanup();
  handlers.clear();
  vi.useRealTimers();
});

describe.each([
  ['health', SystemHealthPage, getSystemHealth, health, 'system:health:changed'],
  ['capabilities', CapabilityMap, getCapabilities, capabilities, 'capabilities:changed'],
])('%s readiness view', (_name, Page, read, snapshot, event) => {
  it('renders service changes without polling, reconciles once on reconnect/reshow and releases listeners', async () => {
    read.mockResolvedValue(snapshot('Initial reading'));
    let view;
    await act(async () => { view = render(<MemoryRouter><Page /></MemoryRouter>); });
    expect(screen.getByText('Initial reading')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValue(snapshot('Changed reading'));
    await emit(event);
    expect(screen.getByText('Changed reading')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    await emit('connect');
    expect(read).toHaveBeenCalledTimes(3);
    await visibility('hidden');
    await emit(event);
    expect(read).toHaveBeenCalledTimes(3);
    await visibility('visible');
    expect(read).toHaveBeenCalledTimes(4);
    await visibility('visible');
    expect(read).toHaveBeenCalledTimes(4);

    view.unmount();
    expect(socket.emit).toHaveBeenCalledWith('readiness:unsubscribe');
    expect(handlers.get(event)?.size).toBe(0);
    expect(handlers.get('connect')?.size).toBe(0);
    await emit(event);
    await visibility('hidden');
    await visibility('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('recovers an initial failure and marks a failed later read stale until a successful event', async () => {
    read.mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => { render(<MemoryRouter><Page /></MemoryRouter>); });
    expect(screen.getByText(/unavailable\./i)).toBeInTheDocument();
    read.mockResolvedValue(snapshot('Recovered reading'));
    await emit('connect');
    expect(screen.getByText('Recovered reading')).toBeInTheDocument();
    read.mockRejectedValueOnce(new Error('Unavailable'));
    await emit(event);
    expect(screen.getByText(/Showing the last available reading/)).toBeInTheDocument();
    expect(screen.getByText('Recovered reading')).toBeInTheDocument();
    await emit(event);
    expect(screen.queryByText(/Showing the last available reading/)).not.toBeInTheDocument();
  });

  it('coalesces invalidations during an in-flight read into one trailing reconciliation', async () => {
    let resolve;
    read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await act(async () => { render(<MemoryRouter><Page /></MemoryRouter>); });
    await emit(event);
    await emit(event);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(snapshot('Latest reading'));
    await act(async () => { resolve(snapshot('Old reading')); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Latest reading')).toBeInTheDocument();
  });
});
