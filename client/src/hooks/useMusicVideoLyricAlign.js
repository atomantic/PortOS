import { useEffect, useRef } from 'react';
import toast from '../components/ui/Toast';
import useSseJobSlot from './useSseJobSlot.js';
import {
  alignMusicVideoLyrics,
  musicVideoLyricAlignEventsUrl,
  cancelMusicVideoLyricAlign,
} from '../services/apiMusicVideo.js';

/** Human label for the alignment job's current progress frame. */
export function lyricAlignStageLabel(frame) {
  switch (frame?.stage) {
    case 'installing': return frame.detail || 'Installing the alignment runtime…';
    case 'separating': return 'Separating vocals with Demucs…';
    case 'emissions': return 'Reading the vocal with MMS_FA…';
    case 'aligning': return 'Aligning the lyric text with CTC…';
    case 'decoding': return 'Decoding the song…';
    case 'loading-model': return 'Loading the speech model…';
    case 'downloading-model': return 'Downloading the speech model (first run only)…';
    case 'transcribing': return frame.total > 1 ? `Transcribing phrase ${frame.current} of ${frame.total}…` : 'Transcribing…';
    case 'saving': return 'Saving word timings…';
    case 'analyzing': return 'Analyzing the new song…';
    case 'remapping': return 'Moving the shots to the new song…';
    default: return 'Starting…';
  }
}

/**
 * Lyric word alignment (#10155) as one SSE job slot. `run(projectId, cueId?)`
 * starts the job as a promise for the page handlers and the autopilot kickoff — it resolves with the updated
 * project, null when cancelled or the stream dropped, and rejects with the
 * server's message on failure so the panel beside the button can show it. A
 * job reattached after a reload has no waiter, so its failure toasts instead.
 * `attach(jobId, projectId)` adopts a running job. `onAligned(projectId, project)`
 * fires on success. The slot `context` is `{ projectId, cueId }`.
 */
export default function useMusicVideoLyricAlign({ onAligned } = {}) {
  const waiter = useRef(null);
  const settle = (fn) => {
    const pending = waiter.current;
    waiter.current = null;
    if (pending) fn(pending);
  };
  const slot = useSseJobSlot({
    startRequest: ({ projectId, cueId, separateVocals, retimeSong }) => alignMusicVideoLyrics(projectId, {
      ...(cueId ? { cueId } : {}), ...(separateVocals ? { separateVocals: true } : {}), ...(retimeSong ? { retimeSong: true } : {}),
    }, { silent: true }),
    eventsUrl: musicVideoLyricAlignEventsUrl,
    cancelRequest: cancelMusicVideoLyricAlign,
    onComplete: (frame, { projectId, cueId, retimeSong }) => {
      if (frame.project) onAligned?.(projectId, frame.project);
      toast.success(cueId ? 'Re-aligned that line' : retimeSong ? 'Re-timed lyrics and shots to the new song' : 'Aligned words to the vocal');
      settle((pending) => pending.resolve(frame.project || null));
    },
    errorFallback: 'Could not align the words to the vocal',
    canceledMessage: 'Lyric alignment cancelled',
    lostConnectionMessage: 'Lost connection to the lyric alignment',
    onErrorFrame: (frame) => {
      if (!waiter.current) return false;
      settle((pending) => pending.reject(new Error(frame.error || 'Could not align the words to the vocal. Try Align words again.')));
      return true;
    },
    onKickoffError: (err) => {
      if (!waiter.current) return false;
      settle((pending) => pending.reject(err));
      return true;
    },
  });

  // Cancel and a dropped stream clear the slot without a callback; release
  // whoever is waiting on it.
  useEffect(() => {
    if (!slot.active && waiter.current?.started) settle((pending) => pending.resolve(null));
    if (slot.active && waiter.current) waiter.current.started = true;
  }, [slot.active]);
  useEffect(() => () => settle((pending) => pending.resolve(null)), []);

  const run = (projectId, cueId = null, { separateVocals = false, retimeSong = false } = {}) => new Promise((resolve, reject) => {
    if (slot.active) { resolve(null); return; }
    waiter.current = { resolve, reject, started: false };
    slot.start({ projectId, cueId, ...(separateVocals ? { separateVocals } : {}), ...(retimeSong ? { retimeSong } : {}) });
  });

  return {
    ...slot,
    stageLabel: slot.active ? lyricAlignStageLabel(slot.latest) : null,
    run,
    attach: (jobId, projectId) => slot.attach(jobId, { projectId, cueId: null }),
  };
}
