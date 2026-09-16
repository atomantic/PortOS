import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AppQualityScheduleForm from './AppQualityScheduleForm';

vi.mock('../../services/apiApps', () => ({
  getAppQualitySchedule: vi.fn(),
  previewAppQualitySchedule: vi.fn(),
  applyAppQualitySchedule: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { applyAppQualitySchedule, getAppQualitySchedule, previewAppQualitySchedule } from '../../services/apiApps';
import toast from '../ui/Toast';

// The server resolves the whole bag, so the form never fills a default itself.
const OPTIONS = { checksPerDay: null, windowStartHour: 0, windowEndHour: 23, claimBetween: true, claimOffsetHours: 3, claimTaskType: 'claim-work', padBeforeHours: 1, padAfterHours: 2, fileIssues: true };

const response = (overrides = {}) => ({
  checks: [
    { taskType: 'security', label: 'Security', applicable: true, reason: null },
    { taskType: 'accessibility', label: 'Accessibility', applicable: false, reason: 'no user interface found in this repository' },
  ],
  capabilities: { ui: false, tests: true },
  scanned: 120,
  claimTaskTypes: ['claim-work', 'claim-issue', 'plan-task'],
  busySources: [{ taskType: 'release-check', cron: '30 3 * * *', origin: 'app' }],
  plan: {
    checksPerDay: 1,
    slots: [{ taskType: 'security', label: 'Security', day: 1, hour: 9, fileIssues: true, cron: '0 9 * * 1' }],
    claim: { taskType: 'claim-work', hours: [12], cron: '0 12 * * *' },
    warnings: [],
    options: OPTIONS,
  },
  ...overrides,
});

const app = { id: 'example-app', name: 'Example App' };
const renderForm = () => render(<MemoryRouter><AppQualityScheduleForm app={app} /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  getAppQualitySchedule.mockResolvedValue(response());
  previewAppQualitySchedule.mockImplementation(async () => response());
  applyAppQualitySchedule.mockImplementation(async () => response());
});

describe('AppQualityScheduleForm', () => {
  it('renders the planned week and says which checks the repository skipped', async () => {
    renderForm();
    expect(await screen.findByRole('heading', { name: 'Weekly quality schedule' })).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 checks apply to this repository/)).toBeInTheDocument();
    // The planned week, not just the checkbox list, names the check and its hour.
    const week = screen.getByRole('table');
    expect(within(week).getByText('Mon')).toBeInTheDocument();
    expect(within(week).getByText('09:00')).toBeInTheDocument();
    expect(within(week).getByText(/Security/)).toBeInTheDocument();
    expect(screen.getByText(/no user interface found in this repository/)).toBeInTheDocument();
    expect(screen.getByText(/Planned around 1 existing job/)).toBeInTheDocument();
  });

  it('writes nothing until Apply is pressed', async () => {
    renderForm();
    await screen.findByRole('heading', { name: 'Weekly quality schedule' });
    fireEvent.change(screen.getByLabelText('Checks per day'), { target: { value: '2' } });
    await waitFor(() => expect(previewAppQualitySchedule).toHaveBeenCalled());
    expect(applyAppQualitySchedule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Apply schedule/ }));
    await waitFor(() => expect(applyAppQualitySchedule).toHaveBeenCalled());
    expect(applyAppQualitySchedule.mock.calls[0][1]).toMatchObject({ taskTypes: ['security'], checksPerDay: 2 });
    expect(toast.success).toHaveBeenCalled();
  });

  it('asks for one plan after a burst of edits, not one per keystroke', async () => {
    renderForm();
    await screen.findByRole('heading', { name: 'Weekly quality schedule' });
    // Arrow-keying a 24-option hour select fires a change per step; each
    // preview behind it is a repository scan and a database read.
    const earliest = screen.getByLabelText('Earliest hour');
    for (const value of ['1', '2', '3', '4', '5']) fireEvent.change(earliest, { target: { value } });
    await waitFor(() => expect(previewAppQualitySchedule).toHaveBeenCalled());
    expect(previewAppQualitySchedule).toHaveBeenCalledTimes(1);
    expect(previewAppQualitySchedule.mock.calls[0][1].windowStartHour).toBe(5);
  });

  it('asks for no plan at all until the form is touched', async () => {
    renderForm();
    await screen.findByRole('heading', { name: 'Weekly quality schedule' });
    // The initial GET already carried the plan for the untouched form.
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(previewAppQualitySchedule).not.toHaveBeenCalled();
  });

  it('sends only the checks still ticked', async () => {
    renderForm();
    await screen.findByRole('heading', { name: 'Weekly quality schedule' });
    fireEvent.click(screen.getByLabelText('Security'));
    await waitFor(() => {
      const last = previewAppQualitySchedule.mock.calls.at(-1)?.[1];
      expect(last?.taskTypes).toEqual([]);
    });
  });

  it('drops the claim job from the request when the user turns it off', async () => {
    renderForm();
    await screen.findByRole('heading', { name: 'Weekly quality schedule' });
    fireEvent.change(screen.getByLabelText('Between checks'), { target: { value: '' } });
    await waitFor(() => expect(previewAppQualitySchedule.mock.calls.at(-1)?.[1].claimBetween).toBe(false));
  });

  it('surfaces a planner warning rather than hiding an unschedulable form', async () => {
    getAppQualitySchedule.mockResolvedValue(response({
      plan: { ...response().plan, warnings: ['26 checks need 4 slots a day, which does not fit in a 3-hour window — widen the window or deselect checks.'] },
    }));
    renderForm();
    expect(await screen.findByText(/does not fit in a 3-hour window/)).toBeInTheDocument();
  });

  it('reports a failed load instead of rendering an empty schedule', async () => {
    getAppQualitySchedule.mockRejectedValue(new Error('Server unreachable'));
    renderForm();
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unreachable');
    expect(screen.queryByRole('button', { name: /Apply schedule/ })).not.toBeInTheDocument();
  });
});
