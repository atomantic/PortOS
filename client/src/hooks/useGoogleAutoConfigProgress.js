import { useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { runGoogleAutoConfig } from '../services/apiCalendar';
import useMounted from './useMounted';
import { uuidv4 } from '../lib/uuid';

const EVENT = 'calendar:google:autoconfig';

// Subscribe synchronously before dispatch; HTTP alone settles the operation.
export function useGoogleAutoConfigProgress() {
  const [progress, setProgress] = useState(null);
  const active = useRef(null);
  const mounted = useMounted();

  useEffect(() => () => {
    active.current?.unsubscribe();
    active.current = null;
  }, []);

  const run = async (email) => {
    if (active.current) return null;
    const requestId = uuidv4();
    const seen = new Set();
    const listener = (frame) => {
      if (active.current?.requestId !== requestId || frame?.requestId !== requestId
        || typeof frame.step !== 'string' || typeof frame.message !== 'string') return;
      const key = JSON.stringify([frame.step, frame.message]);
      if (seen.has(key)) return;
      seen.add(key);
      setProgress({ step: frame.step, message: frame.message });
    };
    const unsubscribe = () => socket.off(EVENT, listener);
    active.current = { requestId, unsubscribe };
    setProgress(null);
    socket.on(EVENT, listener);
    return runGoogleAutoConfig(email, { silent: true, requestId }).catch(() => null).finally(() => {
      unsubscribe();
      if (active.current?.requestId === requestId) active.current = null;
      if (mounted.current) setProgress(null);
    });
  };

  return { progress, run, mounted };
}
