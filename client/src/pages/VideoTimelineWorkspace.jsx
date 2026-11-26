import { useMemo, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { BedAudio } from '../components/media/VideoTimelineLanes';
import VideoTimelineTracks from '../components/media/VideoTimelineTracks';
import { formatTimecode } from '../utils/formatters';
import { assetUrl, bedAssetId, fadeMultiplier, overlayOpacityAt, segmentDuration } from '../lib/videoTimelineModel';
import { useTimelinePlayback } from './useTimelinePlayback';

export default function VideoTimelineWorkspace({
  visible, lanes, playSegments, playTracks, total, canvasAspect, playheadRef, reportBedDuration,
  metaFor, selection, setSelection, removeFromLane, updateLanes,
  isSegmentMissing, isOverlayMissing, isBedMissing,
}) {
  const { segments, overlays, audio } = lanes;
  const [pxPerSec, setPxPerSec] = useState(60);

  const {
    t, playing, muted, seek, togglePlaying, toggleMuted,
    videoRef, bedRegistry, activeSegment, activeWithin,
  } = useTimelinePlayback({
    playSegments, playTracks, clipVolume: audio.clipVolume, total, metaFor, playheadRef, visible,
  });

  // Everything about an overlay except its opacity is frame-invariant; only the
  // opacity is recomputed as the playhead moves.
  const overlayChrome = useMemo(() => overlays.map((ov) => ({
    key: ov._key,
    src: assetUrl(ov.assetKind, ov.assetFile),
    left: `${(ov.x || 0) * 100}%`,
    top: `${(ov.y || 0) * 100}%`,
    width: `${(ov.width || 0.25) * 100}%`,
    overlay: ov,
  })), [overlays]);

  const activeStillSrc = activeSegment?.type === 'still'
    ? assetUrl(activeSegment.assetKind, activeSegment.assetFile)
    : null;
  // The same linear ramp ffmpeg's `fade` applies, rendered as a black scrim so
  // the preview shows the cut the export will make.
  const activeFadeScrim = activeSegment
    ? 1 - fadeMultiplier(
      activeSegment.fadeInSec || 0,
      activeSegment.fadeOutSec || 0,
      segmentDuration(activeSegment),
      activeWithin,
    )
    : 0;

  if (!visible) return null;

  const playheadSec = Math.min(t, total);

  return (
    <div className="order-1 lg:order-2 space-y-3 min-w-0">
      {/* The preview adopts the CANONICAL render canvas, not a fixed 16:9
          box — overlay x/y/width are normalized against that canvas, so a
          portrait or square project would otherwise place them somewhere
          the export does not. */}
      <div className="bg-black rounded-lg overflow-hidden relative" style={{ aspectRatio: canvasAspect }}>
        <video
          ref={videoRef}
          className={`w-full h-full ${activeStillSrc ? 'invisible' : ''}`}
          playsInline
          preload="auto"
        />
        {activeStillSrc && (
          <img src={activeStillSrc} alt="" className="absolute inset-0 w-full h-full object-contain" />
        )}
        {/* The segment fade scrim sits UNDER the overlay lane, matching the
            export: ffmpeg fades each segment before concat and composites
            overlays afterwards, so a fade dims the base video and leaves
            the overlay at its own opacity. */}
        {activeFadeScrim > 0 && (
          <div
            data-testid="fade-scrim"
            aria-hidden="true"
            style={{ opacity: activeFadeScrim }}
            className="absolute inset-0 bg-black pointer-events-none"
          />
        )}
        {/* Overlay lane, composited exactly as ffmpeg will: normalized
            position/width against the canvas, alpha from the same ramp.
            Every overlay stays MOUNTED and rides its opacity to zero —
            unmounting at the window edge would re-decode the image on each
            boundary crossing while scrubbing. */}
        {overlayChrome.map(({ key, src, left, top, width, overlay }) => (src ? (
          <img
            key={key}
            src={src}
            alt=""
            data-testid="overlay-preview"
            style={{ left, top, width, opacity: overlayOpacityAt(overlay, t, total) }}
            className="absolute pointer-events-none"
          />
        ) : null))}
        {segments.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
            Add clips to start
          </div>
        )}
      </div>

      {/* Bed playback elements. Hidden — the timeline lane is the UI. */}
      {audio.tracks.map((track) => (
        <BedAudio
          key={track._key}
          trackKey={track._key}
          assetId={bedAssetId(track)}
          src={assetUrl(track.assetKind, track.assetFile)}
          registry={bedRegistry}
          onDuration={reportBedDuration}
        />
      ))}

      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <button
          type="button"
          onClick={togglePlaying}
          disabled={segments.length === 0}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 bg-port-card border border-port-border rounded-md hover:border-port-accent disabled:opacity-40"
          title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={toggleMuted}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 bg-port-card border border-port-border rounded-md hover:border-port-accent"
          title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
        <input
          type="range"
          aria-label="Playhead position"
          min={0}
          max={Math.max(0.01, total)}
          step={0.01}
          value={playheadSec}
          onChange={(e) => seek(Number(e.target.value))}
          className="min-w-0 flex-1 basis-40"
          disabled={segments.length === 0}
        />
        <span className="font-mono text-[11px] tabular-nums whitespace-nowrap">
          {formatTimecode(t)} / {formatTimecode(total)}
        </span>
        <label htmlFor="timeline-zoom" className="flex items-center gap-1 ml-auto sm:ml-2">
          <span>zoom</span>
          <input
            id="timeline-zoom"
            type="range"
            min={20}
            max={200}
            value={pxPerSec}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
            className="w-20"
          />
        </label>
      </div>

      <VideoTimelineTracks
        playSegments={playSegments}
        overlays={overlays}
        playTracks={playTracks}
        selection={selection}
        setSelection={setSelection}
        removeFromLane={removeFromLane}
        updateLanes={updateLanes}
        metaFor={metaFor}
        isSegmentMissing={isSegmentMissing}
        isOverlayMissing={isOverlayMissing}
        isBedMissing={isBedMissing}
        total={total}
        pxPerSec={pxPerSec}
        playheadSec={playheadSec}
      />
    </div>
  );
}
