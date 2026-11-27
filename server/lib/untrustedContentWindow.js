/** Resolve the actual context-window budget and expose numeric ranking inputs for the policy preview. */

import { knownContextWindow } from './aiToolkit/providerStatus.js';
import { withModelNumCtx } from './aiToolkit/internal/ollamaBacked.js';
import { withOllamaRuntimeContextWindow } from './ollamaContext.js';
import { isUntrustedContentProvider } from './untrustedContentSelection.js';

/**
 * The token budget an analysis against this provider/model gets.
 *
 * The runtime projection folds in the ambient `OLLAMA_CONTEXT_LENGTH` ceiling
 * before the shared ladder resolves anything, so an Ollama daemon configured
 * through the env var alone still budgets at what it serves (#7472).
 * `knownContextWindow` clamps on `numCtx` only for Ollama-backed providers;
 * other OpenAI-compatible local endpoints ignore `num_ctx` and must not be
 * shrunk by it. A local endpoint with no explicit `numCtx` keeps this guard's
 * own 4096 floor: this is a security guard, and the floor only ever LOWERS the
 * shared ladder's answer.
 */
export function resolveUntrustedContentWindow(selected, effectiveModel) {
  const runtimeProvider = withOllamaRuntimeContextWindow(withModelNumCtx(selected, effectiveModel));
  const claimedWindow = knownContextWindow(runtimeProvider, effectiveModel) ?? 4096;
  const local = isUntrustedContentProvider(selected, 'messages');
  return local && !(Number(runtimeProvider.numCtx) > 0) ? Math.min(claimedWindow, 4096) : claimedWindow;
}

/** The default budget covers any model without a model-specific context setting. */
export function untrustedContentWindowsFor(provider) {
  const defaultWindow = resolveUntrustedContentWindow(provider);
  const modelIds = new Set([
    ...Object.keys(provider.modelContextWindows ?? {}),
    ...Object.keys(provider.modelNumCtx ?? {}),
  ]);
  const modelWindows = [...modelIds].flatMap(model => {
    const tokens = resolveUntrustedContentWindow(provider, model);
    return tokens === defaultWindow ? [] : [[model, tokens]];
  });
  return { defaultWindow, byModel: Object.fromEntries(modelWindows) };
}
