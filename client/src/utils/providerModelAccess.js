/**
 * Which of a provider's advertised catalog this install is entitled to run —
 * the browser half of the model-access policy.
 *
 * Every rule comes from the server module that declares it
 * (`server/lib/aiToolkit/internal/modelAccess.js`), reached at the toolkit's
 * dependency-free `internal/` leaf exactly as `providerContextWindows.js`
 * reaches `ollamaBacked.js`. Nothing here restates a pattern rule: the editor's
 * live "N of M models" preview and the server's own scoping have to agree, or
 * the user tunes a policy against a count the API never produces.
 *
 * Only what the browser actually consumes is re-exported. `applyModelAccess`
 * in particular is deliberately NOT: a client payload has already been scoped,
 * and scoping it again would overwrite `modelCatalog` with the narrowed list —
 * the one mistake that turns this feature into data loss on the next save.
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
 * What a policy WOULD do to a catalog, for the editor's live preview.
 *
 * Takes the catalog and the configured model ids explicitly rather than reading
 * them off a provider record, so the caller can memoize on values that actually
 * change — the editor previews an UNSAVED policy against the full list, and a
 * provider object rebuilt every render would defeat any memo keyed on it.
 */
export function previewModelAccess(catalog, policy, configuredModels = []) {
  const models = (catalog || []).filter(model => typeof model === 'string' && model);
  const normalized = normalizeModelAccess(policy);
  const visible = scopeModelsByAccess(models, normalized, { keep: configuredModels });
  return {
    total: models.length,
    visibleCount: visible.length,
    hidden: models.length - visible.length,
    // The distinction the sentinel discipline exists for: a mode is SELECTED
    // but constrains nothing yet (no patterns typed). The editor says so rather
    // than showing a reassuring "all 82 of 82 models", which reads as a saved
    // policy that works.
    inert: Boolean(normalized) && normalized.mode !== 'all' && !modelAccessConstrains(normalized),
  };
}

/** The tier models a form/provider shape pins, for {@link previewModelAccess}. */
export const configuredModelsOf = providerConfiguredModels;
