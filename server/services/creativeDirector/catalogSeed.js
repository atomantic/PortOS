/**
 * Creative Director — catalog ingredient seeding (#1808).
 *
 * Turns a list of resolved catalog ingredient records (characters / places /
 * objects / scenes / ideas) into the structured `cast` array stored on a CD
 * project and surfaced to the treatment agent. The agent uses the cast to ground
 * the treatment prompt and bind specific members to individual scenes (per-scene
 * casting). The same ingredients are linked to the project via
 * catalog_ingredient_refs (ref_kind='creative-director') — see
 * linkIngredientsToCreativeDirector in catalogDB.js — so the Catalog "Appears
 * in" panel and the convergence contract stay on one data model.
 *
 * Pure transform (no I/O), so it's unit-tested without a DB.
 */

import { cdRefRoleForType } from '../catalogDB.js';
import { getActiveCatalogType, payloadSnippet } from '../../lib/catalogTypes.js';

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
