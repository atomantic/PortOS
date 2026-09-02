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

  if (isOllamaProvider(provider)) {
    const result = await ensureOllamaProviderReady(provider);
    return result.success ? result : failedReadiness('Ollama', result);
  }

  if (isMtplxProvider(provider)) {
    const result = await ensureMtplxProviderReady(provider);
    return result.success ? result : failedReadiness('MTPLX', result);
  }

  if (isSlotstreamProvider(provider)) {
    const result = await ensureSlotstreamProviderReady(provider);
    return result.success ? result : failedReadiness('Slotstream', result);
  }

  return { success: true };
}
