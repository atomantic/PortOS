import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  getPlatformAccounts: vi.fn(),
  getAgentPublished: vi.fn(),
}));

import * as api from '../../../services/api';
import PublishedTab from './PublishedTab.jsx';

describe('PublishedTab', () => {
  it('shows a retryable error instead of a spinner when the account load fails', async () => {
    api.getPlatformAccounts
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue([{ id: 'account-1', status: 'active', credentials: { username: 'example-user' } }]);
    api.getAgentPublished.mockResolvedValue({ posts: [], comments: [] });

    render(<PublishedTab agentId="agent-1" />);

    expect(await screen.findByText(/Could not load platform accounts/)).toBeInTheDocument();
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });

    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(api.getPlatformAccounts).toHaveBeenLastCalledWith('agent-1', null, { silent: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getPlatformAccounts.mockResolvedValue([{
      id: 'account-1', status: 'active', credentials: { username: 'example-user' },
    }]);
  });

  it('shows a retryable error and releases Refresh after a failed published-content load', async () => {
    api.getAgentPublished.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue({ posts: [], comments: [] });

    render(<PublishedTab agentId="agent-1" />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(refresh).toBeEnabled();
    expect(api.getAgentPublished).toHaveBeenLastCalledWith(
      { agentId: 'agent-1', accountId: 'account-1', days: 7 },
      { silent: true },
    );

    await act(async () => { fireEvent.click(retry); });

    expect(await screen.findByText(/No published content in the last 7 days/)).toBeInTheDocument();
    expect(api.getAgentPublished).toHaveBeenCalledTimes(2);
  });

  it('renders external links with an accessible >=44px tap target for published posts and comments', async () => {
    api.getAgentPublished.mockResolvedValue({
      posts: [
        {
          postId: 'post-1',
          title: 'Autonomous post title',
          submolt: 'general',
          score: 10,
          commentCount: 2,
          publishedAt: '2026-11-04T12:00:00Z',
          url: 'https://moltbook.example/post/1',
        },
        {
          postId: 'post-2',
          title: 'Post without URL',
          submolt: 'meta',
          score: null,
          commentCount: null,
          publishedAt: '2026-11-04T13:00:00Z',
          url: null,
        },
      ],
      comments: [
        {
          commentId: 'comment-1',
          postTitle: 'Discussion on agent runtime',
          isReply: false,
          publishedAt: '2026-11-04T14:00:00Z',
          url: 'https://moltbook.example/comment/1',
        },
      ],
    });

    render(<PublishedTab agentId="agent-1" />);

    expect(await screen.findByText('Autonomous post title')).toBeInTheDocument();
    expect(screen.getByText('Discussion on agent runtime')).toBeInTheDocument();

    const links = screen.getAllByRole('link', { name: 'Open on Moltbook' });
    expect(links).toHaveLength(2);

    const [postLink, commentLink] = links;

    expect(postLink).toHaveAttribute('href', 'https://moltbook.example/post/1');
    expect(postLink).toHaveAttribute('target', '_blank');
    expect(postLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(postLink.className).toContain('min-h-[44px]');
    expect(postLink.className).toContain('min-w-[44px]');
    expect(postLink.className).toContain('inline-flex');

    expect(commentLink).toHaveAttribute('href', 'https://moltbook.example/comment/1');
    expect(commentLink).toHaveAttribute('target', '_blank');
    expect(commentLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(commentLink.className).toContain('min-h-[44px]');
    expect(commentLink.className).toContain('min-w-[44px]');
    expect(commentLink.className).toContain('inline-flex');
  });
});
