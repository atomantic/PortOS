/**
 * How large a context window a provider/model gets for planning, and where that
 * number came from (a user override, a reported window, or a ladder guess the
 * card must label as assumed) — plus the "(32K ctx)" option label built on it.
 *
 * Browser MIRROR of the context-window ladder in `server/services/stageRunner.js`
 * (`KNOWN_MODEL_CONTEXT_WINDOWS`, the vendor constants, `catalogModelContextWindow`,
 * `effectiveContextWindow`) — the two must resolve identically or the card
 * promises a budget the budgeter won't use. `server/services/stageRunner.mirror.test.js`
 * reads this file as TEXT and fails when they drift.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { formatContextLength } from './formatters.js';
import { isLocalEndpoint } from './providerEndpoints.js';
import { commandBasename, isApiProvider, isCodexProvider, isProcessProvider } from './providerTypes.js';

export const DEFAULT_LARGE_CONTEXT_WINDOW = 128_000;

export const CODEX_CONTEXT_WINDOW = 1_000_000;

export const GEMINI_CONTEXT_WINDOW = 1_048_576;

export const GROK_CONTEXT_WINDOW = 256_000;

export const KIMI_CONTEXT_WINDOW = 256_000;

// Keep in sync with server/services/stageRunner.js.
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

export const knownModelContextWindow = (model) => {
  if (typeof model !== 'string' || !model.trim()) return null;
  const found = KNOWN_MODEL_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model));
  return found ? found[1] : null;
};

export const knownProviderContextWindow = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const id = String(provider?.id || '').toLowerCase();
  const command = commandBasename(provider?.command);
  if (isCodexProvider(provider)) return CODEX_CONTEXT_WINDOW;
  if (id === 'antigravity-cli' || id === 'antigravity-tui' || command === 'agy') return GEMINI_CONTEXT_WINDOW;
  if (id === 'grok-cli' || id === 'grok-tui' || command === 'grok') return GROK_CONTEXT_WINDOW;
  if (id === 'kimi-cli' || id === 'kimi-tui' || command === 'kimi') return KIMI_CONTEXT_WINDOW;
  return null;
};

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
 * The window this provider's own `/models` catalog reported for this model, or
 * `null` when it never mentioned it. Recorded by model refresh — the serving
 * side's own declaration, so it outranks the hand-maintained regex table.
 * Mirror of `catalogModelContextWindow` in server/services/stageRunner.js.
 */
export function catalogModelContextWindow(provider, model) {
  const windows = provider?.modelContextWindows;
  if (!windows || typeof windows !== 'object') return null;
  if (typeof model !== 'string' || !model) return null;
  const tokens = Number(windows[model]);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/**
 * The planning context window for a provider/model AND where it came from.
 * Mirror of `effectiveContextWindow` in server/services/stageRunner.js — the two
 * must resolve identically, or the card promises a budget the budgeter won't use.
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
