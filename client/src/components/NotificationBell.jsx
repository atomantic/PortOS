import { createContext, useContext, useMemo } from 'react';
import { useEngagementReminderToast } from '../hooks/useEngagementReminderToast';
import { useNotifications } from '../hooks/useNotifications';
import NotificationDropdown from './NotificationDropdown';

const NotificationContext = createContext(null);

// Desktop and mobile use the same feed. Updating it only renders the bells.
export function NotificationBellProvider({ children }) {
  useEngagementReminderToast();
  const { notifications, unreadCount, markAsRead, markAllAsRead, removeNotification, clearAll } = useNotifications();
  const value = useMemo(() => ({
    notifications, unreadCount, markAsRead, markAllAsRead, removeNotification, clearAll,
  }), [notifications, unreadCount, markAsRead, markAllAsRead, removeNotification, clearAll]);
  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function NotificationBell({ position }) {
  const { notifications, unreadCount, markAsRead, markAllAsRead, removeNotification, clearAll } = useContext(NotificationContext);
  return (
    <NotificationDropdown
      position={position}
      notifications={notifications}
      unreadCount={unreadCount}
      onMarkAsRead={markAsRead}
      onMarkAllAsRead={markAllAsRead}
      onRemove={removeNotification}
      onClearAll={clearAll}
    />
  );
}
