import { useCallback, useEffect } from 'react';
import { selectedPerformanceInstruction } from '../../lib/musicVideoShotTiming.js';
import { clipOffsetSec, clipReversed, clipSpeedRate } from '../../lib/musicVideoLayers.js';
import { resolveSourceTake } from '../../../../server/lib/musicVideo/musicVideoSourceTake.js';

// The song frame the film look's grain and drift follow; footage renders run at 24 fps.
export const ANIMATIC_FPS = 24;
// How many shots past the one on screen get their clip loaded ahead, so a short shot is
// ready to show the moment the song reaches it.
export const CLIP_PRELOAD_SHOTS = 2;

export const timedShots = (scenes) => scenes.filter((scene) => Number.isFinite(scene?.startSec)).sort((a, b) => a.startSec - b.startSec);

/** The shot on screen at song time `t`: the last one that has started. */
export function shotAt(scenes, t) {
  const timed = timedShots(scenes);
  let current = timed[0] || null;
  for (const scene of timed) {
    if (scene.startSec <= t) current = scene;
    else break;
  }
  return current;
}

// Words need song analysis and at least one timed line; a title card can draw without words.
export const hasTimedLyrics = (project) => Number(project.audioAnalysis?.durationSec) > 0
  && (project.lyricCues || []).some((cue) => Number.isFinite(cue?.startSec) && String(cue?.text || '').trim());

/**
 * Lets the browser drop a video's download and decoder. Removing the element
 * alone does not: iOS Safari keeps both until the element is collected, and
 * after a few dozen cuts it stops loading new clips at all.
 *
 * Only an element that has left the page lets go. In development React replays
 * each effect's cleanup once on a mounted element (StrictMode), and a clip whose
 * source is known at mount (a film shot's render) would lose it and never load.
 */
export function releaseVideo(video) {
  if (!video || video.isConnected) return;
  video.pause?.();
  video.removeAttribute('src');
  video.load?.();
}

/**
 * Where song time `t` lands in a shot's clip: the take's edit-in point (a
 * performance take trimmed to the sung window) plus the time into the shot. Past
 * the clip's end it loops (`loop`, the render's default) or holds the last frame.
 * A hand-set speed and offset (lib/musicVideoLayers.js) play as the render plays
 * them: the offset moves the in-point by whole frames, a negative one past the
 * clip's start holds its first frame that long, and the speed runs the clip faster
 * or slower, looping round the whole file as the render's looped input does.
 * `early` follows the song's clock before the shot starts too (a beat toggle
 * into it, whose window opens at `fromSec`), reading the footage before its
 * in-point; with less footage than that it plays on from the clip's first
 * frame, as the render does, rather than holding it.
 */
export function clipTimeAt(scene, t, clipSec = null, { early = false, fromSec = null } = {}) {
  const sourceOffset = typeof scene?.sourceTake?.offsetSec === 'number' ? scene.sourceTake.offsetSec : null;
  const inSec = sourceOffset ?? selectedPerformanceInstruction(scene)?.edit?.inSec ?? 0;
  const holdsSource = sourceOffset != null;
  const local = early ? t - (scene.startSec || 0) : Math.max(0, t - (scene.startSec || 0));
  const rate = clipSpeedRate(scene);
  const start = inSec + clipOffsetSec(scene);
  // A negative offset holds the first frame before the clip runs; otherwise it runs from `start`.
  const position = (l) => (start >= 0 ? Math.max(0, start + l * rate) : Math.max(0, l + start) * rate);
  const at = early && local < 0 && fromSec != null && fromSec <= t
    ? position(fromSec - (scene.startSec || 0)) + (t - fromSec) * rate
    : position(local);
  if (clipReversed(scene)) {
    // Backwards from the file's end, as the render reads it once: past its start it holds the first frame shown last.
    if (!(clipSec > 0)) return 0;
    return Math.min(clipSec - 0.05, Math.max(0, clipSec - at));
  }
  if (rate !== 1 || start !== inSec) {
    if (!(clipSec > 0) || at < clipSec) return at;
    return !holdsSource && scene.loop !== false && !(inSec > 0) ? at % clipSec : Math.max(0, clipSec - 0.05);
  }
  if (local < 0) return at;
  if (!(clipSec > inSec)) return inSec + local;
  const span = clipSec - inSec;
  if (local < span) return inSec + local;
  return !holdsSource && scene.loop !== false ? inSec + (local % span) : Math.max(inSec, clipSec - 0.05);
}

/** The picture a shot plays: a return uses its source clip and frame, and keeps the timeline shot's identity. */
export function playedScene(scene, scenes) {
  if (!scene) return null;
  const resolved = resolveSourceTake(scene, scenes);
  if (!resolved) return scene;
  return {
    ...scene,
    videoHistoryId: resolved.videoHistoryId,
    referenceImageId: resolved.referenceImageId || scene.referenceImageId || null,
    sourceTake: {
      ...(scene.sourceTake || {}),
      sceneId: resolved.source?.sceneId || scene.sourceTake?.sceneId,
      offsetSec: resolved.offsetSec,
    },
  };
}

// A Blender shot's render already holds its speed, direction and framing, so the player reads only
// the shot's place on the song: it plays from its first frame, holds its last, and is fitted
// whole (a cut pads a render made at another size the same way). Cached per scene, so a shot's
// clip keeps one identity while the project is edited around it.
const filmScenes = new WeakMap();
export function filmScene(scene) {
  if (!filmScenes.has(scene)) {
    filmScenes.set(scene, { sceneId: scene.sceneId, label: scene.label, startSec: scene.startSec, endSec: scene.endSec, loop: false, frameFit: 'black' });
  }
  return filmScenes.get(scene);
}

// A film is black where a shot ends before the next begins, as a cut is. These stand-ins give
// the shot clock a frame to tick on there; they are never shown or counted as shots.
export function withFilmGaps(scenes) {
  const timed = timedShots(scenes);
  const gaps = timed
    .filter((scene, i) => Number.isFinite(scene.endSec) && scene.endSec > scene.startSec && scene.endSec < (timed[i + 1]?.startSec ?? Infinity))
    .map((scene) => ({ sceneId: `gap:${scene.sceneId}`, startSec: scene.endSec }));
  return gaps.length ? [...scenes, ...gaps] : scenes;
}

// Runs `apply(songTime)` on every animation frame while the song plays, and once more when it stops:
// the song's timeupdate is far too coarse for a beat flip or a smooth fade.
export function useSongFrames(audioRef, apply) {
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    let handle = 0;
    const tick = () => {
      apply(audio.currentTime || 0);
      handle = requestAnimationFrame(tick);
    };
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

// Keep shot selection on the same clock as its motion, without rendering the
// whole preview every frame. timeupdate still refreshes the transport readout.
export function useShotClock(audioRef, scenes, setTime) {
  const syncShot = useCallback((t) => {
    setTime((current) => (shotAt(scenes, current) === shotAt(scenes, t) ? current : t));
  }, [scenes, setTime]);
  useSongFrames(audioRef, syncShot);
}
