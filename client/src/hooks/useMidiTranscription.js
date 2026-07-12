import { useEffect, useRef, useState } from 'react';
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
  // First-use runtime install (MuScriptor). When the kickoff returns a 503
  // MIDI_RUNTIME_MISSING, we open an in-app installer modal instead of dead-
  // ending on a "run this shell command" toast (mirrors the image/video model
  // runtime installers), then re-run the transcription once the install
  // completes. `installContext` doubles as the open flag AND the captured
  // target: non-null means the installer is open for that target, null closed.
  const [installContext, setInstallContext] = useState(null);
  // Guard against a reopen loop: if a transcription 503s again right after an
  // install reported success, fall back to the hint toast instead of looping
  // the modal open.
  const installAttemptedRef = useRef(false);
  // Gated-repo gate (MuScriptor's weights live in a gated HuggingFace repo). A
  // transcribe with no accepted license / token streams a `gated_repo` error
  // frame; we open a license + token-entry modal (mirroring the image-model
  // gated flow) instead of dead-ending on a raw-traceback toast, then re-run
  // the captured transcription once a token is saved. Non-null = open for that
  // target; `{ context, repo }`.
  const [gatedContext, setGatedContext] = useState(null);
  const sse = useSseProgress(job ? eventsUrl(job.jobId) : null);
  const latest = sse.latest;
  const stage = latest?.stage ?? null;

  useEffect(() => {
    if (!job || !latest) return;
    if (latest.type === 'complete') {
      onComplete?.(latest, job.context);
      setJob(null);
    } else if (latest.type === 'error') {
      // Gated-repo download failure — open the license + token prompt instead
      // of toasting a raw HuggingFace traceback the user can't act on.
      if (latest.code === 'gated_repo') {
        setGatedContext({ context: job.context, repo: latest.repo || null });
      } else {
        toast.error(latest.error || 'MIDI transcription failed');
      }
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

  // The actual kickoff, shared by the user click (`start`) and the post-install
  // retry (`installGate.onComplete`). Kept free of the install-open gate so the
  // retry — fired synchronously right after clearing installContext, before the
  // re-render commits it — isn't swallowed by a stale closure value.
  const kickoff = (context) => {
    if (job || pending) return;
    setPending(true);
    startRequest(context)
      .then(({ jobId }) => {
        installAttemptedRef.current = false; // runtime is present — reset the loop guard
        setJob({ jobId, context });
      })
      .catch((err) => {
        // The runtime isn't provisioned yet: install it in-app on first use,
        // then re-run the transcription for the same target. Only auto-open
        // once — a second miss after a "successful" install is a real fault, so
        // surface the message instead of relooping the installer.
        if (err?.code === 'MIDI_RUNTIME_MISSING' && !installAttemptedRef.current) {
          installAttemptedRef.current = true;
          setInstallContext(context);
          return;
        }
        toast.error(err?.message || 'Failed to start MIDI transcription');
      })
      .finally(() => setPending(false));
  };

  const start = (context) => {
    if (job || pending || installContext !== null || gatedContext !== null) return;
    kickoff(context);
  };

  const cancel = () => {
    if (!job) return;
    cancelRequest(job.jobId, { silent: true }).catch(() => {});
  };

  // Installer modal wiring — spread onto <MidiInstallModal>. Completing the
  // install re-fires the captured transcription; closing it (user cancel)
  // clears the pending target and resets the loop guard so a later click can
  // retry the install cleanly.
  const installGate = {
    open: installContext !== null,
    onComplete: () => {
      const ctx = installContext;
      setInstallContext(null);
      if (ctx !== null) kickoff(ctx);
    },
    onClose: () => {
      setInstallContext(null);
      installAttemptedRef.current = false;
    },
  };

  // Gated-repo modal wiring — spread onto <MidiGatedModal>. Saving a token
  // re-fires the captured transcription (the license may still be unaccepted,
  // in which case it 403s and the modal reopens — each reopen needs a fresh
  // Save click, so there's no runaway loop). Closing clears the target.
  const gatedGate = {
    open: gatedContext !== null,
    repo: gatedContext?.repo ?? null,
    onSaved: () => {
      const ctx = gatedContext?.context ?? null;
      setGatedContext(null);
      if (ctx !== null) kickoff(ctx);
    },
    onClose: () => setGatedContext(null),
  };

  // `context` exposes the in-flight job's captured target so a caller can
  // gate per-target UI ("is the active job for THIS record?") without
  // mirroring the value in its own state.
  return {
    active: pending || !!job || installContext !== null || gatedContext !== null,
    stage,
    context: job?.context ?? null,
    start,
    cancel,
    installGate,
    gatedGate,
  };
}
