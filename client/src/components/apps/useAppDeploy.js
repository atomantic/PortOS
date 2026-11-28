/**
 * Stream one app's `deploy.sh` output via Socket.IO.
 *
 * Reattaches to a running deploy after a reload or reconnect. Use when: App deployment surfaces
 * only.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import socket from '../../services/socket';

const MAX_OUTPUT_LINES = 5000;
const CANCEL_ACK_TIMEOUT_MS = 10_000;

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
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const runRef = useRef({
    live: false, confirmed: false, linkLost: false, startedAt: null, tombstone: null,
    terminalError: null, cancelRequest: null,
  });

  const resetCancellation = useCallback(() => {
    runRef.current.cancelRequest = null;
    setIsCancelling(false);
  }, []);

  useEffect(() => {
    const run = runRef.current;
    Object.assign(run, { live: false, confirmed: false, linkLost: false, startedAt: null, tombstone: null, terminalError: null });
    resetCancellation();
    setOutput([]);
    setError(null);
    setResult(null);
    setIsDeploying(false);
    if (!appId) return undefined;

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
        run.terminalError = null;
        resetCancellation();
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
      resetCancellation();
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
        resetCancellation();
        socket.emit('app:operations:list');
        return;
      }
      if (data.startedAt != null) run.startedAt = data.startedAt;
      run.terminalError = data.message;
      endRun();
    });
    const onComplete = forApp((data) => {
      if (data.startedAt != null) run.startedAt = data.startedAt;
      // Only the terminal error can fill in a missing failure reason. Dispatch
      // and cancellation refusals describe requests, not the deploy's outcome.
      const failure = data.cancelled ? 'Deploy cancelled' : data.timedOut ? 'Deploy timed out' : DEPLOY_FAILED_MESSAGE;
      setError(data.success === false ? (data.error || run.terminalError || failure) : null);
      setResult(data);
      endRun();
    });

    const adopt = (op) => {
      resetCancellation();
      run.terminalError = null;
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
      run.cancelRequest = null;
      socket.off('app:deploy:output', onOutput);
      socket.off('app:deploy:status', onStatus);
      socket.off('app:deploy:error', onError);
      socket.off('app:deploy:complete', onComplete);
      socket.off('app:operations:active', onActive);
      socket.off('connect', requestActive);
      socket.off('disconnect', onDisconnect);
    };
  }, [appId, resetCancellation]);

  const startDeploy = useCallback((flags = []) => {
    resetCancellation();
    Object.assign(runRef.current, { live: true, confirmed: false, linkLost: false, startedAt: null, terminalError: null });
    setOutput([]);
    setError(null);
    setResult(null);
    setIsDeploying(true);
    socket.emit('app:deploy', { appId, flags });
  }, [appId, resetCancellation]);

  const cancelDeploy = useCallback(() => {
    const run = runRef.current;
    if (!appId || !run.live || run.cancelRequest) return;
    if (!socket.connected) {
      setError('Reconnect to cancel this deploy');
      return;
    }
    const request = Symbol();
    run.cancelRequest = request;
    setIsCancelling(true);
    setError(null);
    // Drop this request if it cannot be sent now. A buffered cancellation
    // replayed on reconnect could target a later deploy of the same app.
    socket.volatile.timeout(CANCEL_ACK_TIMEOUT_MS).emit('app:deploy:cancel', { appId }, (err, response) => {
      if (run.cancelRequest !== request || (!err && response?.ok)) return;
      resetCancellation();
      setError(response?.message || 'Could not confirm deploy cancellation');
    });
  }, [appId, resetCancellation]);

  const clearDeploy = useCallback(() => {
    setOutput([]);
    setError(null);
    setResult(null);
  }, []);

  return { output, isDeploying, isCancelling, error, result, startDeploy, cancelDeploy, clearDeploy };
}
