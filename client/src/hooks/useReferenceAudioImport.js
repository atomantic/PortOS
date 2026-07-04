import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  importReferenceAudio,
  cancelReferenceAudioImport,
  referenceAudioImportEventsUrl,
} from '../services/apiRounds.js';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress.js';

/**
 * One round reference-audio-import job slot (#2120) — download + extract a
 * reference's audio from a URL via yt-dlp into the uploads dir, streaming SSE
 * progress. The deferred convenience path from the reference-audio analysis
 * feature (#2106); upload/mic capture remain the primary attach paths.
 *
 * Mirrors `useYoutubeTrackImport`: call it once per UI surface that can
 * independently kick off an import so each owns its own job + SSE subscription
 * (a shared slot would let a second kickoff orphan the first's in-flight job).
 *
 * `onComplete(filename, context)` fires once the download lands a file in the
 * uploads dir — `context` is whatever was passed to `start(url, context)`,
 * captured at kickoff so a slow-finishing job still attaches to the right
 * target even if the caller's own state changed while it was in flight.
 */
export default function useReferenceAudioImport({ onComplete } = {}) {
  const [job, setJob] = useState(null); // { jobId, context }
  // `pending` covers the gap between clicking Download and the kickoff request
  // resolving, when `job` is still null — without it a fast double-click could
  // fire a second request whose response silently orphans the first job.
  const [pending, setPending] = useState(false);
  const sse = useSseProgress(job ? referenceAudioImportEventsUrl(job.jobId) : null);
  const latest = sse.latest;
  const percent = Math.round(latest?.percent ?? 0);
  const stage = latest?.stage ?? null;

  useEffect(() => {
    if (!job || !latest) return;
    if (latest.type === 'complete') {
      onComplete?.(latest.filename, job.context);
      toast.success('Reference audio downloaded — Save the song to keep it');
      setJob(null);
    } else if (latest.type === 'error') {
      toast.error(latest.error || 'Reference audio download failed');
      setJob(null);
    } else if (latest.type === 'canceled' || latest.type === 'cancelled') {
      toast.info('Reference audio download cancelled');
      setJob(null);
    }
  }, [latest]);

  // Stream closed without a terminal frame (server restart mid-download, or the
  // job was pruned before/after attach) — recover so the spinner can't hang.
  useEffect(() => {
    if (job && sse.closed && !isTerminalSseFrame(latest)) {
      setJob(null);
      toast.info('Lost connection to the reference-audio download');
    }
  }, [sse.closed]);

  const start = (url, context) => {
    const trimmed = (url || '').trim();
    if (!trimmed || job || pending) return;
    setPending(true);
    importReferenceAudio(trimmed, { silent: true })
      .then(({ jobId }) => setJob({ jobId, context }))
      .catch((err) => toast.error(err?.message || 'Failed to start reference-audio download'))
      .finally(() => setPending(false));
  };

  const cancel = () => {
    if (!job) return;
    cancelReferenceAudioImport(job.jobId, { silent: true }).catch(() => {});
  };

  return { active: pending || !!job, percent, stage, start, cancel };
}
