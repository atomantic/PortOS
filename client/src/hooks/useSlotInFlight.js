import { useEffect, useState } from 'react';

/**
 * Track whether a render slot ({ jobId, filename, ... }) has an in-flight
 * render, so a "render" button can disable + spin while its own render is
 * still going.
 *
 * Returns `{ inFlight, setStatus }`. Wire `setStatus` to the slot's
 * MediaJobThumb `onStatus` so a live/fetched terminal status clears the
 * in-flight flag.
 *
 * Two staleness guards keep the button from getting stuck "loading" forever:
 *
 * 1. A truthy `slot.filename` means the render is complete by definition — the
 *    server clears `filename` when a re-render is queued, so a present filename
 *    is an authoritative "not in flight" signal (mirrors MediaJobThumb's
 *    `fallbackFilename` short-circuit). Without this, every fresh navigation
 *    re-arms `status='unknown'` and the button shows a disabled/loading flash
 *    until the job-status fetch (or the 5s grace) resolves — even though the
 *    render finished long ago. That's what made comic-page proof/final buttons
 *    look stuck after kicking off an unrelated render (e.g. a volume cover).
 *
 * 2. A 5s grace window: if MediaJobThumb never reports a real status (the job
 *    archive expired before this session), stop treating the unresolved
 *    'unknown' as in-flight so the button isn't permanently disabled.
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
