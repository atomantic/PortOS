import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  getAgentPersonalities: vi.fn(),
  getPlatformAccounts: vi.fn(),
  getScheduleStats: vi.fn(),
  getProviders: vi.fn(),
  getAutomationSchedules: vi.fn(),
}));

import * as api from '../../services/api';
import AgentList from './AgentList.jsx';

describe('AgentList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAgentPersonalities.mockResolvedValue([]);
    api.getPlatformAccounts.mockResolvedValue([]);
    api.getScheduleStats.mockResolvedValue({ total: 0, totalRuns: 0 });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getAutomationSchedules.mockResolvedValue([]);
  });

  it('shows a retryable error instead of an endless spinner when one load fails, and recovers on Retry', async () => {
    api.getScheduleStats.mockRejectedValueOnce(new Error('stats unavailable'));

    render(<MemoryRouter><AgentList /></MemoryRouter>);

    expect(await screen.findByText(/Could not load social agents/)).toBeInTheDocument();
    expect(screen.queryByText('Loading agents')).not.toBeInTheDocument();
    expect(api.getAgentPersonalities).toHaveBeenLastCalledWith(null, { silent: true });
    expect(api.getAutomationSchedules).toHaveBeenLastCalledWith(null, null, { silent: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(await screen.findByRole('heading', { name: 'Social Agents' })).toBeInTheDocument();
    expect(api.getScheduleStats).toHaveBeenCalledTimes(2);
  });
});
