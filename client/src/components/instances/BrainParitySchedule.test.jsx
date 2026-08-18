import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  getCosJob: vi.fn(),
  toggleCosJob: vi.fn(),
  updateCosJob: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { getCosJob, toggleCosJob, updateCosJob } from '../../services/api';
import BrainParitySchedule, { PARITY_SWEEP_JOB_ID } from './BrainParitySchedule';

const job = (overrides = {}) => ({
  id: PARITY_SWEEP_JOB_ID,
  name: 'Brain Parity Sweep',
  enabled: false,
  interval: 'weekly',
  lastRun: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BrainParitySchedule', () => {
  it('reads "Off" for the shipped default, so the sweep is visibly opt-in', async () => {
    getCosJob.mockResolvedValue(job());
    render(<BrainParitySchedule />);
    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.getByText(/only checked when you press Check/i)).toBeInTheDocument();
  });

  it('reads the job silently — an install without the job is not an error', async () => {
    getCosJob.mockResolvedValue(job());
    render(<BrainParitySchedule />);
    await screen.findByText('Off');
    expect(getCosJob).toHaveBeenCalledWith(PARITY_SWEEP_JOB_ID, { silent: true });
  });

  it('renders nothing on a server too old to ship the job', async () => {
    const err = new Error('Job not found');
    err.status = 404;
    getCosJob.mockRejectedValue(err);
    const { container } = render(<BrainParitySchedule />);
    await waitFor(() => expect(getCosJob).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a retry on a transient read failure rather than vanishing like an unsupported server', async () => {
    // A dropped connection must not read as "this install has no such job" —
    // that would hide the control with no way back short of a page reload.
    const err = new Error('Server unreachable');
    getCosJob.mockRejectedValueOnce(err).mockResolvedValueOnce(job());
    render(<BrainParitySchedule />);

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('enables the sweep through the job toggle and reflects the server result', async () => {
    getCosJob.mockResolvedValue(job());
    toggleCosJob.mockResolvedValue({ success: true, job: job({ enabled: true }) });
    render(<BrainParitySchedule />);

    await userEvent.click(await screen.findByText('Off'));

    expect(toggleCosJob).toHaveBeenCalledWith(PARITY_SWEEP_JOB_ID, { silent: true });
    expect(await screen.findByText('On')).toBeInTheDocument();
  });

  it('submits the interval NAME only, letting the server recompute intervalMs', async () => {
    getCosJob.mockResolvedValue(job({ enabled: true }));
    updateCosJob.mockResolvedValue({ success: true, job: job({ enabled: true, interval: 'daily' }) });
    render(<BrainParitySchedule />);

    const select = await screen.findByLabelText('Parity sweep interval');
    await userEvent.selectOptions(select, 'daily');

    expect(updateCosJob).toHaveBeenCalledWith(PARITY_SWEEP_JOB_ID, { interval: 'daily' }, { silent: true });
    await waitFor(() => expect(select).toHaveValue('daily'));
  });

  it('locks the interval picker while the sweep is off', async () => {
    getCosJob.mockResolvedValue(job());
    render(<BrainParitySchedule />);
    expect(await screen.findByLabelText('Parity sweep interval')).toBeDisabled();
  });
});
