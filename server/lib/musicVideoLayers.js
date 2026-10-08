/**
 * Music Video — per-scene visual layers (#8985, part of #8966).
 *
 * In a composed render a scene can show its generated footage (the default,
 * and every scene saved before the field existed), its selected still frame
 * with a deterministic camera move, a code-rendered title card (a solid
 * colour whose text the typography layer draws), or a code shot (#10297) that
 * the composition's own code draws. A composition document is handed the
 * `code` layer and no media; whatever its section code draws is the shot (the
 * stock layered template draws nothing extra, leaving the ground and the type).
 * A composed render has no code to run, so it lays a black ground under its
 * typography. Cards and code shots need no frame or clip. A plain concat render always
 * uses footage. Pure and dependency-free: the server render and the client
 * board read the same rules, so the Render button's readiness matches what the
 * render preflight accepts.
 */

export const MUSIC_VIDEO_VISUAL_LAYERS = ['footage', 'still', 'card', 'code'];

/** Layers the composition draws itself: no reference frame and no clip to generate. */
export const isSelfDrawnLayer = (layer) => layer === 'card' || layer === 'code';
export const MUSIC_VIDEO_STILL_MOVES = ['hold', 'push', 'pan'];

/**
 * Kinetic lyric type per shot (#10583), read by the shared lyricType.js document
 * module: `textZone` is where the shot's words may sit so they never cover the
 * subject (`none` keeps the shot clear), and `lyricRole` overrides the role of the
 * lines sung over it. Both are optional; a shot without them takes the sheet's roles
 * and the module's default zone.
 */
export const MUSIC_VIDEO_TEXT_ZONES = ['lower-left', 'upper-right', 'center', 'none'];
export const MUSIC_VIDEO_LYRIC_ROLES = ['line', 'hook', 'stamp', 'data'];

/**
 * Whether a composition honours per-scene layers: a composed render cuts
 * stills and cards itself, and a composition document (mode `document`) is
 * handed each scene's layer in `window.PORTOS_MV` and draws still/card/code
 * scenes itself — neither needs a clip for them, and a card or code shot needs
 * no frame either.
 * Plain concat and code renders play footage only.
 */
export const LAYERED_COMPOSITION_MODES = Object.freeze(['composed', 'document']);
export const isLayeredComposition = (project) => LAYERED_COMPOSITION_MODES.includes(project?.composition?.mode);

/** The layer a scene contributes; `layered` is true only for a layered composition (see isLayeredComposition). */
export function sceneVisualLayer(scene, { layered = false } = {}) {
  const layer = scene?.visualLayer;
  return layered && (layer === 'still' || isSelfDrawnLayer(layer)) ? layer : 'footage';
}

/** A generated document executes the explicit code-first medium plan. */
export function documentSceneVisualLayer(project, scene, { generated = false } = {}) {
  if (!generated || project?.productionPolicy?.strategy !== 'code-first') return sceneVisualLayer(scene, { layered: true });
  const direction = (project?.treatment?.shotDirections || []).find((entry) => entry.sceneId === scene.sceneId)
    || scene?.direction;
  // A director's code shot stays code; only a planned procedural span becomes the template's card.
  if (direction?.medium === 'procedural') return scene?.visualLayer === 'code' ? 'code' : 'card';
  if (direction?.medium === 'still') return 'still';
  if (direction?.medium === 'existing-footage' || direction?.medium === 'generated-footage') return 'footage';
  return sceneVisualLayer(scene, { layered: true });
}

/** A still/card/code section has no clip to measure, so it needs an authored span. */
export function sceneHasAuthoredSpan(scene) {
  return typeof scene?.startSec === 'number' && typeof scene?.endSec === 'number' && scene.endSec > scene.startSec;
}

/**
 * Whether the render can include this scene as-is: footage needs its clip, a
 * still needs its reference frame and a span, and a card or code shot needs only a span.
 */
export function sceneRenderReady(scene, { layered = false } = {}) {
  const layer = sceneVisualLayer(scene, { layered });
  if (layer === 'footage') return Boolean(scene?.videoHistoryId);
  if (!sceneHasAuthoredSpan(scene)) return false;
  return isSelfDrawnLayer(layer) || Boolean(scene.referenceImageId);
}
