import { Maximize2 } from 'lucide-react';
import VideoStartTrimControl from '../media/VideoStartTrimControl.jsx';
import { clipReversed } from '../../lib/musicVideoLayers.js';
import { sceneFrameFit } from './SceneFrameFit.jsx';

/** Native playback and source trim; metadata lifetime belongs to the card's hook. */
export default function SceneClipPreview({ scene, index, performance, playback, onOpenPreview, onTrimClip, takeBusy, generatingVideo }) {
  const { clipPlayerRef, clipSrc, onLoadedMetadata } = playback;
  return (
    <>
      {scene.videoHistoryId && !performance && (
        <div className="relative w-full">
          <video
            ref={clipPlayerRef}
            src={clipSrc}
            className={`block w-full aspect-video ${sceneFrameFit(scene) === 'fill' ? 'object-cover' : 'object-contain'} rounded border border-port-border bg-black`}
            muted
            playsInline
            preload="metadata"
            controls
            onLoadedMetadata={onLoadedMetadata}
          />
          {/* This thumbnail plays the file as is; the player and the render play it backwards. */}
          {clipReversed(scene) && (
            <span className="port-media-overlay pointer-events-none absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px]">Reversed in the player</span>
          )}
          {/* Keep native play/pause ownership on the video. Pause before the
              lightbox's unmuted autoplay so both players cannot play together. */}
          <button
            type="button"
            onClick={() => {
              clipPlayerRef.current?.pause();
              onOpenPreview?.(`video:${scene.videoHistoryId}`);
            }}
            aria-label={`View scene ${index + 1} clip full size`}
            title={`View scene ${index + 1} clip full size`}
            className="always-dark absolute top-1 right-1 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 p-1 flex items-center justify-center rounded bg-black/50 text-white hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-port-accent"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        </div>
      )}
      {/* Keep the clip from a later frame as a new take of this shot. */}
      {scene.videoHistoryId && !performance && onTrimClip && (
        <VideoStartTrimControl videoRef={clipPlayerRef} sourceKey={scene.videoHistoryId}
          disabled={takeBusy || !!generatingVideo}
          onTrim={(startSec) => onTrimClip(scene, startSec)} />
      )}
    </>
  );
}
