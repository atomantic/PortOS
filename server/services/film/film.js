/**
 * A Blender film as it stands on this machine, and the plan to join its shot
 * videos: which shot supplies each span of the picture, which spans are black
 * because a shot has no video yet, and which shots hold a final render back.
 * Reads only; assemble.js does the joining.
 */
import { join } from 'node:path';
import { blenderRenderFrame, blenderShotFrameRange, normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { blenderFinalsSignature, blenderFramesDir, blenderHandleFramePattern, blenderShotVideo, readBlenderRenders } from './renderIndex.js';
import { blenderFilmProblems, readBlenderManifest } from './manifest.js';
import { blenderRefusal } from './workspace.js';

/** `{ settings, manifest, shots, renders, cutEffects, problems }` for a project; `manifest` is null before the first sync. */
export async function readBlenderFilm(owner) {
  const { settings } = normalizeBlenderRecord(await owner.readRecord());
  const manifest = await readBlenderManifest(owner);
  const shots = manifest?.shots || [];
  const renders = shots.length ? await readBlenderRenders(owner, manifest, { settings }) : {};
  const timeline = await owner.timeline();
  const cutEffects = manifest ? (timeline.cutEffects?.(manifest) || []) : [];
  const problems = manifest
    ? blenderFilmProblems(manifest, { fps: settings.fps, durationSec: timeline.durationSec, cutEffects })
    : ['Sync shots from scripts first.'];
  return { owner, settings, manifest, shots, renders, cutEffects, problems };
}

export const blenderNotSynced = () => blenderRefusal('Sync shots from scripts first', 'MUSIC_VIDEO_BLENDER_NOT_SYNCED', 409);

const conforms = (render, frame, fps, frames) => render.width === frame.width && render.height === frame.height && render.fps === fps && render.frames === frames;

function buildTransitionSpec(owner, { effect, fromQ, toQ }, shots, ranges, from, to) {
  const fromShot = shots[effect.index];
  const toShot = shots[effect.index + 1];
  const fromRange = ranges[effect.index];
  const toRange = ranges[effect.index + 1];
  const beforeCutEnd = Math.min(to, effect.cutFrame);
  const afterCutStart = Math.max(from, effect.cutFrame);
  const incomingSpans = effect.style === 'beat-toggle'
    ? effect.incoming
      .map(([start, end]) => [Math.max(from, start) - from, Math.min(to, end) - from])
      .filter(([start, end]) => end > start)
    : [];
  return {
    style: effect.style,
    cutFrame: effect.cutFrame,
    windowStartFrame: effect.startFrame,
    windowEndFrame: effect.endFrame,
    segStartFrame: from,
    segEndFrame: to,
    outgoing: {
      video: from < effect.cutFrame ? blenderShotVideo(owner, fromShot.id, fromQ) : null,
      videoOffset: from < effect.cutFrame ? from - fromRange.startFrame : 0,
      videoFrames: from < effect.cutFrame ? beforeCutEnd - from : 0,
      handlePattern: effect.needOutFrames > 0 && to > effect.cutFrame ? join(blenderFramesDir(owner, fromShot.id, fromQ), blenderHandleFramePattern('out', fromQ)) : null,
      handleStart: to > effect.cutFrame ? afterCutStart : 0,
      handleFrames: to > effect.cutFrame ? to - afterCutStart : 0,
    },
    incoming: {
      handlePattern: from < effect.cutFrame ? join(blenderFramesDir(owner, toShot.id, toQ), blenderHandleFramePattern('in', toQ)) : null,
      handleStart: from < effect.cutFrame ? from : 0,
      handleFrames: from < effect.cutFrame ? beforeCutEnd - from : 0,
      video: to > effect.cutFrame ? blenderShotVideo(owner, toShot.id, toQ) : null,
      videoOffset: to > effect.cutFrame ? afterCutStart - toRange.startFrame : 0,
      videoFrames: to > effect.cutFrame ? to - afterCutStart : 0,
    },
    ...(incomingSpans.length ? { incomingSpans } : {}),
  };
}

function hasRenderedHandles(effect, fromRender, toRender) {
  if (!fromRender?.complete || !toRender?.complete) return false;
  if (effect.needOutFrames > 0 && (fromRender.handleFrames?.outFrames ?? 0) < effect.needOutFrames) return false;
  if (effect.needInFrames > 0 && (toRender.handleFrames?.inFrames ?? 0) < effect.needInFrames) return false;
  return true;
}

function planSegments(film, { first, last, frame, pickQuality, padEndBlack = false }) {
  const { settings, shots, renders, owner, cutEffects = [] } = film;
  const { fps } = settings;
  const ranges = shots.map((shot) => blenderShotFrameRange(shot, fps));
  const picked = shots.map((shot, index) => (ranges[index].endFrame > first && ranges[index].startFrame < last ? pickQuality(shot) : null));
  const activeByIndex = new Map();
  for (const effect of cutEffects) {
    if (effect.style !== 'dissolve' && effect.style !== 'beat-toggle') continue;
    const fromQ = picked[effect.index];
    const toQ = picked[effect.index + 1];
    if (!fromQ || !toQ) continue;
    if (!hasRenderedHandles(effect, renders[shots[effect.index].id]?.[fromQ], renders[shots[effect.index + 1].id]?.[toQ])) continue;
    activeByIndex.set(effect.index, { effect, fromQ, toQ });
  }
  const segments = [];
  let cursor = first;
  let incoming = null;
  for (const [index, shot] of shots.entries()) {
    const range = ranges[index];
    const outgoing = activeByIndex.get(index) || null;
    const bodyStart = incoming ? incoming.effect.endFrame : range.startFrame;
    const bodyEnd = outgoing ? outgoing.effect.startFrame : range.endFrame;
    if (!incoming) {
      const gapTo = Math.min(last, range.startFrame);
      if (gapTo > cursor) {
        segments.push({ shotId: null, source: null, offsetFrames: 0, frames: gapTo - cursor, direct: false });
        cursor = gapTo;
      }
    }
    const bodyFrom = Math.max(cursor, bodyStart);
    const bodyTo = Math.min(last, bodyEnd);
    if (bodyTo > bodyFrom) {
      const q = picked[index];
      if (!q) {
        segments.push({ shotId: shot.id, source: null, offsetFrames: 0, frames: bodyTo - bodyFrom, direct: false });
      } else {
        const render = renders[shot.id][q];
        const whole = bodyFrom === range.startFrame && bodyTo === range.endFrame;
        segments.push({
          shotId: shot.id,
          source: blenderShotVideo(owner, shot.id, q),
          offsetFrames: bodyFrom - range.startFrame,
          frames: bodyTo - bodyFrom,
          direct: whole && conforms(render, frame, fps, range.frameCount),
        });
      }
      cursor = bodyTo;
    }
    if (outgoing) {
      const tFrom = Math.max(cursor, outgoing.effect.startFrame);
      const tTo = Math.min(last, outgoing.effect.endFrame);
      if (tTo > tFrom) {
        segments.push({
          shotId: null,
          source: null,
          offsetFrames: 0,
          frames: tTo - tFrom,
          direct: false,
          transition: buildTransitionSpec(owner, outgoing, shots, ranges, tFrom, tTo),
        });
        cursor = tTo;
      }
    }
    incoming = outgoing;
  }
  if (padEndBlack && last > cursor) segments.push({ shotId: null, source: null, offsetFrames: 0, frames: last - cursor, direct: false });
  return segments;
}

/**
 * The segments of a work-in-progress cut at `quality`: every shot in film
 * order, its shot video when it has one and black frames when it does not.
 * `missing` and `stale` name the shots the cut is not final for.
 */
export function planBlenderCut(film, quality) {
  const { settings, shots, renders } = film;
  const frame = blenderRenderFrame(settings, quality);
  const missing = [];
  const stale = [];
  const last = shots.length ? Math.max(...shots.map((shot) => blenderShotFrameRange(shot, settings.fps).endFrame)) : 0;
  const segments = planSegments(film, {
    first: 0,
    last,
    frame,
    pickQuality: (shot) => {
      const render = renders[shot.id]?.[quality];
      if (!render?.complete) { missing.push(shot.id); return null; }
      if (render.stale) stale.push(shot.id);
      return quality;
    },
  });
  return { segments, missing, stale, width: frame.width, height: frame.height, fps: settings.fps };
}

/**
 * The plan for the final video: every shot's current final render, joined
 * whole. Throws 409 MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY (context
 * `{ missing, stale, problems }`) unless every shot has a complete, current
 * final render, its handle frames are on disk, and the film tiles the song.
 */
export function planBlenderFinal(film) {
  const plan = planBlenderCut(film, 'final');
  const missingHandles = [];
  for (const effect of film.cutEffects || []) {
    if (effect.style !== 'dissolve' && effect.style !== 'beat-toggle') continue;
    const fromShot = film.shots[effect.index];
    const toShot = film.shots[effect.index + 1];
    if (!hasRenderedHandles(effect, film.renders[fromShot?.id]?.final, film.renders[toShot?.id]?.final)) {
      if (fromShot && effect.needOutFrames > 0 && (film.renders[fromShot.id]?.final?.handleFrames?.outFrames ?? 0) < effect.needOutFrames) {
        missingHandles.push(`Shot ${fromShot.id} is missing rendered out handle frames for its ${effect.style === 'dissolve' ? 'dissolve' : 'beat toggle'}`);
      }
      if (toShot && effect.needInFrames > 0 && (film.renders[toShot.id]?.final?.handleFrames?.inFrames ?? 0) < effect.needInFrames) {
        missingHandles.push(`Shot ${toShot.id} is missing rendered in handle frames for its ${effect.style === 'dissolve' ? 'dissolve' : 'beat toggle'}`);
      }
    }
  }
  const problems = film.problems.length ? film.problems : missingHandles;
  if (plan.missing.length || plan.stale.length || problems.length || !film.shots.length) {
    const parts = [
      plan.missing.length ? `${plan.missing.length} without a final render (${plan.missing.slice(0, 8).join(', ')}${plan.missing.length > 8 ? ', ...' : ''})` : null,
      plan.stale.length ? `${plan.stale.length} changed since their final render (${plan.stale.slice(0, 8).join(', ')}${plan.stale.length > 8 ? ', ...' : ''})` : null,
      ...problems,
    ].filter(Boolean);
    throw blenderRefusal(`The Blender film is not ready for its final render: ${parts.join('; ') || 'no shots'}`,
      'MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY', 409, { missing: plan.missing, stale: plan.stale, problems });
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
  const { settings, renders } = film;
  const { fps } = settings;
  const frame = blenderRenderFrame(settings, 'final');
  const first = Math.round(startSec * fps);
  const last = Math.round(endSec * fps);
  const missing = [];
  const segments = planSegments(film, {
    first,
    last,
    frame,
    padEndBlack: true,
    pickQuality: (shot) => {
      const final = renders[shot.id]?.final;
      const preview = renders[shot.id]?.preview;
      const quality = final?.complete && !final.stale ? 'final' : preview?.complete ? 'preview' : final?.complete ? 'final' : null;
      if (!quality) missing.push(shot.id);
      return quality;
    },
  });
  if (missing.length) {
    throw blenderRefusal(`Render a preview or a final of ${missing.join(', ')} first: ${missing.length === 1 ? 'that shot has' : 'those shots have'} no video for this part of the song`,
      'MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY', 409, { missing, stale: [] });
  }
  return { segments, width: frame.width, height: frame.height, fps, startSec: first / fps, durationSec: (last - first) / fps };
}
