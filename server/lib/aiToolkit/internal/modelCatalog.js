/**
 * Parse an OpenAI-compatible `/models` payload into the two things a provider
 * record stores: the model ids, and each model's REAL context window when the
 * catalog reports one.
 *
 * Why the second half exists: without it, every model a hosted gateway serves
 * fell through to the hardcoded `KNOWN_MODEL_CONTEXT_WINDOWS` regex table and,
 * failing that, to a blanket 128K assumption — so a 1M-context model reached by
 * OpenRouter (`stealth/ox-alpha`) was budgeted and CHUNKED as if it were 128K.
 * The catalog is the serving side's own declaration, so reading it is both more
 * accurate than a regex table and free of the per-model maintenance that table
 * demands.
 *
 * Kept in `internal/` (like `gateways.js` and `ollamaBacked.js`) because
 * `providerCatalogService.js` is the only caller and this directory stays self-contained —
 * no imports out to other PortOS modules (see ../AGENTS.md).
 */

/**
 * Keys under which an OpenAI-compatible catalog declares a context window.
 * Different servers spell it differently and the union is small enough to just
 * read all of them: OpenRouter (`context_length`), vLLM (`max_model_len`),
 * LM Studio (`max_context_length` / `loaded_context_length`), llama.cpp
 * (`n_ctx`), and the OpenAI-style `context_window` / `max_input_tokens`.
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
 * none. `null` is the "catalog didn't say" sentinel and must never collapse
 * into a number — the caller falls back to its own heuristics for it, which is
 * a different answer from "this model's window is small".
 *
 * When an entry declares SEVERAL windows the SMALLEST wins. OpenRouter is the
 * case that forces this: its top-level `context_length` is the widest window
 * any upstream offers for that model, while `top_provider.context_length` is
 * what the default route actually serves. Budgeting to the wider number would
 * build a prompt the served route rejects, so the conservative bound is the
 * only safe read — and the same rule handles a local server that reports both a
 * model's trained maximum and the smaller window it was loaded at.
 *
 * @param {unknown} entry
 * @returns {number|null}
 */
export function catalogContextWindow(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let smallest = null;
  // One level of nesting, not a recursive walk: `top_provider` is the only
  // nested shape any supported catalog uses, and a blind deep scan would sweep
  // up unrelated numeric fields (pricing, quantization) that merely share a key.
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
 * Entries are usually `{ id }` under `data` and bare strings under `models`,
 * but servers mix all four shapes — hence the id fallbacks. An entry that
 * resolves to no usable id THROWS rather than being dropped: a partially
 * understood catalog persisted as a plausible-looking list is worse than a
 * refresh that fails loudly (same posture as `_execCliModelList`).
 *
 * `contextWindows` carries an entry only for models whose window the catalog
 * actually declared — a bare string list yields `{}`, which the caller must
 * read as "unknown", never as "these models have no window".
 *
 * @param {unknown[]} entries
 * @param {string} key — the payload key the entries came from, for the error text
 * @returns {{ models: string[], contextWindows: Record<string, number> }}
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
 * Most fetchers (every CLI probe, the Ollama `/api/tags` short-circuit) answer
 * with a plain `string[]` and have no window information to offer; only the
 * OpenAI-compatible `/models` parser returns the rich shape. Normalizing here
 * keeps `fetchProviderModels`' historical `string[]` contract intact while the
 * refresh path gets the windows.
 *
 * @param {unknown} result
 * @returns {{ models: string[], contextWindows: Record<string, number> }|null}
 */
export function toModelCatalog(result) {
  if (Array.isArray(result)) return { models: result, contextWindows: {} };
  if (result && typeof result === 'object' && Array.isArray(result.models)) {
    return { models: result.models, contextWindows: result.contextWindows || {} };
  }
  return null;
}

/**
 * The one place that decides whether `modelContextWindows` is written at all.
 * Both the refresh path and `createProvider` go through this so the rule can't
 * be relaxed on one side only.
 *
 * `clearWhenEmpty` is what separates the two callers. `createProvider` builds a
 * NEW record, so an empty map simply means "omit the field". A refresh PATCHES
 * an existing record through `updateProvider`'s shallow merge, where an omitted
 * key leaves the stored value untouched — so clearing a stale map there needs an
 * explicit `undefined`. Without it the prune below would silently no-op in
 * exactly the case it has the most to remove: every previously-known model
 * delisted at once, leaving windows keyed to models the provider no longer
 * serves (and still consulted for a `defaultModel` that dropped out of the list).
 */
export const modelContextWindowPatch = (windows, { clearWhenEmpty = false } = {}) => {
  if (windows && Object.keys(windows).length > 0) return { modelContextWindows: { ...windows } };
  return clearWhenEmpty ? { modelContextWindows: undefined } : {};
};

/**
 * The `updateProvider` patch a probed catalog produces.
 *
 * The model list is always written — an empty list is a real answer (the user
 * deleted their last local model). The window map is a MERGE, not a
 * replacement, and that is the whole subtlety: catalogs are inconsistent about
 * declaring `context_length`, so a listing that declares it for 3 of 50 models
 * says nothing about the other 47. Replacing the map would drop them back to
 * the assumed 128K — the exact bug this feature exists to fix, one refresh
 * later. So: carry forward what earlier refreshes learned, let the fresh
 * catalog overwrite it, and prune anything for a model the provider no longer
 * lists (that entry can never be selected again, and keeping it grows the
 * record forever).
 *
 * @param {{models: string[], contextWindows: Record<string, number>}} catalog
 * @param {Record<string, number>} [previousWindows] — what the record already knew
 * @returns {{models: string[], modelContextWindows?: Record<string, number>}}
 */
export function modelCatalogUpdate(catalog, previousWindows) {
  const listed = new Set(catalog.models);
  const merged = {};
  for (const [id, tokens] of Object.entries(previousWindows || {})) {
    const kept = positiveInt(tokens);
    if (kept && listed.has(id)) merged[id] = kept;
  }
  Object.assign(merged, catalog.contextWindows || {});
  // Clear only when the record actually had windows — no need to write an
  // explicit `undefined` onto a provider that never learned any.
  const hadWindows = Boolean(previousWindows && Object.keys(previousWindows).length > 0);
  return { models: [...catalog.models], ...modelContextWindowPatch(merged, { clearWhenEmpty: hadWindows }) };
}
