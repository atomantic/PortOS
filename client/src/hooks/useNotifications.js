import { useState, useEffect, useCallback } from 'react';
import { useSocket } from './useSocket';
import * as api from '../services/api';

export function useNotifications() {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const socket = useSocket();

  // Fetch initial notifications
  useEffect(() => {
    const fetchNotifications = async () => {
      setLoading(true);
      const [notifs, countData] = await Promise.all([
        api.getNotifications({ limit: 50 }),
        api.getNotificationCount()
      ]);
      setNotifications(notifs);
      setUnreadCount(countData.count);
      setLoading(false);
    };

    fetchNotifications();
  }, []);

  // Subscribe to socket events
  useEffect(() => {
    if (!socket) return;

    socket.emit('notifications:subscribe');

    const handleAdded = (notification) => {
      setNotifications(prev => [notification, ...prev]);
      setUnreadCount(prev => prev + 1);
    };

    const handleRemoved = ({ id }) => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    };

    const handleUpdated = (notification) => {
      setNotifications(prev =>
        prev.map(n => n.id === notification.id ? notification : n)
      );
    };

    const handleCount = (count) => {
      setUnreadCount(count);
    };

    const handleCleared = () => {
      setNotifications([]);
      setUnreadCount(0);
    };

    socket.on('notifications:added', handleAdded);
    socket.on('notifications:removed', handleRemoved);
    socket.on('notifications:updated', handleUpdated);
    socket.on('notifications:count', handleCount);
    socket.on('notifications:cleared', handleCleared);

    return () => {
      socket.off('notifications:added', handleAdded);
      socket.off('notifications:removed', handleRemoved);
      socket.off('notifications:updated', handleUpdated);
      socket.off('notifications:count', handleCount);
      socket.off('notifications:cleared', handleCleared);
      socket.emit('notifications:unsubscribe');
    };
  }, [socket]);

  const markAsRead = useCallback(async (id) => {
    await api.markNotificationRead(id);
    setNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, read: true } : n)
    );
    setUnreadCount(prev => Math.max(0, prev - 1));
  }, []);

  const markAllAsRead = useCallback(async () => {
    await api.markAllNotificationsRead();
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
  }, []);

  const removeNotification = useCallback(async (id) => {
    await api.deleteNotification(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const clearAll = useCallback(async () => {
    await api.clearNotifications();
    setNotifications([]);
    setUnreadCount(0);
  }, []);

  const refresh = useCallback(async () => {
    const [notifs, countData] = await Promise.all([
      api.getNotifications({ limit: 50 }),
      api.getNotificationCount()
    ]);
    setNotifications(notifs);
    setUnreadCount(countData.count);
  }, []);

  return {
    notifications,
    unreadCount,
    loading,
    markAsRead,
    markAllAsRead,
    removeNotification,
    clearAll,
    refresh
  };
}
