import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { importTrackFromYoutube, cancelTrackImport, trackImportEventsUrl } from '../services/apiTracks.js';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress.js';

/**
 * One YouTube-audio-import job slot (#1945) — start/cancel + SSE progress +
 * terminal-frame handling. Call it once per UI surface that can independently
 * kick off an import (e.g. the create form and an existing project's track
 * picker) so two surfaces each own their own job and SSE subscription; a
 * single shared slot would let a second surface's kickoff silently orphan the
 * first surface's in-flight job (its SSE subscription would never re-attach).
 *
 * `onComplete(track, context)` fires once the import lands a Track — `context`
 * is whatever was passed to `start(url, context)`, captured at kickoff time so
 * a slow-finishing job still attaches to the right target even if the caller's
 * own state (e.g. which project is selected) changes while it's in flight.
 */
export default function useYoutubeTrackImport({ onComplete } = {}) {
  const [job, setJob] = useState(null); // { jobId, context }
  // `pending` covers the gap between clicking Import and the kickoff request
  // resolving, when `job` is still null. Without it, `active` (below) would
  // read false during that window, so a fast double-click could fire a
  // second request (the second response's setJob would silently orphan the
  // first job), AND a caller's "block navigation while active" guard
  // (MusicVideo.jsx's selectProject/handleDelete) would let the user switch
  // away/delete before the job even exists to be guarded against.
  const [pending, setPending] = useState(false);
  const sse = useSseProgress(job ? trackImportEventsUrl(job.jobId) : null);
  const percent = Math.round(sse.latest?.percent ?? 0);

  useEffect(() => {
    const frame = sse.latest;
    if (!job || !frame) return;
    if (frame.type === 'complete') {
      onComplete?.(frame.track, job.context);
      toast.success(`Imported "${frame.track.title}" from YouTube`);
      setJob(null);
    } else if (frame.type === 'error') {
      toast.error(frame.error || 'YouTube import failed');
      setJob(null);
    } else if (frame.type === 'canceled' || frame.type === 'cancelled') {
      toast.info('YouTube import cancelled');
      setJob(null);
    }
  }, [sse.latest]);

  // Stream closed without a terminal frame (server restart mid-import, or the
  // job was pruned before/after attach) — recover so the spinner can't hang.
  useEffect(() => {
    if (job && sse.closed && !isTerminalSseFrame(sse.latest)) {
      setJob(null);
      toast.info('Lost connection to the YouTube import — check the music library');
    }
  }, [sse.closed]);

  const start = (url, context) => {
    const trimmed = url.trim();
    if (!trimmed || job || pending) return;
    setPending(true);
    importTrackFromYoutube(trimmed, { silent: true })
      .then(({ jobId }) => setJob({ jobId, context }))
      .catch((err) => toast.error(err?.message || 'Failed to start YouTube import'))
      .finally(() => setPending(false));
  };

  const cancel = () => {
    if (!job) return;
    cancelTrackImport(job.jobId, { silent: true }).catch(() => {});
  };

  return { active: pending || !!job, percent, start, cancel };
}
