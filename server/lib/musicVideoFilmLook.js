import { filmLookRuntimeSource, isFilmLookNeutral, normalizeFilmLook } from './filmLook.js';

/** Aspects a camera can play inside the video frame. The video's own aspect stays on the treatment brief. */
export const MUSIC_VIDEO_CAMERA_FRAME_ASPECTS = Object.freeze(['16:9', '4:3', '3:2']);
const CAMERA_FRAME_RATIOS = { '16:9': 16 / 9, '4:3': 4 / 3, '3:2': 3 / 2, '9:16': 9 / 16, '1:1': 1 };

const evenInside = (n, limit) => {
  const even = Math.max(2, Math.round(n / 2) * 2);
  return Math.max(2, Math.min(even, limit - (limit % 2)));
};

/** The camera a shot is on, or null when the shot names none. */
export function shotCamera(project, scene) {
  const id = scene?.shotSheet?.cameraId;
  if (!id) return null;
  return (project?.cameras || []).find((camera) => camera?.id === id) || null;
}

/**
 * The look a shot finishes with: the shot's own, else its camera's, else the video's.
 * A present look wins even when it is Clean, so an explicit none does not fall through.
 * Null when that look changes nothing.
 */
export function shotFilmLook(project, scene) {
  const camera = shotCamera(project, scene);
  const look = normalizeFilmLook(scene?.filmLook ?? camera?.filmLook ?? project?.filmLook);
  return isFilmLookNeutral(look) ? null : look;
}

export const hasMusicVideoFilmLook = project => !isFilmLookNeutral(project?.filmLook)
  || (project?.scenes || []).some(scene => !isFilmLookNeutral(scene.filmLook))
  || (project?.cameras || []).some(camera => !isFilmLookNeutral(camera.filmLook));

/** Stored overscan as a percent of each edge, or null when it crops nothing. */
export function normalizeOverscan(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(8, Math.round(n * 100) / 100);
}

/** The video's overscan (0 when unset): a center crop of this percent off each edge, before the matte and the look. */
export const musicVideoOverscan = (project) => normalizeOverscan(project?.overscan) || 0;

/**
 * Even pixel window a camera aspect occupies inside `canvasW`×`canvasH`.
 * Null when the aspects already match (within 2%), so the chain stays full-bleed.
 * A narrower camera is pillarboxed; a wider one is letterboxed.
 */
export function cameraFrameWindow(canvasW, canvasH, aspect) {
  const ratio = CAMERA_FRAME_RATIOS[aspect];
  const width = Math.round(canvasW);
  const height = Math.round(canvasH);
  if (!ratio || width < 2 || height < 2) return null;
  const video = width / height;
  if (Math.abs(ratio - video) / video < 0.02) return null;
  const w = ratio < video ? evenInside(height * ratio, width) : evenInside(width, width);
  const h = ratio < video ? evenInside(height, height) : evenInside(width / ratio, height);
  if (w >= width && h >= height) return null;
  return { w, h };
}

/** CSS size of that window inside a 16:9 animatic. Null when the camera already fills it. */
export function cameraFrameCss(aspect) {
  const ratio = CAMERA_FRAME_RATIOS[aspect];
  const video = 16 / 9;
  if (!ratio || Math.abs(ratio - video) / video < 0.02) return null;
  if (ratio < video) return { width: `${(ratio / video) * 100}%`, height: '100%' };
  return { width: '100%', height: `${(video / ratio) * 100}%` };
}

/** Shared document render/preview finish, selected on absolute song frames.
 * apply(null) disables the preview finish; a neutral object enables shot looks
 * even when the video itself has no look. This does not change stored settings.
 */
export function documentFilmLookRuntime(project) {
  const scenes = (project?.scenes || [])
    .filter(scene => Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec)
    .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .sort((a, b) => a.startSec - b.startSec)
    .map(scene => ({ startSec: scene.startSec, endSec: scene.endSec,
      // A shot or camera look is pinned, including an explicit Clean. Absent follows the live video look.
      pinned: scene.filmLook != null || shotCamera(project, scene)?.filmLook != null,
      look: shotFilmLook(project, scene) }));
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  return filmLookRuntimeSource(project?.filmLook) + `
(() => {
  const api = globalThis.__portosFilmLook;
  const apply = api.apply.bind(api), frame = api.frame.bind(api);
  const scenes = ${json(scenes)};
  let base = ${json(shotFilmLook(project, null))};
  let enabled = true, at = 0, previous;
  const select = () => {
    const fps = Number(globalThis.portosComposition?.fps) || 24;
    const t = at / fps;
    // Latest-starting shot wins, matching the document engine; gaps use the video look.
    let scene = null;
    for (const candidate of scenes) { if (candidate.startSec > t) break; scene = candidate; }
    const look = enabled ? (scene && t < scene.endSec && scene.pinned ? scene.look : base) : null;
    const key = JSON.stringify(look);
    if (key !== previous) { previous = key; apply(look); }
  };
  api.apply = next => { enabled = next !== null; base = next; select(); };
  api.frame = n => { at = Math.max(0, Math.floor(Number(n) || 0)); select(); frame(at); };
  select();
})();`;
}
