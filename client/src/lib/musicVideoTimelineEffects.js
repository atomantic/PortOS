/**
 * Pure layout of a shot's effects on the Music Video editor timeline, one row per kind: transitions, cut effects, image effects and in-shot effect markers.
 *
 * Read through the render's own helpers (`sceneTransitions` with the camera's cut defaults,
 * `sceneCutEffect`, `sceneImageEffect`), the same ones the Shots board's effect badges use, so the
 * timeline and the board never disagree about what a shot plays. Markers come from the shot's saved
 * `glitches` list and keep its indexes, so a moved marker is saved back as that list with one `atSec` changed.
 */
import { sceneCutEffect } from '../../../server/lib/musicVideo/musicVideoCutEffects.js';
import { sceneImageEffect } from '../../../server/lib/musicVideo/musicVideoImageEffects.js';
import { shotEffectLabel } from './musicVideoShotEffects.js';
import {
  MUSIC_VIDEO_GLITCH_REPEAT_LIMIT, MUSIC_VIDEO_TRANSITIONS, MUSIC_VIDEO_TRANSITION_STYLES, applyCameraCutDefaults, sceneTransitions,
} from '../../../server/lib/musicVideo/musicVideoTransitions.js';

const FPS = 24;
const round3 = (n) => Math.round(n * 1000) / 1000;
/** The longest an in-shot effect may run: the server's own bound on `lengthSec`. */
export const EFFECT_MAX_LENGTH_SEC = 4;
const FRAME_SEC = 1 / FPS;

/** How long a style plays when no length is set: its own frames, once, at the render's 24 fps. */
export const effectNaturalSec = (style) => (MUSIC_VIDEO_TRANSITION_STYLES[style]?.frames.length || 1) / FPS;

/**
 * One timeline shot's effects, one entry per kind so each draws on its own row:
 * - `transitions`: the effects over its cuts, `[{ side: 'in' | 'out', label, lengthSec }]`
 *   (a glitch over the cut has no length of its own, `lengthSec` null; a wipe has its length);
 * - `cut`: how it hands over to the next shot (a beat toggle or dissolve before the cut, a fade
 *   across it), `{ label, startSec, endSec }` on the song's clock, or null;
 * - `image`: a still's image effect over the whole shot, `{ label, startSec, endSec }`, or null;
 * - `markers`: its in-shot effects, `{ id, index, atSec, t, lengthSec, repeats, label, off }`:
 *   `index` into `scene.glitches`, `atSec` from the shot's start, `t` and `repeats` on the song's
 *   clock, `off` when its strength is zero; `lengthSec` is the set length or null, `playSec` how
 *   long it plays (the set length, else the style's own).
 * `options` are `shotEffects`' own (`{ layered, planned, cameras }`).
 */
export function timelineShotEffects(shot, options = {}) {
  const { scene } = shot;
  const { transitionIn, transitionOut, wipeIn, wipeOut } = sceneTransitions(applyCameraCutDefaults(scene, options.cameras));
  const transitions = [['in', transitionIn, wipeIn], ['out', transitionOut, wipeOut]].flatMap(([side, glitch, wipe]) => {
    if (glitch) return [{ side, label: shotEffectLabel(glitch), lengthSec: null }];
    return wipe ? [{ side, label: shotEffectLabel(wipe.style), lengthSec: wipe.lengthSec }] : [];
  });
  const handover = sceneCutEffect(scene, options.planned?.get(scene.sceneId) ?? null);
  const fade = handover?.style === 'fade-black';
  const cut = handover?.enabled ? {
    label: shotEffectLabel(handover.style),
    startSec: Math.max(shot.startSec, shot.endSec - (fade ? handover.overlapSec / 2 : handover.overlapSec)),
    endSec: shot.endSec + (fade ? handover.overlapSec / 2 : 0),
  } : null;
  const still = sceneImageEffect(scene, { layered: !!options.layered });
  const image = still ? { label: shotEffectLabel(still.effect), startSec: shot.startSec, endSec: shot.endSec } : null;
  const span = shot.endSec - shot.startSec;
  const markers = [];
  (Array.isArray(scene.glitches) ? scene.glitches : []).forEach((glitch, index) => {
    if (!glitch || !MUSIC_VIDEO_TRANSITIONS.includes(glitch.style) || !Number.isFinite(glitch.atSec)) return;
    const atSec = Math.min(Math.max(0, glitch.atSec), span);
    const count = Number.isInteger(glitch.count) && Number.isFinite(glitch.everySec) && glitch.everySec > 0 ? Math.min(glitch.count, MUSIC_VIDEO_GLITCH_REPEAT_LIMIT) : 1;
    const repeats = [];
    // A repeat never plays past its shot.
    for (let k = 1; k < count && atSec + k * glitch.everySec < span; k += 1) repeats.push(round3(shot.startSec + atSec + k * glitch.everySec));
    markers.push({
      id: `${shot.sceneId}:${index}`, index, atSec, t: shot.startSec + atSec,
      lengthSec: Number.isFinite(glitch.lengthSec) && glitch.lengthSec > 0 ? glitch.lengthSec : null,
      playSec: Number.isFinite(glitch.lengthSec) && glitch.lengthSec > 0 ? glitch.lengthSec : effectNaturalSec(glitch.style),
      repeats, label: shotEffectLabel(glitch.style), off: glitch.strength === 0,
    });
  });
  return { transitions, cut, image, markers };
}

/**
 * Where an in-shot effect dragged to song time `t` lands, counted from its
 * shot's start: on a frame of the shot, pulled onto a snap point (a beat, a
 * lyric line) within `toleranceSec`, and kept inside the shot. Returns
 * `{ atSec, snapped }`.
 */
export function effectTimeAt(shot, t, points = [], toleranceSec = 0) {
  const span = shot.endSec - shot.startSec;
  let nearest = null;
  for (const point of points) {
    const distance = Math.abs(point - t);
    if (distance <= toleranceSec && point >= shot.startSec && point < shot.endSec && (nearest == null || distance < Math.abs(nearest - t))) nearest = point;
  }
  if (nearest != null) return { atSec: round3(nearest - shot.startSec), snapped: true };
  const lastFrame = Math.max(0, Math.ceil(span * FPS - 1e-6) - 1) / FPS;
  return { atSec: round3(Math.min(Math.max(0, Math.round((t - shot.startSec) * FPS) / FPS), lastFrame)), snapped: false };
}

/**
 * Where an in-shot effect lands when one of its ends is dragged to song time
 * `t` (`edge` 'start' or 'end'): the other end stays put, the dragged one lands
 * on a frame (or a snap point within `toleranceSec`), and the effect keeps at
 * least a frame and at most `EFFECT_MAX_LENGTH_SEC`, inside its shot. Returns
 * `{ atSec, lengthSec, snapped }`.
 */
export function effectTrimAt(shot, marker, edge, t, points = [], toleranceSec = 0) {
  const span = shot.endSec - shot.startSec;
  const startSec = marker.atSec;
  const endSec = marker.atSec + marker.playSec;
  let nearest = null;
  for (const point of points) {
    const distance = Math.abs(point - t);
    if (distance <= toleranceSec && (nearest == null || distance < Math.abs(nearest - t))) nearest = point;
  }
  const at = nearest != null ? nearest - shot.startSec : Math.round((t - shot.startSec) * FPS) / FPS;
  if (edge === 'end') {
    const end = Math.min(Math.max(at, startSec + FRAME_SEC), startSec + EFFECT_MAX_LENGTH_SEC, span);
    return { atSec: startSec, lengthSec: round3(Math.max(FRAME_SEC, end - startSec)), snapped: nearest != null && Math.abs(end - at) < 1e-6 };
  }
  const start = Math.max(0, endSec - EFFECT_MAX_LENGTH_SEC, Math.min(at, endSec - FRAME_SEC));
  return { atSec: round3(start), lengthSec: round3(endSec - start), snapped: nearest != null && Math.abs(start - at) < 1e-6 };
}

/** A shot's saved effects with the one at `index` changed by `patch`. */
export const glitchesWithEdit = (glitches, index, patch) => glitches.map((glitch, i) => (i === index ? { ...glitch, ...patch } : glitch));
