import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress.js';
import useMounted from './useMounted.js';

const defaultReadPercent = (frame) => frame.percent;

/**
 * One single-slot SSE job: kickoff, captured target, progress and terminal
 * recovery. Reserve the slot synchronously, including the preparation window
 * before the server returns a jobId. Each independent surface owns one slot.
 *
 * Options:
 * - `startRequest(startArg)` → resolves `{ jobId }` — the feature's kickoff call.
 * - `eventsUrl(jobId)` / `cancelRequest(jobId, { silent })` — SSE URL + cancel call.
 * - `onSettled(reason, context)` — refresh saved state on success, failure, cancellation or disconnect.
 * - `onComplete(frame, context)` — fires on the terminal `complete` frame.
 * - `context` (the second `start` arg, or the start arg itself when omitted) is
 *   captured and exposed immediately at kickoff, including while `pending`.
 * - `trimStartArg` — trims URL input and ignores an empty start when true.
 * - `readPercent(frame)` — optional projection to 0–100 (default: frame.percent).
 *   Missing/non-finite values preserve the last reported progress.
 * - `successToast(frame)` — optional; toast.success its return when truthy.
 * - `errorFallback` / `canceledMessage` / `lostConnectionMessage` /
 *   `startErrorFallback` — the per-feature toast copy.
 * - `onErrorFrame(frame, context)` → return true to suppress the error toast.
 * - `onKickoffError(err, startArg)` → return true to suppress the kickoff toast.
 * - `onKickoffSuccess(jobId, startArg)` — fires when the kickoff resolves.
 *
 * `attach(jobId, context)` adopts a job some OTHER request already started
 * (e.g. a workflow step whose response carried the jobId) into the idle slot,
 * so it gets the same progress, terminal and cancel handling. Returns false
 * when the slot is busy.
 */
export default function useSseJobSlot({
  startRequest,
  eventsUrl,
  cancelRequest,
  onComplete,
  trimStartArg = false,
  readPercent = defaultReadPercent,
  successToast,
  errorFallback = 'Job failed',
  canceledMessage = 'Job cancelled',
  lostConnectionMessage = 'Lost connection to the job',
  startErrorFallback = 'Failed to start the job',
  onErrorFrame,
  onKickoffError,
  onKickoffSuccess,
  onSettled,
} = {}) {
  // jobId is null during preparation; context already owns the target then.
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState({ percent: 0, stage: null });
  const slotRef = useRef(null);
  const mounted = useMounted();
  useEffect(() => () => { slotRef.current = null; }, []);
  const jobUrl = job?.jobId ? eventsUrl(job.jobId) : null;
  const sse = useSseProgress(jobUrl);
  const latest = sse.latest;
  const percent = latest ? readPercent(latest) : undefined;

  const clearJob = () => {
    slotRef.current = null;
    setJob(null);
  };

  // Sparse metadata/warning frames preserve progress. A known mismatched URL
  // belongs to an older stream; absent URL identity remains tolerated for the
  // existing SSE test seams.
  useEffect(() => {
    if (!job?.jobId || !latest) return;
    if (sse.latestUrl && sse.latestUrl !== jobUrl) return;
    setProgress((prev) => ({
      percent: Number.isFinite(percent) ? Math.round(percent) : prev.percent,
      stage: typeof latest.stage === 'string' && latest.stage ? latest.stage : prev.stage,
    }));
  }, [latest, job, jobUrl, sse.latestUrl, percent]);

  useEffect(() => {
    if (!job?.jobId || !latest) return;
    if (sse.latestUrl && sse.latestUrl !== jobUrl) return;
    if (['complete', 'error', 'canceled', 'cancelled'].includes(latest.type)) onSettled?.(latest.type, job.context);
    if (latest.type === 'complete') {
      clearJob();
      // Completion follow-ups may throw synchronously or return a rejected
      // promise. Own both failures after releasing the slot.
      const finish = async () => {
        try {
          await onComplete?.(latest, job.context);
          const msg = successToast?.(latest);
          if (msg) toast.success(msg);
        } catch (err) {
          console.error(`❌ Job completion follow-up failed: ${err?.message || 'Unknown error'}`);
          toast.error('Finished, but the page could not update — reload to see the result');
        }
      };
      void finish();
    } else if (latest.type === 'error') {
      clearJob();
      if (!onErrorFrame?.(latest, job.context)) {
        toast.error(latest.error || errorFallback);
      }
    } else if (latest.type === 'canceled' || latest.type === 'cancelled') {
      clearJob();
      toast.info(canceledMessage);
    }
  }, [latest, sse.latestUrl]);

  useEffect(() => {
    if (job?.jobId && sse.closed && !isTerminalSseFrame(latest)) {
      if (sse.latestUrl && sse.latestUrl !== jobUrl) return;
      const context = job.context;
      clearJob();
      onSettled?.('disconnected', context);
      toast.info(lostConnectionMessage);
    }
  }, [sse.closed]);

  const start = (startArg, context) => {
    const arg = trimStartArg ? (startArg ?? '').trim() : startArg;
    if (trimStartArg && !arg) return;
    if (!mounted.current || slotRef.current) return;
    const slot = { jobId: null, context: context === undefined ? arg : context };
    slotRef.current = slot;
    setJob(slot);
    setProgress({ percent: 0, stage: null });
    const isCurrent = () => mounted.current && slotRef.current === slot;
    startRequest(arg)
      .then(({ jobId }) => {
        if (!isCurrent()) return;
        onKickoffSuccess?.(jobId, arg);
        setJob({ jobId, context: slot.context });
      })
      .catch((err) => {
        if (!isCurrent()) return;
        clearJob();
        if (onKickoffError?.(err, arg)) return;
        toast.error(err?.message || startErrorFallback);
      });
  };

  const attach = (jobId, context) => {
    if (!jobId || !mounted.current || slotRef.current) return false;
    const slot = { jobId, context: context ?? null };
    slotRef.current = slot;
    setJob(slot);
    setProgress({ percent: 0, stage: null });
    return true;
  };

  const cancel = () => {
    if (!mounted.current || !job?.jobId) return;
    cancelRequest(job.jobId, { silent: true }).catch(() => {});
  };

  return {
    active: !!job,
    connected: sse.isOpen,
    pending: !!job && !job.jobId,
    jobId: job?.jobId ?? null,
    percent: progress.percent,
    stage: progress.stage,
    // Most recent frame for THIS job (null until one arrives) — for features
    // that render counts the percent projection can't carry.
    latest: job?.jobId ? latest : null,
    context: job?.context ?? null,
    start,
    attach,
    cancel,
  };
}
