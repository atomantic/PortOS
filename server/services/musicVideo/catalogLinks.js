// Keeps a music video's catalog links (catalog_ingredient_refs, ref_kind
// 'music-video') in step with the subjects it cast from Casting, Environments
// and Objects, so a catalog record shows which videos use it. The subjects keep
// their own name/description snapshot; only the link lives in the catalog.

import { isFileBackend } from '../../lib/pgFileFacade.js';

const REF_KIND = 'music-video';

// `ingredientId → role` for the project's catalog-linked subjects.
export function desiredCatalogLinks(project, roleForType) {
  const subjects = project && !project.deleted && Array.isArray(project.concept?.subjects) ? project.concept.subjects : [];
  const links = new Map();
  for (const subject of subjects) {
    if (typeof subject?.ingredientId === 'string' && subject.ingredientId) {
      links.set(subject.ingredientId, roleForType(subject.kind));
    }
  }
  return links;
}

// One sync per project at a time; a save landing mid-sync re-syncs after.
const syncing = new Map();

/**
 * Link every catalog-cast subject and unlink records the project no longer
 * casts. A deleted (or missing) project unlinks everything. Fire-and-forget
 * from the project write paths: the save already succeeded.
 */
export function syncProjectCatalogLinks(projectId) {
  if (!projectId || isFileBackend()) return Promise.resolve(null);
  const running = syncing.get(projectId);
  if (running) {
    running.again = true;
    return running.promise;
  }
  const state = { again: false, promise: null };
  state.promise = (async () => {
    const [catalogDB, { getProject }] = await Promise.all([import('../catalogDB.js'), import('./projects.js')]);
    let stats = null;
    do {
      state.again = false;
      const project = await getProject(projectId);
      const desired = desiredCatalogLinks(project, catalogDB.musicVideoRefRoleForType);
      const current = await catalogDB.listIngredientsForRef(REF_KIND, projectId);
      stats = { linked: 0, unlinked: 0 };
      for (const { ingredient, role } of current) {
        if (desired.get(ingredient.id) === role) continue;
        await catalogDB.unlinkIngredientFromRef(ingredient.id, REF_KIND, projectId, role);
        stats.unlinked++;
      }
      const have = new Set(current.map(({ ingredient, role }) => `${ingredient.id}\n${role}`));
      for (const [ingredientId, role] of desired) {
        if (have.has(`${ingredientId}\n${role}`)) continue;
        await catalogDB.linkIngredientToRef(ingredientId, REF_KIND, projectId, role);
        stats.linked++;
      }
    } while (state.again);
    return stats;
  })().finally(() => syncing.delete(projectId));
  syncing.set(projectId, state);
  return state.promise;
}

export function queueProjectCatalogLinkSync(projectId) {
  syncProjectCatalogLinks(projectId).catch((err) => {
    console.error(`❌ Music Video ${String(projectId).slice(0, 8)}: catalog link sync failed: ${err.message}`);
  });
}
