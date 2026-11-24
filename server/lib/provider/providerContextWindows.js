/**
 * Context-window ladder for provider/model planning: the vendor constants, the known-model regex table and the per-provider fallback.
 *
 * Split out of `services/stageRunner.js` so the browser can import it: the budget meter on a provider card and the server's manuscript chunker must resolve the same window, or the card promises a budget the budgeter won't use (silent, ~8x off). Pure: no Node built-ins, nothing outside `server/lib`. `effectiveContextWindow` (the full planning walk, which also needs `promptRunner.js`'s local-endpoint test) stays in `stageRunner.js`.
 */

import { bareLocalModelId, isAntigravityProvider, isCodexProvider, isGrokProvider, isKimiProvider } from './providerModels.js';

// A conservative-large window ASSUMED for frontier CLI / cloud-API providers that declared none: 128K is below every current frontier model's real ceiling (often ~1M), so a typical whole manuscript fits in one call without over-promising.
// A floor to escape, not a cap to honor: a models refresh records each model's real window (`modelContextWindows`) and an explicit `contextWindow` overrides both.
export const DEFAULT_LARGE_CONTEXT_WINDOW = 128_000;
export const CODEX_CONTEXT_WINDOW = 1_000_000;
export const GEMINI_CONTEXT_WINDOW = 1_048_576;
export const GROK_CONTEXT_WINDOW = 256_000;
export const KIMI_CONTEXT_WINDOW = 256_000;

const KNOWN_MODEL_CONTEXT_WINDOWS = Object.freeze([
  [/gpt[-_.:/]?5\.5(?:[-_.:/]|\b)/i, CODEX_CONTEXT_WINDOW],
  [/gpt[-_.:/]?5\.4[-_.:/]?mini(?:[-_.:/]|\b)/i, 400_000],
  [/gpt[-_.:/]?5\.4(?![-_.:/]?(?:mini|nano))(?:[-_.:/]|\b)/i, CODEX_CONTEXT_WINDOW],
  [/claude[-_.:/]?fable[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?mythos[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?opus[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?opus[-_.:/]?4[-_.:/]?8/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?4[-_.:/]?6(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?4(?:[-_.:/]|\b)/i, 200_000],
  [/claude[-_.:/]?haiku[-_.:/]?5[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?haiku[-_.:/]?4(?:[-_.:/]|\b)/i, 200_000],
  [/gemini[-_.:/]?2\.5[-_.:/]?pro(?:[-_.:/]|\b)/i, GEMINI_CONTEXT_WINDOW],
]);

/** The known window for a model id, or `null` when the table has no row for it. */
export function knownModelContextWindow(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const found = KNOWN_MODEL_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model));
  return found ? found[1] : null;
}

/** The vendor window for a configured-default CLI/TUI provider, or `null`. Keyed on the shared vendor predicates (shipped ids and command basename), so a path-configured `/opt/homebrew/bin/grok` resolves like a bare `grok`, as the effort ladders do. */
export function knownProviderContextWindow(provider) {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return null;
  if (isCodexProvider(provider)) return CODEX_CONTEXT_WINDOW;
  if (isAntigravityProvider(provider)) return GEMINI_CONTEXT_WINDOW;
  if (isGrokProvider(provider)) return GROK_CONTEXT_WINDOW;
  if (isKimiProvider(provider)) return KIMI_CONTEXT_WINDOW;
  return null;
}

/** The window this provider's own `/models` catalog reported for a model, or `null`. Populated by model refresh (aiToolkit/internal/modelCatalog.js): the serving side's declaration, which is why it outranks the hand-maintained regex table. */
export function catalogModelContextWindow(provider, model) {
  const windows = provider?.modelContextWindows;
  if (!windows || typeof windows !== 'object') return null;
  if (typeof model !== 'string' || !model) return null;
  const tokens = Number(windows[model]);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/**
 * `provider` with a daemon's OBSERVED windows folded onto the catalog rung, or the SAME object when nothing is observed. Pure and shared so the server budgets with it (`services/observedContextWindows.js` supplies the observation)
 * and the provider card's meter merges the same map off the readiness payload: the card's number is the dispatch gate's. Observation lands on `modelContextWindows` because that is its rank: above a model refresh's record and the regex table,
 * below an explicit `provider.contextWindow` (a deliberate override isn't a stale guess). Nothing is persisted (see `services/observedContextWindows.js`).
 *
 * @param {object|null|undefined} provider
 * @param {Record<string, number>|null|undefined} observed
 */
export function mergeObservedContextWindows(provider, observed) {
  // `{}` is normalized away by both producers, but this shared leaf is reached from the browser over HTTP and an older or newer server may spell "nothing observed" either way; identity-stability must hold for both.
  if (!observed || Object.keys(observed).length === 0) return provider;
  return { ...provider, modelContextWindows: { ...provider?.modelContextWindows, ...observed } };
}

/**
 * A local daemon's served window map, re-keyed by every spelling `provider` could dispatch under, or `null` when the listing said nothing about windows. Both spellings are emitted: the listing keys by the daemon's bare id while
 * `resolveEffectiveModel` hands downstream whatever the record says (an OpenCode wrapper's `<kind>/`-prefixed form); one alone answers "unknown" for half the providers. Lives beside {@link mergeObservedContextWindows} so a caller already
 * holding the listing (`services/provider/providerReadiness.js`, polling the same cached `/v1/models`) reuses it without a static edge onto the probing service `promptRunner.js` defers.
 *
 * @param {object} provider — a RAW provider record
 * @param {{kind: string}} runtime — its local runtime, already resolved
 * @param {Record<string, number>|null|undefined} served — the probe's `contextWindows`
 * @returns {Record<string, number>|null}
 */
export function aliasServedContextWindows(provider, runtime, served) {
  // The probe already rejects non-positive-integer values, so what arrives is usable or absent.
  if (!served || Object.keys(served).length === 0) return null;
  const windows = { ...served };
  const offered = [provider?.defaultModel, ...(Array.isArray(provider?.models) ? provider.models : [])];
  for (const model of offered) {
    if (typeof model !== 'string' || windows[model]) continue;
    const bare = bareLocalModelId(model, runtime.kind);
    if (bare && windows[bare]) windows[model] = windows[bare];
  }
  return windows;
}
