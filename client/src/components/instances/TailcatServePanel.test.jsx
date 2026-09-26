import { TailcatServeProvider } from './TailcatServeProvider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render as renderUI, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  getTailcatServe: vi.fn(),
  startTailcatServe: vi.fn(),
  retryTailcatServe: vi.fn(),
  stopTailcatServe: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../services/socket', () => {
  const listeners = new Map();
  return { default: {
    on: vi.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    }),
    off: vi.fn((event, handler) => listeners.get(event)?.delete(handler)),
    emit: (event, payload) => listeners.get(event)?.forEach(handler => handler(payload)),
  } };
});
import socket from '../../services/socket';

afterEach(() => vi.useRealTimers());

import { getTailcatServe, startTailcatServe, stopTailcatServe } from '../../services/api';
import TailcatServePanel from './TailcatServePanel';

const stopped = {
  enabled: false,
  status: 'stopped',
  live: false,
  localPort: 5555,
  keyName: 'portos-api',
  tcAddress: null,
  tcAddressRedacted: null,
  hasAddress: false,
  lastError: null,
  lastErrorAt: null,
};

const serving = {
  ...stopped,
  enabled: true,
  status: 'active',
  live: true,
  tcAddress: 'tcEXAMPLE' + 'E'.repeat(40),
  tcAddressRedacted: 'tcEX…EEEE',
  hasAddress: true,
};

describe('TailcatServePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTailcatServe.mockResolvedValue(stopped);
  });

  it('shows start control when serve is stopped', async () => {
    render(<TailcatServePanel />);
    expect(await screen.findByRole('button', { name: 'Start serve' })).toBeInTheDocument();
    expect(screen.getByText(/serve :5555/)).toBeInTheDocument();
  });

  it('starts serve and exposes a copy control when an address is known', async () => {
    getTailcatServe
      .mockResolvedValueOnce(stopped)
      .mockResolvedValue(serving);
    startTailcatServe.mockResolvedValue(serving);
    const user = userEvent.setup();
    render(<TailcatServePanel />);
    await user.click(await screen.findByRole('button', { name: 'Start serve' }));
    await waitFor(() => expect(startTailcatServe).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Copy address' })).toBeInTheDocument();
    expect(screen.getByText(/tcEX…EEEE/)).toBeInTheDocument();
  });

  it('stops a live serve', async () => {
    getTailcatServe.mockResolvedValue(serving);
    stopTailcatServe.mockResolvedValue(stopped);
    const user = userEvent.setup();
    render(<TailcatServePanel />);
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopTailcatServe).toHaveBeenCalled());
  });
});

function render(ui) { return renderUI(<TailcatServeProvider>{ui}</TailcatServeProvider>); }

it('reveals the full address for manual copying when clipboard is unavailable', async () => {
  getTailcatServe.mockResolvedValue(serving);
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  render(<TailcatServePanel />);
  await user.click(await screen.findByRole('button', { name: 'Copy address' }));
  expect(screen.getByRole('textbox', { name: 'Full Tailcat address' })).toHaveValue(serving.tcAddress);
  await user.click(screen.getByRole('button', { name: 'Hide address' }));
  expect(screen.queryByRole('textbox', { name: 'Full Tailcat address' })).not.toBeInTheDocument();
});

it('does not overwrite a start receipt with an older in-flight status read', async () => {
  let resolveRead;
  getTailcatServe.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
  startTailcatServe.mockResolvedValue(serving);
  const user = userEvent.setup();
  render(<TailcatServePanel />);
  await user.click(screen.getByRole('button', { name: 'Start serve' }));
  expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
  await act(async () => resolveRead(stopped));
  expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
});

it('shares lifecycle changes between both controls without recurring status reads', async () => {
  vi.useFakeTimers();
  getTailcatServe.mockReset().mockResolvedValue(stopped);
  const { unmount } = render(<><TailcatServePanel /><TailcatServePanel compact /></>);
  await act(async () => {});
  expect(getTailcatServe).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(getTailcatServe).toHaveBeenCalledTimes(1);

  getTailcatServe.mockResolvedValue(serving);
  await act(async () => socket.emit('tailcat:serve:changed', {}));
  expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(2);
  getTailcatServe.mockResolvedValue({ ...serving, live: false, status: 'failed', lastError: 'Example process exited' });
  await act(async () => socket.emit('tailcat:serve:changed', {}));
  expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2);

  const reads = getTailcatServe.mock.calls.length;
  await act(async () => socket.emit('connect'));
  expect(getTailcatServe).toHaveBeenCalledTimes(reads + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => socket.emit('tailcat:serve:changed', {}));
  expect(getTailcatServe).toHaveBeenCalledTimes(reads + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(getTailcatServe).toHaveBeenCalledTimes(reads + 2);
  unmount();
  await act(async () => socket.emit('tailcat:serve:changed', {}));
  expect(getTailcatServe).toHaveBeenCalledTimes(reads + 2);
});

it.each([false, true])('reconciles changes received during a mutation (failed=%s)', async (failed) => {
  getTailcatServe.mockReset().mockResolvedValue(stopped);
  let finishMutation;
  startTailcatServe.mockImplementationOnce(() => new Promise((resolve, reject) => {
    finishMutation = () => failed ? reject(new Error('Example failure')) : resolve(serving);
  }));
  const user = userEvent.setup();
  render(<TailcatServePanel />);
  await waitFor(() => expect(getTailcatServe).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('button', { name: 'Start serve' }));
  getTailcatServe.mockResolvedValue({ ...serving, live: false, status: 'failed', lastError: 'Example process exited' });
  await act(async () => {
    socket.emit('tailcat:serve:changed', {});
    socket.emit('tailcat:serve:changed', {});
  });
  expect(getTailcatServe).toHaveBeenCalledTimes(1);
  await act(async () => finishMutation());
  expect(getTailcatServe).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Example process exited')).toBeInTheDocument();
});
