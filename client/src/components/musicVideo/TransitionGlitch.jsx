import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createMusicVideoGlitchPainter } from '../../lib/musicVideoGlitchCanvas.js';
import { drawFigurePicture, figureClipSettling } from './animaticPicture.js';
import {
  blockBox, edgeGlows, mergeGlitchFrames, sceneImageEffectGlitchFrames, sceneShotGlitchFrames, sceneTransitionSections, transitionFrameAt, transitionGlitchFrames,
} from '../../lib/musicVideoTransitions.js';

// The canvas paints at most this wide; a glitch lasts a few frames, so detail past it is never seen.
const MAX_CANVAS_PX = 960;
// Animation frames a paused glitch frame keeps repainting while its picture finishes decoding.
const SETTLE_FRAMES = 30;

const paintEffect = createMusicVideoGlitchPainter({ blockBox, edgeGlows });

/** Paint one glitch frame (`params` from musicVideoTransitions.js) of what the figure shows. */
function paintGlitch(canvas, figure, params, frame) {
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  const width = Math.min(MAX_CANVAS_PX, Math.round(box.width * (window.devicePixelRatio || 1)));
  const height = Math.round(width * box.height / box.width);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const out = canvas.getContext('2d');
  if (!out) return false;

  out.fillStyle = '#000';
  out.fillRect(0, 0, width, height);
  // Nothing decoded yet: leave the picture clean rather than glitch a black frame.
  if (!drawFigurePicture(out, figure, width, height)) return false;

  paintEffect(canvas, params, frame);
  return true;
}

/**
 * The shots' cut transitions over the storyboard animatic: on each glitched
 * frame (the same frames the final render repaints) a canvas over the picture
 * paints the glitch of what is on screen; every other frame it stays hidden.
 * Below the lyric layer, as the render keeps its typography clean.
 */
export default function TransitionGlitch({ scenes, figureRef, audioRef, time, endSec = null, fps, layered = false, cameras = null }) {
  const canvasRef = useRef(null);
  // A still's glitch to its end frame (an image effect) paints the same way, on the frames the render repaints.
  // So do the glitches a shot sets at moments inside it, including a camera's default cuts.
  const glitches = useMemo(() => mergeGlitchFrames(transitionGlitchFrames(sceneTransitionSections(scenes, fps, { endSec, cameras })),
    sceneImageEffectGlitchFrames(scenes, fps, { layered, endSec, cameras }), sceneShotGlitchFrames(scenes, fps, { endSec, cameras })), [scenes, fps, endSec, layered, cameras]);
  const paint = useCallback((t) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hit = transitionFrameAt(glitches, Math.floor(t * fps + 1e-6));
    // Mid-seek the clip cannot be copied; keep the last glitch frame rather than paint the shot's still.
    if (hit && figureClipSettling(figureRef.current)) return;
    const shown = !!hit && paintGlitch(canvas, figureRef.current, hit.params, hit.frame);
    canvas.style.visibility = shown ? 'visible' : 'hidden';
  }, [glitches, fps, figureRef]);
  // A pause, a scrub or a frame step lands through `time`; playback runs on animation frames.
  // Paused, it repaints for a moment, since the clip's seek to the new frame decodes after the step.
  useEffect(() => {
    paint(time);
    let handle = 0;
    let left = SETTLE_FRAMES;
    const settle = () => {
      if (!audioRef.current?.paused || left-- <= 0) return;
      paint(time);
      handle = requestAnimationFrame(settle);
    };
    handle = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(handle);
  }, [time, paint, audioRef]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !glitches.length) return undefined;
    let handle = 0;
    const tick = () => {
      paint(audio.currentTime || 0);
      handle = requestAnimationFrame(tick);
    };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(handle); paint(audio.currentTime || 0); };
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(handle);
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop);
    };
  }, [audioRef, glitches, paint]);
  if (!glitches.length) return null;
  return (
    <canvas
      ref={canvasRef}
      data-testid="animatic-glitch"
      style={{ visibility: 'hidden' }}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
