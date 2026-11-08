import { useState, useCallback, useEffect, useRef } from 'react';
import socket from '../services/socket';

const MAX_OUTPUT_LINES = 5000;

const DEPLOY_CONNECTION_LOST_MESSAGE =
  "Lost connection while this deploy ran; it has finished on the server. Check the app's logs or run Deploy again to confirm.";
const DEPLOY_NOT_CONFIRMED_MESSAGE =
  'Lost connection before the server confirmed this deploy started. Run Deploy again.';

const DEPLOY_FAILED_MESSAGE = 'Deploy failed';

const statusEntry = (message, ts) => ({ text: `--- ${message} ---\n`, stream: 'status', ts });

/**
 * Hook for streaming one app's deploy.sh output via Socket.IO.
 *
 * The server owns the deploy (it is an `app:operations` entry that outlives the
 * socket that started it) and broadcasts every frame keyed by `appId`. The hook
 * therefore subscribes for its whole lifetime, and on mount and on every
 * reconnect asks for `app:operations:active` to learn whether a deploy for this
 * app is still running.
 *
 * Run identity is the registry operation's `startedAt`. The hook owns one log
 * buffer for one run at a time; a snapshot listing a deploy with a different
 * `startedAt` is a different run (started elsewhere, or while the socket was
 * down) and replaces the buffer, result and error instead of stitching onto it.
 *
 * Settling rules:
 *  - While the socket stays connected the terminal frame is reliable: the
 *    server emits it before the registry's end broadcast. An empty snapshot
 *    therefore settles a live run only if the socket dropped during that run
 *    (`linkLost`), when the terminal frame may have gone to the old socket.
 *  - A run that ended (terminal frame, or settled by an empty snapshot) is
 *    tombstoned by its `startedAt`; a trailing snapshot still listing it cannot
 *    resurrect it. The tombstone is replaced only by the next run that ends.
 *  - `confirmed`: the server acknowledged this run (a frame, or a snapshot
 *    listing it). The lost-connection copy for an unacknowledged dispatch does
 *    not claim the deploy ran.
 */
export function useAppDeploy(appId) {
  const [output, setOutput] = useState([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const runRef = useRef({ live: false, confirmed: false, linkLost: false, startedAt: null, tombstone: null });

  useEffect(() => {
    if (!appId) return undefined;
    const run = runRef.current;
    Object.assign(run, { live: false, confirmed: false, linkLost: false, startedAt: null, tombstone: null });
    setOutput([]);
    setError(null);
    setResult(null);
    setIsDeploying(false);

    const appendOutput = (...entries) => setOutput(prev => {
      const next = [...prev, ...entries];
      return next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next;
    });
    // A frame from a run that already ended (its startedAt is tombstoned).
    const isEnded = (data) => data.startedAt != null && data.startedAt === run.tombstone;
    const markLive = (data) => {
      const otherRun = run.live && data.startedAt != null && run.startedAt != null && data.startedAt !== run.startedAt;
      if (!run.live || otherRun) {
        // Frames from a run this hook was not following. They also supersede a
        // refused duplicate's error.
        setError(null);
        run.linkLost = false;
        if (otherRun) {
          setOutput([]);
          setResult(null);
        }
      }
      if (data.startedAt != null) run.startedAt = data.startedAt;
      else if (!run.live) run.startedAt = null;
      run.live = true;
      run.confirmed = true;
      setIsDeploying(true);
    };
    const endRun = () => {
      run.live = false;
      // An unknown identity keeps the previous tombstone rather than erasing it.
      if (run.startedAt != null) run.tombstone = run.startedAt;
      setIsDeploying(false);
    };
    const forApp = (handler) => (data) => { if (data?.appId === appId) handler(data); };

    const onOutput = forApp((data) => {
      if (isEnded(data)) return;
      markLive(data);
      appendOutput({ text: data.text, stream: data.stream, ts: data.timestamp });
    });
    const onStatus = forApp((data) => {
      if (isEnded(data)) return;
      // A deploy started elsewhere (another tab) begins a fresh log.
      if (data.phase === 'start' && !run.live) {
        setOutput([]);
        setResult(null);
      }
      markLive(data);
      appendOutput(statusEntry(data.message, data.timestamp));
    });
    const onError = forApp((data) => {
      setError(data.message);
      if (data.duplicate) {
        // Our dispatch was refused; the run already in flight is not ours to
        // end. Re-sync so a live deploy for this app is reattached.
        run.live = false;
        run.startedAt = null;
        setIsDeploying(false);
        socket.emit('app:operations:list');
        return;
      }
      if (data.startedAt != null) run.startedAt = data.startedAt;
      endRun();
    });
    const onComplete = forApp((data) => {
      if (data.startedAt != null) run.startedAt = data.startedAt;
      // A failed run replaces any stale duplicate-refusal error.
      setError(data.success === false ? (data.error || DEPLOY_FAILED_MESSAGE) : null);
      setResult(data);
      endRun();
    });

    const adopt = (op) => {
      run.live = true;
      run.confirmed = true;
      run.linkLost = false;
      run.startedAt = op.startedAt;
      setIsDeploying(true);
      setError(null);
      setResult(null);
      setOutput((op.steps || []).map(s => statusEntry(s.message || s.step, s.timestamp)));
    };

    const onActive = ({ operations = [] } = {}) => {
      const op = operations.find(o => o.appId === appId && o.type === 'deploy');
      if (op) {
        if (run.tombstone != null && op.startedAt === run.tombstone) return;
        if (run.live && (run.startedAt == null || run.startedAt === op.startedAt)) {
          // The run we are following (a local dispatch learns its identity here).
          run.startedAt = op.startedAt;
          run.confirmed = true;
          run.linkLost = false;
          return;
        }
        adopt(op);
        return;
      }
      if (run.live && run.linkLost) {
        endRun();
        setError(run.confirmed ? DEPLOY_CONNECTION_LOST_MESSAGE : DEPLOY_NOT_CONFIRMED_MESSAGE);
      }
    };

    const requestActive = () => socket.emit('app:operations:list');
    const onDisconnect = () => { if (run.live) run.linkLost = true; };

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
    Object.assign(runRef.current, { live: true, confirmed: false, linkLost: false, startedAt: null });
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
