import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { wsState } = vi.hoisted(() => ({ wsState: { connectionStatus: 'disconnected' } }));

vi.mock('../../../services/apiAccounts.js', () => ({
  getPlatformAccounts: vi.fn(),
  moltworldStatus: vi.fn(),
  moltworldRateLimits: vi.fn(),
  moltworldGetQueue: vi.fn(),
  moltworldAddToQueue: vi.fn(),
  moltworldWsMove: vi.fn(),
  moltworldWsThink: vi.fn(),
  moltworldExplore: vi.fn(),
  moltworldThink: vi.fn(),
}));
vi.mock('../../../services/apiAgents.js', () => ({
  getAgentActivityTimeline: vi.fn(),
}));
vi.mock('./useMoltworldWs', () => ({
  default: () => ({ connectionStatus: wsState.connectionStatus, feedItems: [], presence: [], connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

import {
  getPlatformAccounts,
  moltworldStatus,
  moltworldRateLimits,
  moltworldGetQueue,
  moltworldAddToQueue,
  moltworldWsMove,
  moltworldExplore,
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
    wsState.connectionStatus = 'disconnected';
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

  it('labels the pending-queue cancel control and keeps the add form when queueing fails', async () => {
    moltworldGetQueue.mockResolvedValue([
      { id: 'q-1', actionType: 'mw_think', status: 'pending', params: { thought: 'hello' } },
    ]);
    moltworldAddToQueue.mockRejectedValue(new Error('queue failed'));
    render(<WorldTab agentId="agent-1" />);
    const cancel = await screen.findByRole('button', { name: 'Cancel pending think' });
    expect(cancel.className).toContain('pointer-coarse:min-h-11');
    expect(cancel.className).toContain('pointer-coarse:min-w-11');

    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    fireEvent.change(screen.getByLabelText('Queued action thinking (optional)'), { target: { value: 'keep me' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' })); });
    expect(screen.getByLabelText('Queued action thinking (optional)')).toHaveValue('keep me');
    expect(screen.getByRole('button', { name: 'Add to Queue' })).toBeInTheDocument();
  });

  it('refreshes the world status and selected history after a REST move', async () => {
    moltworldExplore.mockResolvedValueOnce({
      x: 3, y: 4, messages: [{ id: 'msg-1', fromName: 'Example agent', message: 'Hello from nearby' }]
    });

    render(<WorldTab agentId="agent-1" />);
    await screen.findByRole('button', { name: 'Move Here' });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter history'), { target: { value: 'mw_explore' } });
    });
    getAgentActivityTimeline.mockClear();
    fireEvent.change(screen.getByLabelText('X (-240 to 240)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Y (-240 to 240)'), { target: { value: '4' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move Here' })); });

    expect(moltworldExplore).toHaveBeenCalledWith({ accountId: 'acct-1', agentId: 'agent-1', x: 3, y: 4 });
    expect(await screen.findByText('Hello from nearby')).toBeInTheDocument();
    expect(moltworldStatus).toHaveBeenCalledTimes(2);
    expect(moltworldRateLimits).toHaveBeenCalledTimes(2);
    expect(getAgentActivityTimeline).toHaveBeenCalledExactlyOnceWith(30, ['agent-1'], null, 'mw_explore', { silent: true });
  });

  it('does not toast a WebSocket move as sent when the relay rejects', async () => {
    wsState.connectionStatus = 'connected';
    moltworldWsMove.mockRejectedValue(new Error('ws down'));
    render(<WorldTab agentId="agent-1" />);
    await screen.findByRole('button', { name: 'Move Here' });
    fireEvent.change(screen.getByLabelText('X (-240 to 240)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Y (-240 to 240)'), { target: { value: '4' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move Here' })); });
    expect(moltworldWsMove).toHaveBeenCalled();
    expect(screen.getByLabelText('X (-240 to 240)')).toHaveValue(3);
    expect(screen.getByRole('button', { name: 'Move Here' })).toBeEnabled();
    expect(moltworldExplore).not.toHaveBeenCalled();
  });

  it('wraps world headers and sizes compact actions for coarse pointers', async () => {
    render(<WorldTab agentId="agent-1" />);
    const history = await screen.findByRole('heading', { name: 'Activity History' });
    expect(history.parentElement.className).toContain('flex-wrap');
    const refresh = screen.getAllByRole('button', { name: 'Refresh' })[0];
    expect(refresh.className).toContain('pointer-coarse:min-h-11');
    expect(screen.getByLabelText('Filter history').className).toContain('pointer-coarse:min-h-11');
    expect(screen.getByRole('button', { name: '+ Add' }).className).toContain('pointer-coarse:min-h-11');
    expect(screen.getByRole('heading', { name: 'Action Queue' }).parentElement.className).toContain('flex-wrap');
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

  it('keeps action and queue drafts while the account is reloaded', async () => {
    getPlatformAccounts.mockResolvedValueOnce([{ id: 'acct-1', status: 'active' }]);
    const { rerender } = render(<WorldTab agentId="agent-1" />);
    const thought = await screen.findByRole('textbox', { name: 'Thought text' });
    fireEvent.change(thought, { target: { value: 'Draft thought' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    fireEvent.change(screen.getByLabelText('Queued action thinking (optional)'), { target: { value: 'Draft queue action' } });

    let resolveAccount;
    getPlatformAccounts.mockReturnValueOnce(new Promise(resolve => { resolveAccount = resolve; }));
    rerender(<WorldTab agentId="agent-2" />);
    expect(await screen.findByText('Loading world tools')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Thought text' })).not.toBeInTheDocument();

    await act(async () => { resolveAccount([{ id: 'acct-2', status: 'active' }]); });
    expect(await screen.findByRole('textbox', { name: 'Thought text' })).toHaveValue('Draft thought');
    expect(screen.getByLabelText('Queued action thinking (optional)')).toHaveValue('Draft queue action');
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
