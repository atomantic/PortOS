import { useState, useCallback, useEffect, useRef } from 'react';
import socket from '../services/socket';

const MAX_OUTPUT_LINES = 5000;

/**
 * Hook for streaming deploy.sh output via Socket.IO.
 */
export function useAppDeploy() {
  const [output, setOutput] = useState([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const cleanupRef = useRef(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const appendOutput = useCallback((entry) => {
    setOutput(prev => {
      const next = [...prev, entry];
      return next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next;
    });
  }, []);

  const startDeploy = useCallback((appId, flags = []) => {
    setOutput([]);
    setError(null);
    setResult(null);
    setIsDeploying(true);

    const onOutput = (data) => {
      appendOutput({ text: data.text, stream: data.stream, ts: data.timestamp });
    };
    const onStatus = (data) => {
      appendOutput({ text: `--- ${data.message} ---\n`, stream: 'status', ts: data.timestamp });
    };
    const onError = (data) => {
      setError(data.message);
      setIsDeploying(false);
      cleanup();
    };
    const onComplete = (data) => {
      setResult(data);
      setIsDeploying(false);
      cleanup();
    };
    const cleanup = () => {
      socket.off('app:deploy:output', onOutput);
      socket.off('app:deploy:status', onStatus);
      socket.off('app:deploy:error', onError);
      socket.off('app:deploy:complete', onComplete);
      cleanupRef.current = null;
    };

    cleanupRef.current?.();
    cleanupRef.current = cleanup;
    socket.on('app:deploy:output', onOutput);
    socket.on('app:deploy:status', onStatus);
    socket.on('app:deploy:error', onError);
    socket.on('app:deploy:complete', onComplete);
    socket.emit('app:deploy', { appId, flags });
  }, [appendOutput]);

  const clearDeploy = useCallback(() => {
    setOutput([]);
    setError(null);
    setResult(null);
  }, []);

  return { output, isDeploying, error, result, startDeploy, clearDeploy };
}
