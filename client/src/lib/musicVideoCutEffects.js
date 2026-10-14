/**
 * Music Video cut effects — re-export of `server/lib/musicVideoCutEffects.js`,
 * so the shot card's beat toggle control and the animatic's toggling follow the
 * same settings and frames as the final render.
 */
export {
  BEAT_TOGGLE_OVERLAP,
  BEAT_TOGGLE_RATE_LABELS,
  BEAT_TOGGLE_RATES,
  MUSIC_VIDEO_CUT_EFFECT_LABELS,
  MUSIC_VIDEO_CUT_EFFECTS,
  beatToggleCuts,
  beatToggleSwitches,
  sceneBeatToggles,
  sceneCutEffect,
} from '../../../server/lib/musicVideoCutEffects.js';
