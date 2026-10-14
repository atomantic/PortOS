/**
 * Music Video cut transitions — re-export of `server/lib/musicVideoTransitions.js`,
 * so the shot card's pickers (cut transitions and in-shot glitches) and the animatic's glitch frames follow the same
 * styles and frame placement as the final render.
 */
export {
  MUSIC_VIDEO_GLITCH_LENGTHS,
  MUSIC_VIDEO_SHOT_GLITCH_LIMIT,
  MUSIC_VIDEO_TRANSITIONS,
  MUSIC_VIDEO_TRANSITION_LABELS,
  MUSIC_VIDEO_TRANSITION_STYLES,
  mergeGlitchFrames,
  blockBox,
  sceneImageEffectGlitchFrames,
  sceneShotGlitchFrames,
  sceneTransitions,
  sceneTransitionSections,
  transitionFrameAt,
  transitionGlitchFrames,
} from '../../../server/lib/musicVideoTransitions.js';
