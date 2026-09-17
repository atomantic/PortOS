import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import JobsTab from './JobsTab';
import { findEnabledByRole } from '../../../test/enabledBarrier.js';

const api = vi.hoisted(() => ({
  getCosJobs: vi.fn(),
  triggerCosJob: vi.fn(),
  updateCosJob: vi.fn(),
  toggleCosJob: vi.fn(),
  deleteCosJob: vi.fn(),
  getJobHistory: vi.fn(),
  getApps: vi.fn(),
  getProviders: vi.fn(),
  getSettings: vi.fn(),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), loading: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const mockJob = {
  id: 'job-1',
  name: 'Test Job',
  description: 'Test job description',
  type: 'agent',
  interval: 'daily',
  intervalMs: 86400000,
  priority: 'MEDIUM',
  autonomyLevel: 'medium',
  enabled: true,
  promptTemplate: 'Do test things',
  category: 'General',
  lastRun: null,
  runCount: 0
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosJobs.mockResolvedValue({ jobs: [mockJob] });
  api.getJobHistory.mockResolvedValue({ runs: [] });
  api.triggerCosJob.mockResolvedValue({ success: true });
  api.updateCosJob.mockResolvedValue({ job: mockJob });
  api.getApps.mockResolvedValue([]);
  api.getProviders.mockResolvedValue({ providers: [] });
  api.getSettings.mockResolvedValue({ timezone: 'UTC' });
});

describe('JobsTab / JobCard Run Now disable behavior (#4036)', () => {
  it('surfaces a deliberate skipped trigger without claiming the job ran', async () => {
    api.triggerCosJob.mockResolvedValue({
      success: false,
      status: 'skipped',
      reason: 'Task was not queued'
    });
    render(<JobsTab apps={[]} providers={[]} />);
    await waitFor(() => expect(screen.getByText('Test Job')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Task was not queued',
      { id: 'job-trigger' }
    ));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('enables the Run now button when not editing and disables it while editing (save flow)', async () => {
    render(<JobsTab apps={[]} providers={[]} />);

    // Wait for jobs to load
    await waitFor(() => expect(screen.getByText('Test Job')).toBeInTheDocument());

    const runNowButton = screen.getByRole('button', { name: 'Run now' });
    expect(runNowButton).not.toBeDisabled();
    expect(runNowButton).toHaveAttribute('title', 'Run now');

    // Click edit button
    const editButton = screen.getByRole('button', { name: 'Edit' });
    fireEvent.click(editButton);

    // The name stays the visible "Run now" (an aria-label would hide it from a
    // speech-input user); the reason it is disabled lives in the title.
    const disabledRunNowButton = screen.getByRole('button', { name: 'Run now' });
    expect(disabledRunNowButton).toBeDisabled();
    expect(disabledRunNowButton).toHaveAttribute('title', 'Save changes before running job');

    // Attempting to click Run now while editing should not trigger job
    fireEvent.click(disabledRunNowButton);
    expect(api.triggerCosJob).not.toHaveBeenCalled();

    // Saving edits should re-enable the button
    const saveButton = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveButton);

    await findEnabledByRole('button', { name: 'Run now' });
  });

  it('re-enables the Run now button when exiting edit mode via Cancel', async () => {
    render(<JobsTab apps={[]} providers={[]} />);

    await waitFor(() => expect(screen.getByText('Test Job')).toBeInTheDocument());

    const editButton = screen.getByRole('button', { name: 'Edit' });
    fireEvent.click(editButton);

    const editingRunNow = screen.getByRole('button', { name: 'Run now' });
    expect(editingRunNow).toBeDisabled();
    expect(editingRunNow).toHaveAttribute('title', 'Save changes before running job');

    // Click Cancel button
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    const reEnabledRunNow = screen.getByRole('button', { name: 'Run now' });
    expect(reEnabledRunNow).not.toBeDisabled();
  });

  it('uses the server-projected recurrence run for the Due badge', async () => {
    const recurrenceJob = {
      ...mockJob,
      lastRun: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      cronSchedule: { frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-08-31' },
      cronExpression: '0 2 * * 1',
      nextRunAt: new Date(Date.now() + 7 * 86_400_000).toISOString()
    };
    api.getCosJobs.mockResolvedValue({ jobs: [recurrenceJob] });
    render(<JobsTab apps={[]} providers={[]} />);

    await waitFor(() => expect(screen.getByText('Test Job')).toBeInTheDocument());
    expect(screen.queryByText('Due')).not.toBeInTheDocument();
  });
});
