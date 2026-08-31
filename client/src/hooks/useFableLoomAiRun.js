import { useCallback, useEffect, useRef, useState } from 'react';
import { uuidv4 } from '../lib/uuid.js';
import socket from '../services/socket';

// A FableLoom operation is keyed by a caller-owned id rather than by the run
// id: the run id does not exist until the server has created it, and a completed
// operation may already have released its shell session.
export default function useFableLoomAiRun() {
  const [run, setRun] = useState(null);
  const operationIdRef = useRef(null);

  useEffect(() => {
    const handleStatus = (event) => {
      if (!event?.operationId || event.operationId !== operationIdRef.current) return;
      setRun((current) => ({ ...(current || {}), ...event }));
    };
    socket.on('ai:status', handleStatus);
    return () => socket.off('ai:status', handleStatus);
  }, []);

  const begin = useCallback(() => {
    const operationId = uuidv4();
    operationIdRef.current = operationId;
    setRun({ operationId, phase: 'start', message: 'Starting AI…' });
    return operationId;
  }, []);

  const fail = useCallback((message) => {
    setRun((current) => current
      ? { ...current, phase: 'error', message: message || 'AI operation failed', shellReady: false }
      : current);
  }, []);

  return { run, begin, fail };
}
