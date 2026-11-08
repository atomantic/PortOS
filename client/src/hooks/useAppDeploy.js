import { useState, useCallback, useEffect, useRef } from 'react';
import socket from '../services/socket';

const MAX_OUTPUT_LINES = 5000;

const DEPLOY_CONNECTION_LOST_MESSAGE =
  "Lost connection while this deploy ran; it has finished on the server. Check the app's logs or run Deploy again to confirm.";

const statusEntry = (message, ts) => ({ text: `--- ${message} ---\n`, stream: 'status', ts });

/**
 * Hook for streaming one app's deploy.sh output via Socket.IO.
 *
 * The server owns the deploy (it is an `app:operations` entry that outlives the
 * socket that started it) and broadcasts every frame keyed by `appId`. The hook
 * therefore subscribes for its whole lifetime, and on mount and on every
 * reconnect asks for `app:operations:active` to learn whether a deploy for this
 * app is still running. A deploy it believed was running that the registry no
 * longer lists finished while the socket was gone; the spinner is settled with
 * a message rather than left spinning.
 *
 * Ordering rules for the registry snapshot vs. the live frames (all on one
 * ordered socket stream, but a snapshot can be generated before an event it
 * trails):
 *  - `finished`: a terminal frame arrived. A snapshot still listing that run is
 *    stale and must not resurrect it; the registry's end broadcast (always sent
 *    after the terminal frame) re-arms rehydration.
 *  - `confirmed`: the server acknowledged this run (any frame, or a snapshot
 *    listing it). Until then an empty snapshot may simply predate our request's
 *    claim, so it must not be read as "the deploy is gone".
 */
export function useAppDeploy(appId) {
  const [output, setOutput] = useState([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const runRef = useRef({ live: false, confirmed: false, finished: false });

  useEffect(() => {
    if (!appId) return undefined;
    const run = runRef.current;
    run.live = false;
    run.confirmed = false;
    run.finished = false;
    setOutput([]);
    setError(null);
    setResult(null);
    setIsDeploying(false);

    const appendOutput = (...entries) => setOutput(prev => {
      const next = [...prev, ...entries];
      return next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next;
    });
    const markLive = () => {
      run.live = true;
      run.confirmed = true;
      run.finished = false;
      setIsDeploying(true);
    };
    const markFinished = () => {
      run.live = false;
      run.finished = true;
      setIsDeploying(false);
    };
    const forApp = (handler) => (data) => { if (data?.appId === appId) handler(data); };

    const onOutput = forApp((data) => {
      markLive();
      appendOutput({ text: data.text, stream: data.stream, ts: data.timestamp });
    });
    const onStatus = forApp((data) => {
      // A deploy started elsewhere (another tab) begins a fresh log.
      if (data.phase === 'start' && !run.live) {
        setOutput([]);
        setError(null);
        setResult(null);
      }
      markLive();
      appendOutput(statusEntry(data.message, data.timestamp));
    });
    const onError = forApp((data) => {
      setError(data.message);
      if (data.duplicate) {
        // Our dispatch was refused; the run already in flight is not ours to
        // end. Re-sync so a live deploy for this app is reattached.
        run.live = false;
        setIsDeploying(false);
        socket.emit('app:operations:list');
        return;
      }
      markFinished();
    });
    const onComplete = forApp((data) => {
      setResult(data);
      markFinished();
    });

    const onActive = ({ operations = [] } = {}) => {
      const op = operations.find(o => o.appId === appId && o.type === 'deploy');
      if (op) {
        if (run.live) { run.confirmed = true; return; }
        if (run.finished) return;
        run.live = true;
        run.confirmed = true;
        setIsDeploying(true);
        setError(null);
        setResult(null);
        const steps = (op.steps || []).map(s => statusEntry(s.message || s.step, s.timestamp));
        setOutput(prev => (prev.length ? prev : steps));
        return;
      }
      // The end broadcast follows every terminal frame, so a snapshot without
      // the run means any stale one has been replaced.
      run.finished = false;
      if (run.live && run.confirmed) {
        run.live = false;
        setIsDeploying(false);
        setError(DEPLOY_CONNECTION_LOST_MESSAGE);
      }
    };

    const requestActive = () => socket.emit('app:operations:list');
    // A dispatch that never reached the server before the link dropped has no
    // claim to wait for: from here the registry is authoritative.
    const onDisconnect = () => { if (run.live) run.confirmed = true; };

    socket.on('app:deploy:output', onOutput);
    socket.on('app:deploy:status', onStatus);
    socket.on('app:deploy:error', onError);
    socket.on('app:deploy:complete', onComplete);
    socket.on('app:operations:active', onActive);
    socket.on('connect', requestActive);
    socket.on('disconnect', onDisconnect);
    // The socket is normally connected long before this view mounts, so the
    // server's connect-time push already fired.
    requestActive();

    return () => {
      socket.off('app:deploy:output', onOutput);
      socket.off('app:deploy:status', onStatus);
      socket.off('app:deploy:error', onError);
      socket.off('app:deploy:complete', onComplete);
      socket.off('app:operations:active', onActive);
      socket.off('connect', requestActive);
      socket.off('disconnect', onDisconnect);
    };
  }, [appId]);

  const startDeploy = useCallback((flags = []) => {
    const run = runRef.current;
    run.live = true;
    run.confirmed = false;
    run.finished = false;
    setOutput([]);
    setError(null);
    setResult(null);
    setIsDeploying(true);
    socket.emit('app:deploy', { appId, flags });
  }, [appId]);

  const clearDeploy = useCallback(() => {
    setOutput([]);
    setError(null);
    setResult(null);
  }, []);

  return { output, isDeploying, error, result, startDeploy, clearDeploy };
}
