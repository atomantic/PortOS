import { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from './useSocket';
import * as api from '../services/api';

export function useNotifications() {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const socket = useSocket();

  const countGeneration = useRef(0);

  // The total covers the full store, not just the loaded page. A socket total
  // or newer request supersedes any count request already in flight.
  const refreshCount = useCallback(async () => {
    const generation = ++countGeneration.current;
    await api.getNotificationCount().then(({ count }) => {
      if (generation === countGeneration.current) setUnreadCount(count);
    }).catch(err => {
      console.error(`❌ Failed to load notification count: ${err.message}`);
    });
  }, []);

  // Fetch initial notifications
  useEffect(() => {
    let cancelled = false;
    const fetchNotifications = async () => {
      setLoading(true);
      try {
        const [notifs] = await Promise.all([
          api.getNotifications({ limit: 50 }),
          refreshCount()
        ]);
        if (cancelled) return;
        setNotifications(notifs);
      } catch (err) {
        if (cancelled) return;
        console.error(`❌ Failed to load notifications: ${err.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchNotifications();
    return () => { cancelled = true; countGeneration.current++; };
  }, [refreshCount]);

  // Subscribe to socket events
  useEffect(() => {
    if (!socket) return;

    socket.emit('notifications:subscribe');

    const handleAdded = (notification) => {
      setNotifications(prev => [notification, ...prev.filter(n => n.id !== notification.id)]);
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
      countGeneration.current++;
      setUnreadCount(count);
    };

    const handleCleared = () => {
      setNotifications([]);
    };

    socket.on('notifications:added', handleAdded);
    socket.on('notifications:removed', handleRemoved);
    socket.on('notifications:updated', handleUpdated);
    socket.on('notifications:count', handleCount);
    socket.on('notifications:cleared', handleCleared);

    // notifications:* is a shared namespace; OpenWorld's useOpenWorldData also
    // subscribes. The server keeps a per-socket Set with no ref count, so
    // emitting notifications:unsubscribe here would also remove OpenWorld's
    // events. Just drop the listeners; disconnect cleans up Set membership.
    return () => {
      socket.off('notifications:added', handleAdded);
      socket.off('notifications:removed', handleRemoved);
      socket.off('notifications:updated', handleUpdated);
      socket.off('notifications:count', handleCount);
      socket.off('notifications:cleared', handleCleared);
    };
  }, [socket]);

  const markAsRead = useCallback(async (id) => {
    await api.markNotificationRead(id);
    setNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, read: true } : n)
    );
    await refreshCount();
  }, [refreshCount]);

  const markAllAsRead = useCallback(async () => {
    await api.markAllNotificationsRead();
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    await refreshCount();
  }, [refreshCount]);

  const removeNotification = useCallback(async (id) => {
    await api.deleteNotification(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
    await refreshCount();
  }, [refreshCount]);

  const clearAll = useCallback(async () => {
    await api.clearNotifications();
    setNotifications([]);
    await refreshCount();
  }, [refreshCount]);

  const refresh = useCallback(async () => {
    const [notifs] = await Promise.all([
      api.getNotifications({ limit: 50 }),
      refreshCount()
    ]);
    setNotifications(notifs);
  }, [refreshCount]);

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
