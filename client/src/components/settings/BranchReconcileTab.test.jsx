import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getBranchReconcileStatus: vi.fn(),
  runBranchReconcile: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
vi.mock('../BrailleSpinner', () => ({ default: () => <div>loading</div> }));

import {
  getSettings, updateSettings, getBranchReconcileStatus, runBranchReconcile,
} from '../../services/api';
import { BranchReconcileTab } from './BranchReconcileTab';

beforeEach(() => {
  vi.clearAllMocks();
  getBranchReconcileStatus.mockResolvedValue({ lastRun: null });
});

describe('BranchReconcileTab', () => {
  it('disables Run Now when the reconciler is saved-disabled', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: false } });
    render(<BranchReconcileTab />);
    const runBtn = await screen.findByRole('button', { name: /run now/i });
    expect(runBtn).toBeDisabled();
  });

  it('disables Run Now while the form is dirty even if saved-enabled', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: true, cron: '0 3 * * *' } });
    render(<BranchReconcileTab />);
    const runBtn = await screen.findByRole('button', { name: /run now/i });
    expect(runBtn).not.toBeDisabled(); // saved-enabled, clean

    // Make the form dirty by toggling an action.
    fireEvent.click(screen.getByLabelText(/Auto-merge PRs/i));
    expect(runBtn).toBeDisabled();
  });

  it('runs a reconcile pass when Run Now is clicked (saved-enabled + clean)', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: true, cron: '0 3 * * *' } });
    runBranchReconcile.mockResolvedValue({ at: 't', cleaned: ['a'], dispatched: true });
    render(<BranchReconcileTab />);
    const runBtn = await screen.findByRole('button', { name: /run now/i });
    fireEvent.click(runBtn);
    await waitFor(() => expect(runBranchReconcile).toHaveBeenCalledWith({ silent: true }));
  });

  it('saves the config with the branchReconcile slice', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: false, cron: '0 3 * * *' } });
    updateSettings.mockResolvedValue({ branchReconcile: {} });
    render(<BranchReconcileTab />);
    await screen.findByRole('button', { name: /run now/i });
    fireEvent.click(screen.getByLabelText(/Enable the daily reconciler/i));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ branchReconcile: expect.objectContaining({ enabled: true }) })
    ));
  });
});
