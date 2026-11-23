/**
 * Whether a render slot (`{ jobId, filename }`) has an in-flight render.
 *
 * Returns `{ inFlight, setStatus }`. A present `filename` (or 5s grace on a stale/expired job)
 * clears `inFlight` so the render button never sticks "loading". Use when: A render button that should
 * disable + spin only while its own slot is actually rendering (comic pages, covers). Wire `setStatus`
 * to the slot's `MediaJobThumb` `onStatus`.
 */

import { useEffect, useState } from 'react';

/**
 * Track whether a render slot ({ jobId, filename, ... }) has an in-flight render, so a "render" button can disable + spin while its own render is going. Returns `{ inFlight, setStatus }`; wire `setStatus` to the slot's MediaJobThumb `onStatus`.
 * Two staleness guards keep the button from sticking "loading": (1) a truthy `slot.filename` means complete by definition (the server clears it when a re-render is queued; mirrors MediaJobThumb's `fallbackFilename` short-circuit), else every navigation re-arms `status='unknown'` and the button flashes loading
 * until the status fetch resolves; (2) a 5s grace window, so a job archive that expired before this session (MediaJobThumb never reports a real status) isn't treated as in flight forever.
 */
export default function useSlotInFlight(slot) {
  const [status, setStatus] = useState('unknown');
  const [expired, setExpired] = useState(false);
  const settled = !!slot?.filename;
  useEffect(() => {
    setStatus('unknown');
    setExpired(false);
    if (!slot?.jobId || settled) return undefined;
    const t = setTimeout(() => setExpired(true), 5000);
    return () => clearTimeout(t);
  }, [slot?.jobId, settled]);
  const inFlight = !!slot?.jobId && !settled
    && status !== 'completed' && status !== 'failed' && status !== 'canceled'
    && !(status === 'unknown' && expired);
  return { inFlight, setStatus };
}
