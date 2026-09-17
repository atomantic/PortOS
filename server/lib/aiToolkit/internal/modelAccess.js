/**
 * Per-provider MODEL ACCESS policy — which of a provider's catalog this install
 * is actually entitled to run.
 *
 * ## Why a policy rather than a shorter catalog
 *
 * A provider's `models` list is what its upstream ADVERTISES, and for a hosted
 * gateway that is the vendor's whole product line regardless of what the user
 * has paid for. NVIDIA NIM's `/v1/models` answers with its entire catalog; only
 * a subset is reachable on the free build.nvidia.com tier, and nothing in the
 * response says which (the entries carry `id`/`object`/`created`/`owned_by` and
 * no pricing, tier or entitlement field). The same shape recurs everywhere a
 * plan gates a catalog: an OpenRouter account with only the `:free` variants, a
 * vendor key scoped to two models out of thirty.
 *
 * So entitlement cannot be DERIVED — it has to be DECLARED. This module is the
 * declaration: a small, user-editable policy stored on the provider record.
 *
 * ## The catalog is never destroyed
 *
 * Scoping happens on the way OUT to a reader, never at refresh time, and the
 * unscoped list stays in `providers.json`. Turning the policy off restores the
 * full list with no re-probe, and a provider whose upstream catalog moved on
 * still has the real answer stored. The scoped payload carries the original as
 * `modelCatalog` so an editor round-trip cannot save the narrowed list over it.
 *
 * ## `all` and an empty pattern list both mean "no constraint"
 *
 * Following the sentinel discipline in the root AGENTS.md: *not configured* and
 * *configured to hide everything* must not collapse into one value. A policy in
 * `allow` mode with NO patterns is a half-finished edit (the user picked the
 * mode, then went to type the list), not an instruction to blank every model
 * picker in the app — so it reads as no constraint. Hiding everything is spelled
 * by there being no matching model, which requires at least one real pattern.
 *
 * ## Patterns
 *
 * Case-insensitive globs over the WHOLE model id: `*` matches any run of
 * characters, `?` exactly one, and everything else is literal. `meta/*` scopes a
 * vendor namespace, `*:free` an OpenRouter tier suffix, and a bare
 * `moonshotai/kimi-k2.5` is an exact pin. No substring matching — `gemma` does
 * not match `google/gemma-3-4b-it`, because a policy that silently widened
 * itself would be a policy the user cannot audit by reading it.
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
 * `null` is the "no policy" sentinel every reader below keys on, and it covers
 * three distinct inputs deliberately: a missing/garbage value, `mode: 'all'`,
 * and a constraining mode with no usable pattern. What it does NOT do is erase
 * a stored pattern list when the mode is `all` — that combination is how a user
 * parks a curated list while temporarily opening the provider back up, so the
 * patterns are preserved on the record and merely not applied. Readers ask
 * {@link modelAccessConstrains} rather than re-deriving that rule.
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
 * Two reasons it is not a compiled RegExp. First, the patterns are USER INPUT,
 * and a translated glob backtracks catastrophically: `*a*a*a*a*a*b` against a
 * long non-matching id is exponential in a backtracking engine, and this runs
 * once per model per read. The greedy-with-one-backtrack walk below is O(n·m)
 * with no such cliff. Second, a RegExp translation has to escape every regex
 * metacharacter in the pattern, and this directory may not import the repo's
 * shared `escapeRegExp` (it stays self-contained — see ../AGENTS.md), so it
 * would have to re-inline the escape the tree-wide guard in
 * `server/lib/textUtils.test.js` exists to prevent.
 *
 * `*` consumes any run including empty, `?` exactly one character, everything
 * else is literal — so a pattern with no wildcard is an exact, case-insensitive
 * equality test.
 */
function globMatches(text, pattern) {
  let t = 0;
  let p = 0;
  // Where the most recent `*` sat, and how much of the text it had consumed at
  // the time. On a dead end we return here and let it eat one more character —
  // the single backtrack that keeps this linear-ish instead of exponential.
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

/** True when `modelId` matches any of `patterns`. */
export function modelMatchesAccessPatterns(modelId, patterns) {
  if (typeof modelId !== 'string' || !modelId) return false;
  const id = modelId.toLowerCase();
  return (patterns || []).some(pattern => globMatches(id, String(pattern).toLowerCase()));
}

/**
 * The subset of `models` the policy admits.
 *
 * `keep` names ids that stay visible whatever the policy says — the models the
 * provider is CONFIGURED to run. A picker rendering a stored `defaultModel` that
 * the policy hides would show a blank selection and silently re-point the
 * provider on the next save, which is a worse failure than showing one model
 * the user did not list. The policy governs what can be CHOSEN next, not what
 * the record already says.
 *
 * Order is the catalog's own; `keep` never reorders or introduces an id the
 * catalog does not contain.
 */
export function scopeModelsByAccess(models, policy, { keep = [] } = {}) {
  const catalog = (models || []).filter(model => typeof model === 'string' && model);
  if (!modelAccessConstrains(policy)) return catalog;
  const kept = new Set(keep.filter(model => typeof model === 'string' && model));
  return catalog.filter(model => {
    if (kept.has(model)) return true;
    const matched = modelMatchesAccessPatterns(model, policy.patterns);
    return policy.mode === 'allow' ? matched : !matched;
  });
}

/** The model ids a provider record NAMES (see {@link CONFIGURED_MODEL_KEYS}). */
export const providerConfiguredModels = (provider) =>
  CONFIGURED_MODEL_KEYS.map(key => provider?.[key]).filter(model => typeof model === 'string' && model);

/**
 * The policy that governs a provider read: its OWN first, then the resolved
 * `modelAccessEffective` a caller may have stamped (see `withGatewayModelAccess`
 * in ../providers.js).
 *
 * Own-first matters on a write response, where a route carries the resolution
 * forward from the read that preceded the write: a policy the write just SET
 * must outrank the inherited one that was resolved a moment earlier. The two
 * agree in every other case, because `withGatewayModelAccess` copies an own
 * policy into the resolved field rather than inheriting past it.
 *
 * Consequence worth knowing: a wrapper cannot opt OUT of its gateway's policy by
 * storing mode `all` with no patterns, because that normalizes to "no policy"
 * and inheritance takes over. Opting out is spelled as a `deny` list that
 * matches nothing. A third "explicitly unconstrained" state is not worth the
 * field until someone needs it.
 */
export const effectiveModelAccess = (provider) =>
  normalizeModelAccess(provider?.modelAccess) || normalizeModelAccess(provider?.modelAccessEffective);

/**
 * The shape a provider takes on its way out to a reader that SELECTS models:
 * `models` narrowed to the policy, with the untouched catalog preserved as
 * `modelCatalog` and the count it hid as `modelAccessHiddenCount`.
 *
 * Returns the SAME object when nothing was hidden, so a provider with no policy
 * — every record on an install that has not configured this — serializes byte
 * for byte as it did before, and `modelCatalog` is absent rather than a
 * redundant copy of `models`.
 *
 * `modelCatalog` matters beyond display: the provider editor seeds its
 * "Available Models" box from the payload, so without the full list in hand an
 * ordinary Save on a scoped provider would persist the narrowed catalog over
 * the real one — a silent, refresh-only-recoverable data loss.
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
