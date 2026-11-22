/**
 * Resolves a provider/model context window for planning and its source (override, reported, or assumed
 * ladder guess) via `KNOWN_MODEL_CONTEXT_WINDOWS` and `knownModelContextWindow`.
 *
 * The rungs (vendor constants, known-model table, per-provider fallback, catalog read, live-daemon merge) are re-exported from the pure leaf
 * `server/lib/provider/providerContextWindows.js`, the ones the server's `effectiveContextWindow` budgets with. `resolveModelContextWindow` is the client's
 * own walk because the UI also needs the SOURCE; it and `isLikelyLargeContextProvider` can drift from their server twins in `stageRunner.js`, so keep them together.
 *
 * The Ollama `num_ctx` ceiling is shared with the server's dispatch gate so the meter cannot promise a window a run would be refused for (#7466). Its
 * second rung, the ambient `OLLAMA_CONTEXT_LENGTH` the daemon launched with, is server env the browser cannot read: it arrives as `runtimeContextWindow` on the
 * readiness payload and is folded in via `withRuntimeContextWindow` (#7472).
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
} from '../../../server/lib/provider/providerContextWindows.js';
// The Ollama `num_ctx` ceiling, resolved as the server's budgeter and pre-dispatch gate do (#7466), via the toolkit's dependency-free `internal/` leaf.
import { clampToRuntimeContextWindow, withModelNumCtx } from '../../../server/lib/aiToolkit/internal/ollamaBacked.js';

export {
  // Stamps the window PortOS holds a local Ollama daemon at (`runtimeContextWindow` on the readiness payload, #7472) onto a provider projection so the clamp sees the rung the browser can't resolve.
  withRuntimeContextWindow,
} from '../../../server/lib/aiToolkit/internal/ollamaBacked.js';

export {
  DEFAULT_LARGE_CONTEXT_WINDOW,
  CODEX_CONTEXT_WINDOW,
  GEMINI_CONTEXT_WINDOW,
  GROK_CONTEXT_WINDOW,
  KIMI_CONTEXT_WINDOW,
  knownModelContextWindow,
  knownProviderContextWindow,
  catalogModelContextWindow,
  // Folds a daemon's live `/v1/models` windows onto the catalog rung exactly as the server's budgeter does, so the card can't rank the observation differently.
  mergeObservedContextWindows,
} from '../../../server/lib/provider/providerContextWindows.js';

export const isLikelyLargeContextProvider = (provider) => {
  if (isProcessProvider(provider)) return true;
  return isApiProvider(provider) && !isLocalEndpoint(provider.endpoint);
};

/**
 * Where a resolved context window came from; three states, because that is what the UI distinguishes:
 * - `REPORTED`: a real window (catalog, known-model table, vendor default, or Ollama's num_ctx); the rung doesn't change what the card says.
 * - `OVERRIDE`: a number the user typed.
 * - `ASSUMED`: nobody reported one and the ladder GUESSED; this must be visible, or "128K ctx" for a 1M model reads as a measured fact.
 */
export const CONTEXT_WINDOW_SOURCE = Object.freeze({
  OVERRIDE: 'override',
  REPORTED: 'reported',
  ASSUMED: 'assumed',
});

/**
 * Which window this provider/model CLAIMS, before the runtime ceiling. Walks the same rungs in the same order as `claimedContextWindow` in
 * server/services/stageRunner.js; the order and local-endpoint test could drift and make the card promise a budget the budgeter won't use.
 */
const claimedModelContextWindow = (provider, model) => {
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

/**
 * The planning context window for a provider/model AND where it came from: the claimed window held to what an Ollama daemon was LAUNCHED with,
 * as the server's budgeter resolves it. `{ tokens: null, source: null }` means nothing is known; the budgeter applies its own floor there.
 *
 * @param {object|null|undefined} provider
 * @param {string|null|undefined} model
 * @returns {{tokens: number|null, source: string|null}}
 */
export const resolveModelContextWindow = (rawProvider, model) => {
  const provider = withModelNumCtx(rawProvider, model);
  const claimed = claimedModelContextWindow(provider, model);
  const tokens = clampToRuntimeContextWindow(provider, claimed.tokens);
  // A clamped window is the daemon's own `num_ctx`, a REPORTED window even when the replaced number was an override or guess.
  return tokens === claimed.tokens
    ? claimed
    : { tokens, source: CONTEXT_WINDOW_SOURCE.REPORTED };
};

export const effectiveModelContextWindow = (provider, model) =>
  resolveModelContextWindow(provider, model).tokens;

/**
 * Display label for a model `<option>`: the id plus a "(32K ctx)" parenthetical when known; the option's `value` stays the raw id.
 *
 * Narrower than {@link resolveModelContextWindow}: only rungs describing THIS model (live local probe `ctxById`, the provider's catalog window,
 * the known-model table). Provider-level and assumed rungs would stamp one guessed number on every option. The daemon's launch ceiling applies to
 * every option alike and the picker is where someone decides what "fits", so it is clamped (#7466).
 *
 * Takes `provider` rather than a pre-merged map so every picker gets catalog windows for free.
 * @param {string} id
 * @param {Record<string, number>} [ctxById] — live windows for local models
 * @param {object} [provider] — the provider whose catalog lists this model
 * @returns {string}
 */
export const modelOptionLabel = (id, ctxById, provider) => {
  const ctx = clampToRuntimeContextWindow(
    provider,
    ctxById?.[id] || catalogModelContextWindow(provider, id) || knownModelContextWindow(id),
  );
  const label = formatContextLength(ctx);
  return label ? `${id} (${label})` : id;
};
