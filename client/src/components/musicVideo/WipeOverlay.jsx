import { useCallback, useEffect, useMemo, useRef } from 'react';
import { sceneWipeCuts } from '../../lib/musicVideoTransitions.js';
import { compileWipeNode, createMusicVideoWipePainter, wipeDefinition } from '../../lib/musicVideoWipes.js';
import { drawFigurePicture } from './animaticPicture.js';

// The canvas paints at most this wide, as the glitch overlay does.
const MAX_CANVAS_PX = 960;
// Animation frames a paused wipe frame keeps repainting while the incoming clip decodes.
const SETTLE_FRAMES = 30;
// How close to a cut (in frames) the outgoing picture is held for the wipe.
const HOLD_FRAMES = 3;

const paintWipe = createMusicVideoWipePainter({ definitions: wipeDefinition, compile: compileWipeNode });

const cutAt = (cuts, frame) => cuts.find((cut) => frame >= cut.cutFrame && frame < cut.cutFrame + cut.frames) || null;
const cutAhead = (cuts, frame) => cuts.find((cut) => frame < cut.cutFrame && frame >= cut.cutFrame - HOLD_FRAMES) || null;

function sizeCanvas(canvas, width, height) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas.getContext('2d');
}

function drawContained(ctx, img, width, height) {
  const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

/**
 * The shots' wipes over the storyboard animatic, on the frames the final render
 * paints them (`sceneWipeCuts`, one definition with the render's ffmpeg filter).
 * The cut stays where it is: from the cut on, the figure already shows the
 * incoming shot, and this canvas paints the outgoing shot's held last picture
 * over it, taken away by the wipe. The held picture is the figure's own frame
 * just before the cut, or the outgoing still when playback jumped straight in.
 * Below the lyric layer, as the render keeps its typography clean.
 */
export default function WipeOverlay({ scenes, figureRef, audioRef, time, endSec = null, planned = null, fps }) {
  const canvasRef = useRef(null);
  const heldRef = useRef({ key: null, canvas: null });
  const incomingRef = useRef(null);
  const cuts = useMemo(() => sceneWipeCuts(scenes, fps, { endSec, planned }), [scenes, fps, endSec, planned]);
  // The outgoing stills, loaded ahead, for a wipe reached by a seek rather than by playback.
  const stills = useMemo(() => {
    const byId = new Map((scenes || []).map((scene) => [scene.sceneId, scene]));
    const map = new Map();
    for (const cut of cuts) {
      const id = byId.get(cut.fromSceneId)?.referenceImageId;
      if (!id || typeof Image === 'undefined') continue;
      const img = new Image();
      img.src = `/data/images/${id}`;
      map.set(cut.fromSceneId, img);
    }
    return map;
  }, [scenes, cuts]);

  const paint = useCallback((t) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const frame = Math.floor(t * fps + 1e-6);
    const hide = () => { canvas.style.visibility = 'hidden'; };
    if (!box.width || !box.height) { hide(); return; }
    const width = Math.min(MAX_CANVAS_PX, Math.round(box.width * (window.devicePixelRatio || 1)));
    const height = Math.round(width * box.height / box.width);
    const held = heldRef.current;
    const ahead = cutAhead(cuts, frame);
    if (ahead) {
      // Keep the outgoing shot's picture as the frame shows it before the cut.
      held.canvas ||= document.createElement('canvas');
      const ctx = sizeCanvas(held.canvas, width, height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      held.key = drawFigurePicture(ctx, figureRef.current, width, height) ? `${ahead.cutFrame}:${width}x${height}` : null;
    }
    const cut = cutAt(cuts, frame);
    if (!cut) { hide(); return; }
    let outgoing = held.key === `${cut.cutFrame}:${width}x${height}` ? held.canvas : null;
    if (!outgoing) {
      const still = stills.get(cut.fromSceneId);
      if (!still?.complete || !still.naturalWidth) { hide(); return; }
      held.canvas ||= document.createElement('canvas');
      const ctx = sizeCanvas(held.canvas, width, height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      drawContained(ctx, still, width, height);
      held.key = `${cut.cutFrame}:${width}x${height}`;
      outgoing = held.canvas;
    }
    incomingRef.current ||= document.createElement('canvas');
    const incoming = incomingRef.current;
    const inCtx = sizeCanvas(incoming, width, height);
    inCtx.fillStyle = '#000';
    inCtx.fillRect(0, 0, width, height);
    drawFigurePicture(inCtx, figureRef.current, width, height);
    const out = sizeCanvas(canvas, width, height);
    const shown = !!out && paintWipe(out, {
      outgoing, incoming, style: cut.style, index: frame - cut.cutFrame, frames: cut.frames, color: cut.color || null, width, height,
    });
    canvas.style.visibility = shown ? 'visible' : 'hidden';
  }, [cuts, stills, fps, figureRef]);

  // A pause, a scrub or a frame step lands through `time`; playback runs on animation frames.
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
    if (!audio || !cuts.length) return undefined;
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
  }, [audioRef, cuts, paint]);
  if (!cuts.length) return null;
  return (
    <canvas
      ref={canvasRef}
      data-testid="animatic-wipe"
      data-wipes={cuts.length}
      style={{ visibility: 'hidden' }}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
