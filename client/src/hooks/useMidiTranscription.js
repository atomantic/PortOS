import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress.js';

/**
 * One audio → MIDI transcription job slot (MuScriptor) — generic over the
 * Rounds and Music Video API surfaces, which share the same kickoff/SSE/cancel
 * job shape (mirroring useReferenceAudioImport). Call it once per UI surface
 * that can independently kick off a transcription so each owns its own job +
 * SSE subscription.
 *
 * `startRequest(context)` performs the feature's kickoff API call and resolves
 * `{ jobId }`; `eventsUrl(jobId)` / `cancelRequest(jobId)` are that feature's
 * SSE URL builder and cancel call. `onComplete(frame, context)` fires on the
 * terminal frame — `frame` carries `{ filename, model, ... }` plus whatever the
 * server merged in (the music video path includes the persisted
 * `midiTranscription`); `context` is whatever was passed to `start(context)`,
 * captured at kickoff so a slow-finishing job still attaches to the right
 * target even if the caller's own state changed while it was in flight.
 */
export default function useMidiTranscription({ startRequest, eventsUrl, cancelRequest, onComplete } = {}) {
  const [job, setJob] = useState(null); // { jobId, context }
  // Covers the gap between clicking Transcribe and the kickoff request
  // resolving, when `job` is still null — without it a fast double-click could
  // fire a second request whose response silently orphans the first job.
  const [pending, setPending] = useState(false);
  const sse = useSseProgress(job ? eventsUrl(job.jobId) : null);
  const latest = sse.latest;
  const stage = latest?.stage ?? null;

  useEffect(() => {
    if (!job || !latest) return;
    if (latest.type === 'complete') {
      onComplete?.(latest, job.context);
      setJob(null);
    } else if (latest.type === 'error') {
      toast.error(latest.error || 'MIDI transcription failed');
      setJob(null);
    } else if (latest.type === 'canceled' || latest.type === 'cancelled') {
      toast.info('MIDI transcription cancelled');
      setJob(null);
    }
  }, [latest]);

  // Stream closed without a terminal frame (server restart mid-transcription,
  // or the job was pruned before/after attach) — recover so the spinner can't hang.
  useEffect(() => {
    if (job && sse.closed && !isTerminalSseFrame(latest)) {
      setJob(null);
      toast.info('Lost connection to the MIDI transcription');
    }
  }, [sse.closed]);

  const start = (context) => {
    if (job || pending) return;
    setPending(true);
    startRequest(context)
      .then(({ jobId }) => setJob({ jobId, context }))
      .catch((err) => toast.error(err?.message || 'Failed to start MIDI transcription'))
      .finally(() => setPending(false));
  };

  const cancel = () => {
    if (!job) return;
    cancelRequest(job.jobId, { silent: true }).catch(() => {});
  };

  // `context` exposes the in-flight job's captured target so a caller can
  // gate per-target UI ("is the active job for THIS record?") without
  // mirroring the value in its own state.
  return { active: pending || !!job, stage, context: job?.context ?? null, start, cancel };
}
