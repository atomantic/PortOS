import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  getAgentActivityTimeline: vi.fn(),
}));

import * as api from '../../../services/api';
import ActivityTab from './ActivityTab.jsx';

const page = (action, count, prefix = 'a') => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, action, status: 'completed', timestamp: `2026-08-23T00:${String(59 - i).padStart(2, '0')}:00.000Z`,
}));

describe('ActivityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the selected action for the first page and for Load More', async () => {
    api.getAgentActivityTimeline.mockImplementation(async (_l, _a, before) => page('post', 50, before ? 'more' : 'a'));

    render(<ActivityTab agentId="agent-1" />);
    await screen.findByText('Activity Log');
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(50, ['agent-1'], null, null, { silent: true });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'post' } });
    });
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(50, ['agent-1'], null, 'post', { silent: true });

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Load More' })); });
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(
      50, ['agent-1'], '2026-08-23T00:10:00.000Z', 'post'
    );
  });

  it('shows a retryable error instead of an endless spinner when the activity load fails', async () => {
    api.getAgentActivityTimeline
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce([]);

    render(<ActivityTab agentId="agent-1" />);

    expect(await screen.findByText(/Could not load activity log/)).toBeInTheDocument();
    expect(screen.queryByText('Loading activity')).not.toBeInTheDocument();
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(50, ['agent-1'], null, null, { silent: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(await screen.findByRole('heading', { name: 'Activity Log' })).toBeInTheDocument();
    expect(api.getAgentActivityTimeline).toHaveBeenCalledTimes(2);
  });
  it('keeps the newest filter when an earlier filter answers late', async () => {
    let resolvePost;
    api.getAgentActivityTimeline.mockImplementation(async (_l, _a, _before, action) => {
      if (action === 'post') return new Promise((resolve) => { resolvePost = resolve; });
      if (action === 'comment') return page('comment', 1, 'c');
      return page('vote', 1, 'v');
    });

    render(<ActivityTab agentId="agent-1" />);
    await screen.findByText('vote');
    const filter = screen.getByLabelText('Filter by action');
    await act(async () => { fireEvent.change(filter, { target: { value: 'post' } }); });
    await act(async () => { fireEvent.change(filter, { target: { value: 'comment' } }); });
    expect(await screen.findByText('comment')).toBeInTheDocument();

    await act(async () => { resolvePost(page('post', 1, 'p')); });
    expect(screen.getByText('comment')).toBeInTheDocument();
    expect(screen.queryByText('post')).toBeNull();
  });

  it('drops a Load More page that resolves after the filter changed', async () => {
    let resolveMore;
    api.getAgentActivityTimeline.mockImplementation(async (_l, _a, before, action) => {
      if (before) return new Promise((resolve) => { resolveMore = resolve; });
      return action === 'comment' ? page('comment', 1, 'c') : page('vote', 50, 'v');
    });

    render(<ActivityTab agentId="agent-1" />);
    const loadMoreButton = await screen.findByRole('button', { name: 'Load More' });
    await act(async () => { fireEvent.click(loadMoreButton); });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'comment' } });
    });
    expect(await screen.findByText('comment')).toBeInTheDocument();

    await act(async () => { resolveMore(page('vote', 50, 'late')); });
    expect(screen.queryByText('vote')).toBeNull();
  });

  it('lets Load More run for the new filter while the previous filter\'s Load More is still pending', async () => {
    api.getAgentActivityTimeline.mockImplementation(async (_l, _a, before, action) => {
      if (before && action === null) return new Promise(() => {});
      if (before) return page('comment', 1, 'more');
      return action === 'comment' ? page('comment', 50, 'c') : page('vote', 50, 'v');
    });

    render(<ActivityTab agentId="agent-1" />);
    const loadMoreButton = await screen.findByRole('button', { name: 'Load More' });
    await act(async () => { fireEvent.click(loadMoreButton); });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'comment' } });
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load More' })); });
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(
      50, ['agent-1'], '2026-08-23T00:10:00.000Z', 'comment'
    );
  });
  it('does not page the new filter with the previous filter\'s cursor before its first page arrives', async () => {
    let resolveComment;
    api.getAgentActivityTimeline.mockImplementation(async (_l, _a, _before, action) => {
      if (action === 'comment') return new Promise((resolve) => { resolveComment = resolve; });
      return page('vote', 50, 'v');
    });

    render(<ActivityTab agentId="agent-1" />);
    const loadMoreButton = await screen.findByRole('button', { name: 'Load More' });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'comment' } });
    });
    const callsBeforeClick = api.getAgentActivityTimeline.mock.calls.length;
    await act(async () => { fireEvent.click(loadMoreButton); });
    expect(api.getAgentActivityTimeline).toHaveBeenCalledTimes(callsBeforeClick);

    await act(async () => { resolveComment(page('comment', 1, 'c')); });
    expect(screen.getByText('comment')).toBeInTheDocument();
  });
});
