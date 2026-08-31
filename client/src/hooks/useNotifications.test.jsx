import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  vi.clearAllMocks();
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
