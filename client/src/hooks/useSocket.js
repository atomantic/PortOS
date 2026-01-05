import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socket = null;

export function useSocket() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!socket) {
      // Connect to the server - use relative path for Tailscale compatibility
      socket = io({
        path: '/socket.io',
        transports: ['websocket', 'polling']
      });

      socket.on('connect', () => {
        setConnected(true);
      });

      socket.on('disconnect', () => {
        setConnected(false);
      });
    }

    return () => {
      // Don't disconnect on component unmount - keep socket alive
    };
  }, []);

  return socket;
}

export function getSocket() {
  return socket;
}
