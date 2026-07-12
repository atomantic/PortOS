import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress.js';

/**
 * One generic single-slot SSE job — the shared machinery every "kick off a job,
 * stream progress over SSE, settle on the terminal frame" hook re-implements:
 *
 *  - `pending` covers the gap between clicking Start and the kickoff request
 *    resolving, when `job` is still null — without it a fast double-click could
 *    fire a second request whose response silently orphans the first job.
 *  - the terminal-frame effect (`complete` / `error` / `canceled|cancelled`),
 *  - the `sse.closed`-without-a-terminal-frame recovery (server restart mid-job,
 *    or the job was pruned before/after attach) so the spinner can't hang.
 *
 * Call it once per UI surface that can independently kick off a job so each owns
 * its own job + SSE subscription — a shared slot would let a second kickoff
 * orphan the first's in-flight job (its SSE subscription would never re-attach).
 *
 * The three feature hooks (`useReferenceAudioImport`, `useYoutubeTrackImport`,
 * `useVideoDownload`) and `useMidiTranscription` are thin wrappers over this;
 * the recovery + terminal-frame logic lives here in exactly one place (#2368).
 *
 * Options:
 * - `startRequest(startArg)` → resolves `{ jobId }` — the feature's kickoff call.
 * - `eventsUrl(jobId)` / `cancelRequest(jobId, { silent })` — SSE URL + cancel call.
 * - `onComplete(frame, context)` — fires on the terminal `complete` frame.
 * - `context` (the second `start` arg, or the start arg itself when omitted) is
 *   captured at kickoff so a slow-finishing job still attaches to the right
 *   target even if the caller's own state changed while it was in flight.
 * - `trimStartArg` — when true, `start(url, context)` trims `url` and no-ops on
 *   empty (the URL-import hooks); when false, `start(context)` passes through.
 * - `successToast(frame)` — optional; toast.success its return when truthy.
 * - `errorFallback` / `canceledMessage` / `lostConnectionMessage` /
 *   `startErrorFallback` — the per-feature toast copy.
 * - `onErrorFrame(frame, context)` → return true to suppress the default error
 *   toast (the MIDI gated-repo prompt intercepts here).
 * - `onKickoffError(err, startArg)` → return true to suppress the default kickoff
 *   error toast (the MIDI first-use install gate intercepts here).
 * - `onKickoffSuccess(jobId, startArg)` — fires when the kickoff resolves.
 */
export default function useSseJobSlot({
  startRequest,
  eventsUrl,
  cancelRequest,
  onComplete,
  trimStartArg = false,
  successToast,
  errorFallback = 'Job failed',
  canceledMessage = 'Job cancelled',
  lostConnectionMessage = 'Lost connection to the job',
  startErrorFallback = 'Failed to start the job',
  onErrorFrame,
  onKickoffError,
  onKickoffSuccess,
} = {}) {
  const [job, setJob] = useState(null); // { jobId, context }
  const [pending, setPending] = useState(false);
  const sse = useSseProgress(job ? eventsUrl(job.jobId) : null);
  const latest = sse.latest;
  const percent = Math.round(latest?.percent ?? 0);
  const stage = latest?.stage ?? null;

  useEffect(() => {
    if (!job || !latest) return;
    if (latest.type === 'complete') {
      onComplete?.(latest, job.context);
      const msg = successToast?.(latest);
      if (msg) toast.success(msg);
      setJob(null);
    } else if (latest.type === 'error') {
      if (!onErrorFrame?.(latest, job.context)) {
        toast.error(latest.error || errorFallback);
      }
      setJob(null);
    } else if (latest.type === 'canceled' || latest.type === 'cancelled') {
      toast.info(canceledMessage);
      setJob(null);
    }
  }, [latest]);

  // Stream closed without a terminal frame — recover so the spinner can't hang.
  useEffect(() => {
    if (job && sse.closed && !isTerminalSseFrame(latest)) {
      setJob(null);
      toast.info(lostConnectionMessage);
    }
  }, [sse.closed]);

  const start = (startArg, context) => {
    const arg = trimStartArg ? (startArg ?? '').trim() : startArg;
    if (trimStartArg && !arg) return;
    if (job || pending) return;
    setPending(true);
    startRequest(arg)
      .then(({ jobId }) => {
        onKickoffSuccess?.(jobId, arg);
        setJob({ jobId, context: context === undefined ? arg : context });
      })
      .catch((err) => {
        if (onKickoffError?.(err, arg)) return;
        toast.error(err?.message || startErrorFallback);
      })
      .finally(() => setPending(false));
  };

  const cancel = () => {
    if (!job) return;
    cancelRequest(job.jobId, { silent: true }).catch(() => {});
  };

  return {
    active: pending || !!job,
    percent,
    stage,
    context: job?.context ?? null,
    start,
    cancel,
  };
}
