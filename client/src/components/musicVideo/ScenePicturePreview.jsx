import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import ImageEffectStill from './ImageEffectStill.jsx';
import { paintFigureGlitch } from './TransitionGlitch.jsx';
import { shotImageUrl } from './sceneImageTreatmentUrls.js';
import { normalizePreMusic } from '../../../../server/lib/musicVideo/musicVideoColdOpen.js';
import { sceneImageEffect, scenePhotoSequence } from '../../../../server/lib/musicVideo/musicVideoImageEffects.js';
import {
  mergeGlitchFrames, sceneImageEffectGlitchFrames, sceneShotGlitchFrames, sceneTransitionSections, transitionFrameAt, transitionGlitchFrames,
} from '../../../../server/lib/musicVideo/musicVideoTransitions.js';

// A shot with no span still previews its effect over this long.
const FALLBACK_SPAN_SEC = 4;

/**
 * What a still shot shows in a composed render, in the shot card's Picture
 * column instead of its old clip: the still alone, or the still playing its
 * image effect, photo sequence, cut transitions and in-shot effects looped over
 * the shot's length with play/pause and a scrubber.
 */
export default function ScenePicturePreview({ scene, projectId, beats = [], fps = 24, cameras = null }) {
  const imageUrl = useCallback(id => shotImageUrl(projectId, scene, id), [projectId, scene]);
  const effect = sceneImageEffect(scene, { layered: true });
  const sequence = useMemo(() => scenePhotoSequence(scene, { beats, fps }), [scene, beats, fps]);
  const coldOpen = normalizePreMusic(scene.preMusic);
  const spanSec = coldOpen ? coldOpen.durationSec
    : typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec
      ? scene.endSec - scene.startSec : FALLBACK_SPAN_SEC;
  // Normalize this shot to 0..spanSec so cut transitions and in-shot glitches preview on the same frames the render paints.
  const glitches = useMemo(() => {
    const previewScene = { ...scene, startSec: 0, endSec: spanSec };
    const sections = sceneTransitionSections([previewScene], fps, { endSec: spanSec, cameras });
    return mergeGlitchFrames(
      transitionGlitchFrames(sections),
      sceneImageEffectGlitchFrames([previewScene], fps, { layered: true, endSec: spanSec, cameras }),
      sceneShotGlitchFrames([previewScene], fps, { endSec: spanSec, cameras }),
    );
  }, [scene, spanSec, fps, cameras]);
  const hasPreview = Boolean(effect || sequence || glitches.length);
  const [playing, setPlaying] = useState(true);
  const [pausedAt, setPausedAt] = useState(0);
  const clampedPausedAt = Math.min(pausedAt, spanSec);
  const startedAt = useRef(0);
  const figureRef = useRef(null);
  const canvasRef = useRef(null);
  const scrubRef = useRef(null);
  const timeRef = useRef(null);
  const scrubId = useId();
  // Time into the shot, looping over its span.
  const getTime = useCallback(() => {
    const elapsed = (performance.now() - startedAt.current) / 1000;
    return ((elapsed % spanSec) + spanSec) % spanSec;
  }, [spanSec]);
  const getSongTime = useCallback(() => (scene.startSec || 0) + getTime(), [scene.startSec, getTime]);
  const paintAt = useCallback((localSec) => {
    if (scrubRef.current) scrubRef.current.value = String(localSec);
    if (timeRef.current) timeRef.current.textContent = `${localSec.toFixed(2)}s / ${spanSec.toFixed(2)}s`;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hit = transitionFrameAt(glitches, Math.floor(localSec * fps + 1e-6));
    const shown = Boolean(hit) && paintFigureGlitch(canvas, figureRef.current, hit.params, hit.frame);
    canvas.style.visibility = shown ? 'visible' : 'hidden';
  }, [glitches, fps, spanSec]);
  useEffect(() => {
    if (playing) startedAt.current = performance.now() - clampedPausedAt * 1000;
    // Restart the loop when playback resumes or the image effect timing changes.
  }, [playing, clampedPausedAt, effect?.effect, effect?.developSec, effect?.changeSec]);
  useEffect(() => {
    if (!hasPreview) return undefined;
    if (!playing) {
      paintAt(clampedPausedAt);
      const handle = requestAnimationFrame(() => paintAt(clampedPausedAt));
      return () => cancelAnimationFrame(handle);
    }
    let handle = 0;
    const tick = () => {
      paintAt(getTime());
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [hasPreview, playing, clampedPausedAt, paintAt, getTime]);
  const toggle = () => {
    if (playing) setPausedAt(getTime());
    setPlaying((on) => !on);
  };
  const scrub = (e) => {
    const next = Number(e.target.value);
    setPlaying(false);
    setPausedAt(next);
    paintAt(next);
  };
  if (!scene.referenceImageId && !sequence?.imageIds.length) {
    return <div className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-port-border text-xs text-port-text-muted">No still yet</div>;
  }
  const src = imageUrl(scene.referenceImageId);
  return (
    <div ref={figureRef} className="relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black" data-testid="scene-picture-preview">
      {effect || sequence ? (
        <ImageEffectStill src={src} endSrc={scene.endImageId ? imageUrl(scene.endImageId) : null} imageUrl={imageUrl} effect={effect} sequence={sequence} fps={fps}
          startSec={scene.startSec || 0} time={(scene.startSec || 0) + clampedPausedAt} playing={playing} getTime={getSongTime} />
      ) : (
        <img src={src} alt="" onLoad={() => hasPreview && paintAt(playing ? getTime() : clampedPausedAt)} className="h-full w-full object-cover" />
      )}
      {glitches.length > 0 && (
        <canvas ref={canvasRef} data-testid="picture-preview-glitch" style={{ visibility: 'hidden' }}
          className="pointer-events-none absolute inset-0 h-full w-full" />
      )}
      {hasPreview && (
        <div className="port-media-overlay absolute inset-x-1 bottom-1 flex items-center gap-2 rounded px-1.5 py-0.5 text-[11px]">
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause effect preview' : 'Play effect preview'}
            className="port-media-overlay-item flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded pointer-fine:sm:min-h-0 pointer-fine:sm:min-w-0 sm:p-1">
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <label htmlFor={scrubId} className="sr-only">Preview time</label>
          <input id={scrubId} ref={scrubRef} type="range" min={0} max={spanSec} step={1 / fps} defaultValue={clampedPausedAt}
            onChange={scrub}
            className="min-w-0 flex-1 accent-port-accent min-h-[44px] pointer-fine:sm:min-h-0" />
          <span ref={timeRef} className="shrink-0 tabular-nums">{clampedPausedAt.toFixed(2)}s / {spanSec.toFixed(2)}s</span>
        </div>
      )}
    </div>
  );
}
