import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SchedulesTab from './SchedulesTab.jsx';

vi.mock('../../../services/api', () => ({
  getAutomationSchedules: vi.fn(),
  getPlatformAccounts: vi.fn(),
  getScheduleStats: vi.fn(),
  runAutomationScheduleNow: vi.fn(),
}));

import * as api from '../../../services/api';

describe('SchedulesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explains an initial load failure and retries without duplicate error toasts', async () => {
    api.getAutomationSchedules
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce([]);
    api.getPlatformAccounts.mockResolvedValue([]);
    api.getScheduleStats.mockResolvedValue(null);

    render(<SchedulesTab agentId="agent-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load automation schedules.');
    expect(api.getAutomationSchedules).toHaveBeenLastCalledWith('agent-1', null, { silent: true });
    expect(api.getPlatformAccounts).toHaveBeenLastCalledWith('agent-1', null, { silent: true });
    expect(api.getScheduleStats).toHaveBeenLastCalledWith({ silent: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(await screen.findByText('No schedules')).toBeInTheDocument();
    expect(api.getAutomationSchedules).toHaveBeenCalledTimes(2);
  });

  it('re-enables Run Now after the schedule request fails', async () => {
    api.getAutomationSchedules.mockResolvedValue([{
      id: 'schedule-1', agentId: 'agent-1', accountId: 'account-1', enabled: true,
      action: { type: 'heartbeat', params: {} }, schedule: { type: 'interval', intervalMs: 60000 },
      rateLimit: { maxPerDay: 5 },
    }]);
    api.getPlatformAccounts.mockResolvedValue([{ id: 'account-1', status: 'active', credentials: { username: 'example-user' } }]);
    api.getScheduleStats.mockResolvedValue(null);
    api.runAutomationScheduleNow.mockRejectedValueOnce(new Error('Run failed'));

    render(<SchedulesTab agentId="agent-1" />);
    const runButton = await screen.findByRole('button', { name: 'Run Now' });

    await act(async () => { fireEvent.click(runButton); });

    expect(runButton).toBeEnabled();
    expect(runButton).toHaveTextContent('Run Now');
  });
});
