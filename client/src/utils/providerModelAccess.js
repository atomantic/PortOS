/**
 * Which of a provider's advertised catalog this install is entitled to run: the browser half of the model-access policy.
 *
 * Every rule comes from `server/lib/aiToolkit/internal/modelAccess.js`, reached at the toolkit's dependency-free `internal/` leaf as `providerContextWindows.js` does; nothing here restates a pattern rule, or the editor's live "N of M models" preview would disagree with the server's scoping.
 * Only what the browser consumes is re-exported. `applyModelAccess` is deliberately NOT: a client payload is already scoped, and scoping it again would overwrite `modelCatalog` with the narrowed list (data loss on the next save).
 */

import {
  modelAccessConstrains,
  normalizeModelAccess,
  providerConfiguredModels,
  scopeModelsByAccess,
} from '../../../server/lib/aiToolkit/internal/modelAccess.js';

export {
  // The mode enum and pattern cap, so the editor's controls and the server's
  // zod schema cannot disagree about what is accepted.
  MODEL_ACCESS_MODES,
  MAX_MODEL_ACCESS_PATTERNS,
  // The tier fields a record NAMES — the editor sanitizes the same set.
  CONFIGURED_MODEL_KEYS,
  // What the form submits, and what the catalog list marks as glob-covered.
  normalizeModelAccess,
  modelMatchesAccessPatterns,
  // The scoping primitive itself, so other model pickers (Default Model, tier
  // selects) can apply the same policy the editor already previews.
  scopeModelsByAccess,
} from '../../../server/lib/aiToolkit/internal/modelAccess.js';

/** How each mode reads in the editor. Ordered as the mode selector renders them. */
export const MODEL_ACCESS_MODE_LABELS = Object.freeze({
  all: 'All models the provider advertises',
  allow: 'Only models matching the list',
  deny: 'All models except those matching the list',
});

/** The "no policy" shape, stable so a memo keyed on it can hit. */
export const NO_MODEL_ACCESS = Object.freeze({ mode: 'all', patterns: Object.freeze([]) });

/**
 * The FULL advertised catalog for a provider payload.
 *
 * A scoped payload carries the untouched list as `modelCatalog` and a narrowed
 * `models`; an unscoped one carries only `models`. Editors must read the
 * catalog through this — seeding a model textarea from `models` alone would let
 * an ordinary Save persist the narrowed list over the real one.
 */
export const providerModelCatalog = (provider) =>
  (Array.isArray(provider?.modelCatalog) ? provider.modelCatalog
    : Array.isArray(provider?.models) ? provider.models : []);

/**
 * What a policy WOULD do to a catalog, for the editor's live preview. Takes the catalog and configured model ids explicitly so the caller can memoize on values that change (an UNSAVED policy against the full list; a provider object rebuilt each render would defeat a memo).
 */
export function previewModelAccess(catalog, policy, configuredModels = []) {
  const models = (catalog || []).filter(model => typeof model === 'string' && model);
  const normalized = normalizeModelAccess(policy);
  const visible = scopeModelsByAccess(models, normalized, { keep: configuredModels });
  return {
    total: models.length,
    visibleCount: visible.length,
    hidden: models.length - visible.length,
    // A mode is SELECTED but constrains nothing yet (no patterns typed): the editor says so rather than show a reassuring "all 82 of 82 models" that reads as a working saved policy.
    inert: Boolean(normalized) && normalized.mode !== 'all' && !modelAccessConstrains(normalized),
  };
}

/** The tier models a form/provider shape pins, for {@link previewModelAccess}. */
export const configuredModelsOf = providerConfiguredModels;
