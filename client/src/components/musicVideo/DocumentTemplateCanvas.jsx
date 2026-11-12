import { useEffect, useRef } from 'react';
import '../../../../server/services/musicVideo/documentTemplates/layered/cameraRig.js';
import { createDocumentTemplateDrawing } from './documentTemplateDrawing.js';
import { resolveSourceTake } from '../../../../server/lib/musicVideoSourceTake.js';
import { sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { sceneImageEffect, scenePhotoSequence, photoSequenceLayers, photoSequenceIndex } from '../../lib/musicVideoImageEffects.js';
import { blockBox, edgeGlows, glitchFrameParams, mergeGlitchFrames, sceneImageEffectGlitchFrames, sceneShotGlitchFrames, sceneTransitionSections, transitionGlitchFrames } from '../../lib/musicVideoTransitions.js';
import { createMusicVideoGlitchPainter } from '../../lib/musicVideoGlitchCanvas.js';
import { compileWipeNode, createMusicVideoWipePainter, wipeDefinition } from '../../lib/musicVideoWipes.js';
import './documentTemplateFonts.css';

const rig = globalThis.PORTOS_CAMERA_RIG;
const glitch = createMusicVideoGlitchPainter({ blockBox, edgeGlows });
const wipe = createMusicVideoWipePainter({ definitions: wipeDefinition, compile: compileWipeNode });

/** Trusted template drawing over the browser's playing media; no document code or worker. */
export default function DocumentTemplateCanvas({ project, data, figureRef, audioRef, time }) {
  const canvasRef = useRef(null);
  const timeRef = useRef(time);
  timeRef.current = time;
  const paintRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current, audio = audioRef.current;
    if (!canvas?.getContext('2d')?.createImageData || !audio) return undefined;
    canvas.width = data.render.width; canvas.height = data.render.height;
    const ctx = canvas.getContext('2d');
    const drawing = createDocumentTemplateDrawing(canvas, data, rig);
    const fps = data.render.fps;
    const scenes = data.scenes.filter(s => Number.isFinite(s.startSec) && s.endSec > s.startSec).sort((a, b) => a.startSec - b.startSec);
    const wipeAfter = new Map(scenes.filter(s => s.wipe).map(s => [s.wipe.fromSceneId, s.wipe]));
    const byId = new Map((project.scenes || []).map(s => [s.sceneId, s]));
    const options = { fps, beats: project.audioAnalysis?.beats || [] };
    const effectScenes = project.scenes || [];
    const endSec = data.song.durationSec;
    const effects = new Map(mergeGlitchFrames(
      transitionGlitchFrames(sceneTransitionSections(effectScenes, fps, { endSec, cameras: project.cameras })),
      sceneImageEffectGlitchFrames(effectScenes, fps, { layered: true, endSec, cameras: project.cameras }),
      sceneShotGlitchFrames(effectScenes, fps, { endSec, cameras: project.cameras }),
    ).map(effect => [effect.frame, glitchFrameParams(effect)]));
    const images = new Map();
    let active = true, handle = 0;
    const videoFrames = new Map();
    const watchVideo = video => {
      if (!video?.requestVideoFrameCallback || videoFrames.has(video)) return;
      videoFrames.set(video, video.requestVideoFrameCallback(() => {
        videoFrames.delete(video);
        if (!active || !video.isConnected) return;
        watchVideo(video);
        // seeked can precede the drawable frame. Playback has a paint loop,
        // but a paused composition must repaint when that frame is presented.
        if (audio.paused) paint();
      }));
    };
    const image = id => {
      if (!id) return null;
      let img = images.get(id);
      if (!img) {
        img = new Image(); img.onload = () => { if (active) paint(); };
        img.src = `/data/images/${encodeURIComponent(id)}`;
      }
      images.delete(id); images.set(id, img);
      while (images.size > 16) { const oldest = images.keys().next().value; images.get(oldest).onload = null; images.delete(oldest); }
      return img.complete && img.naturalWidth ? img : null;
    };
    const stack = document.createElement('canvas'); stack.width = canvas.width; stack.height = canvas.height;
    const stackCtx = stack.getContext('2d');
    const sourceFor = (scene, t) => {
      const original = byId.get(scene.sceneId);
      const selected = resolveSourceTake(original, project.scenes || []);
      const shot = selected ? { ...original, videoHistoryId: selected.videoHistoryId, referenceImageId: selected.referenceImageId || original?.referenceImageId } : original;
      const footage = sceneVisualLayer(shot, { layered: true }) === 'footage' && !!shot?.videoHistoryId;
      const video = [...(figureRef.current?.querySelectorAll('video[data-document-scene]') || [])].find(v => v.dataset.documentScene === scene.sceneId);
      if (footage) watchVideo(video);
      const sequence = !footage ? scenePhotoSequence(shot, options) : null;
      let source = footage && video?.readyState >= 2 && !video.seeking ? video : image(shot?.referenceImageId);
      if (sequence?.stacked) {
        const layers = photoSequenceLayers(sequence, t, { fps });
        const loaded = layers.map(layer => image(sequence.imageIds[layer.index]));
        if (loaded.every(Boolean)) {
          stackCtx.globalAlpha = 1; stackCtx.fillStyle = '#000'; stackCtx.fillRect(0, 0, stack.width, stack.height);
          layers.forEach((layer, i) => {
            const im = loaded[i], layout = layer.layout;
            const fit = (layout ? Math.min(stack.width / im.naturalWidth, stack.height / im.naturalHeight) * layout.scale : Math.max(stack.width / im.naturalWidth, stack.height / im.naturalHeight));
            const dw = im.naturalWidth * fit, dh = im.naturalHeight * fit;
            stackCtx.save(); stackCtx.globalAlpha = layout?.opacity ?? 1;
            stackCtx.translate(stack.width / 2 + (layout?.x || 0) * stack.width, stack.height / 2 + (layout?.y || 0) * stack.height);
            if (layout?.rotation) stackCtx.rotate(layout.rotation * Math.PI / 180);
            stackCtx.drawImage(im, -dw / 2, -dh / 2, dw, dh); stackCtx.restore();
          });
          source = stack;
        }
      } else if (sequence) source = image(sequence.imageIds[photoSequenceIndex(sequence, t, { fps })]);
      // Use the already-installed color-match filter, the same sRGB curve as the render.
      const filter = figureRef.current?.querySelector(`[data-document-color-match="${scene.sceneId.replace(/[^A-Za-z0-9_-]/g, '')}"]`)?.style.filter || null;
      return { source, footage, effect: sceneImageEffect(shot, { layered: true }), end: image(shot?.endImageId), filter };
    };
    const raw = document.createElement('canvas'); raw.width = canvas.width; raw.height = canvas.height;
    const held = document.createElement('canvas'); held.width = canvas.width; held.height = canvas.height;
    let heldScene = null;
    const drawScene = (scene, t) => {
      const media = scene ? sourceFor(scene, t) : {};
      return drawing.scene(t, scene, media.source, { ...media, index: scenes.indexOf(scene) });
    };
    const paint = () => {
      if (!active) return;
      for (const [video, pending] of videoFrames) if (!video.isConnected) {
        video.cancelVideoFrameCallback(pending); videoFrames.delete(video);
      }
      const songTime = audio.currentTime || timeRef.current || 0;
      const t = drawing.state(songTime).t;
      const scene = scenes.filter(s => s.startSec <= t && t < s.endSec).at(-1) || null;
      const frame = Math.floor(t * fps + 1e-6);
      const cut = scene?.wipe;
      if (cut && frame >= cut.cutFrame && frame < cut.cutFrame + cut.frames) {
        const outgoing = scenes.find(s => s.sceneId === cut.fromSceneId);
        if (heldScene !== `${outgoing?.sceneId}:${cut.cutFrame}`) {
          drawScene(outgoing, (cut.cutFrame - 0.5) / fps);
          held.getContext('2d').drawImage(canvas, 0, 0);
          // A seek fallback overwrites the playback cache and may still be
          // waiting on media. Repaint it until a real last-frame hold is cached.
          heldScene = null;
        }
        const fx = drawScene(scene, t);
        raw.getContext('2d').drawImage(canvas, 0, 0);
        wipe(ctx, { outgoing: held, incoming: raw, style: cut.style, index: frame - cut.cutFrame, frames: cut.frames, color: cut.color || null, width: canvas.width, height: canvas.height });
        drawing.finish(t, fx, scene);
      } else {
        const fx = drawScene(scene, t);
        const nextWipe = wipeAfter.get(scene?.sceneId);
        // Keep the latest displayed outgoing picture even when playback drops
        // the last frame before the cut. Only scenes feeding a wipe need a copy.
        if (nextWipe && frame < nextWipe.cutFrame) {
          held.getContext('2d').drawImage(canvas, 0, 0); heldScene = `${scene.sceneId}:${nextWipe.cutFrame}`;
        }
        drawing.finish(t, fx, scene);
      }
      const selectedEffect = effects.get(frame);
      if (selectedEffect) glitch(canvas, selectedEffect, frame);
      drawing.hud(t);
      canvas.dataset.songFrame = String(frame);
    };
    paintRef.current = paint;
    const tick = () => { paint(); handle = requestAnimationFrame(tick); };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(handle); paint(); };
    const onSeek = () => { heldScene = null; paint(); };
    audio.addEventListener('play', start); audio.addEventListener('pause', stop); audio.addEventListener('ended', stop);
    audio.addEventListener('seeking', onSeek); audio.addEventListener('seeked', onSeek);
    const figure = figureRef.current;
    figure?.addEventListener('loadeddata', paint, true); figure?.addEventListener('seeked', paint, true);
    Promise.all(['900 40px "MV Stencil"', '400 20px "MV Mono"', '600 20px "MV Mono"'].map(font => document.fonts.load(font))).then(() => { if (active) paint(); });
    paint(); if (!audio.paused) start();
    return () => {
      active = false; cancelAnimationFrame(handle); paintRef.current = null;
      for (const [video, pending] of videoFrames) video.cancelVideoFrameCallback(pending);
      videoFrames.clear();
      audio.removeEventListener('play', start); audio.removeEventListener('pause', stop); audio.removeEventListener('ended', stop);
      audio.removeEventListener('seeking', onSeek); audio.removeEventListener('seeked', onSeek);
      figure?.removeEventListener('loadeddata', paint, true); figure?.removeEventListener('seeked', paint, true);
      for (const img of images.values()) img.onload = null;
    };
  }, [project, data, figureRef, audioRef]);
  useEffect(() => { paintRef.current?.(); }, [time]);
  return <canvas ref={canvasRef} tabIndex={-1} aria-hidden="true" data-testid="document-template-canvas" className="pointer-events-none absolute inset-0 h-full w-full" />;
}
