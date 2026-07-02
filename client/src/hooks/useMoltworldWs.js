import { useState, useEffect, useCallback, useRef } from 'react';
import socket from '../services/socket';
import * as api from '../services/api';

const MAX_FEED_ITEMS = 200;
let idCounter = 0;

/**
 * Hook for Moltworld real-time WebSocket events.
 *
 * Subscribes to moltworld:* Socket.IO events and maintains:
 * - connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
 * - feedItems: ring buffer of last 200 events (newest first)
 * - presence: latest agent presence snapshot — `null` until the first
 *   presence/nearby event arrives (not-yet-known), then a (possibly empty)
 *   array. An empty array is a *confirmed-empty* snapshot that must clear the
 *   panel, distinct from the not-yet-known `null` sentinel.
 * - connect(accountId) / disconnect(): control the server-side WS relay
 */
export default function useMoltworldWs() {
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [feedItems, setFeedItems] = useState([]);
  const [presence, setPresence] = useState(null);
  const feedRef = useRef([]);

  const addFeedItem = useCallback((eventType, data) => {
    const item = {
      id: ++idCounter,
      eventType,
      agentName: data.agentName || data.name || data.agentId || '',
      content: data.message || data.thought || data.thinking || data.action || '',
      timestamp: data.timestamp || Date.now(),
      raw: data
    };
    feedRef.current = [item, ...feedRef.current].slice(0, MAX_FEED_ITEMS);
    setFeedItems([...feedRef.current]);
  }, []);

  useEffect(() => {
    // Subscribe to agents channel (moltworld events ride on agent subscribers)
    socket.emit('agents:subscribe');

    const handleStatus = (data) => {
      setConnectionStatus(data.status || 'disconnected');
      addFeedItem('status', { ...data, agentName: 'System', content: `Connection: ${data.status}` });
    };
    const handleEvent = (data) => {
      addFeedItem(data.type || data.event || 'event', data);
    };
    const handlePresence = (data) => {
      // No `?? []` fallback: a payload missing both keys (`{}`) is malformed /
      // absent, NOT a confirmed-empty snapshot, and must preserve prior state.
      // Validate shape, not length: an empty array IS a legitimate "nobody
      // nearby" snapshot that must clear a previously-populated panel —
      // gating on `.length > 0` drops it and leaves phantoms.
      const agents = data.agents ?? data.nearby;
      if (Array.isArray(agents)) setPresence(agents);
      addFeedItem('presence', { ...data, content: `${Array.isArray(agents) ? agents.length : 0} agents nearby` });
    };
    const handleThinking = (data) => {
      addFeedItem('thinking', data);
    };
    const handleAction = (data) => {
      addFeedItem('action', data);
    };
    const handleInteraction = (data) => {
      addFeedItem('interaction', data);
    };
    const handleNearby = (data) => {
      const agents = data.agents ?? data.nearby;
      if (Array.isArray(agents)) setPresence(agents);
      addFeedItem('nearby', { ...data, content: `${Array.isArray(agents) ? agents.length : 0} agents` });
    };

    socket.on('moltworld:status', handleStatus);
    socket.on('moltworld:event', handleEvent);
    socket.on('moltworld:presence', handlePresence);
    socket.on('moltworld:thinking', handleThinking);
    socket.on('moltworld:action', handleAction);
    socket.on('moltworld:interaction', handleInteraction);
    socket.on('moltworld:nearby', handleNearby);

    // Fetch initial WS status
    const abortCtrl = new AbortController();
    api.moltworldWsStatus({ signal: abortCtrl.signal, silent: true }).then(data => {
      if (data?.status) setConnectionStatus(data.status);
    }).catch(() => {});

    return () => {
      abortCtrl.abort();
      socket.off('moltworld:status', handleStatus);
      socket.off('moltworld:event', handleEvent);
      socket.off('moltworld:presence', handlePresence);
      socket.off('moltworld:thinking', handleThinking);
      socket.off('moltworld:action', handleAction);
      socket.off('moltworld:interaction', handleInteraction);
      socket.off('moltworld:nearby', handleNearby);
    };
  }, [addFeedItem]);

  const connect = useCallback(async (accountId) => {
    setConnectionStatus('connecting');
    const result = await api.moltworldWsConnect(accountId).catch(() => null);
    if (result?.status) setConnectionStatus(result.status);
  }, []);

  const disconnect = useCallback(async () => {
    await api.moltworldWsDisconnect().catch(() => null);
    setConnectionStatus('disconnected');
  }, []);

  return {
    connectionStatus,
    feedItems,
    presence,
    connect,
    disconnect
  };
}
