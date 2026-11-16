/**
 * Parse an OpenAI-compatible `/models` payload into the model ids and each
 * model's REAL context window when the catalog reports one (it beats the
 * `KNOWN_MODEL_CONTEXT_WINDOWS` regex table and the 128K fallback).
 */

/**
 * Keys under which OpenAI-compatible catalogs declare a context window: OpenRouter
 * (`context_length`), vLLM (`max_model_len`), LM Studio, llama.cpp (`n_ctx`), and
 * the OpenAI-style names.
 */
const CONTEXT_WINDOW_KEYS = Object.freeze([
  'context_length',
  'context_window',
  'contextWindow',
  'max_context_length',
  'loaded_context_length',
  'max_model_len',
  'max_input_tokens',
  'n_ctx',
]);

const positiveInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * The context window one catalog entry declares, or `null` when it declares
 * none. `null` is the "catalog didn't say" sentinel (caller falls back to
 * heuristics) and must never collapse into a number.
 *
 * When an entry declares SEVERAL windows the SMALLEST wins: OpenRouter's
 * top-level `context_length` is the widest any upstream offers while
 * `top_provider.context_length` is what the default route serves, and a local
 * server may report trained maximum and loaded window.
 */
export function catalogContextWindow(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let smallest = null;
  // One level of nesting (`top_provider`), not a deep scan, which would catch
  // unrelated numeric fields sharing a key.
  for (const source of [entry, entry.top_provider]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of CONTEXT_WINDOW_KEYS) {
      const found = positiveInt(source[key]);
      if (found && (smallest === null || found < smallest)) smallest = found;
    }
  }
  return smallest;
}

/**
 * Normalize a catalog array into `{ models, contextWindows }`.
 *
 * Servers mix entry shapes (`{ id }`, bare strings, name/model), hence the id
 * fallbacks. An entry with no usable id THROWS rather than being dropped: a
 * partially understood catalog persisted as a plausible list is worse than a
 * loud failure (same posture as `_execCliModelList`).
 *
 * `contextWindows` only has models whose window was declared; `{}` means
 * "unknown", never "no window".

 * @param {string} key — the payload key the entries came from, for the error text
 */
export function parseModelCatalog(entries, key) {
  const models = [];
  const contextWindows = {};
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : (entry?.id || entry?.name || entry?.model);
    if (typeof id !== 'string' || !id) {
      throw new Error(`Model list response had "${key}" entries with no usable model id`);
    }
    models.push(id);
    const window = catalogContextWindow(entry);
    if (window) contextWindows[id] = window;
  }
  return { models, contextWindows };
}

/**
 * Coerce whatever a model fetcher returned into the catalog shape, or `null`
 * when it returned nothing usable.
 *
 * Most fetchers answer with a plain `string[]`; only the OpenAI-compatible
 * `/models` parser returns the rich shape. Normalizing here keeps
 * `fetchProviderModels`' `string[]` contract intact.
 */
export function toModelCatalog(result) {
  if (Array.isArray(result)) return { models: result, contextWindows: {} };
  if (result && typeof result === 'object' && Array.isArray(result.models)) {
    return { models: result.models, contextWindows: result.contextWindows || {} };
  }
  return null;
}

/**
 * The one place that decides whether `modelContextWindows` is written at all
 * (refresh and `createProvider` share it).
 *
 * `clearWhenEmpty`: `createProvider` builds a NEW record so an empty map means
 * "omit"; a refresh PATCHES through `updateProvider`'s shallow merge, where an
 * omitted key keeps the stored value, so clearing a stale map needs an explicit
 * `undefined`.
 */
export const modelContextWindowPatch = (windows, { clearWhenEmpty = false } = {}) => {
  if (windows && Object.keys(windows).length > 0) return { modelContextWindows: { ...windows } };
  return clearWhenEmpty ? { modelContextWindows: undefined } : {};
};

/**
 * The `updateProvider` patch a probed catalog produces.
 *
 * The model list is always written (an empty list is a real answer). The window
 * map is a MERGE: catalogs inconsistently declare `context_length`, so replacing
 * would drop undeclared models back to the assumed 128K. Carry forward earlier
 * windows, let the fresh catalog overwrite, and prune models no longer listed.

 * @param {Record<string, number>} [previousWindows] — what the record already knew
 */
export function modelCatalogUpdate(catalog, previousWindows) {
  const listed = new Set(catalog.models);
  const merged = {};
  for (const [id, tokens] of Object.entries(previousWindows || {})) {
    const kept = positiveInt(tokens);
    if (kept && listed.has(id)) merged[id] = kept;
  }
  Object.assign(merged, catalog.contextWindows || {});
  const hadWindows = Boolean(previousWindows && Object.keys(previousWindows).length > 0);
  return { models: [...catalog.models], ...modelContextWindowPatch(merged, { clearWhenEmpty: hadWindows }) };
}
