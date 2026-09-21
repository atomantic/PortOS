import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import NotificationDropdown from './NotificationDropdown';
import ReviewHubCard from './ReviewHubCard';
import DailyActionsWidget from './DailyActionsWidget';
import ProactiveAlertsWidget from './ProactiveAlertsWidget';
import { __resetActionQueue } from '../hooks/useActionQueue';
import { ACTION_QUEUE_CHANGED } from '../constants/events';

const mock = vi.hoisted(() => ({ getReviewQueue: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('../services/api', () => ({ getReviewQueue: mock.getReviewQueue }));
vi.mock('../services/socket', () => ({ default: { on: mock.on, off: mock.off } }));

const required = { id: 'health:disk', source: 'health', required: true, title: 'Disk needs attention', reason: 'Free space is low' };
const optional = { id: 'product:daily-post', source: 'product', required: false, isRecommendation: true, title: 'Daily POST', reason: 'Practice today' };
const envelope = (items = [required, optional], partial = false) => ({ items, partial, sources: {} });

function Surfaces() {
  const [history, setHistory] = useState([{ id: 'event-1', title: 'An event', read: false, timestamp: '2026-01-01' }]);
  return <>
    <NotificationDropdown notifications={history} unreadCount={history.filter(n => !n.read).length}
      onMarkAllAsRead={() => setHistory(history.map(n => ({ ...n, read: true })))}
      onClearAll={() => setHistory([])} onRemove={() => setHistory([])} onMarkAsRead={() => {}} />
    <ReviewHubCard /><DailyActionsWidget /><ProactiveAlertsWidget />
  </>;
}
const show = () => render(<MemoryRouter><Surfaces /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  __resetActionQueue();
  mock.getReviewQueue.mockResolvedValue(envelope());
});
afterEach(cleanup);

describe('canonical action previews', () => {
  it('shares IDs and required counts across the bell and saved widgets; history controls cannot complete actions', async () => {
    show();
    const bell = await screen.findByRole('button', { name: 'Notifications (1 required actions)' });
    fireEvent.click(bell);
    const panel = screen.getByRole('region', { name: 'Notifications' });
    expect(mock.getReviewQueue).toHaveBeenCalledTimes(1);
    for (const link of screen.getAllByRole('link', { name: /Disk needs attention/ })) {
      expect(link).toHaveAttribute('href', '/review/health%3Adisk?view=today');
      expect(link.closest('li')).toHaveAttribute('data-action-id', 'health:disk');
    }
    expect(screen.getAllByRole('link', { name: /Disk needs attention/ })).toHaveLength(3);
    expect(screen.getAllByRole('link', { name: /Daily POST/ })).toHaveLength(4);
    fireEvent.click(within(panel).getByRole('button', { name: 'Mark all notifications as read' }));
    expect(bell).toHaveAccessibleName('Notifications (1 required actions)');
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear all notifications' }));
    expect(within(panel).getByText('No notifications')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Disk needs attention/ })).toBeInTheDocument();

    mock.getReviewQueue.mockResolvedValue(envelope([optional]));
    act(() => mock.on.mock.calls.find(([event]) => event === 'brain:threads:changed')[1]());
    await waitFor(() => expect(screen.queryByText('Disk needs attention')).not.toBeInTheDocument());
    expect(bell).toHaveAccessibleName('Notifications (0 required actions)');
    expect(screen.getAllByText('Optional recommendations')).toHaveLength(4);
  });

  it('reports loading, failure, and lower bounds without flashing a healthy empty state', async () => {
    let finish;
    mock.getReviewQueue.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    show();
    expect(screen.queryByText('All caught up!')).not.toBeInTheDocument();
    await act(async () => finish(envelope([required], true)));
    expect(screen.getByRole('button', { name: /at least 1 required actions/ })).toBeInTheDocument();
    expect(screen.getAllByText(/Action counts are incomplete/)).toHaveLength(3);
    mock.getReviewQueue.mockRejectedValue(new Error('offline'));
    act(() => window.dispatchEvent(new Event(ACTION_QUEUE_CHANGED)));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3));
    expect(screen.getAllByText('Disk needs attention')).toHaveLength(2);
    expect(screen.queryByText('All caught up!')).not.toBeInTheDocument();
  });

  it('treats a source preview limit as context and keeps unrelated widgets healthy', async () => {
    mock.getReviewQueue.mockResolvedValue({ ...envelope([required], true), sources: {
      review: { label: 'Stored review obligations', availability: 'available', truncation: true },
      product: { label: 'Product recommendations', availability: 'available', truncation: false },
      health: { label: 'Health anomalies', availability: 'available', truncation: false },
    } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    const daily = screen.getByRole('region', { name: "Today's actions" });
    expect(within(daily).getByText('All caught up!')).toBeInTheDocument();
    expect(within(daily).queryByText(/limited preview|unavailable|incomplete/)).not.toBeInTheDocument();
    const notices = screen.getAllByText(/Showing a limited preview of Stored review obligations/);
    expect(notices).toHaveLength(2);
    for (const notice of notices) expect(notice).not.toHaveClass('text-port-warning');
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });

  it('names failed sources and offers recovery only in affected previews', async () => {
    mock.getReviewQueue.mockResolvedValue({ ...envelope([], true), sources: {
      review: { label: 'Stored review obligations', availability: 'unavailable', available: false },
      product: { label: 'Product recommendations', availability: 'available', truncation: false },
      health: { label: 'Health anomalies', availability: 'available', truncation: false },
    } });
    show();
    const notice = await screen.findByText(/Could not load Stored review obligations/);
    expect(within(notice).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(notice).getByRole('link', { name: 'View source details' })).toHaveAttribute('href', '/review?view=today');
    expect(within(screen.getByRole('region', { name: "Today's actions" })).getByText('All caught up!')).toBeInTheDocument();
  });

  it('drops an older response when completion invalidates a pending read', async () => {
    let finish;
    mock.getReviewQueue.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    show();
    mock.getReviewQueue.mockResolvedValue(envelope([]));
    act(() => mock.on.mock.calls.find(([event]) => event === 'review:queue:changed')[1]());
    await act(async () => finish(envelope()));
    await waitFor(() => expect(screen.getAllByText('All caught up!')).toHaveLength(3));
    expect(screen.queryByText('Disk needs attention')).not.toBeInTheDocument();
  });
});
