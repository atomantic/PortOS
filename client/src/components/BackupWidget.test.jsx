import { MemoryRouter } from 'react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetBackupStatus,
  mockGetBackupSnapshots,
  mockDownloadBackupSnapshot,
  mockRestoreBackup,
  mockTriggerBackup,
  mockToast,
} = vi.hoisted(() => ({
  mockGetBackupStatus: vi.fn(),
  mockGetBackupSnapshots: vi.fn(),
  mockDownloadBackupSnapshot: vi.fn(),
  mockRestoreBackup: vi.fn(),
  mockTriggerBackup: vi.fn(),
  mockToast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('../services/api', () => ({
  getBackupStatus: (...args) => mockGetBackupStatus(...args),
  getBackupSnapshots: (...args) => mockGetBackupSnapshots(...args),
  downloadBackupSnapshot: (...args) => mockDownloadBackupSnapshot(...args),
  restoreBackup: (...args) => mockRestoreBackup(...args),
  triggerBackup: (...args) => mockTriggerBackup(...args),
}));

vi.mock('./ui/Toast', () => ({ default: mockToast }));

import BackupWidget from './BackupWidget.jsx';

const renderWidget = () => render(
  <MemoryRouter>
    <BackupWidget />
  </MemoryRouter>,
);

const openRestorePanel = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
  return screen.findByRole('textbox', { name: 'Selective restore (optional)' });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBackupStatus.mockResolvedValue({
    status: 'ok',
    lastRun: '2026-08-25T11:00:00Z',
    nextRun: '2026-08-26T11:00:00Z',
    filesChanged: 2,
    destPath: '/backup/example',
  });
  mockGetBackupSnapshots.mockResolvedValue([{ id: '2026-08-25T11-00-00', fileCount: 3 }]);
  mockDownloadBackupSnapshot.mockResolvedValue({ filename: 'portos-snapshot.tar.gz' });
});

describe('BackupWidget snapshots', () => {
  it('offers neither action for a snapshot that is still being written', async () => {
    mockGetBackupSnapshots.mockResolvedValue([
      { id: '2026-08-25T12-00-00', fileCount: 0, incomplete: true },
    ]);
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    expect(await screen.findByText('Still being written…')).toBeInTheDocument();
    // The server 409s both; a button that can only fail should not be offered.
    expect(screen.getByRole('button', { name: /Download snapshot/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  it('keeps failed snapshots downloadable for salvage but disables restore', async () => {
    mockGetBackupSnapshots.mockResolvedValue([
      { id: '2026-08-25T12-00-00', fileCount: 2, failed: true, incomplete: false },
    ]);
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    expect(await screen.findByText('Backup failed — download available for salvage')).toBeInTheDocument();
    const download = screen.getByRole('button', { name: /Download snapshot/ });
    const restore = screen.getByRole('button', { name: 'Restore' });
    expect(download).toBeEnabled();
    expect(restore).toBeDisabled();

    fireEvent.click(download);
    await waitFor(() => expect(mockDownloadBackupSnapshot).toHaveBeenCalledWith('2026-08-25T12-00-00'));
    expect(mockRestoreBackup).not.toHaveBeenCalled();
  });

  it('offers a download action for each snapshot and confirms success', async () => {
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    const download = await screen.findByRole('button', { name: /Download snapshot 2026-08-25T11-00-00/ });
    fireEvent.click(download);

    await waitFor(() => expect(mockDownloadBackupSnapshot).toHaveBeenCalledWith('2026-08-25T11-00-00'));
    expect(mockToast.success).toHaveBeenCalledWith('Snapshot downloaded');
  });

  it('keeps duplicate snapshot ids distinct and binds restore approval to source', async () => {
    mockGetBackupSnapshots.mockResolvedValue([
      {
        id: 'same-id',
        source: 'current-machine',
        sourceLabel: 'current-machine (current machine)',
        selectionKey: 'current-machine/same-id',
        fileCount: 2,
      },
      {
        id: 'same-id',
        source: 'previous-machine',
        sourceLabel: 'previous-machine',
        selectionKey: 'previous-machine/same-id',
        fileCount: 2,
      },
    ]);
    mockRestoreBackup
      .mockResolvedValueOnce({ changedFiles: ['brain/example.json'] })
      .mockResolvedValueOnce({ changedFiles: ['brain/example.json'] });
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    expect(await screen.findByText('Source: previous-machine')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(await screen.findByText('brain/example.json')).toBeInTheDocument();
    expect(mockRestoreBackup).toHaveBeenNthCalledWith(1, {
      snapshotId: 'same-id',
      source: 'previous-machine',
      subdirFilter: null,
      dryRun: true,
    }, { silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Restore 1 file(s)' }));
    await waitFor(() => expect(mockRestoreBackup).toHaveBeenNthCalledWith(2, {
      snapshotId: 'same-id',
      source: 'previous-machine',
      subdirFilter: null,
      dryRun: false,
    }, { silent: true }));
  });

  it('stays silent when the user dismisses the save dialog', async () => {
    mockDownloadBackupSnapshot.mockRejectedValue(
      Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }),
    );
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    fireEvent.click(await screen.findByRole('button', { name: /Download snapshot 2026-08-25T11-00-00/ }));

    await waitFor(() => expect(mockDownloadBackupSnapshot).toHaveBeenCalled());
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('shows a toast when a snapshot download fails', async () => {
    mockDownloadBackupSnapshot.mockRejectedValue(new Error('Connection lost'));
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    fireEvent.click(await screen.findByRole('button', { name: /Download snapshot 2026-08-25T11-00-00/ }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Download failed: Connection lost'));
  });

  it('restores exactly the selective scope accepted by the preview', async () => {
    let finishRestore;
    mockRestoreBackup
      .mockResolvedValueOnce({
        dryRun: true,
        snapshotId: '2026-08-25T11-00-00',
        subdirFilter: 'brain',
        changedFiles: ['brain/example.json'],
        verification: { status: 'verified', checkedFiles: 1 },
      })
      .mockReturnValueOnce(new Promise(resolve => { finishRestore = resolve; }));
    renderWidget();

    const filter = await openRestorePanel();
    fireEvent.change(filter, { target: { value: ' brain ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(await screen.findByText('brain/example.json')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Snapshot integrity verified (1 selected file(s)).');
    expect(mockRestoreBackup).toHaveBeenNthCalledWith(1, {
      snapshotId: '2026-08-25T11-00-00',
      subdirFilter: 'brain',
      dryRun: true,
    }, { silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Restore 1 file(s)' }));
    expect(mockRestoreBackup).toHaveBeenNthCalledWith(2, {
      snapshotId: '2026-08-25T11-00-00',
      subdirFilter: 'brain',
      dryRun: false,
    }, { silent: true });
    expect(filter).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Snapshots' })).toBeDisabled();

    await act(async () => {
      finishRestore({ changedFiles: ['brain/example.json'] });
    });
    expect(mockToast.success).toHaveBeenCalledWith('Restore complete — 1 file(s) restored');
  });

  it('warns before confirming a legacy snapshot without an integrity manifest', async () => {
    mockRestoreBackup.mockResolvedValueOnce({
      dryRun: true,
      changedFiles: ['settings.json'],
      verification: { status: 'unverified', reason: 'manifest_absent', checkedFiles: 0 },
    });
    renderWidget();

    await openRestorePanel();
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Legacy snapshot: no integrity manifest is available. PortOS cannot verify these backup bytes before restore.',
    );
    expect(screen.getByRole('button', { name: 'Restore 1 file(s)' })).toBeEnabled();
  });

  it('invalidates a selective preview when the filter is cleared', async () => {
    mockRestoreBackup
      .mockResolvedValueOnce({ changedFiles: ['brain/example.json'] })
      .mockResolvedValueOnce({ changedFiles: ['brain/example.json', 'media/example.json'] })
      .mockResolvedValueOnce({ changedFiles: ['brain/example.json', 'media/example.json'] });
    renderWidget();

    const filter = await openRestorePanel();
    fireEvent.change(filter, { target: { value: 'brain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByRole('button', { name: 'Restore 1 file(s)' })).toBeEnabled();

    fireEvent.change(filter, { target: { value: '' } });
    expect(screen.queryByText('brain/example.json')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore \d+ file/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByRole('button', { name: 'Restore 2 file(s)' })).toBeEnabled();
    expect(mockRestoreBackup).toHaveBeenNthCalledWith(2, {
      snapshotId: '2026-08-25T11-00-00',
      subdirFilter: null,
      dryRun: true,
    }, { silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Restore 2 file(s)' }));
    await waitFor(() => expect(mockRestoreBackup).toHaveBeenNthCalledWith(3, {
      snapshotId: '2026-08-25T11-00-00',
      subdirFilter: null,
      dryRun: false,
    }, { silent: true }));
  });

  it('ignores a late preview response after the filter changes', async () => {
    let finishPreview;
    mockRestoreBackup.mockReturnValue(new Promise(resolve => { finishPreview = resolve; }));
    renderWidget();

    const filter = await openRestorePanel();
    fireEvent.change(filter, { target: { value: 'brain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    fireEvent.change(filter, { target: { value: 'media' } });

    await act(async () => {
      finishPreview({ changedFiles: ['brain/example.json'] });
    });
    expect(screen.queryByText('brain/example.json')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore \d+ file/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeEnabled();
  });

  it('reports a current preview failure and re-enables previewing', async () => {
    mockRestoreBackup.mockRejectedValueOnce(new Error('disk offline'));
    renderWidget();

    await openRestorePanel();
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Preview failed: disk offline'));
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeEnabled();
  });

  it('suppresses a late preview failure after the filter changes', async () => {
    let rejectPreview;
    mockRestoreBackup.mockReturnValue(new Promise((_, reject) => { rejectPreview = reject; }));
    renderWidget();

    const filter = await openRestorePanel();
    fireEvent.change(filter, { target: { value: 'brain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    fireEvent.change(filter, { target: { value: 'media' } });

    await act(async () => {
      rejectPreview(new Error('disk offline'));
    });
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeEnabled();
  });
});

describe('BackupWidget manual backup', () => {
  it('announces an already-running backup without success feedback', async () => {
    mockTriggerBackup.mockResolvedValue({ skipped: true });
    renderWidget();
    fireEvent.click(await screen.findByRole('button', { name: 'Backup Now' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Backup already running'));
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Backup Now' })).toBeEnabled();
  });

  it('reports the completed file count for a healthy backup', async () => {
    mockTriggerBackup.mockResolvedValue({ status: 'ok', filesChanged: 3, pgBackup: { status: 'ok' } });
    renderWidget();
    fireEvent.click(await screen.findByRole('button', { name: 'Backup Now' }));

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Backup complete — 3 files changed', { icon: '💾' }));
    expect(mockToast.success).toHaveBeenCalledTimes(1);
    expect(mockTriggerBackup).toHaveBeenCalledWith({ silent: true });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('qualifies file completion when the database dump failed', async () => {
    mockTriggerBackup.mockResolvedValue({ status: 'degraded', filesChanged: 3, pgBackup: { status: 'failed' } });
    renderWidget();
    fireEvent.click(await screen.findByRole('button', { name: 'Backup Now' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Backup complete — 3 files changed; database dump failed', { icon: '⚠️' }));
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('disables the pending action and clears it with one error on rejection', async () => {
    let rejectRun;
    mockTriggerBackup.mockReturnValue(new Promise((_, reject) => { rejectRun = reject; }));
    renderWidget();
    fireEvent.click(await screen.findByRole('button', { name: 'Backup Now' }));
    expect(screen.getByRole('button', { name: /Backup Now/ })).toBeDisabled();

    await act(async () => { rejectRun(new Error('Connection lost')); });

    expect(mockTriggerBackup).toHaveBeenCalledWith({ silent: true });
    expect(mockToast.error).toHaveBeenCalledExactlyOnceWith('Connection lost');
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Backup Now' })).toBeEnabled();
  });
});
