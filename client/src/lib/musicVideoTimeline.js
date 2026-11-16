/**
 * Pure layout for the Music Video editor timeline: shots on the song's clock, ruler ticks, lyric spans and zoom bounds.
 *
 * Everything here is a function of the project record and a zoom level (pixels per second), so the
 * timeline component only draws and handles pointers. Shots before the song (the cold open) and shots
 * with no time keep no place on the song's clock; `timelineShots` returns them apart, in board order.
 */
import { isPreMusicShot } from '../../../server/lib/musicVideoColdOpen.js';

/** The closest zoom: at the render's 24 fps a frame is 10 px wide, enough to place a cut on one. */
export const TIMELINE_MAX_PX_PER_SEC = 240;
/** One zoom step (a button press). */
export const TIMELINE_ZOOM_STEP = 1.5;

const onClock = (scene) => !isPreMusicShot(scene) && Number.isFinite(scene?.startSec) && Number.isFinite(scene?.endSec) && scene.endSec > scene.startSec;

/**
 * `{ shots, off }`: the shots on the song's clock in song order, each
 * `{ scene, sceneId, startSec, endSec, number }` (`number` as the player counts
 * it), and the shots with no place on it.
 */
export function timelineShots(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const shots = scenes.filter(onClock).sort((a, b) => a.startSec - b.startSec)
    .map((scene, i) => ({ scene, sceneId: scene.sceneId, startSec: scene.startSec, endSec: scene.endSec, number: i + 1 }));
  return { shots, off: scenes.filter((scene) => !onClock(scene)) };
}

/** How long the timeline runs: the analyzed song, or the last shot's end when that is later (or the song is not analyzed). */
export function timelineDurationSec(project, shots = timelineShots(project).shots) {
  const song = Number(project?.audioAnalysis?.durationSec);
  return Math.max(Number.isFinite(song) ? song : 0, ...shots.map((shot) => shot.endSec), 1);
}

/** The zoom at which the whole timeline fits `widthPx`; never closer than the closest zoom. */
export const fitPxPerSec = (widthPx, durationSec) => Math.min(TIMELINE_MAX_PX_PER_SEC, Math.max(0.5, widthPx / Math.max(durationSec, 1)));

/** `pxPerSec` kept between the fit zoom (the whole song in view) and the closest zoom. */
export const clampPxPerSec = (pxPerSec, fit) => Math.min(TIMELINE_MAX_PX_PER_SEC, Math.max(fit, pxPerSec));

const RULER_STEPS_SEC = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** The ruler's label interval at this zoom: the smallest round step whose labels sit at least `minPx` apart. */
export const rulerStepSec = (pxPerSec, minPx = 64) => RULER_STEPS_SEC.find((step) => step * pxPerSec >= minPx) ?? RULER_STEPS_SEC[RULER_STEPS_SEC.length - 1];

/** The ruler's label times from 0 through the timeline's end. */
export function rulerTicks(durationSec, stepSec) {
  return Array.from({ length: Math.floor(durationSec / stepSec + 1e-6) + 1 }, (_, i) => Math.round(i * stepSec * 1000) / 1000);
}

// A cue with no explicit end runs to the next cue (capped): the same reading the planner uses.
const OPEN_CUE_MAX_SEC = 8;

/** Timed lyric lines as spans `{ id, text, startSec, endSec }` in song order (#8964). */
export function lyricSpans(cues) {
  const timed = (Array.isArray(cues) ? cues : [])
    .filter((c) => typeof c?.startSec === 'number' && c.text)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  return timed.map((c, i) => {
    const next = timed[i + 1];
    const openEnd = Math.min(c.startSec + OPEN_CUE_MAX_SEC, next ? next.startSec : Infinity);
    return { id: c.id || `cue-${i}`, text: c.text, startSec: c.startSec, endSec: typeof c.endSec === 'number' && c.endSec > c.startSec ? c.endSec : openEnd };
  });
}

/** The shot on screen at song time `t` (the last one that has started), or null before the first. */
export function timelineShotAt(shots, t) {
  let current = null;
  for (const shot of shots) {
    if (shot.startSec <= t + 1e-3) current = shot; else break;
  }
  return current;
}
