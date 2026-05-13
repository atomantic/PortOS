import { useEffect, useRef, useState } from 'react';
import { pipelineAutoRunSseUrl } from '../services/api';

/**
 * Subscribe to the auto-run-text SSE stream for a pipeline issue. Returns the
 * stream of progress frames as `frames` (in order) and a `latest` convenience
 * pointer. The hook tears down the EventSource on unmount or when the issueId
 * changes.
 *
 * Frame shapes (see server/services/pipeline/autoRunner.js#broadcast):
 *   { type: 'start',          runId, stages }
 *   { type: 'stage:start',    stage }
 *   { type: 'stage:complete', stage, status, length }
 *   { type: 'skip',           stage, reason }
 *   { type: 'complete',       runId, completedAt }
 *   { type: 'canceled',       runId, completedAt }
 *   { type: 'error',          runId, error, failedAt }
 */
export function usePipelineAutoRunProgress(issueId, { enabled = true } = {}) {
  const [frames, setFrames] = useState([]);
  const [latest, setLatest] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    if (!issueId || !enabled) return undefined;
    setFrames([]);
    setLatest(null);
    setIsOpen(false);

    const url = pipelineAutoRunSseUrl(issueId);
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setIsOpen(true);
    es.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      setFrames((prev) => [...prev, data]);
      setLatest(data);
      if (data?.type === 'complete' || data?.type === 'canceled' || data?.type === 'error') {
        // Server closes the stream after the cleanup window. Drop the client
        // ourselves so the browser doesn't keep retrying.
        es.close();
      }
    };
    es.onerror = () => {
      // EventSource auto-retries on transient disconnects; only mark closed
      // when readyState is CLOSED (terminal).
      if (es.readyState === EventSource.CLOSED) setIsOpen(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [issueId, enabled]);

  return { frames, latest, isOpen, close: () => esRef.current?.close() };
}
