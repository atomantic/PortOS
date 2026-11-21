/**
 * Server-confirmed maintenance status and `refresh`.
 *
 * `{ mode: 'banner' }` follows the coarse `maintenance:readiness` push instead of refetching. Use
 * when: Admission hold, blockers, and reconnect invalidation; the global banner.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import useMounted from './useMounted.js';
import { useSocket } from './useSocket.js';
import { readShellBootstrap } from '../services/shellBootstrap.js';
import { getMaintenanceStatus } from '../services/apiSystem.js';

// mode 'banner' follows only the coarse `maintenance:readiness` projection
// ({ state, blockerCount, agentDiskPressure }) after the bootstrap/reconnect read, so detailed
// operation-journal invalidations never refetch for the always-mounted banner.
// The default 'detailed' mode refetches the full status (hold identity/revision).
const toBanner = ({ state, blockers, blockerCount, agentDiskPressure }) => ({
  state, blockerCount: blockerCount ?? blockers?.length ?? 0, ...(agentDiskPressure && { agentDiskPressure }),
});

export function useMaintenance({ mode = 'detailed' } = {}) {
  const banner = mode === 'banner';
  const [status, setStatus] = useState(null);
  const mounted = useMounted();
  const generation = useRef(0);
  const needsRetry = useRef(false);
  const socket = useSocket();
  const refresh = useCallback(async (initial = false) => {
    const requested = ++generation.current;
    try {
      const read = () => getMaintenanceStatus({ silent: true });
      const next = await (banner && initial === true ? readShellBootstrap('maintenance', read) : read());
      if (mounted.current && requested === generation.current) {
        needsRetry.current = false;
        setStatus(banner ? toBanner(next) : next);
      }
    } catch {
      if (mounted.current && requested === generation.current) {
        needsRetry.current = true;
        setStatus({ state: 'unknown', error: 'Could not read maintenance status.' });
      }
    }
  }, [mounted, banner]);
  useEffect(() => {
    refresh(true);
    let connected = socket.connected;
    const reconnect = () => {
      if (!banner || connected || needsRetry.current) refresh();
      connected = true;
    };
    const disconnected = () => {
      connected = true;
      ++generation.current;
      setStatus({ state: 'unknown', error: 'Connection lost. Readiness is unknown.' });
    };
    // A pushed projection is newer than any in-flight read: invalidate it.
    const readiness = projection => {
      if (!mounted.current || !projection?.state) return;
      ++generation.current;
      needsRetry.current = false;
      setStatus(toBanner(projection));
    };
    if (banner) socket.on('maintenance:readiness', readiness);
    else socket.on('maintenance:changed', refresh);
    socket.on('connect', reconnect);
    socket.on('disconnect', disconnected);
    return () => {
      ++generation.current;
      socket.off('maintenance:readiness', readiness);
      socket.off('maintenance:changed', refresh);
      socket.off('connect', reconnect);
      socket.off('disconnect', disconnected);
    };
  }, [socket, refresh, banner, mounted]);
  return { status, refresh };
}
