/**
 * Per-provider MODEL ACCESS policy — which of a provider's catalog this install
 * is actually entitled to run.
 *
 * Entitlement cannot be derived from a provider's advertised catalog (e.g. NVIDIA
 * NIM lists everything but only a subset is free), so it is DECLARED here as a
 * small user-editable policy on the provider record.
 *
 * - The catalog is never destroyed: scoping happens on the way OUT to a reader,
 *   and the scoped payload carries the original as `modelCatalog` so an editor
 *   round-trip cannot save the narrowed list over it.
 * - `all` and an empty pattern list both mean "no constraint": `allow` mode with
 *   no patterns is a half-finished edit, not an instruction to blank every picker.
 * - Patterns are case-insensitive globs over the WHOLE model id (`*` any run, `?`
 *   one char, else literal). No substring matching, so a policy never silently
 *   widens itself.
 */

/** The declared policy modes. `all` is the shipped default (today's behavior). */
export const MODEL_ACCESS_MODES = Object.freeze(['all', 'allow', 'deny']);

/** Bounds mirrored by the zod schema in ../validation.js. */
export const MAX_MODEL_ACCESS_PATTERNS = 500;
export const MAX_MODEL_ACCESS_PATTERN_LENGTH = 200;

/**
 * The provider fields that NAME a model to run with, as opposed to listing one
 * that could be chosen. A named model is never scoped out (see
 * {@link scopeModelsByAccess}).
 */
export const CONFIGURED_MODEL_KEYS = Object.freeze([
  'defaultModel', 'lightModel', 'mediumModel', 'heavyModel', 'ultraModel', 'fallbackModel',
]);

/**
 * Normalize a stored/submitted policy to `{ mode, patterns }`, or `null` when
 * it constrains nothing.
 *
 * `null` is the "no policy" sentinel: missing/garbage input, `mode: 'all'`, or a
 * constraining mode with no usable pattern. A stored pattern list under mode
 * `all` is preserved (a parked curated list), merely not applied; readers ask
 * {@link modelAccessConstrains}.
 */
export function normalizeModelAccess(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = MODEL_ACCESS_MODES.includes(value.mode) ? value.mode : 'all';
  const patterns = [...new Set((Array.isArray(value.patterns) ? value.patterns : [])
    .filter(pattern => typeof pattern === 'string')
    .map(pattern => pattern.trim())
    .filter(Boolean)
    .map(pattern => pattern.slice(0, MAX_MODEL_ACCESS_PATTERN_LENGTH)))]
    .slice(0, MAX_MODEL_ACCESS_PATTERNS);
  if (mode === 'all' && patterns.length === 0) return null;
  return { mode, patterns };
}

/** True when a normalized policy actually narrows a catalog. */
export const modelAccessConstrains = (policy) =>
  Boolean(policy) && policy.mode !== 'all' && policy.patterns.length > 0;

/**
 * Match one glob against one id — iterative, with no RegExp.
 *
 * Not a compiled RegExp: patterns are USER INPUT and a translated glob like
 * `*a*a*a*a*a*b` backtracks exponentially; this greedy-with-one-backtrack walk is
 * O(n·m). Also avoids re-inlining a regex escape (the toolkit cannot import the
 * shared `escapeRegExp`; see ../AGENTS.md).
 *
 * A pattern with no wildcard is an exact, case-insensitive equality test.
 */
function globMatches(text, pattern) {
  let t = 0;
  let p = 0;
  // Last `*` position and the text consumed at it; a dead end lets it eat one more char.
  let star = -1;
  let consumedAtStar = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      t += 1;
      p += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      consumedAtStar = t;
    } else if (star >= 0) {
      p = star + 1;
      consumedAtStar += 1;
      t = consumedAtStar;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * The pattern list lowercased once per catalog scope, not once per model (this
 * module also runs in the browser on every keystroke in the policy editor).
 */
const loweredPatterns = (patterns) =>
  (patterns || []).map(pattern => String(pattern).toLowerCase());

/** True when `modelId` matches any of `patterns`. */
export function modelMatchesAccessPatterns(modelId, patterns) {
  return matchesLowered(modelId, loweredPatterns(patterns));
}

/** {@link modelMatchesAccessPatterns} over an already-lowered pattern list. */
function matchesLowered(modelId, lowered) {
  if (typeof modelId !== 'string' || !modelId) return false;
  const id = modelId.toLowerCase();
  return lowered.some(pattern => globMatches(id, pattern));
}

/**
 * The subset of `models` the policy admits.
 *
 * `keep` names ids that stay visible whatever the policy says (the models the
 * provider is CONFIGURED to run): hiding a stored `defaultModel` would blank the
 * picker and silently re-point the provider on the next save. Order is the
 * catalog's own; `keep` never introduces an id the catalog lacks.
 */
export function scopeModelsByAccess(models, policy, { keep = [] } = {}) {
  const catalog = (models || []).filter(model => typeof model === 'string' && model);
  if (!modelAccessConstrains(policy)) return catalog;
  const kept = new Set(keep.filter(model => typeof model === 'string' && model));
  const lowered = loweredPatterns(policy.patterns);
  const allow = policy.mode === 'allow';
  return catalog.filter(model => {
    if (kept.has(model)) return true;
    return matchesLowered(model, lowered) === allow;
  });
}

/** The model ids a provider record NAMES (see {@link CONFIGURED_MODEL_KEYS}). */
export const providerConfiguredModels = (provider) =>
  CONFIGURED_MODEL_KEYS.map(key => provider?.[key]).filter(model => typeof model === 'string' && model);

/**
 * The policy that governs a provider read: its OWN first, then the resolved
 * `modelAccessEffective` a caller may have stamped (`withGatewayModelAccess` in
 * ../providers.js). Own-first so a policy a write just SET outranks the
 * inherited one resolved before it.
 *
 * A wrapper cannot opt OUT of its gateway's policy with mode `all` (it
 * normalizes to "no policy" and inheritance takes over); opt out with a `deny`
 * list that matches nothing.
 */
export const effectiveModelAccess = (provider) =>
  // The stamped field is normalized by construction, so it is taken as-is.
  normalizeModelAccess(provider?.modelAccess) || provider?.modelAccessEffective || null;

/**
 * The shape a provider takes on its way out to a reader that SELECTS models:
 * `models` narrowed to the policy, with the untouched catalog preserved as
 * `modelCatalog` and the count it hid as `modelAccessHiddenCount`.
 *
 * Returns the SAME object when nothing was hidden. `modelCatalog` is required
 * for correctness: the provider editor seeds "Available Models" from the
 * payload, so without it a Save would persist the narrowed list over the real one.
 */
export function applyModelAccess(provider) {
  if (!provider || typeof provider !== 'object') return provider;
  const policy = effectiveModelAccess(provider);
  if (!modelAccessConstrains(policy)) return provider;
  const catalog = Array.isArray(provider.models) ? provider.models : [];
  const scoped = scopeModelsByAccess(catalog, policy, { keep: providerConfiguredModels(provider) });
  if (scoped.length === catalog.length) return provider;
  return {
    ...provider,
    models: scoped,
    modelCatalog: catalog,
    modelAccessHiddenCount: catalog.length - scoped.length,
  };
}

/** Array form of {@link applyModelAccess}. */
export const applyModelAccessList = (providers) =>
  (Array.isArray(providers) ? providers.map(applyModelAccess) : providers);
