import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SchedulesTab from './SchedulesTab.jsx';

vi.mock('../../../services/apiSchedules.js', () => ({
  getAutomationSchedules: vi.fn(),
  getScheduleStats: vi.fn(),
  runAutomationScheduleNow: vi.fn(),
  toggleAutomationSchedule: vi.fn(),
  deleteAutomationSchedule: vi.fn(),
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

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /delete/i })); });
    expect(await screen.findByText('No schedules')).toBeInTheDocument();
    expect(getAutomationSchedules).toHaveBeenCalledTimes(1);
  });
});
