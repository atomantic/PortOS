// Loads the Casting media a scene's saved references need, in the
// `{ [ingredientId]: media[] }` shape musicVideoConditioningReferences takes.
// The catalog lives in Postgres and is imported only for a scene that asks for
// a cast member, so a project without variants never touches it.

import { musicVideoSceneCastIds } from '../../lib/musicVideoConditioning.js';

/**
 * Null when the scene names no cast member, or when every catalog read fails: a
 * failed read conditions on the project's own references, as before #12763.
 * Pass the project so a shot's picks of linked catalog assets also resolve.
 */
export async function loadSceneCastMedia(scene, { listMedia = null, project = null } = {}) {
  const ids = musicVideoSceneCastIds(project, scene);
  if (!ids.length) return null;
  const list = listMedia || (await import('../catalogDB.js')).listMediaForIngredient;
  const loaded = await Promise.all(ids.map((id) => Promise.resolve().then(() => list(id)).catch((err) => {
    console.warn(`⚠️ Cast guides for ${id} unavailable, conditioning on project references: ${err.message}`);
    return null;
  }).then((media) => [id, media])));
  const entries = loaded.filter(([, media]) => Array.isArray(media));
  return entries.length ? Object.fromEntries(entries) : null;
}
