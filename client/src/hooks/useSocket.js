import { useEffect, useState } from 'react';
import socket from '../services/socket';

/**
 * Live `socket.connected` as React state: flips on every `connect` /
 * `disconnect` so a consumer re-renders when the shared transport drops or
 * recovers. Reads the current value at mount (and again inside the effect)
 * so a hook mounted mid-reconnect does not report a stale initial state.
 */
export function useSocketConnected() {
  const [connected, setConnected] = useState(() => Boolean(socket.connected));

  useEffect(() => {
    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    setConnected(Boolean(socket.connected));

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, []);

  return connected;
}

/**
 * Hook to access the shared socket instance. Uses the singleton socket from
 * services/socket.js to avoid duplicate connections, and re-renders the
 * caller on connect/disconnect so a `socket.connected` read in render is
 * never stale. Use `useSocketConnected()` to read that flag as a value.
 */
export function useSocket() {
  useSocketConnected();
  return socket;
}

export function getSocket() {
  return socket;
}
