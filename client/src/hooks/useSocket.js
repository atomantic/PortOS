import { useEffect, useState } from 'react';
import socket from '../services/socket';

/**
 * Hook to access the shared socket instance and track connection status.
 * Uses the singleton socket from services/socket.js to avoid duplicate connections.
 */
export function useSocket() {
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    // Set initial state
    setConnected(socket.connected);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, []);

  return socket;
}

export function getSocket() {
  return socket;
}
