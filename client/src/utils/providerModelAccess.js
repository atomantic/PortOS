/**
 * Which of a provider's advertised catalog this install is entitled to run —
 * the browser half of the model-access policy.
 *
 * Every rule is re-exported from the server module that declares it
 * (`server/lib/aiToolkit/internal/modelAccess.js`), reached at the toolkit's
 * dependency-free `internal/` leaf exactly as `providerContextWindows.js`
 * reaches `ollamaBacked.js`. Nothing here restates a pattern rule: the editor's
 * live "N of M models" preview and the server's own scoping have to agree, or
 * the user tunes a policy against a count the API never produces.
 */

export {
  MODEL_ACCESS_MODES,
  MAX_MODEL_ACCESS_PATTERNS,
  MAX_MODEL_ACCESS_PATTERN_LENGTH,
  CONFIGURED_MODEL_KEYS,
  normalizeModelAccess,
  modelAccessConstrains,
  modelMatchesAccessPatterns,
  scopeModelsByAccess,
  providerConfiguredModels,
  effectiveModelAccess,
  applyModelAccess,
  applyModelAccessList,
} from '../../../server/lib/aiToolkit/internal/modelAccess.js';

import {
  modelAccessConstrains,
  normalizeModelAccess,
  providerConfiguredModels,
  scopeModelsByAccess,
} from '../../../server/lib/aiToolkit/internal/modelAccess.js';

/** How each mode reads in the editor. Ordered as the mode selector renders them. */
export const MODEL_ACCESS_MODE_LABELS = Object.freeze({
  all: 'All models the provider advertises',
  allow: 'Only models matching the list',
  deny: 'All models except those matching the list',
});

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
 * Takes the catalog explicitly rather than reading `provider.models`, because
 * the editor previews an unsaved policy against the full list — the value the
 * server will scope once the form is saved.
 */
export function previewModelAccess(catalog, policy, provider) {
  const models = (catalog || []).filter(model => typeof model === 'string' && model);
  const normalized = normalizeModelAccess(policy);
  const visible = scopeModelsByAccess(models, normalized, { keep: providerConfiguredModels(provider) });
  return {
    total: models.length,
    visible,
    hidden: models.length - visible.length,
    // The distinction the sentinel discipline exists for: a mode is SELECTED
    // but constrains nothing yet (no patterns typed). The editor says so rather
    // than showing a reassuring "all 82 of 82 models", which reads as a saved
    // policy that works.
    inert: Boolean(normalized) && normalized.mode !== 'all' && !modelAccessConstrains(normalized),
  };
}
