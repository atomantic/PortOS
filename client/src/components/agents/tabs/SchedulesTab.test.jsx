import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SchedulesTab from './SchedulesTab.jsx';

vi.mock('../../../services/apiSchedules.js', () => ({
  getAutomationSchedules: vi.fn(),
  getScheduleStats: vi.fn(),
  runAutomationScheduleNow: vi.fn(),
  toggleAutomationSchedule: vi.fn(),
  deleteAutomationSchedule: vi.fn(),
  createAutomationSchedule: vi.fn(),
}));
vi.mock('../../../services/apiAccounts.js', () => ({
  getPlatformAccounts: vi.fn(),
}));

import {
  getAutomationSchedules,
  getScheduleStats,
  runAutomationScheduleNow,
  toggleAutomationSchedule,
  deleteAutomationSchedule,
  createAutomationSchedule,
} from '../../../services/apiSchedules.js';
import { getPlatformAccounts } from '../../../services/apiAccounts.js';

describe('SchedulesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explains an initial load failure and retries without duplicate error toasts', async () => {
    getAutomationSchedules
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce([]);
    getPlatformAccounts.mockResolvedValue([]);
    getScheduleStats.mockResolvedValue(null);

    render(<SchedulesTab agentId="agent-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load automation schedules.');
    expect(getAutomationSchedules).toHaveBeenLastCalledWith('agent-1', null, { silent: true });
    expect(getPlatformAccounts).toHaveBeenLastCalledWith('agent-1', null, { silent: true });
    expect(getScheduleStats).toHaveBeenLastCalledWith({ silent: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(await screen.findByText('No schedules')).toBeInTheDocument();
    expect(getAutomationSchedules).toHaveBeenCalledTimes(2);
  });

  it('re-enables Run Now after the schedule request fails', async () => {
    getAutomationSchedules.mockResolvedValue([{
      id: 'schedule-1', agentId: 'agent-1', accountId: 'account-1', enabled: true,
      action: { type: 'heartbeat', params: {} }, schedule: { type: 'interval', intervalMs: 60000 },
      rateLimit: { maxPerDay: 5 },
    }]);
    getPlatformAccounts.mockResolvedValue([{ id: 'account-1', status: 'active', credentials: { username: 'example-user' } }]);
    getScheduleStats.mockResolvedValue(null);
    runAutomationScheduleNow.mockRejectedValueOnce(new Error('Run failed'));

    render(<SchedulesTab agentId="agent-1" />);
    const runButton = await screen.findByRole('button', { name: 'Run Now' });

    await act(async () => { fireEvent.click(runButton); });

    expect(runButton).toBeEnabled();
    expect(runButton).toHaveTextContent('Run Now');
  });

  it('applies toggle and delete in place without refetching or flashing the spinner', async () => {
    const schedule = {
      id: 'schedule-1', agentId: 'agent-1', accountId: 'account-1', enabled: true,
      action: { type: 'heartbeat', params: {} }, schedule: { type: 'interval', intervalMs: 60000 },
      rateLimit: { maxPerDay: 5 },
    };
    getAutomationSchedules.mockResolvedValue([schedule]);
    getPlatformAccounts.mockResolvedValue([{ id: 'account-1', status: 'active', credentials: { username: 'example-user' } }]);
    getScheduleStats.mockResolvedValue({});
    toggleAutomationSchedule.mockResolvedValue({ ...schedule, enabled: false });
    deleteAutomationSchedule.mockResolvedValue({ success: true });

    render(<SchedulesTab agentId="agent-1" />);
    await screen.findByText('1 enabled / 1 total');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enabled' })); });
    expect(screen.getByText('0 enabled / 1 total')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    expect(deleteAutomationSchedule).not.toHaveBeenCalled();
    expect(screen.getByText('Heartbeat')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel schedule deletion' })); });
    expect(deleteAutomationSchedule).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delete schedule' })); });
    expect(await screen.findByText('No schedules')).toBeInTheDocument();
    expect(deleteAutomationSchedule).toHaveBeenCalledWith('schedule-1');
    expect(getAutomationSchedules).toHaveBeenCalledTimes(1);
  });

  it('keeps the schedule when delete fails and disables confirm while the request is in flight', async () => {
    const schedule = {
      id: 'schedule-1', agentId: 'agent-1', accountId: 'account-1', enabled: true,
      action: { type: 'heartbeat', params: {} }, schedule: { type: 'interval', intervalMs: 60000 },
      rateLimit: { maxPerDay: 5 },
    };
    getAutomationSchedules.mockResolvedValue([schedule]);
    getPlatformAccounts.mockResolvedValue([]);
    getScheduleStats.mockResolvedValue({});
    let resolveDelete;
    deleteAutomationSchedule.mockReturnValue(new Promise((resolve) => { resolveDelete = resolve; }));

    render(<SchedulesTab agentId="agent-1" />);
    await screen.findByText('1 enabled / 1 total');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delete schedule' })); });
    expect(screen.getByRole('button', { name: 'Confirm delete schedule' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel schedule deletion' })).toBeDisabled();
    await act(async () => { resolveDelete({ success: true }); });
    expect(await screen.findByText('No schedules')).toBeInTheDocument();
  });

  it('keeps the schedule when deletion fails', async () => {
    const schedule = {
      id: 'schedule-1', agentId: 'agent-1', accountId: 'account-1', enabled: true,
      action: { type: 'heartbeat', params: {} }, schedule: { type: 'interval', intervalMs: 60000 },
      rateLimit: { maxPerDay: 5 },
    };
    getAutomationSchedules.mockResolvedValue([schedule]);
    getPlatformAccounts.mockResolvedValue([]);
    getScheduleStats.mockResolvedValue({});
    deleteAutomationSchedule.mockRejectedValue(new Error('delete failed'));

    render(<SchedulesTab agentId="agent-1" />);
    await screen.findByText('1 enabled / 1 total');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delete schedule' })); });
    expect(screen.getByText('1 enabled / 1 total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('preserves the create form when schedule creation fails', async () => {
    getAutomationSchedules.mockResolvedValue([]);
    getPlatformAccounts.mockResolvedValue([{ id: 'account-1', status: 'active', credentials: { username: 'example-user' } }]);
    getScheduleStats.mockResolvedValue({});
    createAutomationSchedule.mockRejectedValue(new Error('create failed'));

    render(<SchedulesTab agentId="agent-1" />);
    await screen.findByText('No schedules');
    fireEvent.click(screen.getByRole('button', { name: '+ New Schedule' }));
    fireEvent.change(screen.getByLabelText(/Account/i), { target: { value: 'account-1' } });
    const submit = screen.getByRole('button', { name: 'Create Schedule' });
    await act(async () => { fireEvent.click(submit); });
    expect(submit).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Create Schedule' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Account/i)).toHaveValue('account-1');
  });

  it('wraps schedule cards and gives compact actions a coarse-pointer hit area', async () => {
    getAutomationSchedules.mockResolvedValue([{
      id: 'schedule-1', agentId: 'agent-1', accountId: 'account-1', enabled: true,
      action: { type: 'heartbeat', params: {} }, schedule: { type: 'interval', intervalMs: 60000 },
      rateLimit: { maxPerDay: 5 },
    }]);
    getPlatformAccounts.mockResolvedValue([{ id: 'account-1', status: 'active', credentials: { username: 'example-user' } }]);
    getScheduleStats.mockResolvedValue({});

    render(<SchedulesTab agentId="agent-1" />);
    const run = await screen.findByRole('button', { name: 'Run Now' });
    expect(run.className).toContain('pointer-coarse:min-h-11');
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('pointer-coarse:min-h-11');
    expect(run.parentElement.parentElement.className).toContain('flex-wrap');
    expect(screen.getByRole('heading', { name: 'Automation Schedules' }).parentElement.parentElement.className).toContain('flex-wrap');

    fireEvent.click(screen.getByRole('button', { name: '+ New Schedule' }));
    const grid = screen.getByText('Account').closest('.grid');
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('sm:grid-cols-2');
  });
});
