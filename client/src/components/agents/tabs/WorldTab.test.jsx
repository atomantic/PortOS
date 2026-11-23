import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/apiAccounts.js', () => ({
  getPlatformAccounts: vi.fn(),
  moltworldStatus: vi.fn(),
  moltworldRateLimits: vi.fn(),
  moltworldGetQueue: vi.fn(),
}));
vi.mock('../../../services/apiAgents.js', () => ({
  getAgentActivityTimeline: vi.fn(),
}));
vi.mock('../../../hooks/useMoltworldWs', () => ({
  default: () => ({ connectionStatus: 'disconnected', feedItems: [], presence: [], connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

import {
  getPlatformAccounts,
  moltworldStatus,
  moltworldRateLimits,
  moltworldGetQueue,
} from '../../../services/apiAccounts.js';
import { getAgentActivityTimeline } from '../../../services/apiAgents.js';
import socket from '../../../services/socket';
import WorldTab from './WorldTab.jsx';

const MW_ALL = ['mw_explore', 'mw_build', 'mw_think', 'mw_say', 'mw_heartbeat', 'mw_interact'];
const rows = (count, prefix = 'r') => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, action: 'mw_think', status: 'completed', timestamp: `2026-08-23T00:${String(59 - i).padStart(2, '0')}:00.000Z`,
}));

describe('WorldTab activity history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlatformAccounts.mockResolvedValue([{ id: 'acct-1', status: 'active', credentials: { username: 'example' } }]);
    moltworldStatus.mockResolvedValue(null);
    moltworldRateLimits.mockResolvedValue(null);
    moltworldGetQueue.mockResolvedValue([]);
    getAgentActivityTimeline.mockImplementation(async (_l, _a, before) => rows(30, before ? 'more' : 'r'));
  });

  it('lists every mw_* action by default and keeps the filter on Load More', async () => {
    render(<WorldTab agentId="agent-1" />);
    await screen.findByText('Activity History');
    await act(async () => {});
    expect(getAgentActivityTimeline).toHaveBeenCalledWith(30, ['agent-1'], null, MW_ALL, { silent: true });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter history'), { target: { value: 'mw_think' } });
    });
    expect(getAgentActivityTimeline).toHaveBeenLastCalledWith(30, ['agent-1'], null, 'mw_think', { silent: true });

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Load More' })); });
    expect(getAgentActivityTimeline).toHaveBeenLastCalledWith(
      30, ['agent-1'], '2026-08-23T00:30:00.000Z', 'mw_think'
    );
  });
  it('reads history once per filter change and keeps the newest filter when an earlier one answers late', async () => {
    let resolveThink;
    getAgentActivityTimeline.mockImplementation(async (_l, _a, _before, actions) => {
      if (actions === 'mw_think') return new Promise((resolve) => { resolveThink = resolve; });
      if (actions === 'mw_build') return [{ id: 'b-1', action: 'mw_build', status: 'completed', timestamp: '2026-08-23T00:00:00.000Z' }];
      return rows(1, 'all');
    });

    render(<WorldTab agentId="agent-1" />);
    await screen.findByText('Activity History');
    await act(async () => {});
    expect(getAgentActivityTimeline).toHaveBeenCalledTimes(1);
    expect(moltworldStatus).toHaveBeenCalledTimes(1);

    const filter = screen.getByLabelText('Filter history');
    await act(async () => { fireEvent.change(filter, { target: { value: 'mw_think' } }); });
    await act(async () => { fireEvent.change(filter, { target: { value: 'mw_build' } }); });
    expect(await screen.findByText('build')).toBeInTheDocument();
    expect(getAgentActivityTimeline).toHaveBeenCalledTimes(3);
    expect(moltworldStatus).toHaveBeenCalledTimes(1);
    expect(moltworldGetQueue).toHaveBeenCalledTimes(1);

    await act(async () => { resolveThink(rows(1, 'late')); });
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(screen.queryByText('think')).toBeNull();
  });
  it('clears the previous filter\'s rows and offers Retry when the new filter\'s first page fails', async () => {
    getAgentActivityTimeline.mockImplementation(async (_l, _a, before, actions) => {
      if (actions === 'mw_build' && !before) throw new Error('unavailable');
      return rows(30, before ? 'more' : 'r');
    });

    render(<WorldTab agentId="agent-1" />);
    await screen.findByRole('button', { name: 'Load More' });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter history'), { target: { value: 'mw_build' } });
    });

    expect(await screen.findByText(/Could not load activity history/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load More' })).toBeNull();
    expect(screen.queryByText('No activity history yet')).toBeNull();

    getAgentActivityTimeline.mockImplementation(async () => [
      { id: 'b-1', action: 'mw_build', status: 'completed', timestamp: '2026-08-23T00:00:00.000Z' },
    ]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText('build')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load activity history/)).toBeNull();
  });

  it('refetches the action queue when a queue socket event arrives', async () => {
    render(<WorldTab agentId="agent-1" />);
    await screen.findByText('No queued actions');
    moltworldGetQueue.mockResolvedValue([
      { id: 'q-1', actionType: 'mw_think', status: 'pending', params: { thought: 'hello' } },
    ]);
    const [, onAdded] = socket.on.mock.calls.find(([event]) => event === 'moltworld:queue:added');
    await act(async () => { onAdded({}); });
    expect(await screen.findByText('1 item')).toBeInTheDocument();
    expect(screen.queryByText('No queued actions')).toBeNull();
  });

  it('shows a queue error with Retry instead of an empty queue when the read fails', async () => {
    moltworldGetQueue.mockRejectedValue(new Error('queue down'));
    render(<WorldTab agentId="agent-1" />);
    expect(await screen.findByText(/Could not load action queue — queue down/)).toBeInTheDocument();
    expect(screen.queryByText('No queued actions')).toBeNull();

    moltworldGetQueue.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(await screen.findByText('No queued actions')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load action queue/)).toBeNull();
  });
});

describe('WorldTab account loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moltworldStatus.mockResolvedValue(null);
    moltworldRateLimits.mockResolvedValue(null);
    moltworldGetQueue.mockResolvedValue([]);
    getAgentActivityTimeline.mockResolvedValue([]);
  });

  it('shows a retryable error instead of "No active Moltworld account" when the account read fails', async () => {
    getPlatformAccounts
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue([{ id: 'acct-1', status: 'active', credentials: { username: 'example' } }]);

    render(<WorldTab agentId="agent-1" />);

    expect(await screen.findByText(/Could not load Moltworld account — network unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('No active Moltworld account')).not.toBeInTheDocument();
    expect(getPlatformAccounts).toHaveBeenLastCalledWith('agent-1', 'moltworld', { silent: true });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });

    expect(await screen.findByText('Activity History')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load Moltworld account/)).not.toBeInTheDocument();
  });
});
