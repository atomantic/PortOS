/**
 * How large a context window a provider/model gets for planning, and where that
 * number came from (a user override, a reported window, or a ladder guess the
 * card must label as assumed) — plus the "(32K ctx)" option label built on it.
 *
 * The rungs — the vendor constants, the known-model table, the per-provider
 * fallback and the catalog read — are re-exported from the pure leaf
 * `server/lib/providerContextWindows.js`, the same ones the server's
 * `effectiveContextWindow` budgets with. `resolveModelContextWindow` is the
 * client's own walk over them, because the UI also needs to know WHERE the
 * number came from; it and `isLikelyLargeContextProvider` are what can still
 * drift from the server (the walk order, and the client's own local-endpoint
 * test), so keep both beside their server twins in `stageRunner.js`.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { formatContextLength } from './formatters.js';
import { isLocalEndpoint } from './providerEndpoints.js';
import { isApiProvider, isProcessProvider } from './providerTypes.js';
import {
  DEFAULT_LARGE_CONTEXT_WINDOW,
  catalogModelContextWindow,
  knownModelContextWindow,
  knownProviderContextWindow,
} from '../../../server/lib/providerContextWindows.js';

export {
  DEFAULT_LARGE_CONTEXT_WINDOW,
  CODEX_CONTEXT_WINDOW,
  GEMINI_CONTEXT_WINDOW,
  GROK_CONTEXT_WINDOW,
  KIMI_CONTEXT_WINDOW,
  knownModelContextWindow,
  knownProviderContextWindow,
  catalogModelContextWindow,
} from '../../../server/lib/providerContextWindows.js';

export const isLikelyLargeContextProvider = (provider) => {
  if (isProcessProvider(provider)) return true;
  return isApiProvider(provider) && !isLocalEndpoint(provider.endpoint);
};

/**
 * Where a resolved context window came from — three states, because that is
 * what the UI actually distinguishes:
 *
 * - `REPORTED` — a real window for this model/provider (catalog, known-model
 *   table, vendor default, or Ollama's num_ctx). Which of those it was does not
 *   change what the card says, so they collapse into one state rather than
 *   growing an enum member per rung.
 * - `OVERRIDE` — a number the user typed; worth labelling as theirs.
 * - `ASSUMED` — nobody reported one, so the ladder GUESSED. This is the state
 *   that has to be visible: a card printing "128K ctx" for a model whose real
 *   window is 1M reads as a measured fact with nothing to say otherwise.
 */
export const CONTEXT_WINDOW_SOURCE = Object.freeze({
  OVERRIDE: 'override',
  REPORTED: 'reported',
  ASSUMED: 'assumed',
});

/**
 * The planning context window for a provider/model AND where it came from.
 * Walks the same rungs, in the same order, as `effectiveContextWindow` in
 * server/services/stageRunner.js — the rungs are shared, so the order and the
 * local-endpoint test are what could drift, and the card would then promise a
 * budget the budgeter won't use.
 *
 * `{ tokens: null, source: null }` means nothing is known (an unrecognized model
 * on a local backend); the budgeter applies its own conservative floor there.
 *
 * @param {object|null|undefined} provider
 * @param {string|null|undefined} model
 * @returns {{tokens: number|null, source: string|null}}
 */
export const resolveModelContextWindow = (provider, model) => {
  const explicit = Number(provider?.contextWindow);
  if (Number.isFinite(explicit) && explicit > 0) {
    return { tokens: explicit, source: CONTEXT_WINDOW_SOURCE.OVERRIDE };
  }
  const catalog = catalogModelContextWindow(provider, model);
  if (catalog) return { tokens: catalog, source: CONTEXT_WINDOW_SOURCE.REPORTED };
  const known = knownModelContextWindow(model);
  if (known) return { tokens: known, source: CONTEXT_WINDOW_SOURCE.REPORTED };
  const providerKnown = knownProviderContextWindow(provider);
  if (providerKnown) return { tokens: providerKnown, source: CONTEXT_WINDOW_SOURCE.REPORTED };
  const numCtx = Number(provider?.numCtx);
  if (Number.isFinite(numCtx) && numCtx > 0) {
    return { tokens: numCtx, source: CONTEXT_WINDOW_SOURCE.REPORTED };
  }
  return isLikelyLargeContextProvider(provider)
    ? { tokens: DEFAULT_LARGE_CONTEXT_WINDOW, source: CONTEXT_WINDOW_SOURCE.ASSUMED }
    : { tokens: null, source: null };
};

export const effectiveModelContextWindow = (provider, model) =>
  resolveModelContextWindow(provider, model).tokens;

/**
 * Display label for a model `<option>`: the id plus a "(32K ctx)" parenthetical
 * when the model's context window is known. The option's `value` stays the raw
 * id — only the label carries the annotation.
 *
 * Resolution is deliberately narrower than {@link resolveModelContextWindow}:
 * only rungs that describe THIS model — the live local probe (`ctxById` from
 * `useLocalModels`), the window `provider`'s catalog reported for it, then the
 * known-model table. The provider-level and assumed rungs are excluded on
 * purpose: they would stamp the same guessed number onto every option in the
 * list, which says nothing and reads as fact.
 *
 * Take `provider` rather than a pre-merged map so every picker gets catalog
 * windows for free — merging at the call site is what left the fallback-model
 * and manuscript-override selects labelling a 1M model as if it were unknown.
 *
 * @param {string} id
 * @param {Record<string, number>} [ctxById] — live windows for local models
 * @param {object} [provider] — the provider whose catalog lists this model
 * @returns {string}
 */
export const modelOptionLabel = (id, ctxById, provider) => {
  const ctx = ctxById?.[id] || catalogModelContextWindow(provider, id) || knownModelContextWindow(id);
  const label = formatContextLength(ctx);
  return label ? `${id} (${label})` : id;
};
