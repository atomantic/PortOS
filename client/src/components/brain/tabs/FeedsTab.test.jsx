import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getFeeds: vi.fn(), refreshAllFeeds: vi.fn(), getFeedItems: vi.fn(), removeFeed: vi.fn(),
  markFeedItemRead: vi.fn(), markAllFeedItemsRead: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../../services/apiMessages.js', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

import FeedsTab from './FeedsTab';

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
