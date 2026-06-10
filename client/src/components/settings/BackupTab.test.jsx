import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getBackupStatus: vi.fn(),
  triggerBackup: vi.fn(),
  getBackupSnapshots: vi.fn(),
  restoreDatabase: vi.fn(),
  // FolderPicker imports `* as api` from the same module; it only calls this
  // when its picker is opened (never in these tests), but the mock defines it
  // so the import doesn't resolve to undefined if the picker ever mounts eagerly.
  getDirectories: vi.fn(),
}));
// The real `toast` is a callable function with `.success`/`.error`/`.warning`
// attached — the component calls the bare form (`toast('Backup already
// running')`) as well as the namespaced ones. Mock it faithfully so a future
// test of those bare-call paths doesn't trip over a non-callable stub.
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

import {
  getSettings,
  updateSettings,
  getBackupStatus,
  triggerBackup,
  getBackupSnapshots,
  restoreDatabase,
} from '../../services/api';
import toast from '../ui/Toast';
import { BackupTab } from './BackupTab';

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults — individual tests override as needed.
  getSettings.mockResolvedValue({ backup: { destPath: '/backups', enabled: false, cronExpression: '0 2 * * *', excludePaths: [], disabledDefaultExcludes: [] } });
  getBackupStatus.mockResolvedValue({ status: 'never', defaultExcludes: [], pgBackup: null });
  getBackupSnapshots.mockResolvedValue([]);
});

// Render and wait for the loading spinner to clear (the Save button only
// appears post-load).
const renderTab = async () => {
  render(<BackupTab />);
  await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).toBeTruthy());
};

describe('BackupTab', () => {
  describe('settings save flow', () => {
    it('persists the destination path and toasts success', async () => {
      updateSettings.mockResolvedValue({});
      await renderTab();

      const input = screen.getByLabelText(/Destination Path/i);
      fireEvent.change(input, { target: { value: '/new/dest' } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      });

      expect(updateSettings).toHaveBeenCalledWith({
        backup: {
          destPath: '/new/dest',
          enabled: false,
          cronExpression: '0 2 * * *',
          excludePaths: [],
          disabledDefaultExcludes: [],
        },
      });
      expect(toast.success).toHaveBeenCalledWith('Settings saved');
    });

    it('toasts an error when the save fails', async () => {
      updateSettings.mockRejectedValue(new Error('disk full'));
      await renderTab();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      });

      expect(toast.error).toHaveBeenCalledWith('disk full');
    });
  });

  describe('restore-confirm modal gate', () => {
    const withSnapshot = () => {
      getBackupSnapshots.mockResolvedValue([{ id: 'snap-2026-06-09' }]);
    };

    it('runs a dry-run and opens the confirm modal — without restoring', async () => {
      withSnapshot();
      restoreDatabase.mockResolvedValue({ status: 'ok', sizeBytes: 2048, tableCount: 12 });
      await renderTab();

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /Restore DB/i }));
      });

      // Dry-run preview fired; modal is open; NO destructive restore yet.
      expect(restoreDatabase).toHaveBeenCalledTimes(1);
      expect(restoreDatabase).toHaveBeenCalledWith({ snapshotId: 'snap-2026-06-09', dryRun: true }, { silent: true });
      expect(screen.getByText(/Restore database\?/i)).toBeTruthy();
      expect(restoreDatabase).not.toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: false }),
        expect.anything(),
      );
    });

    it('does NOT call restore when the user cancels the modal', async () => {
      withSnapshot();
      restoreDatabase.mockResolvedValue({ status: 'ok', sizeBytes: 2048, tableCount: 12 });
      await renderTab();

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /Restore DB/i }));
      });
      // One dry-run call so far.
      expect(restoreDatabase).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
      });

      // Still just the dry-run — cancel never triggers the destructive restore.
      expect(restoreDatabase).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByText(/Restore database\?/i)).toBeNull());
    });

    it('runs the destructive restore only after explicit confirmation', async () => {
      withSnapshot();
      restoreDatabase
        .mockResolvedValueOnce({ status: 'ok', sizeBytes: 2048, tableCount: 12 }) // dry-run
        .mockResolvedValueOnce({ status: 'ok' }); // real restore
      await renderTab();

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /Restore DB/i }));
      });
      // The confirm button inside the modal is the dialog's "Restore".
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Restore$/i }));
      });

      expect(restoreDatabase).toHaveBeenLastCalledWith({ snapshotId: 'snap-2026-06-09', dryRun: false }, { silent: true });
      expect(toast.success).toHaveBeenCalledWith('Database restored from snap-2026-06-09', { icon: '💾' });
    });

    it('toasts an error when the confirmed restore fails', async () => {
      withSnapshot();
      restoreDatabase
        .mockResolvedValueOnce({ status: 'ok', sizeBytes: 2048, tableCount: 12 }) // dry-run
        .mockResolvedValueOnce({ status: 'failed', reason: 'pg_restore_error' }); // real restore fails
      await renderTab();

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /Restore DB/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Restore$/i }));
      });

      expect(toast.error).toHaveBeenCalledWith('DB restore failed: pg_restore_error');
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('aborts and toasts when the dry-run reports no dump', async () => {
      withSnapshot();
      restoreDatabase.mockResolvedValue({ status: 'skipped', reason: 'no_dump' });
      await renderTab();

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /Restore DB/i }));
      });

      expect(restoreDatabase).toHaveBeenCalledTimes(1); // only the dry-run
      expect(toast.error).toHaveBeenCalledWith('No DB dump in this snapshot');
      expect(screen.queryByText(/Restore database\?/i)).toBeNull();
    });
  });

  describe('pgBackup conditional rendering', () => {
    it('shows "No backup run yet" when pgBackup is null', async () => {
      getBackupStatus.mockResolvedValue({ status: 'never', defaultExcludes: [], pgBackup: null });
      await renderTab();
      expect(screen.getByText(/No backup run yet/i)).toBeTruthy();
    });

    it('shows size + table count when the last dump succeeded', async () => {
      getBackupStatus.mockResolvedValue({
        status: 'ok',
        defaultExcludes: [],
        pgBackup: { status: 'ok', sizeBytes: 1024, tableCount: 7 },
      });
      await renderTab();
      expect(screen.getByText(/7 tables/i)).toBeTruthy();
    });

    it('surfaces the degraded banner when the last dump failed', async () => {
      getBackupStatus.mockResolvedValue({
        status: 'degraded',
        defaultExcludes: [],
        pgBackup: { status: 'failed', reason: 'version_mismatch' },
      });
      await renderTab();
      expect(screen.getByText(/Last backup degraded/i)).toBeTruthy();
      expect(screen.getByText(/Dump failed: version_mismatch/i)).toBeTruthy();
    });
  });
});
