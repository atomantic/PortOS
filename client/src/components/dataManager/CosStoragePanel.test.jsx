import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CosStoragePanel from './CosStoragePanel';
import * as api from '../../services/apiSystem';
vi.mock('../../services/apiSystem', () => ({
  getCosStorage: vi.fn(), previewCosStorage: vi.fn(), runCosStorage: vi.fn(),
  cancelCosStorage: vi.fn(), saveCosStoragePolicy: vi.fn(), pinCosRecording: vi.fn(),
}));
vi.mock('../../services/socket', () => ({ default: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
const policy = { autoCompress: true, compressAfterDays: 7, autoPurge: false, purgeAfterDays: 90 };
beforeEach(() => {
  vi.clearAllMocks();
  api.getCosStorage.mockResolvedValue({ policy, job: null });
  api.previewCosStorage.mockResolvedValue({ token: 'example-token', models: [], rows: [], reasons: {}, totals: { eligibleRuns: 1, eligibleBytes: 2048, unreadable: 0 }, matching: 0, offset: 0, batchLimit: 1000 });
  api.runCosStorage.mockResolvedValue({ policy, job: { action: 'purge', state: 'running', total: 1, processed: 0, skipped: 0, failed: 0, reclaimedBytes: 0 } });
});
it('requires a fresh preview and explicit deletion consent, then shows progress without clearing history', async () => {
  render(<CosStoragePanel />);
  await screen.findByLabelText('Compress recordings automatically');
  fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'purge' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  const run = await screen.findByRole('button', { name: 'Delete eligible raw recordings' });
  expect(run).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/Permanently delete eligible raw recordings/));
  expect(run).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Exact model (blank for all)'), { target: { value: 'example-model' } });
  expect(screen.queryByRole('button', { name: 'Delete eligible raw recordings' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByRole('button', { name: 'Delete eligible raw recordings' });
  fireEvent.click(screen.getByLabelText(/Permanently delete eligible raw recordings/));
  fireEvent.click(screen.getByRole('button', { name: 'Delete eligible raw recordings' }));
  await waitFor(() => expect(api.runCosStorage).toHaveBeenCalledWith({ token: 'example-token', confirmation: 'PURGE RAW RECORDINGS' }, { silent: true }));
  expect(await screen.findByRole('button', { name: 'Cancel maintenance' })).toBeEnabled();
  expect(screen.getByText(/Metadata, summaries, prompts/)).toBeInTheDocument();
});
it('gates cleanup while policy changes are unsaved or saving', async () => {
  let resolveSave;
  api.saveCosStoragePolicy.mockReturnValue(new Promise(resolve => { resolveSave = resolve; }));
  render(<CosStoragePanel />);
  await screen.findByLabelText('Compress recordings automatically');
  fireEvent.click(screen.getByLabelText('Allow permanent raw recording deletion'));
  expect(screen.getByRole('button', { name: 'Preview cleanup' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save maintenance policy' }));
  expect(screen.getByRole('button', { name: 'Preview cleanup' })).toBeDisabled();
  resolveSave({ policy: { ...policy, autoPurge: true }, job: null });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview cleanup' })).toBeEnabled());
});
it('notifies the storage view once when a job completes, including reconnect reconciliation', async () => {
  const complete = vi.fn();
  api.getCosStorage.mockResolvedValue({ policy, job: { id: 'example-job', action: 'compress', state: 'completed', finishedAt: '2026-01-01T00:00:00Z', total: 1, processed: 1, skipped: 0, failed: 0, reclaimedBytes: 1024 } });
  const { rerender } = render(<CosStoragePanel onMaintenanceComplete={complete} />);
  await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  rerender(<CosStoragePanel onMaintenanceComplete={complete} />);
  expect(complete).toHaveBeenCalledTimes(1);
});
