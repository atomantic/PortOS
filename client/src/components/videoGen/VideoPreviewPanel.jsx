import { Film } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';

// Preview column for VideoGen.jsx (#2834): the rendered clip (or spinner /
// placeholder), the progress bar, and the download link. `previewWidth` /
// `previewHeight` are the px dimensions the page computes from the aspect ratio.
export default function VideoPreviewPanel({
  result, generating, statusMsg, progressPct, previewWidth, previewHeight,
}) {
  const src = result ? (result.path || `/data/videos/${result.filename}`) : null;
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Preview</h2>
        {result && (
          <a href={src} download className="text-xs text-port-accent hover:underline">
            Download
          </a>
        )}
      </div>
      <div
        className="mx-auto bg-port-bg border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative max-w-full"
        style={{ width: previewWidth, height: previewHeight }}
      >
        {result ? (
          // muted so the clip autoplays under the mobile media-engagement
          // policy (iOS/Android block unmuted autoplay outside a user
          // gesture — otherwise it just shows black); poster paints the
          // thumbnail while it buffers. Controls let the user unmute.
          <video
            src={src}
            poster={result.thumbnail ? `/data/video-thumbnails/${result.thumbnail}` : undefined}
            controls
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            className="w-full h-full"
          />
        ) : generating ? (
          <div className="text-gray-500 text-xs flex flex-col items-center gap-1.5">
            <BrailleSpinner />
            <span>{statusMsg || 'Starting...'}</span>
          </div>
        ) : (
          <div className="text-gray-600 text-xs flex flex-col items-center gap-1.5">
            <Film className="w-8 h-8" />
            <span>Generated video will appear here</span>
          </div>
        )}
        {generating && progressPct != null && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
            <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        )}
      </div>
      {result && (
        <div className="text-xs text-gray-400 truncate">{result.filename}</div>
      )}
    </div>
  );
}
