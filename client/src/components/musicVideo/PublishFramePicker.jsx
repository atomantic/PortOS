import { useRef, useState } from 'react';

/** Native video controls offer scrubbing and show the exact requested moment. */
export default function PublishFramePicker({ project, publishKit, cardId }) {
  const video = useRef(null);
  const [atSec, setAtSec] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  if (!project?.renderHistoryId) return null;
  const id = `publish-frame-${project.id}-${cardId}`;
  return <details className="space-y-2 rounded border border-port-border p-2">
    <summary className="cursor-pointer min-h-[44px]">Use a frame from the video</summary>
    <video key={project.renderHistoryId} ref={video} controls playsInline preload="metadata"
      src={`/api/music-video/${encodeURIComponent(project.id)}/publish-kit/video?render=${encodeURIComponent(project.renderHistoryId)}`}
      aria-label="Final video frame preview" className="w-full max-h-72 rounded"
      onLoadedMetadata={e => { setDuration(e.currentTarget.duration); setFailed(false); }}
      onTimeUpdate={e => setAtSec(e.currentTarget.currentTime)} onError={() => setFailed(true)} />
    {failed && <p role="alert">The final video could not be loaded. Render the final video again if its file is missing.</p>}
    <label htmlFor={id}>Frame time (seconds)</label>
    <input id={id} type="number" min="0" max={Math.max(0, duration - 0.001)} step="0.001" value={atSec}
      className="w-full bg-port-bg border border-port-border rounded p-2"
      onChange={e => { const value = Number(e.target.value); setAtSec(value); if (video.current && Number.isFinite(value)) video.current.currentTime = value; }} />
    <button type="button" disabled={publishKit.capturingFrame || failed || !duration || atSec < 0 || atSec >= duration}
      onClick={() => publishKit.captureFrame(atSec)}
      className="bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-3 py-2 min-h-[44px]">
      {publishKit.capturingFrame ? 'Taking frame…' : 'Use this frame'}
    </button>
  </details>;
}
