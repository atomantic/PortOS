/**
 * Music Video — per-scene visual layers (#8985, part of #8966).
 *
 * In a composed render a scene can show its generated footage (the default,
 * and every scene saved before the field existed), its selected still frame
 * with a deterministic camera move, or a code-rendered title card (a solid
 * colour whose text the typography layer draws). A plain concat render always
 * uses footage. Pure and dependency-free: the server render and the client
 * board read the same rules, so the Render button's readiness matches what the
 * render preflight accepts.
 */

export const MUSIC_VIDEO_VISUAL_LAYERS = ['footage', 'still', 'card'];
export const MUSIC_VIDEO_STILL_MOVES = ['hold', 'push', 'pan'];

/** The layer a scene contributes; `layered` is true only for a composed render. */
export function sceneVisualLayer(scene, { layered = false } = {}) {
  const layer = scene?.visualLayer;
  return layered && (layer === 'still' || layer === 'card') ? layer : 'footage';
}

/** A still/card section has no clip to measure, so it needs an authored span. */
export function sceneHasAuthoredSpan(scene) {
  return typeof scene?.startSec === 'number' && typeof scene?.endSec === 'number' && scene.endSec > scene.startSec;
}

/**
 * Whether the render can include this scene as-is: footage needs its clip, a
 * still needs its reference frame and a span, and a card needs only a span.
 */
export function sceneRenderReady(scene, { layered = false } = {}) {
  const layer = sceneVisualLayer(scene, { layered });
  if (layer === 'footage') return Boolean(scene?.videoHistoryId);
  if (!sceneHasAuthoredSpan(scene)) return false;
  return layer === 'card' || Boolean(scene.referenceImageId);
}
