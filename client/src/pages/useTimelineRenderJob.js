import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import { cancelTimelineRender, renderTimelineProject } from '../services/apiImageVideo.js';
import { useSseProgress, isTerminalSseFrame } from '../hooks/useSseProgress';

export function useTimelineRenderJob({ projectId, hasSegments, flushForRender, navigate }) {
  const [renderJob, setRenderJob] = useState(null);
  const renderJobId = renderJob && renderJob.projectId === projectId ? renderJob.id : null;
  const [cancelingJobId, setCancelingJobId] = useState(null);
  const cancelRequest = useRef(null);

  useEffect(() => {
    setCancelingJobId(null);
    return () => {
      cancelRequest.current?.abort();
      cancelRequest.current = null;
    };
  }, [renderJobId]);

  const handleRender = async () => {
    if (!hasSegments) {
      toast.error('Add at least one clip before rendering');
      return;
    }
    // Flush any pending PATCH so the server-side render reads the latest
    // layout. If the save fails (conflict, network), abort — otherwise we'd
    // render a stale server-side timeline while the UI shows fresh edits.
    const saved = await flushForRender();
    if (!saved) return;
    const result = await renderTimelineProject(projectId, { silent: true }).catch((err) => {
      if (err.code === 'RENDER_IN_PROGRESS') {
        const jobId = err.context?.jobId;
        if (jobId) {
          setRenderJob({ id: jobId, projectId });
          toast('Re-attaching to in-flight render');
        } else {
          toast(err.message);
        }
        return null;
      }
      if (err.code === 'MISSING_CLIPS') {
        const gone = [...(err.context?.missingClipIds || []), ...(err.context?.missingAssets || [])];
        toast.error(`Render failed — ${gone.length} missing source${gone.length === 1 ? '' : 's'}`);
        return null;
      }
      toast.error(`Render failed: ${err.message}`);
      return null;
    });
    if (result?.jobId) setRenderJob({ id: result.jobId, projectId });
  };

  const handleCancel = async () => {
    if (!renderJobId || cancelRequest.current) return;
    const controller = new AbortController();
    cancelRequest.current = controller;
    setCancelingJobId(renderJobId);
    try {
      await cancelTimelineRender(renderJobId, { silent: true, signal: controller.signal });
    } catch (err) {
      // Completion can win the race with Cancel. The stream still owns the outcome.
      if (controller.signal.aborted || err.code === 'ALREADY_TERMINAL') return;
      cancelRequest.current = null;
      setCancelingJobId(null);
      if (!err.toasted) toast.error(`Cancel failed: ${err.message}`);
    }
  };

  // SSE progress wiring — subscribes to the render jobId's event stream (via
  // the shared useSseProgress lifecycle) and, on 'complete', navigates to Media
  // History focused on the new clip. Frame shapes come from
  // server/services/videoTimeline/local.js (progress / complete / error / canceled).
  const { latest: renderFrame, closed: renderStreamClosed } = useSseProgress(
    renderJobId ? `/api/video-timeline/${renderJobId}/events` : null,
    { enabled: !!renderJobId, maxFrames: 0 },
  );
  // Derived, not stored: a terminal frame isn't type 'progress', so the reset to
  // zero on complete/error/cancel falls out for free.
  const renderProgress = renderFrame?.type === 'progress' ? renderFrame.progress : 0;
  useEffect(() => {
    if (!renderJobId || !renderFrame) return;
    if (renderFrame.type === 'progress') return;
    // A genuine terminal frame sets `latest` and `closed` in the same commit,
    // so they're visible together here. A STALE terminal frame — the hook
    // keeps `latest` across the disabled gap, so starting a second render
    // briefly re-exposes the previous job's final frame — arrives with
    // `closed === false`; without this gate it would duplicate the toast and
    // tear down the new render's UI while ffmpeg keeps running.
    if (!renderStreamClosed || !isTerminalSseFrame(renderFrame)) return;
    if (renderFrame.type === 'complete') {
      toast.success('Timeline rendered');
      setRenderJob(null);
      navigate(`/media/history?focus=${renderFrame.result.id}`);
    } else if (renderFrame.type === 'error') {
      toast.error(renderFrame.error || 'Render failed');
      setRenderJob(null);
    } else {
      // canceled (either spelling — the hook treats both as terminal)
      toast('Render cancelled');
      setRenderJob(null);
    }
  }, [renderJobId, renderFrame, renderStreamClosed, navigate]);
  useEffect(() => {
    // Stream ended without a terminal frame — connection lost. Terminal frames
    // are handled (and clear the active job) in the frame effect above.
    if (!renderJobId || !renderStreamClosed) return;
    if (isTerminalSseFrame(renderFrame)) return;
    toast.error('Lost connection to render — check Media History');
    setRenderJob(null);
  }, [renderJobId, renderStreamClosed, renderFrame]);

  return { handleRender, handleCancel, renderJobId, renderProgress, canceling: !!renderJobId && cancelingJobId === renderJobId };
}
