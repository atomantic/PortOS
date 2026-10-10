import { useCallback, useEffect, useRef, useState } from 'react';
import useMounted from './useMounted.js';
import { useSocket } from './useSocket.js';
import { getMaintenanceStatus } from '../services/apiSystem.js';

// mode 'banner' follows only the coarse `maintenance:readiness` projection
// ({ state, blockerCount }) after the bootstrap/reconnect read, so detailed
// operation-journal invalidations never refetch for the always-mounted banner.
// The default 'detailed' mode refetches the full status (hold identity/revision).
const toBanner = ({ state, blockers, blockerCount }) => ({ state, blockerCount: blockerCount ?? blockers?.length ?? 0 });

export function useMaintenance({ mode = 'detailed' } = {}) {
  const banner = mode === 'banner';
  const [status, setStatus] = useState(null);
  const mounted = useMounted();
  const generation = useRef(0);
  const socket = useSocket();
  const refresh = useCallback(async () => {
    const requested = ++generation.current;
    try {
      const next = await getMaintenanceStatus({ silent: true });
      if (mounted.current && requested === generation.current) setStatus(banner ? toBanner(next) : next);
    } catch {
      if (mounted.current && requested === generation.current) setStatus({ state: 'unknown', error: 'Could not read maintenance status.' });
    }
  }, [mounted, banner]);
  useEffect(() => {
    refresh();
    const disconnected = () => { ++generation.current; setStatus({ state: 'unknown', error: 'Connection lost. Readiness is unknown.' }); };
    // A pushed projection is newer than any in-flight read: invalidate it.
    const readiness = projection => {
      if (!mounted.current || !projection?.state) return;
      ++generation.current;
      setStatus(toBanner(projection));
    };
    if (banner) socket.on('maintenance:readiness', readiness);
    else socket.on('maintenance:changed', refresh);
    socket.on('connect', refresh);
    socket.on('disconnect', disconnected);
    return () => {
      ++generation.current;
      socket.off('maintenance:readiness', readiness);
      socket.off('maintenance:changed', refresh);
      socket.off('connect', refresh);
      socket.off('disconnect', disconnected);
    };
  }, [socket, refresh, banner, mounted]);
  return { status, refresh };
}
