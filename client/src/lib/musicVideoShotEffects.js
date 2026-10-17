/**
 * Music Video shot effects at a glance: what each shot plays at its start, in
 * its middle and at its end, and how often the video uses each effect, so the
 * Shots board can badge every card and count every option.
 *
 * Read through the same helpers the render uses: a shot's cut transitions and
 * in-shot glitches (musicVideoTransitions.js), a still's image effect
 * (musicVideoImageEffects.js) and its switched-on cut effect, or the one its
 * storyboard row plans (musicVideoCutEffects.js).
 */
import { MUSIC_VIDEO_CUT_EFFECTS, MUSIC_VIDEO_CUT_EFFECT_LABELS, sceneCutEffect } from './musicVideoCutEffects.js';
import { MUSIC_VIDEO_IMAGE_EFFECTS, MUSIC_VIDEO_IMAGE_EFFECT_LABELS, sceneImageEffect } from './musicVideoImageEffects.js';
import { MUSIC_VIDEO_TRANSITIONS, MUSIC_VIDEO_TRANSITION_LABELS, sceneTransitions } from './musicVideoTransitions.js';

/** Where an effect plays in its shot. */
export const SHOT_EFFECT_SLOTS = Object.freeze(['start', 'mid', 'end']);
export const SHOT_EFFECT_SLOT_LABELS = Object.freeze({ start: 'Start', mid: 'Mid-shot', end: 'End' });

/**
 * Every effect option, `{ id, label, slots }`: the glitch styles play at any
 * slot, a cut effect only at a shot's end, an image effect only inside a still.
 */
export const SHOT_EFFECT_OPTIONS = Object.freeze([
  ...MUSIC_VIDEO_TRANSITIONS.map((id) => ({ id, label: MUSIC_VIDEO_TRANSITION_LABELS[id], slots: SHOT_EFFECT_SLOTS })),
  ...MUSIC_VIDEO_CUT_EFFECTS.map((id) => ({ id, label: MUSIC_VIDEO_CUT_EFFECT_LABELS[id], slots: ['end'] })),
  ...MUSIC_VIDEO_IMAGE_EFFECTS.map((id) => ({ id, label: MUSIC_VIDEO_IMAGE_EFFECT_LABELS[id], slots: ['mid'] })),
]);
const LABELS = new Map(SHOT_EFFECT_OPTIONS.map((option) => [option.id, option.label]));
export const shotEffectLabel = (id) => LABELS.get(id) || id;

/**
 * A shot's effects by slot, `{ start, mid, end }`, each a list of option ids
 * (an in-shot glitch style once per glitch). `planned` is `plannedTransitions`
 * of the storyboard rows, so a cut effect the row plans counts until the shot
 * sets its own.
 */
export function shotEffects(scene, { layered = false, planned = null } = {}) {
  const { transitionIn, transitionOut, shotGlitches = [] } = sceneTransitions(scene);
  const image = sceneImageEffect(scene, { layered });
  const cut = sceneCutEffect(scene, planned?.get(scene?.sceneId) ?? null);
  return {
    start: transitionIn ? [transitionIn] : [],
    mid: [...(image ? [image.effect] : []), ...shotGlitches.map((glitch) => glitch.style)],
    end: [...(transitionOut ? [transitionOut] : []), ...(cut?.enabled ? [cut.style] : [])],
  };
}

/** Whether a shot plays an effect anywhere in it. */
export const shotUsesEffect = (effects, id) => SHOT_EFFECT_SLOTS.some((slot) => effects[slot].includes(id));

/**
 * How often the video uses each effect option, from every shot's
 * `shotEffects`: `[{ id, label, slots, start, mid, end, total, shots }]` in
 * option order, unused options included with zeros. `shots` counts the shots
 * that play it anywhere.
 */
export function shotEffectCounts(shotsEffects) {
  return SHOT_EFFECT_OPTIONS.map((option) => {
    const row = { ...option, start: 0, mid: 0, end: 0, shots: 0 };
    for (const effects of shotsEffects) {
      for (const slot of SHOT_EFFECT_SLOTS) row[slot] += effects[slot].filter((id) => id === option.id).length;
      if (shotUsesEffect(effects, option.id)) row.shots += 1;
    }
    return { ...row, total: row.start + row.mid + row.end };
  });
}
