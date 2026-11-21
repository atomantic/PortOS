/**
 * VideoGen's displayed render: SSE presentation state, the reload-resume of an active job, job-scoped Cancel, and the run starter.
 *
 * Use when: The /media/video page owns one render's progress line and status card. Queue
 * submits that bypass SSE stay with the page; `MediaJobsQueue` is their live view.
 */

import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { cancelVideoGen, generateVideo, getActiveVideoJob } from '../services/apiImageVideo.js';
import { useMediaJobSse } from './useMediaJobSse';

/**
 * `onCompleted` refreshes history; `onResumed(job)` replays a resumed job's
 * params into the form. Both are read from the first render's closure on the
 * mount-time resume, as the page always did.
 */
export function useVideoGenRun({ onCompleted, onResumed }) {
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState(null);
  // Live render status (#5872). `phase` is the runner's own STAGE: id, mapped
  // to a named step by the status card — with the queue's own 'queued' as one
  // more phase id, so waiting in line and running share one piece of state
  // instead of a boolean every SSE handler has to remember to clear.
  // `renderStartedAt` drives the elapsed clock, which is what makes a silent
  // phase (an ~89 GB checkpoint streaming onto the GPU) legible as work rather
  // than as a hang.
  const [phase, setPhase] = useState(null);
  const [renderStartedAt, setRenderStartedAt] = useState(null);
  // One run owner for the displayed render: its identity (the acquired OR
  // resumed job), stream, cancellation and unmount detach all live in the hook,
  // so Cancel is job-scoped on both the start and the reload-resume path.
  const { start: startRun, cancel: cancelRun } = useMediaJobSse('video', { cancelJob: cancelVideoGen });

  // Presentation handlers shared by the in-flight POST path and the mount-time
  // resume path. `withToast: false` on resume suppresses the success/error
  // toast — the user already saw it the first time and a page reload
  // shouldn't replay it.
  const videoRunHandlers = (withToast) => {
    return {
      onQueued: (msg) => {
        setPhase('queued');
        setStatusMsg(typeof msg.position === 'number' ? `Queued (position ${msg.position})` : 'Queued');
      },
      onStarted: () => {
        // Out of the queue, but the runner hasn't named a phase yet — clear it
        // rather than guessing, and let the card default to "Loading model".
        setPhase(null);
        // The clock starts HERE, not at submit: time spent waiting in the queue
        // is not render time, and counting it would make the elapsed figure
        // jump backwards on a reload (which reads the worker's own startedAt).
        setRenderStartedAt((at) => at ?? Date.now());
        setStatusMsg('Starting render…');
      },
      // `phase` is presence-guarded on the wire: a frame that carries none must
      // leave the last known phase alone rather than reset the step list to
      // "unknown" on every bare status line.
      onStatus: (msg) => {
        if (msg.phase) setPhase(msg.phase);
        setStatusMsg(msg.message);
      },
      onProgress: (msg) => {
        setProgress({ progress: msg.progress });
        if (msg.phase) setPhase(msg.phase);
        // A bare tqdm percentage shouldn't blank the STATUS line that just
        // preceded it; only overwrite when the progress event carries text.
        if (msg.message) setStatusMsg(msg.message);
      },
      onComplete: () => {
        setGenerating(false);
        setProgress({ progress: 1 });
        setPhase(null);
        setStatusMsg('Complete');
        if (withToast) toast.success('Video generated');
        onCompleted();
      },
      onError: (msg) => {
        setError(msg.error);
        setGenerating(false);
        if (withToast) toast.error(msg.error);
        return new Error(msg.error);
      },
      onCanceled: (msg) => {
        setGenerating(false);
        setPhase(null);
        setStatusMsg(msg.reason || 'Canceled');
        if (withToast) toast(msg.reason || 'Render canceled');
        return new Error(msg.reason || 'Canceled');
      },
      onConnectionError: () => {
        setError('Lost connection to server');
        setGenerating(false);
      },
    };
  };

  // Resume an in-flight (or queued) render so a page reload doesn't lose
  // the progress line next to Generate. Server holds the job's last SSE payload,
  // so re-attaching replays the most recent status/progress immediately.
  // Mirrors the ImageGen `getActiveImageJob` mount path.
  useEffect(() => {
    // `ifIdle`: bail when the user already started a render in this tab. The
    // owner also drops this run if one starts while the read is in flight, and
    // creates no stream (or presentation) if the page unmounts first — the
    // accepted job stays durable for the next resume.
    startRun(
      () => getActiveVideoJob().then((data) => data?.activeJob),
      {
        ...videoRunHandlers(false),
        onAcknowledged: (job) => {
          onResumed(job);
          setGenerating(true);
          setPhase(job.status === 'queued' ? 'queued' : null);
          // The worker's own start time, so a reload keeps a truthful elapsed clock
          // instead of restarting it and reading as a fresh render. A job still in
          // the queue has no start time yet and gets no clock — the same rule the
          // live path follows.
          setRenderStartedAt(job.startedAt ? new Date(job.startedAt).getTime() : null);
          // Skip a forced setProgress(0) here — the stream replays the server's
          // last SSE payload right after open, and a job mid-render would
          // otherwise visibly flash 0% before jumping back to its real progress.
          setStatusMsg(job.status === 'queued'
            ? (typeof job.position === 'number' ? `Queued (position ${job.position})` : 'Queued')
            : 'Resuming…');
        },
      },
      { ifIdle: true, jobIdOf: (job) => job?.jobId },
    ).catch(() => {});
  }, []);

  // Run a single payload through the SSE pipeline. Returns a promise that
  // resolves when the job completes (or rejects on error / cancel). The
  // separate queue-submit path deliberately does not attach SSE: the shared
  // MediaJobsQueue is the live view for work submitted in parallel.
  //
  // The run owner (useMediaJobSse) holds the abort/identity bookkeeping: Cancel
  // pressed between the POST and its acknowledgement cancels the eventual job
  // by id without opening a stream, and an unmount detaches without one.
  const runGeneration = (payload) => {
    setGenerating(true);
    setProgress({ progress: 0 });
    setStatusMsg('Starting...');
    setError(null);
    // Stale-job isolation: the previous run's phase and clock must not be shown
    // as if they belonged to this one. The clock stays null until `started`
    // lands, so it measures the render rather than the queue wait.
    setPhase(null);
    setRenderStartedAt(null);
    return startRun(() => generateVideo(payload), videoRunHandlers(true), {
      onKickoffError: (err) => {
        setError(err.message || 'Video generation failed');
        setGenerating(false);
        toast.error(err.message || 'Video generation failed');
      },
    });
  };

  const handleCancel = async () => {
    // Cancel targets only the run this page owns — started here or resumed
    // after a reload. With nothing owned there is no job id to name, and an
    // unscoped cancel could kill an unrelated parallel render.
    // A refused cancel (job already finishing, or unknown) leaves the run and
    // its stream attached, so only a server-accepted cancel reads as Cancelled.
    const refused = await cancelRun().then(() => false, (err) => {
      toast.error(err.message || 'Cancel failed');
      return true;
    });
    if (refused) return;
    setGenerating(false);
    setStatusMsg('Cancelled');
  };

  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;

  return { generating, progressPct, statusMsg, error, phase, renderStartedAt, runGeneration, handleCancel };
}

export default useVideoGenRun;
