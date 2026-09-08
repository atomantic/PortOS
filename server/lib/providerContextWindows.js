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

import { isAntigravityProvider, isCodexProvider, isGrokProvider, isKimiProvider } from './providerModels.js';

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
