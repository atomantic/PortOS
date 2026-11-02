import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createMusicVideoGlitchPainter } from '../../lib/musicVideoGlitchCanvas.js';
import {
  blockBox, edgeGlows, mergeGlitchFrames, sceneImageEffectGlitchFrames, sceneShotGlitchFrames, sceneTransitionSections, transitionFrameAt, transitionGlitchFrames,
} from '../../lib/musicVideoTransitions.js';

// The canvas paints at most this wide; a glitch lasts a few frames, so detail past it is never seen.
const MAX_CANVAS_PX = 960;
// Animation frames a paused glitch frame keeps repainting while its picture finishes decoding.
const SETTLE_FRAMES = 30;

const paintEffect = createMusicVideoGlitchPainter({ blockBox, edgeGlows });

/** Draw a picture element the way its CSS object-fit lays it out in the frame. */
function drawFitted(ctx, el, width, height) {
  const w = el.videoWidth || el.naturalWidth;
  const h = el.videoHeight || el.naturalHeight;
  if (!w || !h) return;
  const fit = getComputedStyle(el).objectFit;
  const scale = fit === 'cover' ? Math.max(width / w, height / h) : fit === 'contain' ? Math.min(width / w, height / h) : null;
  if (scale == null) { ctx.drawImage(el, 0, 0, width, height); return; }
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(el, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

// #14277: a stacked photo sequence, composed as the renders compose it — each
// visible layer oldest first; a laid-out one (data-layout "x,y,scale,rotation,opacity")
// fitted whole about its centre, otherwise cover-fitted.
function drawPhotoStack(ctx, stack, width, height) {
  let drawn = false;
  for (const img of stack.querySelectorAll('img')) {
    if (img.style.display === 'none' || !img.complete || !img.naturalWidth) continue;
    const [x, y, scale, rotation, opacity] = (img.dataset.layout || '').split(',').map(Number);
    if (!img.dataset.layout) { drawFitted(ctx, img, width, height); drawn = true; continue; }
    const fit = Math.min(width / img.naturalWidth, height / img.naturalHeight) * scale;
    const dw = img.naturalWidth * fit; const dh = img.naturalHeight * fit;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(width / 2 + x * width, height / 2 + y * height);
    if (rotation) ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    drawn = true;
  }
  return drawn;
}

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

  // The picture as the frame shows it: the still, then the clip over it once it has a frame.
  const base = out;
  base.fillStyle = '#000';
  base.fillRect(0, 0, width, height);
  // The current shot's photo stack renders first; an incoming shot preloaded later is not it.
  // Its own end frame (an end-frame image effect, a sibling of the stack) replaces it once shown.
  const firstStack = figure?.querySelector('[data-photo-stack]');
  const endFrame = firstStack ? [...firstStack.parentElement.children].find(el => el.tagName === 'IMG' && el.dataset.shown === 'true') : null;
  const stack = endFrame ? null : firstStack;
  const still = stack ? null : endFrame || figure?.querySelector('img[data-shown="true"]') || figure?.querySelector('img');
  const clip = figure?.querySelector('video[data-ready="true"]:not([aria-hidden="true"])');
  const stillReady = stack ? drawPhotoStack(base, stack, width, height) : !!still?.complete && still.naturalWidth > 0;
  const clipReady = !!clip && clip.readyState >= 2;
  // Nothing decoded yet: leave the picture clean rather than glitch a black frame.
  if (!stillReady && !clipReady) return false;
  if (stillReady && still) drawFitted(base, still, width, height);
  if (clipReady) drawFitted(base, clip, width, height);

  paintEffect(canvas, params, frame);
  return true;
}

/**
 * The shots' cut transitions over the storyboard animatic: on each glitched
 * frame (the same frames the final render repaints) a canvas over the picture
 * paints the glitch of what is on screen; every other frame it stays hidden.
 * Below the lyric layer, as the render keeps its typography clean.
 */
export default function TransitionGlitch({ scenes, figureRef, audioRef, time, endSec = null, fps, layered = false }) {
  const canvasRef = useRef(null);
  // A still's glitch to its end frame (an image effect) paints the same way, on the frames the render repaints.
  // So do the glitches a shot sets at moments inside it.
  const glitches = useMemo(() => mergeGlitchFrames(transitionGlitchFrames(sceneTransitionSections(scenes, fps, { endSec })),
    sceneImageEffectGlitchFrames(scenes, fps, { layered, endSec }), sceneShotGlitchFrames(scenes, fps, { endSec })), [scenes, fps, endSec, layered]);
  const paint = useCallback((t) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hit = transitionFrameAt(glitches, Math.floor(t * fps + 1e-6));
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
