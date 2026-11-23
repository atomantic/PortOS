import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/apiPersonalities.js', () => ({
  getAgentPersonalities: vi.fn(),
  createAgentPersonality: vi.fn(),
}));
vi.mock('../../services/apiAccounts.js', () => ({
  getPlatformAccounts: vi.fn(),
}));
vi.mock('../../services/apiSchedules.js', () => ({
  getScheduleStats: vi.fn(),
  getAutomationSchedules: vi.fn(),
}));
vi.mock('../../services/apiProviders.js', () => ({
  getProviders: vi.fn(),
}));

import { getAgentPersonalities, createAgentPersonality } from '../../services/apiPersonalities.js';
import { getPlatformAccounts } from '../../services/apiAccounts.js';
import { getScheduleStats, getAutomationSchedules } from '../../services/apiSchedules.js';
import { getProviders } from '../../services/apiProviders.js';
import AgentList from './AgentList.jsx';

describe('AgentList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentPersonalities.mockResolvedValue([]);
    getPlatformAccounts.mockResolvedValue([]);
    getScheduleStats.mockResolvedValue({ total: 0, totalRuns: 0 });
    getProviders.mockResolvedValue({ providers: [] });
    getAutomationSchedules.mockResolvedValue([]);
  });

  it('shows a retryable error instead of an endless spinner when one load fails, and recovers on Retry', async () => {
    getScheduleStats.mockRejectedValueOnce(new Error('stats unavailable'));

    render(<MemoryRouter><AgentList /></MemoryRouter>);

    expect(await screen.findByText(/Could not load social agents/)).toBeInTheDocument();
    expect(screen.queryByText('Loading agents')).not.toBeInTheDocument();
    expect(getAgentPersonalities).toHaveBeenLastCalledWith(null, { silent: true });
    expect(getAutomationSchedules).toHaveBeenLastCalledWith(null, null, { silent: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(await screen.findByRole('heading', { name: 'Social Agents' })).toBeInTheDocument();
    expect(getScheduleStats).toHaveBeenCalledTimes(2);
  });

  it('keeps the create form when agent creation fails', async () => {
    createAgentPersonality.mockRejectedValue(new Error('create failed'));
    render(<MemoryRouter><AgentList /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Social Agents' });
    fireEvent.click(screen.getByRole('button', { name: '+ New Agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Example Agent' } });
    const submit = screen.getByRole('button', { name: 'Create Agent' });
    await act(async () => { fireEvent.click(submit); });
    expect(submit).toBeEnabled();
    expect(screen.getByLabelText('Name')).toHaveValue('Example Agent');
    expect(screen.getByRole('heading', { name: 'Create New Agent' })).toBeInTheDocument();
  });
});
