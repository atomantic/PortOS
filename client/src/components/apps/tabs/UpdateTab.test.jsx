import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  getUpdateStatus: vi.fn(),
  checkForUpdate: vi.fn(),
  checkHealth: vi.fn(),
  executePortosUpdate: vi.fn(),
  syncPortosFork: vi.fn(),
  ignoreUpdateVersion: vi.fn(),
  clearIgnoredVersions: vi.fn(),
}));

// Captures registered handlers by event name so tests can fire them directly,
// mirroring how the real socket.io client would invoke a listener.
const socketHandlers = {};
vi.mock('../../../services/socket', () => ({
  default: {
    on: vi.fn((event, handler) => {
      socketHandlers[event] = handler;
    }),
    off: vi.fn((event) => {
      delete socketHandlers[event];
    }),
  },
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import UpdateTab from './UpdateTab';
import * as api from '../../../services/api';

const OUT_OF_SYNC_STATUS = {
  currentVersion: '1.0.0',
  installState: { outOfSync: true, runningStaleCode: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(socketHandlers)) delete socketHandlers[key];
  api.getUpdateStatus.mockResolvedValue(OUT_OF_SYNC_STATUS);
  api.checkHealth.mockResolvedValue({ version: '1.0.0', uptime: 500 });
  api.executePortosUpdate.mockResolvedValue({ started: true, tag: 'v1.0.0' });
});

describe('UpdateTab reconcile', () => {
  it('clears the spinner on the "pm2-stop" step, long before "restarting" would ever fire', async () => {
    const user = userEvent.setup();
    render(<UpdateTab />);

    const button = await screen.findByRole('button', { name: /reconcile now/i });
    await user.click(button);

    await waitFor(() => expect(api.executePortosUpdate).toHaveBeenCalledWith({ reconcile: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: /reconciling/i })).toBeInTheDocument());

    // update.sh kills the server at "pm2-stop" — long before npm install,
    // setup, migrations, build, and the "restarting"/"restart"/"complete"
    // events that follow can ever run. Simulate only that one step arriving.
    api.checkHealth.mockClear();
    expect(socketHandlers['portos:update:step']).toBeTypeOf('function');
    socketHandlers['portos:update:step']({ step: 'pm2-stop', status: 'running', message: 'Stopping PortOS apps...' });

    // The spinner must not hang forever waiting on events from a process
    // that's already gone — it should fall back to the health-poll state.
    await waitFor(() => expect(screen.getByRole('button', { name: /restarting/i })).toBeInTheDocument());
    await waitFor(() => expect(api.checkHealth).toHaveBeenCalled());
  });

  it('falls back to a socket disconnect when even the "pm2-stop" step never arrives', async () => {
    const user = userEvent.setup();
    render(<UpdateTab />);

    const button = await screen.findByRole('button', { name: /reconcile now/i });
    await user.click(button);

    await waitFor(() => expect(api.executePortosUpdate).toHaveBeenCalledWith({ reconcile: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: /reconciling/i })).toBeInTheDocument());

    // The "pm2-stop" step's socket emit lost the race with the kill — no
    // step event arrives at all. The disconnect backstop must still recover.
    api.checkHealth.mockClear();
    expect(socketHandlers.disconnect).toBeTypeOf('function');
    socketHandlers.disconnect();

    await waitFor(() => expect(screen.getByRole('button', { name: /restarting/i })).toBeInTheDocument());
    await waitFor(() => expect(api.checkHealth).toHaveBeenCalled());
  });

  it('ignores a disconnect that happens outside of an active update', async () => {
    render(<UpdateTab />);
    await screen.findByRole('button', { name: /reconcile now/i });

    expect(socketHandlers.disconnect).toBeTypeOf('function');
    socketHandlers.disconnect();

    // No update was in flight, so disconnect must not fabricate a restart state.
    expect(screen.getByRole('button', { name: /reconcile now/i })).toBeInTheDocument();
    expect(api.checkHealth).not.toHaveBeenCalled();
  });

  it('ignores a disconnect that arrives after "pm2-stop" already started polling', async () => {
    const user = userEvent.setup();
    render(<UpdateTab />);

    const button = await screen.findByRole('button', { name: /reconcile now/i });
    await user.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: /reconciling/i })).toBeInTheDocument());

    socketHandlers['portos:update:step']({ step: 'pm2-stop', status: 'running', message: 'Stopping PortOS apps...' });
    await waitFor(() => expect(screen.getByRole('button', { name: /restarting/i })).toBeInTheDocument());

    // A later disconnect (the real process death, or a reconnect blip) must
    // not restart the poll's attempt budget once it's already running.
    api.checkHealth.mockClear();
    socketHandlers.disconnect();
    expect(screen.getByRole('button', { name: /restarting/i })).toBeInTheDocument();
  });
});
