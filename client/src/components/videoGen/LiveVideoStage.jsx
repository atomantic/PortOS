/**
 * VideoGen main stage (#4588) — the full-size preview a render forms on.
 *
 * Before this, the only sign a video render was happening was a percentage next
 * to the Generate button; the clip appeared in the gallery minutes later. The
 * stage shows, at the render's RESOLVED geometry (so a portrait render is a
 * portrait box, not a letterboxed 16:9 one), whatever best represents the
 * in-flight render: the clip an extend is continuing (animated, muted, looping)
 * or the still it is growing out of, and the finished clip once it lands.
 * Transient runner frames stay off this surface because a single decoded frame
 * does not usefully represent the motion or quality of the finished video.
 *
 * Hold and return. The stage never yanks a clip out from under the user: while
 * `held` is set by the page (the lightbox is open) or while the user is playing
 * the finished clip on the stage itself, an incoming descriptor is deferred and
 * adopted when playback settles. An ambient LOOP preview is muted/auto-playing
 * chrome, not something the user chose to watch, so it never holds.
 *
 * Presentational — every input is owned by the VideoGen page.
 */
import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import { VIDEO_STAGE_KIND, videoStageSignature } from '../../lib/videoStagePreview';

export default function LiveVideoStage({
  descriptor,
  generating = false,
  progressPct = null,
  statusMsg = '',
  error = null,
  held = false,
}) {
  const [shown, setShown] = useState(descriptor);
  const [playing, setPlaying] = useState(false);

  const shownSignature = videoStageSignature(shown);
  const nextSignature = videoStageSignature(descriptor);
  // A user-driven playback of the finished clip holds; the ambient loop does not.
  const holding = held || (shown?.kind === VIDEO_STAGE_KIND.RESULT && playing);
  const pendingSwap = shownSignature !== nextSignature;

  useEffect(() => {
    // Signature-gated so a parent re-render that produced an equivalent
    // descriptor doesn't loop setState on a fresh object identity.
    if (holding || !pendingSwap) return;
    setShown(descriptor);
    setPlaying(false);
  }, [holding, pendingSwap, descriptor]);

  const stage = shown || { kind: VIDEO_STAGE_KIND.EMPTY, src: null, poster: null, label: '', aspectRatio: null };
  const isLoop = stage.kind === VIDEO_STAGE_KIND.LOOP;
  const isResult = stage.kind === VIDEO_STAGE_KIND.RESULT;
  const isClip = isLoop || isResult;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Stage</h2>
        {holding && pendingSwap && (
          <span className="text-[11px] text-port-accent">Newer preview ready — showing after playback</span>
        )}
      </div>

      <div
        data-testid="video-stage-frame"
        data-stage-kind={stage.kind}
        className="relative mx-auto flex w-full max-w-3xl items-center justify-center overflow-hidden rounded-lg border border-port-border bg-port-bg"
        // Inline, not a Tailwind `aspect-[w/h]` class — a computed class name
        // never reaches the JIT build. `null` geometry lets the media size itself
        // rather than being letterboxed into a guessed ratio.
        //
        // The height cap has to be paired with a ratio-derived width cap: with
        // `aspect-ratio` + `width: 100%`, a `max-height` alone just overrides the
        // ratio, and a portrait render ends up in a wide box with the clip
        // letterboxed in the middle — the exact geometry bug this stage exists to
        // avoid. Capping the width at `60vh × ratio` keeps the box portrait.
        style={stage.aspectRatio
          ? {
            aspectRatio: String(stage.aspectRatio),
            maxHeight: '60vh',
            maxWidth: `min(100%, calc(60vh * ${stage.aspectRatio}))`,
          }
          : { maxHeight: '60vh' }}
      >
        {isClip ? (
          <video
            key={stage.src}
            src={stage.src}
            poster={stage.poster || undefined}
            aria-label={stage.label}
            className="h-full w-full object-contain"
            playsInline
            controls={isResult}
            muted={isLoop}
            loop={isLoop}
            autoPlay={isLoop}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        ) : stage.src ? (
          <img
            src={stage.src}
            alt={stage.label}
            decoding="async"
            className="h-full w-full object-contain"
          />
        ) : generating ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-gray-500">
            <BrailleSpinner />
            <span className="font-medium text-gray-300">{statusMsg || 'Starting render…'}</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-xs text-gray-600">
            <Film className="w-8 h-8" />
            <span>{stage.label}</span>
          </div>
        )}

        {(generating || error) && (
          <div className="port-media-overlay absolute left-2 top-2 max-w-[calc(100%-1rem)] rounded-lg px-2 py-1 text-[11px]">
            <span className="truncate">{error || statusMsg || 'Working…'}</span>
          </div>
        )}

        {stage.src && !error && (
          <div className="port-media-overlay absolute bottom-2 left-2 rounded-lg px-2 py-1 text-[10px]">
            {stage.label}
          </div>
        )}

        {generating && progressPct != null && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
            <div
              data-testid="video-stage-progress"
              className="h-full bg-port-accent transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
