/**
 * Validate an AI provider's execution prerequisites, then wake a
 * PortOS-managed local provider before the shared AI Toolkit runner sends its
 * request.
 *
 * Public API providers authenticate only with the key stored on their provider
 * record. Rejecting a missing key here keeps an anonymous upstream 404 from
 * masquerading as an unknown provider failure. Private-network endpoints stay
 * keyless by design, using the same shared prerequisite contract as the
 * provider card. The individual local managers still own provider recognition
 * and lifecycle policy.
 */

import { describeMissingPrerequisites, providerPrerequisites } from '../lib/providerPrerequisites.js';
import { ensureProviderReady as ensureOllamaProviderReady, isOllamaProvider } from './ollamaManager.js';
import { ensureMtplxProviderReady, isMtplxProvider } from './mtplxServerManager.js';
import { ensureSlotstreamProviderReady, isSlotstreamProvider } from './slotstreamServerManager.js';

const failedReadiness = (runtime, result) => ({
  ...result,
  error: `${runtime} is not running and PortOS could not start it: ${result?.error || 'unknown error'}`,
});

// Single ordered table of every managed local runtime this install can wake
// before an inference call. Every call site (toolkit runner, aiProvider,
// askService, visionTest, localLlmPlayground) routes through
// `ensureManagedRuntimeReady` instead of hand-rolling its own subset of these
// rows — see issue #8104. Recognition (`is*Provider`) and lifecycle policy
// (`ensure*Ready`) stay owned by each manager module; this table only orders
// them and gives them one shared error/notify contract.
const MANAGED_RUNTIMES = [
  { label: 'Ollama', matches: isOllamaProvider, ensure: ensureOllamaProviderReady },
  { label: 'MTPLX', matches: isMtplxProvider, ensure: ensureMtplxProviderReady },
  { label: 'Slotstream', matches: isSlotstreamProvider, ensure: ensureSlotstreamProviderReady },
];

/**
 * Wake the managed local runtime (if any) that owns `provider`, before an
 * inference call reaches it. A provider that no row recognizes (a public API
 * provider, or a private-network endpoint PortOS doesn't manage) is a no-op
 * success. `onStarting(label)` fires just before the matching row's `ensure`
 * runs, so a caller can surface a "Starting <label> if needed…" status.
 * @returns {Promise<{success:boolean,error?:string}>}
 */
export async function ensureManagedRuntimeReady(provider, { onStarting } = {}) {
  const runtime = MANAGED_RUNTIMES.find((row) => row.matches(provider));
  if (!runtime) return { success: true };

  onStarting?.(runtime.label);
  const result = await runtime.ensure(provider).catch((err) => ({ success: false, error: err.message }));
  return result.success ? result : failedReadiness(runtime.label, result);
}

/**
 * @returns {Promise<{success:boolean,error?:string}>}
 */
export async function ensureProviderReadyForExecution(provider) {
  const { missing } = providerPrerequisites(provider);
  const missingApiKey = missing.filter((entry) => entry.code === 'apiKey');
  if (missingApiKey.length > 0) {
    const providerName = provider?.name || provider?.id || 'API provider';
    return {
      success: false,
      error: `Authentication unavailable for ${providerName}: ${describeMissingPrerequisites(missingApiKey)}. Add it in Settings > AI Providers.`,
    };
  }

  return ensureManagedRuntimeReady(provider);
}
