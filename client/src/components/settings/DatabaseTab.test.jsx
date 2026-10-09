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
  destroyDatabase,
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

describe('DatabaseTab sync and replacement', () => {
  it('disables replace action for stopped targets and shows start requirement message', async () => {
    const stoppedDbStatus = {
      ...dbStatus,
      docker: { containerRunning: false, installed: true, daemonRunning: true },
      native: { configured: true, installed: true, running: true },
      mode: 'native',
    };
    getDatabaseStatus.mockResolvedValue(stoppedDbStatus);
    render(<DatabaseTab />);
    await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());

    // Docker is stopped/not-active, so the replace button should be disabled with start message
    expect(screen.getByText(/Start Docker before replacing/i)).toBeTruthy();
  });

  it('enables replace action for running targets', async () => {
    const runningDbStatus = {
      ...dbStatus,
      docker: { containerRunning: true, installed: true, daemonRunning: true },
      native: { configured: true, installed: true, running: true },
      mode: 'docker',
    };
    getDatabaseStatus.mockResolvedValue(runningDbStatus);
    render(<DatabaseTab />);
    await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());

    // Native is running and not active, so replace button should be enabled
    expect(screen.getByRole('button', { name: /Replace data from Docker/i })).toBeTruthy();
  });

  it('shows replacement warning in confirmation dialog when target is running', async () => {
    const nativeRunningStatus = {
      ...dbStatus,
      docker: { containerRunning: true, installed: true, daemonRunning: true },
      native: { configured: true, installed: true, running: true },
      mode: 'docker',
    };
    getDatabaseStatus.mockResolvedValue(nativeRunningStatus);
    render(<DatabaseTab />);
    await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /Replace data from Docker/i }));

    expect(screen.getByText(/Replace Native data with Docker data\?/i)).toBeTruthy();
    expect(screen.getByText(/This replaces matching tables and their records/i)).toBeTruthy();
    expect(screen.getByText(/records are not merged/i)).toBeTruthy();
    expect(screen.getByText(/Back up Native first/i)).toBeTruthy();
  });

  it('uses explicit action verb "Replace Native data" in confirmation button', async () => {
    const nativeRunningStatus = {
      ...dbStatus,
      docker: { containerRunning: true, installed: true, daemonRunning: true },
      native: { configured: true, installed: true, running: true },
      mode: 'docker',
    };
    getDatabaseStatus.mockResolvedValue(nativeRunningStatus);
    render(<DatabaseTab />);
    await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /Replace data from Docker/i }));

    expect(screen.getByRole('button', { name: /Replace Native data/i })).toBeTruthy();
  });

  it('uses explicit action verb "Delete Docker database" in destroy confirmation', async () => {
    const destroyableStatus = {
      ...dbStatus,
      docker: { containerRunning: false, installed: true, daemonRunning: true },
      native: { configured: true, installed: true, running: true },
      mode: 'native',
    };
    getDatabaseStatus.mockResolvedValue(destroyableStatus);
    render(<DatabaseTab />);
    await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /Destroy$/i }));

    expect(screen.getByRole('button', { name: /Delete Docker database/i })).toBeTruthy();
  });

  it('offers Native deletion only while configured Native is running and explains its scope', async () => {
    const nativeRunningStatus = {
      ...dbStatus,
      docker: { containerRunning: true, installed: true, daemonRunning: true },
      native: { configured: true, installed: true, running: true },
      mode: 'docker',
    };
    getDatabaseStatus.mockResolvedValue(nativeRunningStatus);
    destroyDatabase.mockResolvedValue({ success: true });
    render(<DatabaseTab />);
    await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Native database…' }));
    expect(screen.getByText('Delete the inactive Native database?')).toBeTruthy();
    expect(screen.getByText(/permanently deletes its tables and records/i)).toBeTruthy();
    expect(screen.getByText(/System PostgreSQL and other databases are kept/i)).toBeTruthy();
    expect(screen.getByText(/active Docker database is unchanged/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(destroyDatabase).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Native database…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Native database' }));
    await waitFor(() => expect(destroyDatabase).toHaveBeenCalledWith('native'));
  });

  it('does not offer Native deletion when it is active, stopped, or unconfigured', async () => {
    const statuses = [
      { ...dbStatus, mode: 'native', native: { configured: true, installed: true, running: true } },
      { ...dbStatus, mode: 'docker', native: { configured: true, installed: true, running: false } },
      { ...dbStatus, mode: 'docker', native: { configured: false, installed: false, running: false } },
    ];

    for (const status of statuses) {
      getDatabaseStatus.mockResolvedValueOnce(status);
      const { unmount } = render(<DatabaseTab />);
      await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: /Delete Native database/i })).toBeNull();
      unmount();
    }
  });

  it('cancel button does not make any request and closes dialog', async () => {
    const nativeRunningStatus = {
      ...dbStatus,
      docker: { containerRunning: true, installed: true, daemonRunning: true },
      native: { configured: true, installed: true, running: true },
      mode: 'docker',
    };
    getDatabaseStatus.mockResolvedValue(nativeRunningStatus);
    const { syncDatabase: syncDatabaseMock } = await import('../../services/api');

    render(<DatabaseTab />);
    await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /Replace data from Docker/i }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(syncDatabaseMock).not.toHaveBeenCalled();
    // Confirmation dialog should be gone
    expect(screen.queryByText(/This replaces matching tables/i)).toBeNull();
  });
});

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
    fireEvent.click(screen.getByRole('button', { name: /Migrate to Native/i }));

    await waitFor(() => expect(cutoverDatabase).toHaveBeenCalledWith({ source: 'docker', target: 'native' }));
    // Accepted only: a loading toast, never a success toast.
    expect(toast.loading).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // Disables competing backend actions while the cutover is in flight.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Backup$/i })[0]).toBeDisabled());
  });

  it('ignores a stale in-flight status read that resolves after a cutover was accepted', async () => {
    cutoverDatabase.mockResolvedValue({ id: 'op-9', stage: 'accepted', source: 'docker', target: 'native', accepted: true });
    await renderTab();

    // A manual refresh is in flight (deliberately unresolved) when the user
    // also accepts a cutover — the refresh was issued against the pre-cutover
    // idle state and must not win the race against the acceptance snapshot.
    let resolveStaleRead;
    getDatabaseMaintenanceStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStaleRead = resolve; }));
    fireEvent.click(screen.getByTitle('Refresh status'));
    await waitFor(() => expect(getDatabaseMaintenanceStatus).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: /Migrate Docker/i }));
    fireEvent.click(screen.getByRole('button', { name: /Migrate to Native/i }));
    await waitFor(() => expect(cutoverDatabase).toHaveBeenCalled());

    // The stale read (issued before acceptance) resolves late with idle data.
    // It must NOT clobber the just-established fence.
    await act(async () => { resolveStaleRead(idleMaintenance); });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Backup$/i })[0]).toBeDisabled());
    expect(toast.dismiss).not.toHaveBeenCalledWith('portos-database-cutover');
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

  it('fails closed on competing actions when this tab has an unresolved operation but the status read errors', async () => {
    safeReadJsonSession.mockReturnValue({ id: 'op-6', source: 'docker', target: 'native', acceptedAt: Date.now() });
    getDatabaseMaintenanceStatus.mockRejectedValue(new Error('server unreachable'));
    render(<DatabaseTab />);
    await waitFor(() => expect(getDatabaseStatus).toHaveBeenCalled());
    // Never learned this operation's outcome — must not read as idle.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Backup$/i })[0]).toBeDisabled());
  });

  it('does not attribute a later, different verified operation to this tab\'s earlier success', async () => {
    safeReadJsonSession.mockReturnValue({ id: 'op-7', source: 'docker', target: 'native', acceptedAt: Date.now() });
    getDatabaseMaintenanceStatus.mockResolvedValueOnce({
      stage: 'idle', fenced: false, lastCutover: { id: 'op-7', source: 'docker', target: 'native', sourceRetained: true },
    });
    await renderTab();
    await waitFor(() => expect(screen.getByText(/Verified — now running on native/i)).toBeTruthy());

    // A different (e.g. CLI-run) operation later becomes the recorded
    // lastCutover. This tab never claimed op-8, so it must not keep — or
    // re-show — a verified banner for it.
    getDatabaseMaintenanceStatus.mockResolvedValue({
      stage: 'idle', fenced: false, lastCutover: { id: 'op-8', source: 'native', target: 'docker', sourceRetained: true },
    });
    fireEvent.click(screen.getByTitle('Refresh status'));
    await waitFor(() => expect(getDatabaseMaintenanceStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Verified — now running on/i)).toBeNull();
  });
});
