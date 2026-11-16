/**
 * Pure layout of a shot's effects on the Music Video editor timeline: its cut effects, in-shot effect markers with their repeats, and where a dragged marker lands.
 *
 * Read through `shotEffects`, the same summary the Shots board badges from, so the timeline and the
 * board never disagree about what a shot plays. Markers come from the shot's saved `glitches` list and
 * keep its indexes, so a moved marker is saved back as that list with one `atSec` changed.
 */
import { sceneImageEffect } from './musicVideoImageEffects.js';
import { shotEffectLabel, shotEffects } from './musicVideoShotEffects.js';
import { MUSIC_VIDEO_GLITCH_REPEAT_LIMIT, MUSIC_VIDEO_TRANSITIONS } from './musicVideoTransitions.js';

const FPS = 24;
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * One timeline shot's effects: `{ start, end, image, markers }`. `start` and
 * `end` are the labels of the effects over its cuts, `image` the label of a
 * still's image effect (it plays through the whole shot) or null, and
 * `markers` its in-shot effects, `{ id, index, atSec, t, lengthSec, repeats,
 * label, off }`: `index` into `scene.glitches`, `atSec` from the shot's start,
 * `t` and `repeats` on the song's clock, `off` when its strength is zero.
 * `options` are `shotEffects`' own.
 */
export function timelineShotEffects(shot, options = {}) {
  const { scene } = shot;
  const effects = shotEffects(scene, options);
  const image = sceneImageEffect(scene, { layered: !!options.layered });
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
      repeats, label: shotEffectLabel(glitch.style), off: glitch.strength === 0,
    });
  });
  return { start: effects.start.map(shotEffectLabel), end: effects.end.map(shotEffectLabel), image: image ? shotEffectLabel(image.effect) : null, markers };
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

/** A shot's saved effects with the one at `index` moved to `atSec`. */
export const glitchesWithMove = (glitches, index, atSec) => glitches.map((glitch, i) => (i === index ? { ...glitch, atSec } : glitch));
