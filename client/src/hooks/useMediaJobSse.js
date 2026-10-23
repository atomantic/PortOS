import { useCallback, useEffect, useRef } from 'react';
import { safeParseJSON } from '../lib/genUtils';

/**
 * Imperative EventSource subscriber for a single media-generation job's
 * `/api/{kind}-gen/:id/events` stream. Used by ImageGen + VideoGen, which
 * both POST a render, learn the jobId from the response, then open the SSE
 * and settle a Promise on the terminal frame (the queue worker awaits it).
 *
 * This is a sibling to the declarative `useSseProgress` — not a wrapper of
 * it — because those pages can't know the stream URL until the POST returns,
 * and the batch/queue paths need an awaitable Promise rather than reactive
 * `frames`/`latest` state. The shared machinery here is the parse → dispatch
 * → terminal-close → settle lifecycle; each page maps the per-type fields to
 * its own state via the handler callbacks.
 *
 * `attach(jobId, handlers)` returns a Promise that:
 *   - resolves on `complete` (with `onComplete`'s return value, or `msg.result`)
 *   - rejects on `error` / `canceled` (with the handler's returned Error, or a
 *     default built from `msg.error` / `msg.reason`)
 *   - rejects on connection loss ("Lost connection to server")
 *
 * Handlers (all optional): `isCurrent` (staleness guard — a stale frame
 * closes the stream and is ignored), `onQueued`, `onStarted`, `onStage`,
 * `onStatus`, `onProgress`, `onPreview`, `onComplete`, `onError`,
 * `onCanceled`, `onConnectionError`.
 *
 * `preview` is the mediaJobQueue dispatcher's preview-ONLY frame — a runner
 * frame (`currentImage`) that arrived without a progress value, kept a distinct
 * type so a consumer's progress bar isn't disturbed by it.
 *
 * On top of that transport sits the single-run owner the pages share. One
 * active run record holds the request generation, the job identity the run
 * acquired or adopted, its stream and its completion settlement:
 *
 *   - `start(kickoff, handlers, opts)` runs `kickoff()` (the POST, or a read of
 *     the already-active job), adopts the acknowledged job and attaches its
 *     stream. `handlers` is the `attach` handler object, or `(ack) => handlers`
 *     when a handler needs the acknowledgement. Extra handlers: `onAcknowledged(ack)`
 *     (run is still current, before the stream opens) and `onSync(ack)` (the ack
 *     carries no job id — the work already finished). `opts`: `jobIdOf(ack)`
 *     (default `ack.jobId || ack.generationId`), `ifIdle` (skip when a run is
 *     already active — the resume path) and `onKickoffError(err)` (the request
 *     itself failed while the run was still current).
 *   - `cancel()` targets ONLY this run's job via the `cancelJob(jobId)` option.
 *     Cancelled before the kickoff is acknowledged, it records the intent and
 *     cancels exactly the eventual acknowledged job — no stream is opened.
 *   - `dispose()` (also run on unmount) detaches: it closes the stream and
 *     invalidates every pending callback but does NOT cancel the accepted
 *     durable job, so a reload can resume it.
 *
 * A run that is cancelled, detached or superseded settles its promise ONCE
 * with an error `isMediaRunEnded()` recognises, so callers can skip the error
 * presentation that belongs to a genuine failure.
 */
const ENDED = 'MediaRunEndedError';
const endedError = (reason) => Object.assign(new Error(reason === 'canceled' ? 'Cancelled' : 'Detached'), { name: ENDED, reason });
export const isMediaRunEnded = (err) => err?.name === ENDED;

const defaultJobIdOf = (ack) => ack?.jobId || ack?.generationId;

// Take a run out of play and settle it with the reason; the caller owns
// clearing `runRef` (it knows whether this run is the current one).
const retire = (run, reason) => {
  run.ended = true;
  run.es?.close();
  run.reject(endedError(reason));
};

export function useMediaJobSse(kind, { cancelJob } = {}) {
  const eventSourceRef = useRef(null);
  const runRef = useRef(null);
  const cancelJobRef = useRef(cancelJob);
  useEffect(() => { cancelJobRef.current = cancelJob; });

  const close = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const subscribe = useCallback((jobId, handlers = {}, register) => {
    const {
      isCurrent = () => true,
      onQueued, onStarted, onStage, onStatus, onProgress, onPreview,
      onComplete, onError, onCanceled, onConnectionError,
    } = handlers;
    return new Promise((resolve, reject) => {
      const es = new EventSource(`/api/${kind}-gen/${jobId}/events`);
      register(es);
      es.onmessage = (ev) => {
        // A stale frame (the run this stream belonged to was cancelled /
        // superseded) tears down the stream and is otherwise ignored.
        if (!isCurrent()) { es.close(); return; }
        const msg = safeParseJSON(ev.data);
        if (!msg) return;
        switch (msg.type) {
          case 'queued': onQueued?.(msg); break;
          case 'started': onStarted?.(msg); break;
          case 'stage': onStage?.(msg); break;
          case 'status': onStatus?.(msg); break;
          case 'progress': onProgress?.(msg); break;
          case 'preview': onPreview?.(msg); break;
          case 'complete': {
            es.close();
            const value = onComplete?.(msg);
            resolve(value === undefined ? msg.result : value);
            break;
          }
          case 'error': {
            es.close();
            reject(onError?.(msg) || new Error(msg.error));
            break;
          }
          case 'canceled': {
            es.close();
            reject(onCanceled?.(msg) || new Error(msg.reason || 'Canceled'));
            break;
          }
          default: break;
        }
      };
      es.onerror = () => {
        if (!isCurrent()) { es.close(); return; }
        // Only a genuine terminal failure (readyState CLOSED — e.g. a non-2xx /
        // non-event-stream response, which EventSource will NOT auto-retry) tears
        // down the stream and rejects. A transient blip (readyState CONNECTING)
        // is left alone so the browser's built-in auto-reconnect can recover; the
        // server replays the job's last SSE payload on re-attach. Mirrors
        // useSseProgress.js's CLOSED-only terminal handling.
        if (es.readyState !== EventSource.CLOSED) return;
        es.close();
        const err = new Error('Lost connection to server');
        onConnectionError?.(err);
        reject(err);
      };
    });
  }, [kind]);

  const attach = useCallback((jobId, handlers) => subscribe(jobId, handlers, (es) => { eventSourceRef.current = es; }), [subscribe]);

  // Rejects when the server refused the cancel (error status, or a body with
  // `ok: false`) so the caller keeps the run attached instead of reporting it
  // cancelled while the job is still live.
  const sendCancel = useCallback((jobId) => Promise.resolve().then(() => cancelJobRef.current?.(jobId)).then((res) => {
    if (res?.ok === false) throw new Error(res.reason || res.error || 'Cancel was refused');
    return res;
  }), []);

  const start = useCallback((kickoff, handlers = {}, { jobIdOf = defaultJobIdOf, ifIdle = false, onKickoffError } = {}) => {
    if (ifIdle && runRef.current) return Promise.resolve(null);
    const previous = runRef.current;
    return new Promise((resolve, reject) => {
      const run = { ended: false, cancelRequested: false, jobId: null, es: null, reject };
      if (previous) retire(previous, 'superseded');
      runRef.current = run;
      const isCurrent = () => !run.ended && runRef.current === run;
      const finish = () => { run.ended = true; if (runRef.current === run) runRef.current = null; };
      const fail = (err) => { finish(); reject(err); };
      (async () => kickoff())().then((ack) => {
        if (!isCurrent()) {
          // Cancelled before the acknowledgement: the job exists server-side now,
          // so cancel exactly that job. A detached/superseded run leaves it be.
          const id = run.cancelRequested ? jobIdOf(ack) : null;
          if (id) sendCancel(id).catch(() => {});
          return;
        }
        // A throwing handler must still settle the run, never leave it dangling.
        try {
          const h = typeof handlers === 'function' ? handlers(ack) : handlers;
          const jobId = jobIdOf(ack);
          if (!jobId) {
            finish();
            resolve(h.onSync ? h.onSync(ack) : ack);
            return;
          }
          run.jobId = jobId;
          h.onAcknowledged?.(ack);
          subscribe(jobId, { ...h, isCurrent: () => isCurrent() && (h.isCurrent?.() ?? true) }, (es) => { run.es = es; })
            .then((value) => { finish(); resolve(value); }, fail);
        } catch (err) {
          fail(err);
        }
      }, (err) => {
        if (!isCurrent()) return;
        onKickoffError?.(err);
        fail(err);
      });
    });
  }, [subscribe, sendCancel]);

  // Resolves true when a run was cancelled (false: nothing owned, so nothing to
  // cancel by id — the caller decides whether a legacy cancel still applies).
  // Rejects, leaving the run and its stream attached, when the server refuses
  // the cancel of an acknowledged job.
  const cancel = useCallback(async () => {
    const run = runRef.current;
    if (!run) return false;
    if (run.jobId) {
      // A repeated click shares the in-flight request instead of racing the
      // queue into a spurious ALREADY_TERMINAL refusal.
      run.cancelPending ||= sendCancel(run.jobId).finally(() => { run.cancelPending = null; });
      await run.cancelPending;
      // The run may have settled (terminal frame, supersede) while the request was in flight.
      if (run.canceled) return true;
      if (runRef.current !== run || run.ended) return false;
      run.canceled = true;
      runRef.current = null;
      retire(run, 'canceled');
      return true;
    }
    run.cancelRequested = true;
    runRef.current = null;
    retire(run, 'canceled');
    return true;
  }, [sendCancel]);

  const dispose = useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    if (run) retire(run, 'detached');
    close();
  }, [close]);
  useEffect(() => dispose, [dispose]);

  return { attach, start, cancel, close, dispose };
}
