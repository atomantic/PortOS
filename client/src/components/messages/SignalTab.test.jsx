import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(), updateSettings: vi.fn(), getSignalStatus: vi.fn(),
  checkSignalSetup: vi.fn(), syncSignal: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));
import { SignalTab } from './SignalTab';

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ signal: { enabled: false, intervalMinutes: 60 } });
  api.getSignalStatus.mockResolvedValue({ state: {} });
});

it('requires a saved opt-in before accessing Signal and explains a disabled setup response', async () => {
  let finishSave;
  api.updateSettings.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
  api.checkSignalSetup.mockResolvedValue({ enabled: false });
  render(<SignalTab />);
  const sync = await screen.findByRole('button', { name: 'Sync now' });
  const check = screen.getByRole('button', { name: 'Check setup' });
  expect(sync.disabled).toBe(true);
  expect(check.disabled).toBe(true);

  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scheduled Signal sync' }));
  expect(sync.disabled).toBe(true);
  expect(check.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(sync.disabled).toBe(true);
  expect(check.disabled).toBe(true);
  finishSave({ signal: { enabled: true, intervalMinutes: 60 } });
  await waitFor(() => expect(check.disabled).toBe(false));
  expect(sync.disabled).toBe(false);

  fireEvent.click(check);
  expect(await screen.findByText('Enable Signal sync and save before checking setup or syncing.')).toBeTruthy();
  expect(toast.error).toHaveBeenCalledWith('Enable Signal sync and save before checking setup or syncing.');
  expect(api.syncSignal).not.toHaveBeenCalled();
});
