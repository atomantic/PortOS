import { MemoryRouter } from 'react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetBackupStatus,
  mockGetBackupSnapshots,
  mockDownloadBackupSnapshot,
  mockTriggerBackup,
  mockToast,
} = vi.hoisted(() => ({
  mockGetBackupStatus: vi.fn(),
  mockGetBackupSnapshots: vi.fn(),
  mockDownloadBackupSnapshot: vi.fn(),
  mockTriggerBackup: vi.fn(),
  mockToast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('../services/api', () => ({
  getBackupStatus: (...args) => mockGetBackupStatus(...args),
  getBackupSnapshots: (...args) => mockGetBackupSnapshots(...args),
  downloadBackupSnapshot: (...args) => mockDownloadBackupSnapshot(...args),
  triggerBackup: (...args) => mockTriggerBackup(...args),
}));

vi.mock('./ui/Toast', () => ({ default: mockToast }));

import BackupWidget from './BackupWidget.jsx';

const renderWidget = () => render(
  <MemoryRouter>
    <BackupWidget />
  </MemoryRouter>,
);

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

  it('offers a download action for each snapshot and confirms success', async () => {
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    const download = await screen.findByRole('button', { name: /Download snapshot 2026-08-25T11-00-00/ });
    fireEvent.click(download);

    await waitFor(() => expect(mockDownloadBackupSnapshot).toHaveBeenCalledWith('2026-08-25T11-00-00'));
    expect(mockToast.success).toHaveBeenCalledWith('Snapshot downloaded');
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
