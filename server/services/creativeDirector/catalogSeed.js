/**
 * Creative Director catalog ingredient seeding: pure transform of resolved ingredient records into the project `cast` array the treatment agent uses for per-scene casting.
 * Ingredients are also linked via catalog_ingredient_refs (ref_kind='creative-director'); see linkIngredientsToCreativeDirector in catalogDB.js.
 */

import { cdRefRoleForType } from '../catalog/catalogDB.js';
import { getActiveCatalogType, payloadSnippet } from '../../lib/catalog/catalogTypes.js';

const CAST_SUMMARY_CHARS = 200;
// Mirrors the catalogIngredientIds cap on the create schema — a CD treatment
// with more than ~50 cast members is past the point the agent can reason about
// them per scene, and bounds the JSONB the project row carries.
const MAX_CAST = 50;

/**
 * Build the project `cast` array from resolved ingredient records. Each member
 * carries the stable ingredientId (so the agent can reference it in per-scene
 * casting), a display name, the source type, the CD ref role, and a short
 * payload summary (omitted when empty). Skips records without an id.
 */
export function buildCastFromIngredients(ingredients = []) {
  const list = Array.isArray(ingredients) ? ingredients.filter((ing) => ing && ing.id) : [];
  return list.slice(0, MAX_CAST).map((ing) => {
    const summary = payloadSnippet(ing.payload, ing.type, CAST_SUMMARY_CHARS, getActiveCatalogType);
    const name = (typeof ing.name === 'string' && ing.name.trim()) ? ing.name.trim() : '(untitled)';
    return {
      ingredientId: ing.id,
      name,
      type: ing.type || 'other',
      role: cdRefRoleForType(ing.type),
      ...(summary ? { summary } : {}),
    };
  });
}
