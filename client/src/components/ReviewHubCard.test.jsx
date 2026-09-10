import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getReviewCounts: vi.fn()
}));

const socket = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn()
}));

vi.mock('../services/api', () => api);
vi.mock('../services/socket', () => ({ default: socket }));
vi.mock('react-router', () => ({
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>
}));

import ReviewHubCard from './ReviewHubCard';

// Invokes the handler the component registered for `event` via socket.on,
// the same pattern as client/src/hooks/useNotifications.test.jsx.
function deliver(event, payload) {
  const handler = socket.on.mock.calls.find(([name]) => name === event)?.[1];
  expect(handler).toBeTypeOf('function');
  handler(payload);
}

const ZERO_COUNTS = { total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  api.getReviewCounts.mockResolvedValue(ZERO_COUNTS);
});

afterEach(() => vi.restoreAllMocks());

describe('ReviewHubCard', () => {
  it('subscribes to every review socket event, including the bulk-update event, on mount', async () => {
    render(<ReviewHubCard />);
    await act(async () => { await Promise.resolve(); });

    const events = socket.on.mock.calls.map(([name]) => name);
    expect(events).toEqual(expect.arrayContaining([
      'review:item:created',
      'review:item:updated',
      'review:item:deleted',
      'review:items:bulk-updated'
    ]));
  });

  it('renders the all-caught-up state when there are no pending items', async () => {
    render(<ReviewHubCard />);
    expect(await screen.findByText('All caught up!')).toBeInTheDocument();
  });

  it('renders the total badge and per-type breakdown once counts resolve', async () => {
    api.getReviewCounts.mockResolvedValue({ total: 3, alert: 1, todo: 1, briefing: 0, cos: 1 });
    render(<ReviewHubCard />);

    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('1 alert')).toBeInTheDocument();
    expect(screen.getByText('1 todo')).toBeInTheDocument();
    expect(screen.getByText('1 CoS')).toBeInTheDocument();
  });

  it('refetches counts exactly once when a review:items:bulk-updated event arrives', async () => {
    render(<ReviewHubCard />);
    await act(async () => { await Promise.resolve(); });
    expect(api.getReviewCounts).toHaveBeenCalledTimes(1); // the initial mount fetch

    api.getReviewCounts.mockResolvedValue({ total: 5, alert: 0, todo: 5, briefing: 0, cos: 0 });
    await act(async () => {
      deliver('review:items:bulk-updated', { ids: ['a', 'b'], status: 'dismissed', updatedAt: new Date().toISOString() });
      await Promise.resolve();
    });

    expect(api.getReviewCounts).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('5')).toBeInTheDocument();
  });

  it('unsubscribes every review event, including the bulk-update event, on unmount', async () => {
    const { unmount } = render(<ReviewHubCard />);
    await act(async () => { await Promise.resolve(); });

    unmount();

    const offEvents = socket.off.mock.calls.map(([name]) => name);
    expect(offEvents).toEqual(expect.arrayContaining([
      'review:item:created',
      'review:item:updated',
      'review:item:deleted',
      'review:items:bulk-updated'
    ]));
  });
});
