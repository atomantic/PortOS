import { useCallback, useEffect, useRef, useState } from 'react';
import useMounted from './useMounted.js';
import { useSocket } from './useSocket.js';
import { getMaintenanceStatus } from '../services/apiSystem.js';

export function useMaintenance() {
  const [status, setStatus] = useState(null);
  const mounted = useMounted();
  const generation = useRef(0);
  const socket = useSocket();
  const refresh = useCallback(async () => {
    const requested = ++generation.current;
    try {
      const next = await getMaintenanceStatus({ silent: true });
      if (mounted.current && requested === generation.current) setStatus(next);
    } catch {
      if (mounted.current && requested === generation.current) setStatus({ state: 'unknown', error: 'Could not read maintenance status.' });
    }
  }, [mounted]);
  useEffect(() => {
    refresh();
    const disconnected = () => { ++generation.current; setStatus({ state: 'unknown', error: 'Connection lost. Readiness is unknown.' }); };
    socket.on('maintenance:changed', refresh);
    socket.on('connect', refresh);
    socket.on('disconnect', disconnected);
    return () => {
      ++generation.current;
      socket.off('maintenance:changed', refresh);
      socket.off('connect', refresh);
      socket.off('disconnect', disconnected);
    };
  }, [socket, refresh]);
  return { status, refresh };
}
