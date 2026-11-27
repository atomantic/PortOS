/** Resolves local model budgets and checks whether the prompt fits the provider before dispatch. */

import { allowedModesFor } from '../../lib/callerModePolicy.js';
import { DEFAULT_OUTPUT_RESERVE_TOKENS, estimateTokens, localOutputReserveTokens } from '../../lib/contextBudget.js';
import { PROVIDER_TYPES } from '../../lib/aiToolkit/constants.js';
import { hasLocalRuntimeMarker } from '../../lib/aiToolkit/internal/localRuntimeMarkers.js';
import { isOllamaBackedProvider } from '../../lib/aiToolkit/internal/ollamaBacked.js';
import { contextWindowRejection, knownContextWindow } from '../../lib/aiToolkit/providerStatus.js';
import { isLoopbackEndpoint } from '../../lib/localEndpoint.js';
import { withOllamaRuntimeContextWindow } from '../../lib/ollamaContext.js';
import { finalizeRunRecord } from '../runner.js';

// Deferred: `observedContextWindows.js` reaches `lib/localProviderRuntime.js` and the endpoint probe,
// which ~160 suites never need (see "Import scoping" in server/AGENTS.md).
let observedContextWindowsLoadPromise;
function loadObservedContextWindows() {
  if (!observedContextWindowsLoadPromise) {
    observedContextWindowsLoadPromise = import('../observedContextWindows.js').catch((err) => {
      observedContextWindowsLoadPromise = null;
      throw err;
    });
  }
  return observedContextWindowsLoadPromise;
}

/**
 * `withObservedContextWindows(provider)` behind the deferred load, shared by the dispatch gate and
 * `stageRunner.resolveStageContext`. Rejects on load/probe failure; error policy is the caller's:
 * the gate lets it surface, the budgeter degrades to the provider as stored.
 */
export async function withObservedContextWindowsLazy(provider) {
  const { withObservedContextWindows } = await loadObservedContextWindows();
  return withObservedContextWindows(provider);
}

// The category an oversized prompt already carries elsewhere (`agentErrorAnalysis.js`, `codexTurn.js`).
// A plain string, not an `ERROR_CATEGORIES` member: that enum is provider-health, this is
// REQUEST-specific (`providerCooldown.isSchemaTypeCategory` covers it, so it never benches).
const CONTEXT_LENGTH_CATEGORY = 'context-length';

export function buildRequestCapabilities({ prompt, screenshots, outputReserveTokens, callerPolicy = null } = {}) {
  const reserve = Number.isFinite(Number(outputReserveTokens))
    ? Math.max(0, Number(outputReserveTokens))
    : DEFAULT_OUTPUT_RESERVE_TOKENS;
  return {
    requiredContextTokens: estimateTokens(prompt) + reserve,
    hasImages: Array.isArray(screenshots) && screenshots.length > 0,
    // Only present when the caller declared a mode policy, so an undeclared
    // caller keeps routing across every mode exactly as it always has.
    ...(callerPolicy ? { allowedModes: allowedModesFor(callerPolicy) } : {}),
  };
}

export const isLocalEndpoint = isLoopbackEndpoint;

/**
 * Whether `provider` generates on a local inference server — an API provider
 * served by an Ollama daemon, flagged as llama.cpp / LM Studio / MTPLX / vLLM /
 * SGLang, or pointed at a loopback endpoint. These are the windows a cloud-sized
 * output reserve can swallow whole.
 */
function isLocalInferenceProvider(provider) {
  if (provider?.type !== PROVIDER_TYPES.API) return false;
  return isOllamaBackedProvider(provider)
    || hasLocalRuntimeMarker(provider)
    || isLocalEndpoint(provider.endpoint);
}

/**
 * The output reserve (and generation cap) for a run on a LOCAL model. A caller's declared
 * `outputReserveTokens` is cloud-sized (the persistent mind declares 8,192), which alone is half a
 * 16K local window and refused prompts that fit (#9437). For a local provider with a KNOWN window the
 * reserve shrinks to `localOutputReserveTokens` (floor 2,048, ⅛ of the window, never above what was
 * declared) and `max_tokens`/`num_predict` is capped at the same number.
 *
 * Unchanged when the caller named its own `maxTokens`, declared no reserve, the window is unknown, or
 * the provider is not local.
 *
 * @returns {Promise<{ outputReserveTokens: number|undefined, maxTokens: number|undefined }>}
 */
export async function resolveLocalOutputBudget(provider, model, { outputReserveTokens, maxTokens }) {
  const unchanged = { outputReserveTokens, maxTokens };
  if (Number.isInteger(maxTokens) && maxTokens > 0) return unchanged;
  if (!Number.isFinite(Number(outputReserveTokens)) || !isLocalInferenceProvider(provider)) return unchanged;
  const observed = withOllamaRuntimeContextWindow(await withObservedContextWindowsLazy(provider));
  const reserve = localOutputReserveTokens(outputReserveTokens, knownContextWindow(observed, model));
  return reserve ? { outputReserveTokens: reserve, maxTokens: reserve } : unchanged;
}

/**
 * The prompt room a LOCAL provider leaves once its output reserve is planned, for callers that build
 * their own prompt and want to fit it (the persistent mind's tool rounds). Same window lookup and
 * `localOutputReserveTokens` sizing as the dispatch gate, so a prompt under `maxPromptTokens`
 * (chars/4) is one the gate admits. Returns `null` for a cloud/CLI provider, an undeclared reserve,
 * or an unknown window.
 *
 * @param {{ provider: object, model?: string|null, outputReserveTokens: number }} args
 * @returns {Promise<{ contextWindow: number, outputReserveTokens: number, maxPromptTokens: number }|null>}
 */
export async function resolveLocalPromptBudget({ provider, model = null, outputReserveTokens }) {
  if (!isLocalInferenceProvider(provider)) return null;
  const resolvedModel = model || provider?.defaultModel || null;
  const observed = withOllamaRuntimeContextWindow(await withObservedContextWindowsLazy(provider));
  const contextWindow = knownContextWindow(observed, resolvedModel);
  const reserve = localOutputReserveTokens(outputReserveTokens, contextWindow);
  if (!reserve) return null;
  return { contextWindow, outputReserveTokens: reserve, maxPromptTokens: Math.max(0, contextWindow - reserve) };
}

/**
 * The budget a pre-dispatch REFUSAL may act on. `requiredContextTokens` is the prompt plus an output
 * reserve, which defaults to `DEFAULT_OUTPUT_RESERVE_TOKENS` (8,000 tokens nobody asked for). That
 * is fine for ranking fallbacks, but refusing on it turns "provably cannot fit" into "probably
 * cannot fit". So a refusal uses the provable floor (the prompt alone) unless the caller declared its
 * own `outputReserveTokens`; ranking in `getFallbackProvider` keeps the full budget.
 */
export function refusalCapabilities({ requestCapabilities, prompt, outputReserveTokens }) {
  if (Number.isFinite(Number(outputReserveTokens))) return requestCapabilities;
  return { ...requestCapabilities, requiredContextTokens: estimateTokens(prompt) };
}

/**
 * Refuse a prompt that provably cannot fit the provider about to run it. Before #7441 the context
 * check ran only inside `getFallbackProvider`, never on the happy path (see
 * `services/observedContextWindows.js`).
 *
 *   - An UNKNOWN window is not a rejection: `contextWindowRejection` answers `null` when nothing
 *     declared a window, and nothing infers one from a model id.
 *   - It compares `refusalCapabilities`, not the raw routing budget: an unrequested reserve must not
 *     manufacture a refusal.
 *   - The refusal is an ORDINARY failure with the existing `context-length` category, which is
 *     request-specific (`providerCooldown.isSchemaTypeCategory`) so it never benches a healthy
 *     server. It carries `effectiveProvider`, so the cascade routes it to a wider-window fallback
 *     (Tier 3 applies the same rule); a pinned (`allowFallback: false`) caller gets the message
 *     in milliseconds instead of a ten-minute stall.
 *   - It judges the REQUESTED provider, ahead of `createRun`'s proactive swap; a swap target was
 *     already vetted by `capabilityRejection`.
 */
export async function assertRequestFitsContext(provider, model, requestCapabilities, { runId = null, startTime = null } = {}) {
  const required = Number(requestCapabilities?.requiredContextTokens);
  if (!Number.isFinite(required) || required <= 0) return;

  // Two in-memory projections, both describing what the daemon is doing RIGHT
  // NOW rather than what the record remembers: the windows it is serving, and
  // the ceiling PortOS launched it at — including the ambient
  // `OLLAMA_CONTEXT_LENGTH` rung the toolkit cannot reach for itself (#7472).
  const observed = withOllamaRuntimeContextWindow(await withObservedContextWindowsLazy(provider));
  // `reason` already names both numbers, which is what the operator needs to
  // decide between a smaller prompt and a wider provider — so it IS the
  // message rather than being re-worded beside it.
  const reason = contextWindowRejection(observed, model, requestCapabilities);
  if (!reason) return;

  const message = `${provider.name || provider.id}${model ? ` (${model})` : ''}: ${reason}`;
  // A caller that created its own run record (stageRunner, the loops) has one
  // sitting at `success: null, endTime: null`. Throwing past it leaves the Runs
  // page showing an attempt that never ends and every `success === null`
  // reconciler seeing a phantom active run, so settle it here — the same thing
  // the TUI readiness check does for its own pre-execution refusal.
  if (runId) {
    await finalizeRunRecord({ runId, output: '', exitCode: 1, success: false, error: message, startTime });
  }
  const err = new Error(message);
  // The cascade only retries a failure annotated with the provider that ran
  // (see runPromptThroughProvider) — without these the refusal would be
  // rethrown straight to the caller and a wider fallback would never be tried.
  err.effectiveProvider = provider;
  err.effectiveModel = model;
  err.errorAnalysis = { category: CONTEXT_LENGTH_CATEGORY, message };
  console.log(`📏 Refused before dispatch: ${message}`);
  throw err;
}
