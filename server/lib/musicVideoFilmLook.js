import { filmLookRuntimeSource, isFilmLookNeutral, normalizeFilmLook } from './filmLook.js';

/** A pinned shot look (including None), otherwise the video's look. */
export function shotFilmLook(project, scene) {
  const look = normalizeFilmLook(scene?.filmLook || project?.filmLook);
  return isFilmLookNeutral(look) ? null : look;
}

export const hasMusicVideoFilmLook = project => !isFilmLookNeutral(project?.filmLook)
  || (project?.scenes || []).some(scene => !isFilmLookNeutral(scene.filmLook));

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
      own: !!scene.filmLook, look: shotFilmLook(project, scene) }));
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
    const look = enabled ? (scene && t < scene.endSec && scene.own ? scene.look : base) : null;
    const key = JSON.stringify(look);
    if (key !== previous) { previous = key; apply(look); }
  };
  api.apply = next => { enabled = next !== null; base = next; select(); };
  api.frame = n => { at = Math.max(0, Math.floor(Number(n) || 0)); select(); frame(at); };
  select();
})();`;
}
