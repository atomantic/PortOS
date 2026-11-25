import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../../hooks/useSocket';

// Checkpoint transfers can outlive their initiating request. A terminal frame
// clears progress and asks the caller to refresh the local checkpoint cache.
export default function useRuntimeDownloadProgress(eventName, onSettled) {
  const socket = useSocket();
  const [download, setDownload] = useState(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  useEffect(() => {
    const receive = (frame) => {
      if (!frame) return;
      if (['complete', 'error', 'cancelled'].includes(frame.event)) {
        setDownload(null);
        settled.current();
        return;
      }
      setDownload((previous) => ({
        model: frame.model || previous?.model || null,
        // Resolving/verifying frames don't always carry byte counters.
        received: Number.isFinite(frame.received) ? frame.received : (previous?.received ?? 0),
        total: Number.isFinite(frame.total) ? frame.total : (previous?.total ?? 0),
        message: frame.message || previous?.message || null,
      }));
    };
    socket.on(eventName, receive);
    return () => socket.off(eventName, receive);
  }, [eventName, socket]);

  return [download, () => setDownload(null)];
}
