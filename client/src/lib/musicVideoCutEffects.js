/**
 * Music Video cut effects — re-export of `server/lib/musicVideoCutEffects.js`,
 * so the shot card's cut effect control and the animatic's toggles, dissolves and
 * fades follow the same settings and frames as the final render.
 */
export {
  BEAT_TOGGLE_OVERLAP,
  BEAT_TOGGLE_RATE_LABELS,
  BEAT_TOGGLE_RATES,
  MUSIC_VIDEO_CUT_EFFECT_LABELS,
  MUSIC_VIDEO_CUT_EFFECTS,
  beatToggleSwitches,
  cutEffectCuts,
  plannedCutEffect,
  plannedTransitions,
  sceneCutEffect,
  sceneCutEffects,
} from '../../../server/lib/musicVideoCutEffects.js';
