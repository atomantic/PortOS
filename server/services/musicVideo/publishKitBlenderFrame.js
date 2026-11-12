import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { blenderShotFrameRange } from '../../lib/musicVideoBlender.js';
import { readBlenderFilm } from './blender/film.js';
import { blenderFramesDir, blenderFrameName } from './blender/renderIndex.js';

/** Current lossless song frame, or the master fallback when shot frames were cleared. */
export async function publishKitBlenderFrame(project, atSec) {
  const { settings, shots, renders } = await readBlenderFilm(project);
  const frame = Math.floor(atSec * settings.fps);
  const shot = shots.find(shot => {
    const range = blenderShotFrameRange(shot, settings.fps);
    return frame >= range.startFrame && frame < range.endFrame;
  });
  const render = renders[shot?.id]?.final;
  if (!shot || !render?.complete || render.stale) return null;
  const path = join(blenderFramesDir(project.id, shot.id, 'final'), blenderFrameName(frame, 'final'));
  return existsSync(path) ? path : null;
}
