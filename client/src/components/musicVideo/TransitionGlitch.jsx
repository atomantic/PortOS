import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  blockBox, edgeGlows, mergeGlitchFrames, sceneImageEffectGlitchFrames, sceneShotGlitchFrames, sceneTransitionSections, transitionFrameAt, transitionGlitchFrames,
} from '../../lib/musicVideoTransitions.js';

// The canvas paints at most this wide; a glitch lasts a few frames, so detail past it is never seen.
const MAX_CANVAS_PX = 960;
// Animation frames a paused glitch frame keeps repainting while its picture finishes decoding.
const SETTLE_FRAMES = 30;

const scratchCanvas = (() => {
  const pool = new Map();
  return (key, width, height) => {
    let canvas = pool.get(key);
    if (!canvas) { canvas = document.createElement('canvas'); pool.set(key, canvas); }
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    return canvas;
  };
})();

// Deterministic tape snow: the same frame always shows the same grain.
let snowTile = null;
function snow() {
  if (snowTile) return snowTile;
  snowTile = document.createElement('canvas');
  snowTile.width = 256;
  snowTile.height = 256;
  const ctx = snowTile.getContext('2d');
  if (!ctx) return snowTile;
  const image = ctx.createImageData(256, 256);
  let seed = 123457;
  for (let i = 0; i < image.data.length; i += 4) {
    // xorshift32: an LCG's low byte repeats every 256 pixels and draws stripes.
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const v = (seed >>> 24) & 255;
    image.data[i] = v; image.data[i + 1] = v; image.data[i + 2] = v; image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return snowTile;
}

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

// The render's slip (one ffmpeg swaprect): band [y, y+h) moves `a` px over and the
// edge it uncovers shows the strip beside it.
function slip(ctx, src, a, y, h, width) {
  const d = Math.min(Math.abs(Math.round(a)), width - 1);
  if (d < 1 || h < 1) return;
  if (a > 0) {
    ctx.drawImage(src, 0, y, width - d, h, d, y, width - d, h);
    ctx.drawImage(src, d, y, d, h, 0, y, d, h);
  } else {
    ctx.drawImage(src, d, y, width - d, h, 0, y, width - d, h);
    ctx.drawImage(src, Math.max(0, width - 2 * d), y, d, h, width - d, y, d, h);
  }
}

// The render's vertical roll (one ffmpeg swaprect): the frame moves `a` px down (or up)
// and the edge it uncovers shows the strip beside it.
function roll(ctx, src, a, width, height) {
  const d = Math.min(Math.abs(Math.round(a)), height - 1);
  if (d < 1) return;
  if (a > 0) {
    ctx.drawImage(src, 0, 0, width, height - d, 0, d, width, height - d);
    ctx.drawImage(src, 0, d, width, d, 0, 0, width, d);
  } else {
    ctx.drawImage(src, 0, d, width, height - d, 0, 0, width, height - d);
    ctx.drawImage(src, 0, Math.max(0, height - 2 * d), width, d, 0, height - d, width, d);
  }
}

// The render's macroblock swap (one ffmpeg swaprect): two blocks trade places.
function swapBlocks(ctx, src, sw, width, height) {
  const a = blockBox(sw.x1, sw.y1, sw.w, sw.h, width, height);
  const b = blockBox(sw.x2, sw.y2, sw.w, sw.h, width, height);
  const w = Math.min(a.w, b.w);
  const h = Math.min(a.h, b.h);
  if (w < 2 || h < 2) return;
  ctx.drawImage(src, a.x, a.y, w, h, b.x, b.y, w, h);
  ctx.drawImage(src, b.x, b.y, w, h, a.x, a.y, w, h);
}

// The render's smeared band: slipped like a tear, then blurred sideways. Squeezing the band
// narrow and stretching it back smears it horizontally, as the render's sideways blur does.
function smear(ctx, src, sm, width, height) {
  const y = Math.round(sm.y * height);
  const h = Math.min(Math.round(sm.h * height), height - y);
  if (h < 1) return;
  slip(ctx, src, sm.shift * width, y, h, width);
  const narrow = Math.max(1, Math.round(width / Math.max(1, (sm.blur || 0) * width * 1.5)));
  const band = scratchCanvas('smear', narrow, h);
  const bctx = band.getContext('2d');
  bctx.imageSmoothingEnabled = true;
  bctx.drawImage(ctx.canvas, 0, y, width, h, 0, 0, narrow, h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(band, 0, 0, narrow, h, 0, y, width, h);
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
  let cur = scratchCanvas('a', width, height);
  const base = cur.getContext('2d');
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

  // Slips in the render's order: the whole frame, then each torn band, ping-ponging two scratch canvases.
  const slips = [
    ...(params.roll ? [{ roll: params.roll * height }] : []),
    ...(params.shift ? [{ a: params.shift * width, y: 0, h: height }] : []),
    ...(params.tears || []).map((t) => ({ a: t.shift * width, y: Math.round(t.y * height), h: Math.round(t.h * height) })),
    ...(params.smears || []).map((sm) => ({ smear: sm })),
    ...(params.swaps || []).map((sw) => ({ swap: sw })),
  ];
  slips.forEach((s, i) => {
    const next = scratchCanvas(i % 2 ? 'a' : 'b', width, height);
    const ctx = next.getContext('2d');
    ctx.drawImage(cur, 0, 0);
    if (s.roll) roll(ctx, cur, s.roll, width, height);
    else if (s.swap) swapBlocks(ctx, cur, s.swap, width, height);
    else if (s.smear) smear(ctx, cur, s.smear, width, height);
    else slip(ctx, cur, s.a, s.y, Math.min(s.h, height - s.y), width);
    cur = next;
  });

  // Colour fringe: red and blue pulled apart sideways, rebuilt additively.
  out.globalCompositeOperation = 'source-over';
  out.globalAlpha = 1;
  const fringe = Math.round((params.chroma || 0) * width);
  if (fringe > 0) {
    out.fillStyle = '#000';
    out.fillRect(0, 0, width, height);
    [['#f00', -fringe], ['#0f0', 0], ['#00f', fringe]].forEach(([mask, dx], i) => {
      const layer = scratchCanvas(`c${i}`, width, height);
      const lctx = layer.getContext('2d');
      lctx.globalCompositeOperation = 'source-over';
      lctx.drawImage(cur, dx, 0);
      lctx.globalCompositeOperation = 'multiply';
      lctx.fillStyle = mask;
      lctx.fillRect(0, 0, width, height);
      lctx.globalCompositeOperation = 'source-over';
      out.globalCompositeOperation = 'lighter';
      out.drawImage(layer, 0, 0);
    });
    out.globalCompositeOperation = 'source-over';
  } else {
    out.drawImage(cur, 0, 0);
  }

  // Brightness and saturation, in the render's order (before the bar, lines and snow).
  const bright = params.bright ?? 1;
  const sat = params.sat ?? 1;
  if (bright > 1) {
    // Adding the picture to itself at (b - 1) scales it by b.
    const lit = scratchCanvas('lit', width, height);
    lit.getContext('2d').drawImage(canvas, 0, 0);
    out.globalCompositeOperation = 'lighter';
    out.globalAlpha = Math.min(1, bright - 1);
    out.drawImage(lit, 0, 0);
  } else if (bright < 1) {
    out.globalAlpha = 1 - bright;
    out.fillStyle = '#000';
    out.fillRect(0, 0, width, height);
  }
  if (sat < 1) {
    out.globalCompositeOperation = 'saturation';
    out.globalAlpha = 1 - sat;
    out.fillStyle = '#808080';
    out.fillRect(0, 0, width, height);
  }
  out.globalCompositeOperation = 'source-over';
  out.globalAlpha = 1;
  for (const b of params.blocks || []) {
    const box = blockBox(b.x, b.y, b.w, b.h, width, height);
    out.globalAlpha = b.alpha;
    out.fillStyle = `#${b.color}`;
    out.fillRect(box.x, box.y, box.w, box.h);
  }
  for (const glow of edgeGlows(params.glows)) {
    const reach = glow.size * (glow.side === 'left' || glow.side === 'right' ? width : height);
    const [x0, y0, x1, y1] = glow.side === 'left' ? [0, 0, reach, 0] : glow.side === 'right' ? [width, 0, width - reach, 0]
      : glow.side === 'top' ? [0, 0, 0, reach] : [0, height, 0, height - reach];
    const ramp = out.createLinearGradient(x0, y0, x1, y1);
    ramp.addColorStop(0, `#${glow.color}`);
    ramp.addColorStop(1, `#${glow.color}00`);
    out.globalAlpha = glow.alpha;
    out.fillStyle = ramp;
    out.fillRect(0, 0, width, height);
  }
  out.globalAlpha = 1;
  for (const bar of [...(params.bar ? [params.bar] : []), ...(params.bars || [])]) {
    out.fillStyle = `rgba(255,255,255,${bar.alpha})`;
    out.fillRect(0, Math.round(bar.y * height), width, Math.max(2, Math.round(bar.h * height)));
  }
  if (params.lines) {
    const gap = Math.max(2, Math.round(height / 270));
    out.fillStyle = `rgba(0,0,0,${params.lines})`;
    for (let y = 0; y < height; y += gap) out.fillRect(0, y, width, Math.max(1, Math.floor(gap / 2)));
  }
  if (params.noise) {
    const pattern = out.createPattern(snow(), 'repeat');
    if (pattern) {
      out.save();
      out.globalCompositeOperation = 'overlay';
      out.globalAlpha = Math.min(1, params.noise);
      // Each frame shifts the grain, as the render's temporal noise does.
      out.translate((frame * 97) % 256, (frame * 61) % 256);
      out.fillStyle = pattern;
      out.fillRect(-256, -256, width + 256, height + 256);
      // Past 1 the snow drowns the picture: a dead channel's static.
      if (params.noise > 1) {
        out.globalCompositeOperation = 'source-over';
        out.globalAlpha = Math.min(1, params.noise - 1);
        out.fillRect(-256, -256, width + 256, height + 256);
      }
      out.restore();
    }
  }
  canvas.style.filter = sat > 1 ? `saturate(${sat})` : '';
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
