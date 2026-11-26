import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getFeeds: vi.fn(), refreshAllFeeds: vi.fn(), getFeedItems: vi.fn(), removeFeed: vi.fn(),
  markFeedItemRead: vi.fn(), markAllFeedItemsRead: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../../services/apiMessages.js', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

import FeedsTab from './FeedsTab';

afterEach(() => vi.restoreAllMocks());

describe('FeedsTab loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getFeedItems.mockResolvedValue([]);
  });

  it('shows a retryable failure instead of the first-run prompt, while retaining empty success', async () => {
    api.getFeeds.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    render(<FeedsTab />);

    expect(await screen.findByText('Could not load feeds.')).toBeInTheDocument();
    expect(screen.queryByText('No feeds subscribed yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No feeds subscribed yet.')).toBeInTheDocument();
  });

  it('treats a falsy rejection as a failed primary load', async () => {
    api.getFeeds.mockRejectedValueOnce(undefined);
    render(<FeedsTab />);

    expect(await screen.findByText('Could not load feeds.')).toBeInTheDocument();
    expect(screen.queryByText('No feeds subscribed yet.')).not.toBeInTheDocument();
  });

  it('shows a retryable error instead of "No items yet" when the item list fails to load', async () => {
    api.getFeeds.mockResolvedValue([{ id: 'feed-1', title: 'Example Feed', unreadCount: 0 }]);
    api.getFeedItems.mockRejectedValueOnce(new Error('items down')).mockResolvedValueOnce([]);
    render(<FeedsTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load feed items');
    expect(screen.queryByText(/No items yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No items yet/)).toBeInTheDocument();
  });
});

describe('FeedsTab delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getFeedItems.mockResolvedValue([]);
    api.getFeeds.mockResolvedValue([{ id: 'feed-1', title: 'Example Feed', unreadCount: 0 }]);
    api.removeFeed.mockResolvedValue({});
  });

  it('cancels via the in-flow InlineConfirmRow', async () => {
    render(<FeedsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove feed' }));
    expect(screen.getByText('Remove this feed?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Remove this feed?')).not.toBeInTheDocument();
    expect(api.removeFeed).not.toHaveBeenCalled();
  });

  it('confirms removal', async () => {
    render(<FeedsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove feed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(api.removeFeed).toHaveBeenCalledWith('feed-1');
    expect(await screen.findByText('No feeds subscribed yet.')).toBeInTheDocument();
  });
});

describe('FeedsTab rejected mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getFeeds.mockResolvedValue([{ id: 'feed-1', title: 'Example Feed', unreadCount: 1 }]);
    api.getFeedItems.mockResolvedValue([{ id: 'item-1', feedId: 'feed-1', title: 'Example Item', link: 'https://example.com/a', read: false }]);
  });

  it('keeps the feed and shows no success toast when removeFeed rejects', async () => {
    api.removeFeed.mockRejectedValueOnce(new Error('nope'));
    render(<FeedsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove feed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeFeed).toHaveBeenCalled());
    await Promise.resolve();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('Example Item')).toBeInTheDocument();
  });

  it('does not report feeds that could not be fetched as refreshed', async () => {
    api.refreshAllFeeds.mockResolvedValueOnce({ refreshed: 1, newItems: 0, failures: 1 });
    render(<FeedsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not refresh 1 feed'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps items unread and shows no success toast when markAllFeedItemsRead rejects', async () => {
    api.markAllFeedItemsRead.mockRejectedValueOnce(new Error('nope'));
    render(<FeedsTab />);
    fireEvent.click(await screen.findByTitle('Mark all as read'));
    await waitFor(() => expect(api.markAllFeedItemsRead).toHaveBeenCalled());
    await Promise.resolve();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByTitle('Mark all as read')).toBeInTheDocument();
  });

  it('keeps the item unread when markFeedItemRead rejects', async () => {
    api.markFeedItemRead.mockRejectedValueOnce(new Error('nope'));
    vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<FeedsTab />);
    fireEvent.click(await screen.findByText('Example Item'));
    await waitFor(() => expect(api.markFeedItemRead).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.getByTitle('Mark all as read')).toBeInTheDocument();
  });
});

describe('FeedsTab item interactions', () => {
  const item = {
    id: 'item-1', feedId: 'feed-1', title: 'Example Item',
    link: 'https://example.com/a', read: false, fetchedAt: '2026-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getFeeds.mockResolvedValue([{ id: 'feed-1', title: 'Example Feed', unreadCount: 3 }]);
    api.getFeedItems.mockResolvedValue([item]);
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  it('decrements the unread count once under StrictMode even when clicked twice', async () => {
    api.markFeedItemRead.mockResolvedValue({});
    render(<StrictMode><FeedsTab /></StrictMode>);

    const itemButton = await screen.findByRole('button', { name: /Example Item/ });
    expect(screen.getByRole('button', { name: /All feeds/ })).toHaveTextContent('3');
    fireEvent.click(itemButton);
    fireEvent.click(itemButton);

    expect(api.markFeedItemRead).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(window.open).toHaveBeenCalledWith(item.link, '_blank', 'noopener,noreferrer');
    await waitFor(() => expect(screen.getByRole('button', { name: /All feeds/ })).toHaveTextContent('2'));
    expect(screen.queryByTitle('Mark all as read')).not.toBeInTheDocument();
  });

  it.each(['javascript:', 'file:', 'data:'])('refuses a feed link with the %s scheme', async (link) => {
    api.getFeedItems.mockResolvedValue([{ ...item, link }]);
    render(<FeedsTab />);

    fireEvent.click(await screen.findByRole('button', { name: /Example Item/ }));

    expect(toast.error).toHaveBeenCalledWith('Feed links must use HTTP or HTTPS.');
    expect(window.open).not.toHaveBeenCalled();
    expect(api.markFeedItemRead).not.toHaveBeenCalled();
  });

  it('labels the subscribe button and only reloads items when filters change', async () => {
    render(<FeedsTab />);

    const subscribe = await screen.findByRole('button', { name: 'Subscribe to feed' });
    expect(subscribe).toHaveAttribute('aria-label', 'Subscribe to feed');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Unread' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Example Feed / })));

    expect(api.getFeeds).toHaveBeenCalledTimes(1);
    expect(api.getFeedItems.mock.calls).toEqual([
      [{ feedId: null, unreadOnly: false }],
      [{ feedId: null, unreadOnly: true }],
      [{ feedId: 'feed-1', unreadOnly: true }],
    ]);
  });

  it('ignores a subscription response superseded by the StrictMode remount', async () => {
    const stale = Promise.withResolvers();
    api.getFeeds.mockReturnValueOnce(stale.promise);
    render(<StrictMode><FeedsTab /></StrictMode>);

    expect(await screen.findByRole('button', { name: /^Example Feed / })).toBeInTheDocument();
    await act(async () => stale.resolve([]));
    expect(screen.getByRole('button', { name: /^Example Feed / })).toBeInTheDocument();
  });
});
