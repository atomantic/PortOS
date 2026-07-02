import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { startVideoDownload, cancelVideoDownload, videoDownloadEventsUrl } from '../services/apiVideoDownload.js';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress.js';

/**
 * One full-video-download job slot (#1946) — start/cancel + SSE progress +
 * terminal-frame handling via `POST /api/devtools/video-download`. Mirrors
 * useYoutubeTrackImport (#1945): kick off returns a jobId, progress streams over
 * SSE, and terminal frames drive completion. `onComplete(video)` fires once the
 * download lands a video-history entry so the caller can prepend it to its list
 * without a full refetch.
 */
export default function useVideoDownload({ onComplete } = {}) {
  const [job, setJob] = useState(null); // { jobId }
  // `pending` covers the gap between clicking Download and the kickoff request
  // resolving, when `job` is still null — without it a fast double-click could
  // fire a second request whose response silently orphans the first job.
  const [pending, setPending] = useState(false);
  const sse = useSseProgress(job ? videoDownloadEventsUrl(job.jobId) : null);
  const percent = Math.round(sse.latest?.percent ?? 0);
  const stage = sse.latest?.stage || null;

  useEffect(() => {
    const frame = sse.latest;
    if (!job || !frame) return;
    if (frame.type === 'complete') {
      onComplete?.(frame.video);
      toast.success(`Downloaded "${frame.video?.title || 'video'}"`);
      setJob(null);
    } else if (frame.type === 'error') {
      toast.error(frame.error || 'Video download failed');
      setJob(null);
    } else if (frame.type === 'canceled' || frame.type === 'cancelled') {
      toast.info('Video download cancelled');
      setJob(null);
    }
  }, [sse.latest]);

  // Stream closed without a terminal frame (server restart mid-download, or the
  // job was pruned before/after attach) — recover so the progress UI can't hang.
  useEffect(() => {
    if (job && sse.closed && !isTerminalSseFrame(sse.latest)) {
      setJob(null);
      toast.info('Lost connection to the download — check the list below');
    }
  }, [sse.closed]);

  const start = (url) => {
    const trimmed = (url || '').trim();
    if (!trimmed || job || pending) return;
    setPending(true);
    startVideoDownload(trimmed, { silent: true })
      .then(({ jobId }) => setJob({ jobId }))
      .catch((err) => toast.error(err?.message || 'Failed to start download'))
      .finally(() => setPending(false));
  };

  const cancel = () => {
    if (!job) return;
    cancelVideoDownload(job.jobId, { silent: true }).catch(() => {});
  };

  return { active: pending || !!job, percent, stage, start, cancel };
}
