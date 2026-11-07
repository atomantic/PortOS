import { useEffect, useRef } from 'react';
import socket from '../services/socket';
import { getMediaJob } from '../services/apiMediaJobs';
import useMounted from './useMounted';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

/**
 * Settle media jobs whose terminal socket event was missed while the socket was
 * down. Socket.IO does not replay events emitted during a disconnect, so a
 * surface that clears its busy state only from `*-gen:completed|failed|canceled`
 * stays stuck after a reconnect (#15167; same class as #8426).
 *
 * On every socket `connect`, calls `getMediaJob` for each id returned by
 * `getPendingIds()` and invokes `settle(jobId, job)` for jobs that are terminal
 * (`completed` / `failed` / `canceled`). Queued/running jobs are left alone.
 * `settle` runs only if the id is still pending when the fetch lands, so a live
 * socket event that already cleared it is not double-applied. No polling.
 *
 * Both callbacks are read through refs, so pass inline functions freely.
 */
export default function useMediaJobReconnectSettle(getPendingIds, settle) {
  const getPendingIdsRef = useRef(getPendingIds);
  const settleRef = useRef(settle);
  getPendingIdsRef.current = getPendingIds;
  settleRef.current = settle;
  const mountedRef = useMounted();

  useEffect(() => {
    const onConnect = () => {
      for (const id of getPendingIdsRef.current() || []) {
        getMediaJob(id).then((job) => {
          if (!mountedRef.current || !TERMINAL_STATUSES.has(job?.status)) return;
          if (!(getPendingIdsRef.current() || []).includes(id)) return;
          settleRef.current(id, job);
        }).catch(() => {
          // 404 (past the archive TTL) or a transient failure: leave the row as-is;
          // the next reconnect retries.
        });
      }
    };
    socket.on('connect', onConnect);
    return () => { socket.off('connect', onConnect); };
  }, [mountedRef]);
}
