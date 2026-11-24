import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: socket }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), loading: vi.fn() }));

vi.mock('../../../services/apiAgents.js', () => ({
  getCosJobs: api.getCosJobs,
  triggerCosJob: api.triggerCosJob,
  updateCosJob: api.updateCosJob,
  toggleCosJob: api.toggleCosJob,
  deleteCosJob: api.deleteCosJob,
}));
vi.mock('../../../services/apiApps.js', () => ({ getApps: api.getApps }));
vi.mock('../../../services/apiProviders.js', () => ({ getProviders: api.getProviders }));
vi.mock('../../../services/apiSystem.js', () => ({ getSettings: api.getSettings }));
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

it('refetches jobs when a job incident changes and detaches on unmount', async () => {
  const { unmount } = render(<JobsTab />);
  await waitFor(() => expect(api.getCosJobs).toHaveBeenCalledTimes(1));
  const handler = socket.on.mock.calls.find(([event]) => event === 'cos:jobs:incidents-changed')?.[1];
  expect(handler).toBeTypeOf('function');
  await act(async () => { handler({ jobId: 'job-1' }); });
  await waitFor(() => expect(api.getCosJobs).toHaveBeenCalledTimes(2));
  unmount();
  expect(socket.off).toHaveBeenCalledWith('cos:jobs:incidents-changed', handler);
});

it('shows a retryable error when the provider read fails instead of hiding the provider pickers', async () => {
  api.getProviders.mockRejectedValueOnce(new Error('Server unavailable'))
    .mockResolvedValueOnce({ providers: [] });
  render(<JobsTab apps={[]} providers={[]} />);
  expect(await screen.findByText(/Could not load AI providers for the job provider pickers — Server unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByText(/Could not load AI providers/)).not.toBeInTheDocument());
  expect(api.getProviders).toHaveBeenCalledTimes(2);
});

it('keeps the provider pickers when an older provider retry fails after a newer one succeeded', async () => {
  let rejectSlow;
  api.getProviders.mockRejectedValueOnce(new Error('Server unavailable'))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSlow = reject; }))
    .mockResolvedValueOnce({ providers: [] });
  render(<JobsTab apps={[]} providers={[]} />);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByText(/Could not load AI providers/)).not.toBeInTheDocument());
  await act(async () => rejectSlow(new Error('Late failure')));
  expect(screen.queryByText(/Could not load AI providers/)).not.toBeInTheDocument();
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

  it('shows an error row with Retry when the apps read fails, and recovers on retry', async () => {
    api.getApps.mockRejectedValueOnce(new Error('apps 500'));
    render(<JobsTab apps={[]} providers={[]} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load apps for the job scope pickers — apps 500');

    api.getApps.mockResolvedValue([{ id: 'app-1', name: 'Example App' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(api.getApps).toHaveBeenCalledTimes(2);
  });

  it('applies a toggle response in place without re-reading the job list', async () => {
    api.getCosJobs.mockResolvedValue({ jobs: [mockJob], stats: { enabled: 1, total: 1, totalRuns: 0 } });
    api.toggleCosJob.mockResolvedValue({ success: true, job: { ...mockJob, enabled: false } });
    render(<JobsTab apps={[]} providers={[]} />);
    await screen.findByText('Test Job');

    fireEvent.click(screen.getByRole('button', { name: 'Disable job' }));
    expect(await screen.findByRole('button', { name: 'Enable job' })).toBeInTheDocument();
    expect(screen.getByText('0 enabled / 1 total')).toBeInTheDocument();
    expect(api.getCosJobs).toHaveBeenCalledTimes(1);
  });

  it('offers no Trigger action control for shell jobs in the create or edit form (#17575)', async () => {
    api.getCosJobs.mockResolvedValue({ jobs: [{ ...mockJob, type: 'shell', command: 'echo hi' }] });
    render(<JobsTab apps={[]} providers={[]} />);
    await waitFor(() => expect(screen.getByText('Test Job')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New Job/ }));
    const typeSelect = screen.getAllByRole('combobox').find(el => [...el.options].some(o => o.value === 'shell'));
    fireEvent.change(typeSelect, { target: { value: 'shell' } });
    expect(screen.getByLabelText('Shell command')).toBeInTheDocument();
    expect(screen.queryByLabelText('Trigger action')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getAllByLabelText('Shell command').length).toBeGreaterThan(1);
    expect(screen.queryByLabelText('Trigger action')).toBeNull();
  });
});

it.each([false, true])('retries a failed system tasks read (has jobs: %s)', async (hasJobs) => {
  api.getCosJobs.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ jobs: hasJobs ? [mockJob] : [] });
  render(<JobsTab />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load system tasks');
  expect(screen.queryByText('No system tasks configured.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(hasJobs ? mockJob.name : 'No system tasks configured.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
