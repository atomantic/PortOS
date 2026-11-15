/**
 * Client re-export of music-video wipes (image-to-image cut transitions): styles, groups, labels,
 * `sceneWipe`, `wipeDefinition` and `compileWipeNode`.
 *
 * Music-video wipes (image-to-image transitions on a cut), re-exported from
 * `server/lib/musicVideoWipes.js`: styles, groups, labels, lengths, `sceneWipe`, `wipeDefinition`,
 * `compileWipeNode` and `createMusicVideoWipePainter`. Used by
 * `components/musicVideo/SceneTransitions.jsx` and the storyboard animatic's `WipeOverlay`.
 */

/**
 * Music Video wipes — re-export of `server/lib/musicVideoWipes.js`, so the shot
 * card's wipe picker and the animatic's painter use the same styles and
 * definitions as the final render.
 */
export {
  MUSIC_VIDEO_EDGED_WIPES,
  MUSIC_VIDEO_WIPE_GROUP_LABELS,
  MUSIC_VIDEO_WIPE_GROUPS,
  MUSIC_VIDEO_WIPE_LABELS,
  MUSIC_VIDEO_WIPE_LENGTHS,
  MUSIC_VIDEO_WIPE_SEC,
  MUSIC_VIDEO_WIPES,
  compileWipeNode,
  createMusicVideoWipePainter,
  sceneWipe,
  wipeDefinition,
} from '../../../server/lib/musicVideoWipes.js';
