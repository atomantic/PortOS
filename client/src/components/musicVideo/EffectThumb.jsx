import { useEffect, useRef, useState } from 'react';
import { createMusicVideoGlitchPainter } from '../../../../server/lib/musicVideo/musicVideoGlitchCanvas.js';
import { MUSIC_VIDEO_TRANSITION_STYLES, blockBox, edgeGlows, glitchFrameParams } from '../../../../server/lib/musicVideo/musicVideoTransitions.js';

// Small enough that a library of them repaints in well under a frame.
const WIDTH = 160;
const HEIGHT = 90;
const FPS = 24;
// Clean frames between passes of the effect while it plays, so each pass reads as a moment.
const REST_FRAMES = 14;

const paintEffect = createMusicVideoGlitchPainter({ blockBox, edgeGlows });
// One decode per picture, shared by every thumbnail that shows it.
const pictures = new Map();
const pictureFor = (src) => {
  if (!src) return null;
  let picture = pictures.get(src);
  if (!picture) {
    picture = new Image();
    picture.decoding = 'async';
    picture.src = src;
    pictures.set(src, picture);
  }
  return picture;
};

// With no shot picture yet, a plain scene with edges and color, so every effect still has something to act on.
function paintStandIn(ctx) {
  const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  sky.addColorStop(0, '#3a4a6b');
  sky.addColorStop(1, '#c98a5a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#2b2f3a';
  ctx.fillRect(0, HEIGHT * 0.62, WIDTH, HEIGHT * 0.38);
  ctx.fillStyle = '#e8d6a8';
  ctx.fillRect(WIDTH * 0.18, HEIGHT * 0.38, WIDTH * 0.2, HEIGHT * 0.3);
  ctx.fillStyle = '#7c5cf6';
  ctx.fillRect(WIDTH * 0.62, HEIGHT * 0.3, WIDTH * 0.12, HEIGHT * 0.4);
}

function paintPicture(ctx, picture) {
  if (!picture?.complete || !picture.naturalWidth) { paintStandIn(ctx); return; }
  // Cover: fill the frame, cropping the longer side.
  const scale = Math.max(WIDTH / picture.naturalWidth, HEIGHT / picture.naturalHeight);
  const w = picture.naturalWidth * scale;
  const h = picture.naturalHeight * scale;
  ctx.drawImage(picture, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
}

/**
 * A small picture of what an effect style does, painted by the same painter
 * the preview and the render use, over `src` (the shot it would land on) or a
 * stand-in scene. At rest it shows the style's strongest frame; with `playing`
 * it loops the whole effect at 24 fps.
 */
export default function EffectThumb({ style, src = null, playing = false, className = '' }) {
  const canvasRef = useRef(null);
  const frames = MUSIC_VIDEO_TRANSITION_STYLES[style]?.frames || [];
  // The picture's decode lands after the first paint; this repaints once it has.
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    const picture = pictureFor(src);
    if (!picture || picture.complete) return undefined;
    const done = () => setLoaded((n) => n + 1);
    picture.addEventListener('load', done);
    return () => picture.removeEventListener('load', done);
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.('2d');
    if (!ctx || !frames.length) return undefined;
    const picture = pictureFor(src);
    const paint = (index) => {
      paintPicture(ctx, picture);
      const params = index == null ? null : glitchFrameParams({ style, index });
      if (params) paintEffect(canvas, params, index);
    };
    const peak = Math.floor((frames.length - 1) / 2);
    if (!playing) { paint(peak); return undefined; }
    let handle = 0;
    let started = null;
    const tick = (now) => {
      if (started == null) started = now;
      const step = Math.floor(((now - started) / 1000) * FPS) % (frames.length + REST_FRAMES);
      paint(step < frames.length ? step : null);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(handle); paint(peak); };
  }, [style, src, playing, frames.length, loaded]);

  return <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className={`block aspect-video w-full rounded-sm bg-black ${className}`} />;
}
