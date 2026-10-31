import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  getPlatformAccounts: vi.fn(),
  moltworldStatus: vi.fn(),
  moltworldRateLimits: vi.fn(),
  moltworldGetQueue: vi.fn(),
  getAgentActivityTimeline: vi.fn(),
}));
vi.mock('../../../hooks/useMoltworldWs', () => ({
  default: () => ({ connectionStatus: 'disconnected', feedItems: [], presence: [], connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

import * as api from '../../../services/api';
import WorldTab from './WorldTab.jsx';

const MW_ALL = ['mw_explore', 'mw_build', 'mw_think', 'mw_say', 'mw_heartbeat', 'mw_interact'];
const rows = (count, prefix = 'r') => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, action: 'mw_think', status: 'completed', timestamp: `2026-08-23T00:${String(59 - i).padStart(2, '0')}:00.000Z`,
}));

describe('WorldTab activity history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPlatformAccounts.mockResolvedValue([{ id: 'acct-1', status: 'active', credentials: { username: 'example' } }]);
    api.moltworldStatus.mockResolvedValue(null);
    api.moltworldRateLimits.mockResolvedValue(null);
    api.moltworldGetQueue.mockResolvedValue([]);
    api.getAgentActivityTimeline.mockImplementation(async (_l, _a, before) => rows(30, before ? 'more' : 'r'));
  });

  it('lists every mw_* action by default and keeps the filter on Load More', async () => {
    render(<WorldTab agentId="agent-1" />);
    await screen.findByText('Activity History');
    await act(async () => {});
    expect(api.getAgentActivityTimeline).toHaveBeenCalledWith(30, ['agent-1'], null, MW_ALL);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter history'), { target: { value: 'mw_think' } });
    });
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(30, ['agent-1'], null, 'mw_think');

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Load More' })); });
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(
      30, ['agent-1'], '2026-08-23T00:30:00.000Z', 'mw_think'
    );
  });
  it('reads history once per filter change and keeps the newest filter when an earlier one answers late', async () => {
    let resolveThink;
    api.getAgentActivityTimeline.mockImplementation(async (_l, _a, _before, actions) => {
      if (actions === 'mw_think') return new Promise((resolve) => { resolveThink = resolve; });
      if (actions === 'mw_build') return [{ id: 'b-1', action: 'mw_build', status: 'completed', timestamp: '2026-08-23T00:00:00.000Z' }];
      return rows(1, 'all');
    });

    render(<WorldTab agentId="agent-1" />);
    await screen.findByText('Activity History');
    await act(async () => {});
    expect(api.getAgentActivityTimeline).toHaveBeenCalledTimes(1);
    expect(api.moltworldStatus).toHaveBeenCalledTimes(1);

    const filter = screen.getByLabelText('Filter history');
    await act(async () => { fireEvent.change(filter, { target: { value: 'mw_think' } }); });
    await act(async () => { fireEvent.change(filter, { target: { value: 'mw_build' } }); });
    expect(await screen.findByText('build')).toBeInTheDocument();
    expect(api.getAgentActivityTimeline).toHaveBeenCalledTimes(3);
    expect(api.moltworldStatus).toHaveBeenCalledTimes(1);
    expect(api.moltworldGetQueue).toHaveBeenCalledTimes(1);

    await act(async () => { resolveThink(rows(1, 'late')); });
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(screen.queryByText('think')).toBeNull();
  });
});
