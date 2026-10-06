/**
 * Music Video per-scene visual layers (#8985) — re-export of
 * `server/lib/musicVideoLayers.js`, so the board's layer picker and Render
 * readiness follow the same rules as the server's render preflight.
 */
export {
  MUSIC_VIDEO_VISUAL_LAYERS,
  MUSIC_VIDEO_STILL_MOVES,
  isSelfDrawnLayer,
  sceneVisualLayer,
  sceneHasAuthoredSpan,
  sceneRenderReady,
  isLayeredComposition,
  LAYERED_COMPOSITION_MODES,
} from '../../../server/lib/musicVideoLayers.js';
