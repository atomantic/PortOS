import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  renderMusicVideoProject,
  musicVideoRenderEventsUrl,
  cancelMusicVideoRender,
} from '../services/apiMusicVideo.js';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress.js';

/**
 * The music-video final-render job (#1760, Phase 2): assemble the scene clips
 * over the master audio bed. The kickoff returns a jobId; progress streams over
 * SSE via useSseProgress. One slot per page — a project can only have one final
 * render in flight, and a second kickoff for the same project attaches to the
 * existing job (409 → `err.context.jobId`).
 *
 * `onRendered(projectId, result)` / `onFailed(projectId)` fire on the terminal
 * frame keyed on the projectId captured at kickoff, so a project switch mid-
 * render can't misattribute the result to whatever is selected by then.
 */
export default function useMusicVideoRenderJob({ onRendered, onFailed } = {}) {
  const [job, setJob] = useState(null); // { jobId, projectId } while in flight
  const sse = useSseProgress(job ? musicVideoRenderEventsUrl(job.jobId) : null);
  const progress = job ? Math.round((sse.latest?.progress ?? 0) * 100) : 0;

  // React to terminal SSE frames: record the render on the project, surface the
  // outcome, and clear the in-flight job.
  useEffect(() => {
    const frame = sse.latest;
    if (!job || !frame) return;
    if (frame.type === 'complete') {
      onRendered?.(job.projectId, frame.result || {});
      toast.success('Music video rendered');
      setJob(null);
    } else if (frame.type === 'error') {
      toast.error(frame.error || 'Render failed');
      onFailed?.(job.projectId);
      setJob(null);
    } else if (frame.type === 'canceled' || frame.type === 'cancelled') {
      toast.info('Render cancelled');
      setJob(null);
    }
  }, [sse.latest]);

  // Stream closed on a NON-terminal frame (server restart mid-render, or the job
  // was pruned before/after attach so the 404 closes the stream) — recover so the
  // spinner can't hang. Gating on `!latest` is wrong: `latest` holds the last
  // *progress* frame once any progress streamed, so it would never fire. Mirror
  // VideoTimelineEditor: recover whenever the final frame isn't terminal.
  useEffect(() => {
    if (job && sse.closed && !isTerminalSseFrame(sse.latest)) {
      setJob(null);
      toast.info('Lost connection to the render — check Media History for the result');
    }
  }, [sse.closed]);

  const start = (projectId) => {
    renderMusicVideoProject(projectId, { silent: true })
      .then(({ jobId }) => setJob({ jobId, projectId }))
      .catch((err) => {
        // 409 → a render is already in flight for this project; attach to it.
        if (err?.status === 409 && err?.context?.jobId) {
          setJob({ jobId: err.context.jobId, projectId });
          return;
        }
        toast.error(err?.message || 'Failed to start render');
      });
  };

  const cancel = () => {
    if (!job) return;
    cancelMusicVideoRender(job.jobId, { silent: true }).catch(() => {});
  };

  return { job, progress, start, cancel };
}
