import { Film } from 'lucide-react';
import { Link } from 'react-router';
import { copyToClipboard } from '../../lib/clipboard';
import { FLY_FPS, FLY_SECONDS, photorealActionButton, useDraftNumber } from './photorealControls';

export default function PhotorealFlythroughCard({
  canRender, running, cameraCount, missingFfmpeg, platform, flySeconds, onSecondsChange, video, onRender,
}) {
  const secondsField = useDraftNumber({ committed: flySeconds, min: FLY_SECONDS.min, max: FLY_SECONDS.max, onCommit: onSecondsChange });

  return (
    <div className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
      <h3 className="text-sm font-medium text-white">Fly-through</h3>
      <p className="text-xs text-gray-400">
        One camera glides through the chosen cameras in the order listed, with the same engine and samples. The MP4 is saved to Media History, where you can pick it as a video reference.
      </p>
      {missingFfmpeg && <div role="alert" className="space-y-2 rounded border border-port-warning p-3 text-sm">
        <p>Fly-throughs need FFmpeg on the computer running PortOS. Install it, then try the fly-through again.</p>
        {platform === 'darwin' && <div className="flex flex-wrap items-center gap-2">
          <code>brew install ffmpeg</code>
          <button type="button" className={photorealActionButton} onClick={() => copyToClipboard('brew install ffmpeg', 'Install command copied')}>Copy install command</button>
        </div>}
        <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer" className={photorealActionButton}>FFmpeg install options</a>
      </div>}
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="photoreal-fly-seconds" className="inline-flex items-center gap-1.5 text-xs text-gray-400">
          Seconds
          <input id="photoreal-fly-seconds" type="number" min={FLY_SECONDS.min} max={FLY_SECONDS.max} disabled={running} {...secondsField.inputProps}
            className="w-20 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white" />
        </label>
        <button type="button" onClick={() => onRender(secondsField.effective)} disabled={!canRender} className={photorealActionButton}>
          <Film size={16} aria-hidden="true" /> Render fly-through ({secondsField.effective * FLY_FPS} frames)
        </button>
        {cameraCount < 2 && <span className="text-xs text-gray-500">Choose at least two cameras.</span>}
      </div>
      {video && (
        <div className="space-y-1.5">
          {/* a silent camera move has no caption track */}
          <video src={`/data/videos/${encodeURIComponent(video.filename)}`} controls muted playsInline loop
            className="w-full rounded bg-black" aria-label="Fly-through" />
          <Link to={`/media/history?preview=${encodeURIComponent(`video:${video.id}`)}`} className="text-xs text-port-accent hover:underline">
            Open in Media History
          </Link>
        </div>
      )}
    </div>
  );
}
