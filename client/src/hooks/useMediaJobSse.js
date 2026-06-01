import { useCallback, useRef } from 'react';
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
 * `onStatus`, `onProgress`, `onComplete`, `onError`, `onCanceled`,
 * `onConnectionError`.
 *
 * `eventSourceRef` is exposed so callers can `close()` on cancel/unmount.
 */
export function useMediaJobSse(kind) {
  const eventSourceRef = useRef(null);

  const close = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const attach = useCallback((jobId, handlers = {}) => {
    const {
      isCurrent = () => true,
      onQueued, onStarted, onStage, onStatus, onProgress,
      onComplete, onError, onCanceled, onConnectionError,
    } = handlers;
    return new Promise((resolve, reject) => {
      const es = new EventSource(`/api/${kind}-gen/${jobId}/events`);
      eventSourceRef.current = es;
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

  return { attach, close, eventSourceRef };
}
