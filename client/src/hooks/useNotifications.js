/**
 * Generic toast dispatch + socket-subscribed notification list.
 *
 * Use when: You need to read / dispatch the global notification stream.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import socket from '../services/socket';
import { useSocketSubscription } from './useSocketSubscription';
import useMounted from './useMounted';
import { getNotificationCount, getNotificationSnapshot, markNotificationRead, markAllNotificationsRead, deleteNotification, clearNotifications } from '../services/apiSystem.js';

export function useNotifications() {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const mountedRef = useMounted();
  const countGeneration = useRef(0);
  const listGeneration = useRef(0);
  const pendingPatches = useRef(null);
  const updateNotifications = useCallback((apply) => {
    pendingPatches.current?.push(apply);
    setNotifications(apply);
  }, []);

  // The total covers the full store, not just the loaded page. A socket total
  // or newer request supersedes any count request already in flight.
  const refreshCount = useCallback(async () => {
    const generation = ++countGeneration.current;
    await getNotificationCount().then(({ count }) => {
      if (generation === countGeneration.current) setUnreadCount(count);
    }).catch(err => {
      console.error(`❌ Failed to load notification count: ${err.message}`);
    });
  }, []);

  // The one list loader, shared by mount, reconnect and the public refresh:
  // a response that lands after unmount or behind a newer load is dropped,
  // and a failure logs instead of surfacing as an unhandled rejection (#12042).
  const loadNotifications = useCallback(async (initial = false) => {
    const generation = ++listGeneration.current;
    const countRequest = ++countGeneration.current;
    const patches = [];
    pendingPatches.current = patches;
    const fresh = () => mountedRef.current && generation === listGeneration.current;
    if (initial) setLoading(true);
    try {
      const { notifications: rows, count } = await getNotificationSnapshot({ limit: 50, coalesce: initial });
      if (fresh()) {
        setNotifications(patches.reduce((result, apply) => apply(result), rows));
        if (countRequest === countGeneration.current) setUnreadCount(count);
      }
    } catch (err) {
      if (fresh()) console.error(`❌ Failed to load notifications: ${err.message}`);
    } finally {
      if (fresh()) {
        pendingPatches.current = null;
        setLoading(false);
      }
    }
  }, [mountedRef]);

  const refresh = useCallback(() => loadNotifications(), [loadNotifications]);

  useEffect(() => {
    loadNotifications(true);
    return () => { listGeneration.current++; countGeneration.current++; pendingPatches.current = null; };
  }, [loadNotifications]);

  // Namespace subscription: this is the sole `notifications:*` consumer
  // (mounted once by the notification bell provider) now that OpenWorld's
  // retired useOpenWorldData no longer shares it, so it's safe to unsubscribe
  // on unmount. Re-emits `notifications:subscribe` on every socket reconnect
  // and refetches the list + count so a bell that went silent during a server
  // restart/self-update catches back up without a page reload.
  useSocketSubscription('notifications', { onResubscribe: refresh });

  // Subscribe to socket data events
  useEffect(() => {
    const handleAdded = (notification) => {
      updateNotifications(prev => [notification, ...prev.filter(n => n.id !== notification.id)]);
    };

    const handleRemoved = ({ id }) => {
      updateNotifications(prev => prev.filter(n => n.id !== id));
    };

    const handleUpdated = (notification) => {
      updateNotifications(prev =>
        prev.map(n => n.id === notification.id ? notification : n)
      );
    };

    const handleCount = (count) => {
      countGeneration.current++;
      setUnreadCount(count);
    };

    const handleCleared = () => {
      updateNotifications(() => []);
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
    };
  }, [updateNotifications]);

  const markAsRead = useCallback(async (id) => {
    await markNotificationRead(id);
    updateNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, read: true } : n)
    );
    await refreshCount();
  }, [refreshCount, updateNotifications]);

  const markAllAsRead = useCallback(async () => {
    await markAllNotificationsRead();
    updateNotifications(prev => prev.map(n => ({ ...n, read: true })));
    await refreshCount();
  }, [refreshCount, updateNotifications]);

  const removeNotification = useCallback(async (id) => {
    await deleteNotification(id);
    updateNotifications(prev => prev.filter(n => n.id !== id));
    await refreshCount();
  }, [refreshCount, updateNotifications]);

  const clearAll = useCallback(async () => {
    await clearNotifications();
    updateNotifications(() => []);
    await refreshCount();
  }, [refreshCount, updateNotifications]);

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
