// Loads the Casting media a scene's `characterVariant` names, in the
// `{ [ingredientId]: media[] }` shape musicVideoConditioningReferences takes.
// The catalog lives in Postgres and is imported only for a scene that asks for
// a cast member, so a project without variants never touches it.

import { sceneCastVariant } from '../../lib/musicVideoConditioning.js';

/**
 * Null when the scene names no cast member, or when the catalog read fails: a
 * failed read conditions on the project's own references, as before #12763.
 */
export async function loadSceneCastMedia(scene, { listMedia = null } = {}) {
  const variant = sceneCastVariant(scene);
  if (!variant) return null;
  const list = listMedia || (await import('../catalogDB.js')).listMediaForIngredient;
  const media = await Promise.resolve().then(() => list(variant.ingredientId)).catch((err) => {
    console.warn(`⚠️ Cast guides for ${variant.ingredientId} unavailable, conditioning on project references: ${err.message}`);
    return null;
  });
  return Array.isArray(media) ? { [variant.ingredientId]: media } : null;
}
