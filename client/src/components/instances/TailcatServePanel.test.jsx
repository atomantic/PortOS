import { TailcatServeProvider } from './TailcatServeProvider';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

it('keeps the newest status when visibility refreshes overlap', async () => {
  let resolveOld;
  getTailcatServe.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue({ ...stopped, status: 'failed', lastError: 'Process exited' });
  render(<TailcatServePanel />);
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await screen.findByText('Process exited')).toBeInTheDocument();
  await act(async () => resolveOld(serving));
  expect(screen.getByText('Process exited')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
});
