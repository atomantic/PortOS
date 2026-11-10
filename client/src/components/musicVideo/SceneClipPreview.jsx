import { Maximize2 } from 'lucide-react';
import VideoTrimControl from '../media/VideoTrimControl.jsx';
import HandheldCameraControl from '../media/HandheldCameraControl.jsx';
import { clipReversed } from '../../lib/musicVideoLayers.js';
import { sceneFrameFit } from './SceneFrameFit.jsx';

/** Native playback and source trim; metadata lifetime belongs to the card's hook. */
export default function SceneClipPreview({ scene, index, performance, playback, onOpenPreview, onTrimClip, onHandheldClip = null, takeBusy, generatingVideo }) {
  const { clipPlayerRef, clipSrc, onLoadedMetadata, clipId: playbackClipId } = playback;
  // A source-take return plays the owner's clip. Trim stays on this shot's own file.
  const clipId = playbackClipId || scene.videoHistoryId;
  return (
    <>
      {clipId && !performance && (
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
              onOpenPreview?.(`video:${clipId}`);
            }}
            aria-label={`View scene ${index + 1} clip full size`}
            title={`View scene ${index + 1} clip full size`}
            className="always-dark absolute top-1 right-1 min-h-[44px] min-w-[44px] pointer-fine:sm:min-h-0 pointer-fine:sm:min-w-0 p-1 flex items-center justify-center rounded bg-black/50 text-white hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-port-accent"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        </div>
      )}
      {/* Keep a frame range of the clip as a new take of this shot. */}
      {scene.videoHistoryId && scene.videoHistoryId === clipId && !performance && onTrimClip && (
        <VideoTrimControl videoRef={clipPlayerRef} sourceKey={scene.videoHistoryId}
          disabled={takeBusy || !!generatingVideo}
          onTrim={(range) => onTrimClip(scene, range)} />
      )}
      {/* Re-shoot the clip as if a person were holding the camera, as a new take of this shot. */}
      {scene.videoHistoryId && scene.videoHistoryId === clipId && !performance && onHandheldClip && (
        <HandheldCameraControl key={scene.videoHistoryId} clipId={scene.videoHistoryId}
          disabled={takeBusy || !!generatingVideo}
          onApply={(settings) => onHandheldClip(scene, settings)} />
      )}
    </>
  );
}
