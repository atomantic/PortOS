import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import useSseJobSlot from './useSseJobSlot.js';

// Human labels for the MuScriptor sidecar's STAGE names (SSE progress frames).
// Shared by every surface that shows a transcription's progress (Rounds +
// Music Video) so the phrasing stays in one place. `download-model` is the
// first-use weight download the sidecar reports distinctly from a cached
// `load-model` load — the difference between a multi-minute wait and a quick
// one, so it gets its own label + a one-time toast (below).
export const MIDI_STAGE_LABELS = Object.freeze({
  starting: 'Starting…',
  'import-runtime': 'Loading runtime…',
  'download-model': 'Downloading model…',
  'load-model': 'Loading model…',
  transcribe: 'Transcribing…',
  'write-midi': 'Writing MIDI…',
  importing: 'Saving…',
});

export const midiStageLabel = (stage) => MIDI_STAGE_LABELS[stage] || 'Transcribing…';

/**
 * One audio → MIDI transcription job slot (MuScriptor) — generic over the
 * Rounds and Music Video API surfaces, which share the same kickoff/SSE/cancel
 * job shape. A thin wrapper over the generic `useSseJobSlot` (#2368) that adds
 * MuScriptor's two first-use modals (runtime install + gated-repo token). Call
 * it once per UI surface that can independently kick off a transcription so each
 * owns its own job + SSE subscription.
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

  const slot = useSseJobSlot({
    startRequest,
    eventsUrl,
    cancelRequest,
    onComplete,
    errorFallback: 'MIDI transcription failed',
    canceledMessage: 'MIDI transcription cancelled',
    lostConnectionMessage: 'Lost connection to the MIDI transcription',
    startErrorFallback: 'Failed to start MIDI transcription',
    // Runtime is present — reset the loop guard on a successful kickoff.
    onKickoffSuccess: () => { installAttemptedRef.current = false; },
    // The runtime isn't provisioned yet: install it in-app on first use, then
    // re-run the transcription for the same target. Only auto-open once — a
    // second miss after a "successful" install is a real fault, so let the
    // default toast surface it instead of relooping the installer.
    onKickoffError: (err, context) => {
      if (err?.code === 'MIDI_RUNTIME_MISSING' && !installAttemptedRef.current) {
        installAttemptedRef.current = true;
        setInstallContext(context);
        return true;
      }
      return false;
    },
    // Gated-repo download failure — open the license + token prompt instead of
    // toasting a raw HuggingFace traceback the user can't act on.
    onErrorFrame: (frame, context) => {
      if (frame.code === 'gated_repo') {
        setGatedContext({ context, repo: frame.repo || null });
        return true;
      }
      return false;
    },
  });

  // First-use weight download is the slow part — the sidecar reports it as a
  // distinct `download-model` stage. Fire a one-time toast when it begins so
  // the user is told "we're downloading the model" instead of watching an
  // unexplained multi-minute spinner (the button label alone is easy to miss).
  // Re-arm once the job settles so a later cold-cache size re-toasts.
  const downloadToastedRef = useRef(false);
  useEffect(() => {
    if (!slot.active) { downloadToastedRef.current = false; return; }
    if (slot.stage === 'download-model' && !downloadToastedRef.current) {
      downloadToastedRef.current = true;
      toast.info('Downloading the MuScriptor model — first use only, this can take a few minutes.');
    }
  }, [slot.active, slot.stage]);

  const start = (context) => {
    if (installContext !== null || gatedContext !== null) return;
    slot.start(context);
  };

  // Installer modal wiring — spread onto <MidiInstallModal>. Completing the
  // install re-fires the captured transcription (via `slot.start` directly, so
  // the retry isn't swallowed by this render's not-yet-cleared installContext);
  // closing it (user cancel) clears the pending target and resets the loop
  // guard so a later click can retry the install cleanly.
  const installGate = {
    open: installContext !== null,
    onComplete: () => {
      const ctx = installContext;
      setInstallContext(null);
      if (ctx !== null) slot.start(ctx);
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
      if (ctx !== null) slot.start(ctx);
    },
    onClose: () => setGatedContext(null),
  };

  // `context` exposes the in-flight job's captured target so a caller can
  // gate per-target UI ("is the active job for THIS record?") without
  // mirroring the value in its own state.
  return {
    active: slot.active || installContext !== null || gatedContext !== null,
    stage: slot.stage,
    // Ready-to-render human label for the current stage (defaults to
    // "Transcribing…") so surfaces don't each re-map the STAGE names.
    stageLabel: midiStageLabel(slot.stage),
    context: slot.context,
    start,
    cancel: slot.cancel,
    installGate,
    gatedGate,
  };
}
