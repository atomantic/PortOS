import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';

import socket from '../../services/socket';
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: true },
}));
// Fires every handler registered for `event` — stands in for both a real
// Socket.IO reconnect and the initial connect, since the component tells
// them apart via its own "have we connected before" ref, not the event data.
const fireSocketEvent = (event) => {
  for (const [name, handler] of socket.on.mock.calls) if (name === event) handler({});
};

vi.mock('../../services/api', () => ({
  getDatabaseStatus: vi.fn(),
  getDatabaseMaintenanceStatus: vi.fn(),
  cutoverDatabase: vi.fn(),
  recoverDatabaseCutover: vi.fn(),
  setupNativeDatabase: vi.fn(),
  exportDatabase: vi.fn(),
  fixDatabase: vi.fn(),
  syncDatabase: vi.fn(),
  startDatabase: vi.fn(),
  stopDatabase: vi.fn(),
  destroyDatabase: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('../../lib/safeStorage', () => ({
  safeReadJsonSession: vi.fn(() => null),
  safeWriteJsonSession: vi.fn(),
  safeRemoveSession: vi.fn(),
}));

import {
  getDatabaseStatus, getDatabaseMaintenanceStatus, cutoverDatabase, recoverDatabaseCutover,
} from '../../services/api';
import toast from '../ui/Toast';
import { safeReadJsonSession } from '../../lib/safeStorage';
import { DatabaseTab } from './DatabaseTab';

const dbStatus = {
  connected: true, mode: 'docker', memoryCount: 10, dbBytes: 1000, tableCount: 5,
  docker: { containerRunning: true, installed: true, daemonRunning: true },
  native: { configured: false, installed: false, running: false },
};
const idleMaintenance = { stage: 'idle', fenced: false };

beforeEach(() => {
  vi.clearAllMocks();
  socket.connected = true;
  getDatabaseStatus.mockResolvedValue(dbStatus);
  getDatabaseMaintenanceStatus.mockResolvedValue(idleMaintenance);
  safeReadJsonSession.mockReturnValue(null);
});

afterEach(cleanup);

const renderTab = async () => {
  render(<DatabaseTab />);
  await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText(/Migrate Docker/i)).toBeTruthy());
};

describe('DatabaseTab migration', () => {
  it('offers a migrate action when idle and reads status without a stale-poll interval', async () => {
    await renderTab();
    expect(getDatabaseMaintenanceStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Migrate Docker/i })).toBeTruthy();
  });

  it('never toasts success from an accepted cutover — only a matching verified operation does', async () => {
    cutoverDatabase.mockResolvedValue({ id: 'op-1', stage: 'accepted', source: 'docker', target: 'native', accepted: true });
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: /Migrate Docker/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }));

    await waitFor(() => expect(cutoverDatabase).toHaveBeenCalledWith({ source: 'docker', target: 'native' }));
    // Accepted only: a loading toast, never a success toast.
    expect(toast.loading).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // Disables competing backend actions while the cutover is in flight.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Backup$/i })[0]).toBeDisabled());
  });

  it('reconciles the durable journal on every socket connect, not on a timer', async () => {
    await renderTab();
    expect(getDatabaseMaintenanceStatus).toHaveBeenCalledTimes(1);

    // Reconciling on every connect (not just a later reconnect) matters when a
    // page reloads while the server is still down: the mount-time HTTP read
    // fails, and the socket's first successful connect is the only signal
    // that it's safe to re-read the journal.
    await act(async () => { fireSocketEvent('connect'); });
    await waitFor(() => expect(getDatabaseMaintenanceStatus).toHaveBeenCalledTimes(2));

    await act(async () => { fireSocketEvent('disconnect'); });
    await act(async () => { fireSocketEvent('connect'); });
    await waitFor(() => expect(getDatabaseMaintenanceStatus).toHaveBeenCalledTimes(3));
  });

  it('keeps the last known fenced state (fails closed) when a status re-read errors mid-cutover', async () => {
    getDatabaseMaintenanceStatus.mockResolvedValueOnce({
      id: 'op-5', stage: 'exporting', coordinator: 'awaiting-exit', source: 'docker', target: 'native', fenced: true,
    });
    render(<DatabaseTab />);
    await waitFor(() => expect(screen.getByText(/Draining writers|Exporting source database/i)).toBeTruthy());

    getDatabaseMaintenanceStatus.mockRejectedValueOnce(new Error('server unreachable'));
    await act(async () => { fireSocketEvent('disconnect'); });
    await act(async () => { fireSocketEvent('connect'); });

    // Still shows the fenced state — never silently drops to idle/unknown,
    // which would re-enable competing backend actions mid-cutover.
    expect(screen.getByText(/Exporting source database/i)).toBeTruthy();
  });

  it('shows an actionable recovery control for an interrupted cutover, and resumes the same operation id', async () => {
    getDatabaseMaintenanceStatus.mockResolvedValue({
      id: 'op-2', stage: 'importing', coordinator: 'exited', source: 'docker', target: 'native', fenced: true,
    });
    recoverDatabaseCutover.mockResolvedValue({ id: 'op-2', stage: 'importing', recovery: 'launched' });
    render(<DatabaseTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Resume cutover/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Resume cutover/i }));
    await waitFor(() => expect(recoverDatabaseCutover).toHaveBeenCalledWith('op-2'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports success only once the journal reports a verified match for this tab\'s own operation', async () => {
    safeReadJsonSession.mockReturnValue({ id: 'op-3', source: 'docker', target: 'native', acceptedAt: Date.now() });
    getDatabaseMaintenanceStatus.mockResolvedValue({
      stage: 'idle', fenced: false, lastCutover: { id: 'op-3', source: 'docker', target: 'native', sourceRetained: true },
    });
    await renderTab();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('native'), expect.objectContaining({ id: 'portos-database-cutover' })
    ));
  });

  it('does not claim success for a foreign or superseded operation id', async () => {
    safeReadJsonSession.mockReturnValue({ id: 'op-4', source: 'docker', target: 'native', acceptedAt: Date.now() });
    getDatabaseMaintenanceStatus.mockResolvedValue({ stage: 'idle', fenced: false });
    await renderTab();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
