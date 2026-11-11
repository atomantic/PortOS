/**
 * A Blender film as it stands on this machine, and the plan to join its shot
 * videos: which shot supplies each span of the picture, which spans are black
 * because a shot has no video yet, and which shots hold a final render back.
 * Reads only; assemble.js does the joining.
 */
import { blenderRenderFrame, blenderShotFrameRange, normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { blenderFinalsSignature, blenderShotVideo, readBlenderRenders } from './renderIndex.js';
import { blenderFilmProblems, readBlenderManifest } from './manifest.js';
import { blenderRefusal } from './workspace.js';

/** `{ settings, manifest, shots, renders, problems }` for a project; `manifest` is null before the first sync. */
export async function readBlenderFilm(project) {
  const { settings } = normalizeBlenderRecord(project.blender);
  const manifest = await readBlenderManifest(project.id);
  const shots = manifest?.shots || [];
  const renders = shots.length ? await readBlenderRenders(project.id, manifest, { settings }) : {};
  const problems = manifest ? blenderFilmProblems(manifest, { fps: settings.fps, durationSec: project.audioAnalysis?.durationSec }) : ['Sync shots from scripts first.'];
  return { projectId: project.id, settings, manifest, shots, renders, problems };
}

export const blenderNotSynced = () => blenderRefusal('Sync shots from scripts first', 'MUSIC_VIDEO_BLENDER_NOT_SYNCED', 409);

const conforms = (render, frame, fps, frames) => render.width === frame.width && render.height === frame.height && render.fps === fps && render.frames === frames;

/**
 * The segments of a work-in-progress cut at `quality`: every shot in film
 * order, its shot video when it has one and black frames when it does not.
 * `missing` and `stale` name the shots the cut is not final for.
 */
export function planBlenderCut(film, quality) {
  const { settings, shots, renders, projectId } = film;
  const frame = blenderRenderFrame(settings, quality);
  const missing = [];
  const stale = [];
  const segments = [];
  // The picture starts at the song's first frame, so a gap in the shot list is
  // black and every shot still lands on its own beat.
  let cursor = 0;
  for (const shot of shots) {
    const { startFrame, endFrame, frameCount } = blenderShotFrameRange(shot, settings.fps);
    if (startFrame > cursor) segments.push({ shotId: null, source: null, offsetFrames: 0, frames: startFrame - cursor, direct: false });
    const render = renders[shot.id]?.[quality];
    if (!render?.complete) {
      missing.push(shot.id);
      segments.push({ shotId: shot.id, source: null, offsetFrames: 0, frames: frameCount, direct: false });
    } else {
      if (render.stale) stale.push(shot.id);
      segments.push({ shotId: shot.id, source: blenderShotVideo(projectId, shot.id, quality), offsetFrames: 0, frames: frameCount,
        direct: conforms(render, frame, settings.fps, frameCount) });
    }
    cursor = endFrame;
  }
  return { segments, missing, stale, width: frame.width, height: frame.height, fps: settings.fps };
}

/**
 * The plan for the final video: every shot's current final render, joined
 * whole. Throws 409 MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY (context
 * `{ missing, stale, problems }`) unless every shot has a complete, current
 * final render and the film tiles the song.
 */
export function planBlenderFinal(film) {
  const plan = planBlenderCut(film, 'final');
  if (plan.missing.length || plan.stale.length || film.problems.length || !film.shots.length) {
    const parts = [
      plan.missing.length ? `${plan.missing.length} without a final render (${plan.missing.slice(0, 8).join(', ')}${plan.missing.length > 8 ? ', ...' : ''})` : null,
      plan.stale.length ? `${plan.stale.length} changed since their final render (${plan.stale.slice(0, 8).join(', ')}${plan.stale.length > 8 ? ', ...' : ''})` : null,
      ...film.problems,
    ].filter(Boolean);
    throw blenderRefusal(`The Blender film is not ready for its final render: ${parts.join('; ') || 'no shots'}`,
      'MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY', 409, { missing: plan.missing, stale: plan.stale, problems: film.problems });
  }
  const frames = plan.segments.reduce((sum, segment) => sum + segment.frames, 0);
  return { ...plan, durationSec: frames / plan.fps, boundaryTimes: film.shots.map((shot) => shot.start),
    // Which shot renders this final is joined from: a shot rendered later makes it out of date.
    signature: blenderFinalsSignature(film.shots, film.renders) };
}

/**
 * The segments of the song window `[startSec, endSec)` at the final frame
 * size: each shot's best video (a current final, else its preview fitted up,
 * else an out-of-date final), cut to the window, with black where the film has
 * no shot. Throws 409 MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY naming a shot in the
 * window that has no video at all.
 */
export function planBlenderWindow(film, { startSec, endSec }) {
  const { settings, shots, renders, projectId } = film;
  const { fps } = settings;
  const frame = blenderRenderFrame(settings, 'final');
  const first = Math.round(startSec * fps);
  const last = Math.round(endSec * fps);
  const segments = [];
  const missing = [];
  let cursor = first;
  for (const shot of shots) {
    const range = blenderShotFrameRange(shot, fps);
    const from = Math.max(first, range.startFrame);
    const to = Math.min(last, range.endFrame);
    if (to <= from) continue;
    if (from > cursor) segments.push({ shotId: null, source: null, offsetFrames: 0, frames: from - cursor, direct: false });
    const final = renders[shot.id]?.final;
    const preview = renders[shot.id]?.preview;
    const quality = final?.complete && !final.stale ? 'final' : preview?.complete ? 'preview' : final?.complete ? 'final' : null;
    if (!quality) missing.push(shot.id);
    else {
      const render = renders[shot.id][quality];
      const whole = from === range.startFrame && to === range.endFrame;
      segments.push({ shotId: shot.id, source: blenderShotVideo(projectId, shot.id, quality), offsetFrames: from - range.startFrame, frames: to - from,
        direct: whole && conforms(render, frame, fps, range.frameCount) });
    }
    cursor = to;
  }
  if (missing.length) {
    throw blenderRefusal(`Render a preview or a final of ${missing.join(', ')} first: ${missing.length === 1 ? 'that shot has' : 'those shots have'} no video for this part of the song`,
      'MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY', 409, { missing, stale: [] });
  }
  if (last > cursor) segments.push({ shotId: null, source: null, offsetFrames: 0, frames: last - cursor, direct: false });
  return { segments, width: frame.width, height: frame.height, fps, startSec: first / fps, durationSec: (last - first) / fps };
}
