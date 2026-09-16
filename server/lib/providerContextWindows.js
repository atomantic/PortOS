/**
 * Context-window ladder for provider/model planning: the vendor constants, the
 * known-model regex table, and the per-provider fallback.
 *
 * Split out of `services/stageRunner.js` so the browser can import it: the
 * budget meter on a provider card and the manuscript chunker on the server
 * must resolve the same window, or the card promises a budget the budgeter
 * won't use (silent, and ~8x off when the two disagree). Pure: no Node
 * built-ins, nothing outside `server/lib`.
 *
 * `effectiveContextWindow` — the full planning walk, which also needs the
 * local-endpoint test from `promptRunner.js` — stays in `stageRunner.js`.
 */

import { bareLocalModelId, isAntigravityProvider, isCodexProvider, isGrokProvider, isKimiProvider } from './providerModels.js';

// A conservative-large window ASSUMED for frontier CLI / cloud-API providers
// that haven't declared one. 128K is below every current frontier model's real
// ceiling (Claude/GPT/Gemini are ≥128K, often ~1M), so it means "a typical
// whole manuscript fits in one call" without over-promising. It is a floor to
// escape, not a cap to honor: refreshing the provider's models records each
// model's real window (`modelContextWindows`), and an explicit `contextWindow`
// overrides both.
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
  [/claude[-_.:/]?haiku[-_.:/]?4(?:[-_.:/]|\b)/i, 200_000],
  [/gemini[-_.:/]?2\.5[-_.:/]?pro(?:[-_.:/]|\b)/i, GEMINI_CONTEXT_WINDOW],
]);

/** The known window for a model id, or `null` when the table has no row for it. */
export function knownModelContextWindow(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const found = KNOWN_MODEL_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model));
  return found ? found[1] : null;
}

/**
 * The vendor window for a configured-default CLI/TUI provider, or `null`.
 * Keyed on the shared vendor predicates, which match the shipped ids and the
 * command basename — so a path-configured `/opt/homebrew/bin/grok` resolves
 * the same window as a bare `grok` on PATH, exactly as the effort ladders do.
 */
export function knownProviderContextWindow(provider) {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return null;
  if (isCodexProvider(provider)) return CODEX_CONTEXT_WINDOW;
  if (isAntigravityProvider(provider)) return GEMINI_CONTEXT_WINDOW;
  if (isGrokProvider(provider)) return GROK_CONTEXT_WINDOW;
  if (isKimiProvider(provider)) return KIMI_CONTEXT_WINDOW;
  return null;
}

/**
 * The window this provider's own `/models` catalog reported for this model, or
 * `null` when the catalog never mentioned it. Populated by model refresh (see
 * aiToolkit/internal/modelCatalog.js), so it is the serving side's declaration
 * rather than a guess — which is why it outranks the hand-maintained regex
 * table above.
 */
export function catalogModelContextWindow(provider, model) {
  const windows = provider?.modelContextWindows;
  if (!windows || typeof windows !== 'object') return null;
  if (typeof model !== 'string' || !model) return null;
  const tokens = Number(windows[model]);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/**
 * `provider` with a daemon's OBSERVED windows folded onto the catalog rung, or
 * the SAME object when there is nothing observed.
 *
 * Pure and shared on purpose: the server budgets with it
 * (`services/observedContextWindows.js`, which supplies the observation) and
 * the provider card's meter merges the same map off the readiness payload, so
 * the number on the card is the number the dispatch gate enforces.
 *
 * Observation lands on `modelContextWindows` rather than on `contextWindow`
 * because that is exactly its rank: it outranks whatever a model refresh last
 * recorded and the regex table below it, while an explicit `provider.contextWindow`
 * the user typed still wins — a deliberate override is not a stale guess.
 *
 * Nothing here is persisted. See `services/observedContextWindows.js` for why.
 *
 * @param {object|null|undefined} provider
 * @param {Record<string, number>|null|undefined} observed
 */
export function mergeObservedContextWindows(provider, observed) {
  // `{}` is normalized away by both producers, but this is a shared pure leaf
  // reached from the browser over HTTP — an older or newer server on the other
  // end of `/providers/readiness` may spell "nothing observed" either way, and
  // the identity-stability promise above must hold for both.
  if (!observed || Object.keys(observed).length === 0) return provider;
  return { ...provider, modelContextWindows: { ...provider?.modelContextWindows, ...observed } };
}

/**
 * A local daemon's served window map, re-keyed by every spelling `provider`
 * could dispatch under, or `null` when the listing said nothing about windows.
 *
 * Both spellings are emitted on purpose: the listing keys by the daemon's bare
 * id, while `resolveEffectiveModel` hands downstream code whatever the provider
 * record says — which for an OpenCode wrapper is the `<kind>/`-prefixed form. A
 * map keyed on only one of the two resolves for half the providers and silently
 * answers "unknown" for the rest.
 *
 * Lives beside {@link mergeObservedContextWindows} — its own consumer — rather
 * than in `services/observedContextWindows.js`, so a caller that ALREADY holds
 * the listing (`services/providerReadiness.js`, which polls the same cached
 * `/v1/models` for its checklist) reuses the one aliasing rule without a static
 * edge onto the probing service that `promptRunner.js` deliberately defers.
 *
 * @param {object} provider — a RAW provider record
 * @param {{kind: string}} runtime — its local runtime, already resolved
 * @param {Record<string, number>|null|undefined} served — the probe's `contextWindows`
 * @returns {Record<string, number>|null}
 */
export function aliasServedContextWindows(provider, runtime, served) {
  // The probe already rejects anything that is not a positive integer, so what
  // arrives is either usable or absent.
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
