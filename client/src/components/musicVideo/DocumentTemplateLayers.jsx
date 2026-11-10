import { useCallback, useEffect, useMemo, useRef } from 'react';
// The rig is a plain script the layered document also carries; loading it sets globalThis.PORTOS_CAMERA_RIG.
import '../../../../server/services/musicVideo/documentTemplates/layered/cameraRig.js';
import { documentCameraCss, documentCameraView, documentSceneIndexes } from '../../../../server/lib/musicVideoDocumentCamera.js';
import { templateEffects } from '../../../../server/lib/musicVideoTemplateEffects.js';

// Held from module load: the script runs once per module graph, and a global read later may not carry it.
const RIG = globalThis.PORTOS_CAMERA_RIG;

// The layered engine's noise tiles (documentTemplates/layered/engine.js: grain, buildGrain).
const GRAIN_TILE = 256;
const GRAIN_TILES = 6;
const FRAME_WIDTH = 1920;
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

let grainUrls = null;
// The engine's six noise tiles, built once for the page. Empty where a canvas cannot be read back.
function grainTiles() {
  if (grainUrls) return grainUrls;
  grainUrls = [];
  for (let n = 0; n < GRAIN_TILES; n += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = GRAIN_TILE; canvas.height = GRAIN_TILE;
    const context = canvas.getContext?.('2d');
    if (!context?.createImageData) return grainUrls;
    const image = context.createImageData(GRAIN_TILE, GRAIN_TILE);
    for (let i = 0; i < image.data.length; i += 4) {
      const v = 128 + (hash(i * 0.37 + n * 1013.3) - 0.5) * 255;
      image.data[i] = v; image.data[i + 1] = v; image.data[i + 2] = v; image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    grainUrls.push(canvas.toDataURL('image/png'));
  }
  return grainUrls;
}

// Runs `apply(songTime)` on every animation frame while the song plays, and once when it stops.
function useSongFrames(audioRef, apply) {
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    let handle = 0;
    const tick = () => { apply(audio.currentTime || 0); handle = requestAnimationFrame(tick); };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(handle); apply(audio.currentTime || 0); };
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
  }, [audioRef, apply]);
}

/**
 * `(scene, t, footage) => CSS transform`: the move the layered document draws
 * the scene's clip or still with. Null when `enabled` is off, so callers keep
 * their own move.
 */
export function useDocumentCamera(project, enabled) {
  const scenes = project.scenes;
  const beats = project.audioAnalysis?.beats;
  const downbeats = project.audioAnalysis?.downbeats;
  return useMemo(() => {
    if (!enabled || !RIG) return null;
    const indexes = documentSceneIndexes(scenes);
    return (scene, t, footage) => documentCameraCss(documentCameraView(RIG, scene, t, {
      templateEffects: project.templateEffects, footage, index: indexes.get(scene.sceneId) ?? 0, beats: beats || [], downbeats: downbeats || [],
    }));
  }, [enabled, scenes, beats, downbeats, project.templateEffects]);
}

/** A clip under the document's footage move (`camera` from `useDocumentCamera`). */
export function DocumentFootageMove({ scene, camera, audioRef, time, children }) {
  const ref = useRef(null);
  const apply = useCallback((t) => {
    if (ref.current) ref.current.style.transform = camera(scene, t, true);
  }, [camera, scene]);
  useEffect(() => { apply(time); }, [time, apply]);
  useSongFrames(audioRef, apply);
  return <div ref={ref} data-testid="document-footage-move" className="absolute inset-0 h-full w-full">{children}</div>;
}

/**
 * The vignette and grain the layered engine lays over every frame, above the
 * picture. Sized in container units, so it matches the engine's 1920-wide
 * frame at any preview size.
 */
export function DocumentTemplateFinish({ project, audioRef, time, fps }) {
  const vignetteRef = useRef(null);
  const grainRef = useRef(null);
  const tiles = useMemo(grainTiles, []);
  const apply = useCallback((t) => {
    const el = grainRef.current;
    const scene = project.scenes?.find((shot) => t >= shot.startSec && t < shot.endSec);
    const effects = templateEffects(project, scene);
    if (vignetteRef.current) vignetteRef.current.style.background = `radial-gradient(circle at center, rgba(0,0,0,0) 35cqmin, rgba(0,0,0,${effects.vignette}) 62cqmax)`;
    if (el) el.style.opacity = effects.grain;
    if (!el || !tiles.length) return;
    const frame = Math.floor(t * fps + 1e-6);
    const offset = hash(frame) * GRAIN_TILE;
    el.style.backgroundImage = `url(${tiles[frame % tiles.length]})`;
    el.style.backgroundPosition = `${-(offset / FRAME_WIDTH) * 100}cqw ${-(offset * 0.7 / FRAME_WIDTH) * 100}cqw`;
  }, [tiles, fps, project]);
  useEffect(() => { apply(time); }, [time, apply]);
  useSongFrames(audioRef, apply);
  return (
    <div aria-hidden="true" data-testid="document-template-finish" className="pointer-events-none absolute inset-0" style={{ containerType: 'size' }}>
      <div ref={vignetteRef} className="absolute inset-0" />
      <div ref={grainRef} className="absolute inset-0" style={{ opacity: 0, mixBlendMode: 'overlay', backgroundSize: `${(GRAIN_TILE / FRAME_WIDTH) * 100}cqw` }} />
    </div>
  );
}
