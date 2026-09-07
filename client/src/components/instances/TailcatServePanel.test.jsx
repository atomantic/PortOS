import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
