/**
 * Creative Director — autonomous catalog auto-cast (#1810).
 *
 * The "Auto-generate" slice of the creative-pipeline epic (#1721). Instead of the
 * user hand-picking each catalog ingredient to remix into a Creative Director
 * project, the director queries the catalog itself — embedding the project's brief
 * and running the SAME hybrid (FTS + pgvector) search the Ask retriever uses — to
 * propose castable ingredients, then seeds them as the project `cast` and links
 * them via catalog_ingredient_refs (ref_kind='creative-director'), exactly like
 * the manual remix path (#1808).
 *
 * Director-first principle (mirrors the Music-video slice): autonomy SEEDS the
 * board, the director can always take over — everything auto-cast adds is editable
 * on the same project, and the apply path only ever appends (never replaces) the
 * existing cast.
 *
 * Convergence contract: the autonomous path references the same Catalog ingredients
 * through the same refs as the manual remix — no parallel data model.
 */

import {
  hybridSearchIngredients,
  linkIngredientsToCreativeDirector,
} from '../catalogDB.js';
import { generateQueryEmbedding } from '../memoryEmbeddings.js';
import { buildCastFromIngredients } from './catalogSeed.js';
import { getProject, updateProject } from './local.js';
import { ServerError } from '../../lib/errorHandler.js';

// The catalog atom types that make sense as a director's "cast" — the on-screen
// subjects a treatment binds to scenes. Ideas/concepts are context, not cast, so
// they're excluded by default; a caller may override `types` to widen the net.
export const DEFAULT_CASTABLE_TYPES = ['character', 'place', 'object', 'scene'];
// Mirror catalogSeed's MAX_CAST and the create-schema `catalogIngredientIds` cap —
// past ~50 members the treatment agent can't reason about per-scene casting.
const MAX_CAST = 50;
const BRIEF_MAX = 8000;
const DEFAULT_SUGGEST_LIMIT = 12;

/**
 * Pure: assemble a search brief from a project's authored fields. Name + style
 * spec + user story are the human's stated intent; joining them gives the
 * embedding/FTS query something to match catalog ingredients against. Returns ''
 * when the project carries no usable text (the caller decides what to do).
 */
export function deriveBriefFromProject(project) {
  if (!project || typeof project !== 'object') return '';
  const brief = [project.name, project.styleSpec, project.userStory]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim())
    .join('\n\n');
  return brief.length > BRIEF_MAX ? brief.slice(0, BRIEF_MAX) : brief;
}

/**
 * Slim a hybrid-search hit to the fields the suggest UI needs — never leak the
 * full payload/embedding. Reuses buildCastFromIngredients so the summary/role
 * derivation matches what an applied cast member carries, then layers the search
 * score + method on top.
 */
export function toSuggestionView(hit) {
  const [member] = buildCastFromIngredients([hit.ingredient]);
  if (!member) return null;
  return {
    ...member,
    score: typeof hit.rrfScore === 'number' ? hit.rrfScore : null,
    searchMethod: hit.searchMethod || 'fts',
  };
}

/**
 * Run the autonomous selection: embed the brief, hybrid-search the catalog, and
 * return the ranked castable hits (raw `{ ingredient, rrfScore, searchMethod }`).
 * The embedding is best-effort — if the embedding provider is unavailable the
 * search degrades to FTS-only rather than failing (mirrors askService).
 */
export async function suggestCastForBrief({ brief, types = DEFAULT_CASTABLE_TYPES, limit = DEFAULT_SUGGEST_LIMIT } = {}) {
  const text = (typeof brief === 'string' ? brief : '').trim();
  if (!text) return [];
  const castable = Array.isArray(types) && types.length ? types : DEFAULT_CASTABLE_TYPES;
  const embedding = await generateQueryEmbedding(text, { types: castable }).catch(() => null);
  // hybridSearchIngredients filters by a SINGLE `type`, so query each castable
  // type and merge — post-filtering one global page would let a brief that
  // matches many non-castable items (ideas/concepts/custom types) fill the page
  // before any castable rows are reached, starving the cast candidates (codex
  // review). Per-type queries guarantee each castable type gets a fair page; one
  // failing type degrades to the rest rather than the whole search.
  const perType = await Promise.all(
    castable.map((type) => hybridSearchIngredients(text, embedding, { limit, type }).catch(() => [])),
  );
  // Types partition ingredient ids, but dedupe defensively (keep the best score).
  const byId = new Map();
  for (const hit of perType.flat()) {
    const id = hit?.ingredient?.id;
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || (hit.rrfScore || 0) > (prev.rrfScore || 0)) byId.set(id, hit);
  }
  return Array.from(byId.values())
    .sort((a, b) => (b.rrfScore || 0) - (a.rrfScore || 0))
    .slice(0, limit);
}

/**
 * Apply auto-cast to an existing project: derive (or accept) a brief, suggest
 * castable ingredients, APPEND the fresh ones (those not already cast) to the
 * project `cast`, and link them as creative-director refs. Returns the updated
 * project, the members actually added, and the full ranked suggestions (so the UI
 * can show what was considered, including already-cast matches).
 */
export async function applyAutoCastToProject(projectId, { brief, types, limit, generateFirstPass } = {}) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });

  const effectiveBrief = (typeof brief === 'string' && brief.trim())
    ? brief.trim()
    : deriveBriefFromProject(project);
  if (!effectiveBrief) {
    throw new ServerError(
      'Nothing to auto-cast from — give the project a style spec or story, or pass a brief.',
      { status: 400, code: 'NO_BRIEF' },
    );
  }

  const hits = await suggestCastForBrief({ brief: effectiveBrief, types, limit });
  const suggestions = hits.map(toSuggestionView).filter(Boolean);

  const existingCast = Array.isArray(project.cast) ? project.cast : [];
  const existingIds = new Set(existingCast.map((c) => c.ingredientId));
  const capacity = Math.max(0, MAX_CAST - existingCast.length);
  const freshIngredients = hits
    .map((h) => h.ingredient)
    .filter((ing) => ing?.id && !existingIds.has(ing.id))
    .slice(0, capacity);

  if (freshIngredients.length === 0) {
    // Nothing new to merge, but the caller may still have opted into first-pass
    // scene frames (#1867) — persist that flag on its own so the treatment
    // handler can find it later. Folded in here (#1938) so the route never has
    // to issue a second full read-modify-write + peer-sync push of its own.
    if (generateFirstPass) {
      const updated = await updateProject(projectId, { generateFirstPass: true });
      return { project: updated, added: [], suggestions };
    }
    return { project, added: [], suggestions };
  }

  const newMembers = buildCastFromIngredients(freshIngredients);
  const mergedCast = [...existingCast, ...newMembers];
  // Fold the opt-in flag into the same write as the cast merge (#1938) so the
  // opt-in path is a single read-modify-write + one peer-sync push, not two.
  const updated = await updateProject(projectId, {
    cast: mergedCast,
    ...(generateFirstPass ? { generateFirstPass: true } : {}),
  });

  // Best-effort ref-link (the cast is already persisted) — mirrors createProject.
  await linkIngredientsToCreativeDirector(projectId, freshIngredients)
    .then((linked) => console.log(`🎬 Auto-cast linked ${linked.length} ingredient(s) to CD project ${projectId}`))
    .catch((err) => console.error(`❌ Auto-cast ref-link failed for CD project ${projectId}: ${err.message}`));

  return { project: updated, added: newMembers, suggestions };
}
