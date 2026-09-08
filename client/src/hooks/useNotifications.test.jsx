import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  getNotificationCount: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  deleteNotification: vi.fn(),
  clearNotifications: vi.fn()
}));

const socket = vi.hoisted(() => ({
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn()
}));

vi.mock('../services/api', () => api);
vi.mock('./useSocket', () => ({ useSocket: () => socket }));

import NotificationDropdown from '../components/NotificationDropdown.jsx';
import { useNotifications } from './useNotifications.js';

const NOTIFICATION = {
  id: 'n1',
  type: 'agent_warning',
  title: 'Example notification',
  description: 'A notification returned by the list endpoint.',
  priority: 'medium',
  read: false,
  timestamp: '2025-01-01T00:00:00.000Z'
};

function NotificationSurface() {
  const state = useNotifications();

  return (
    <>
      <output data-testid="notification-loading">{String(state.loading)}</output>
      <NotificationDropdown
        notifications={state.notifications}
        unreadCount={state.unreadCount}
        onMarkAsRead={state.markAsRead}
        onMarkAllAsRead={state.markAllAsRead}
        onRemove={state.removeNotification}
        onClearAll={state.clearAll}
      />
    </>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getNotifications.mockResolvedValue([NOTIFICATION]);
  api.getNotificationCount.mockResolvedValue({ count: 1 });
});

describe('useNotifications response contract', () => {
  it('keeps the bare list response renderable by NotificationDropdown', async () => {
    render(
      <MemoryRouter>
        <NotificationSurface />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('notification-loading')).toHaveTextContent('false');
    });

    expect(api.getNotifications).toHaveBeenCalledWith({ limit: 50 });

    fireEvent.click(screen.getByRole('button', { name: 'Notifications (1 unread)' }));

    expect(screen.getByRole('button', { name: 'View notification: Example notification' })).toBeInTheDocument();
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function deliver(event, payload) {
  const handler = socket.on.mock.calls.find(([name]) => name === event)?.[1];
  expect(handler).toBeTypeOf('function');
  handler(payload);
}

async function loadedHook() {
  const hook = renderHook(() => useNotifications());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe('authoritative unread totals', () => {
  it.each(['socket-first', 'http-first'])('keeps the remaining unread badge and row with %s delivery', async (order) => {
    const second = { ...NOTIFICATION, id: 'n2', title: 'Remaining notification' };
    api.getNotifications.mockResolvedValue([NOTIFICATION, second]);
    api.getNotificationCount.mockResolvedValue({ count: 2 });
    const mutation = deferred();
    api.markNotificationRead.mockReturnValue(mutation.promise);
    render(<MemoryRouter><NotificationSurface /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('notification-loading')).toHaveTextContent('false'));
    fireEvent.click(screen.getByRole('button', { name: 'Notifications (2 unread)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark notification as read: Example notification' }));
    api.getNotificationCount.mockResolvedValue({ count: 1 });

    const socketUpdate = () => {
      deliver('notifications:updated', { ...NOTIFICATION, read: true });
      deliver('notifications:count', 1);
    };
    if (order === 'socket-first') act(socketUpdate);
    await act(async () => { mutation.resolve(); await mutation.promise; });
    if (order === 'http-first') act(socketUpdate);

    expect(screen.getByRole('button', { name: 'Notifications (1 unread)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark notification as read: Remaining notification' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark notification as read: Example notification' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all notifications as read' })).toBeInTheDocument();
  });

  // Each public mutation needs an HTTP fallback when no socket event arrives.
  it.each([
    ['markAsRead', ['n1'], 73],
    ['markAllAsRead', [], 0],
    ['removeNotification', ['n1'], 73],
    ['clearAll', [], 0]
  ])('reconciles %s without socket delivery', async (method, args, count) => {
    api.getNotifications.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ ...NOTIFICATION, id: 'n' + i })));
    api.getNotificationCount.mockResolvedValue({ count: 74 });
    const { result } = await loadedHook();
    expect(result.current.unreadCount).toBe(74);
    api.getNotificationCount.mockResolvedValue({ count });
    await act(async () => { await result.current[method](...args); });
    expect(result.current.unreadCount).toBe(count);
    expect(api.getNotificationCount).toHaveBeenCalledTimes(2);
  });

  it('discards delayed initial and refresh counts after a socket total', async () => {
    const initial = deferred();
    api.getNotificationCount.mockReturnValueOnce(initial.promise);
    const { result } = renderHook(() => useNotifications());
    act(() => deliver('notifications:count', 80));
    await act(async () => { initial.resolve({ count: 2 }); });
    expect(result.current.unreadCount).toBe(80);
    const refresh = deferred();
    api.getNotificationCount.mockReturnValueOnce(refresh.promise);
    let refreshing;
    act(() => { refreshing = result.current.refresh(); });
    act(() => deliver('notifications:count', 81));
    await act(async () => { refresh.resolve({ count: 3 }); await refreshing; });
    expect(result.current.unreadCount).toBe(81);
  });

  it('lets a newer count request supersede an older request', async () => {
    const { result } = await loadedHook();
    const older = deferred();
    api.getNotificationCount.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ count: 9 });
    let refreshing;
    act(() => { refreshing = result.current.refresh(); });
    await act(async () => { await result.current.markAsRead('n1'); });
    await act(async () => { older.resolve({ count: 2 }); await refreshing; });
    expect(result.current.unreadCount).toBe(9);
  });

  it.each(['markAllAsRead', 'clearAll'])('does not zero a newer socket total when %s completes', async (method) => {
    const { result } = await loadedHook();
    const mutation = deferred();
    const fallback = deferred();
    api[method === 'clearAll' ? 'clearNotifications' : 'markAllNotificationsRead'].mockReturnValueOnce(mutation.promise);
    api.getNotificationCount.mockReturnValueOnce(fallback.promise);
    let pending;
    act(() => { pending = result.current[method](); });
    act(() => deliver('notifications:count', 7));
    await act(async () => { mutation.resolve(); });
    expect(result.current.unreadCount).toBe(7);
    act(() => deliver('notifications:count', 8));
    await act(async () => { fallback.resolve({ count: 0 }); await pending; });
    expect(result.current.unreadCount).toBe(8);
  });

  it('preserves the last total on count failure and applies record events idempotently', async () => {
    const { result } = await loadedHook();
    act(() => {
      deliver('notifications:added', NOTIFICATION);
      deliver('notifications:added', NOTIFICATION);
    });
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.unreadCount).toBe(1);
    api.getNotificationCount.mockRejectedValueOnce(new Error('Count unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { await result.current.markAsRead('n1'); });
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.notifications[0].read).toBe(true);
    expect(log).toHaveBeenCalledWith('❌ Failed to load notification count: Count unavailable');
    log.mockRestore();
    act(() => deliver('notifications:cleared'));
    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadCount).toBe(1);
  });
});
